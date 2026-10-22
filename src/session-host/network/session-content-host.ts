/**
 * Owner side of the authenticated native viewport content channel (#389).
 *
 * This module turns one already-authenticated content-lane
 * {@link PeerByteChannel} into a read-only viewport of ONE selected session row.
 * It is constructed explicitly by the host process and is deliberately not
 * imported by the extension entry point, the session host, the sidebar,
 * instances, or the owning-host service: importing this file allocates nothing
 * that outlives the call, and an idle host stays idle.
 *
 * Authority stays exactly where it was. The only owner capabilities used here
 * are the injected service's read-only content watch over the one manager that
 * owns the row, its read-only inventory snapshot (used once per subscribe to
 * fence the request against the exact observed owner run and row before any
 * mutating call), and the manager's own per-session viewer registration
 * (`openViewer` / `readViewer` / `updateViewer` / `closeViewer`). This module
 * therefore holds no frame, transcript, clipboard, roster, or session state of
 * its own, never becomes a second manager, and never starts, stops, writes,
 * resizes, closes, or removes a session. It never calls a row-level mutator: a
 * requested pane size is expressed only as this endpoint's OWN independent
 * viewer contribution, and the canonical geometry that goes on the wire is
 * whatever the manager then reports through the content watch.
 *
 * Identity is the exact `channel.peerKey` proved by the live TLS handshake. A
 * friendly label and any key claimed in a frame are display data, never
 * identity, and are never compared as authority. The injected authorizer is a
 * trusted synchronous callback over that exact key, evaluated for every
 * protected request — including duplicates, unknown subscription ids, and
 * requests that arrive before the hello — and again immediately before every
 * protected write: a viewer registration, a viewer change, a positive
 * acknowledgement the writer is about to admit, and each frame of a queued
 * transfer. `false` and a thrown exception both mean authorization is
 * unavailable: the endpoint retires itself, retires its own watch and viewer,
 * and closes this content channel through the channel's own bounded API. No
 * grant, permission, view-only policy, or lease is created or changed here.
 *
 * Every published viewport is one complete, immutable, codec-produced transfer
 * of one authoritative `watchSessionContent` snapshot. A snapshot is never
 * trimmed, filtered, re-serialized, or merged: native generated SGR, structured
 * styles, cursor, input modes, and typed Kitty PNG images/placements/fallbacks
 * cross unchanged, and a snapshot whose run or row is not the subscribed one is
 * never published. Exactly one write is outstanding at a time — control frames
 * and content frames share ONE serialized, bounded writer, so a stalled
 * acknowledgement can never race a viewport begin and a duplicate-request flood
 * can never accumulate outstanding writes. At most one newer snapshot is
 * retained as pending newest-wins work, and a change that lands while the
 * subscription is still being installed is retained rather than allowed to
 * overwrite the newer post-resize observation with the older install sample.
 *
 * A resolved `send()` means the bytes were admitted to the socket, not that the
 * peer received them, and a write admitted before a stop cannot be recalled.
 * Nothing here claims remote receipt. Every asynchronous write is owned, because
 * the transport only contains a synchronous handler throw, and EVERY outstanding
 * write — control or content — is bounded by the existing transfer deadline: a
 * write that stays outstanding is treated as a stalled transport, the
 * subscription is retired, and the channel is closed rather than waiting
 * forever. The deadline belongs to an actually in-flight write only, so an
 * unchanged idle viewport never expires and no freshness is ever inferred from
 * silence.
 *
 * Installation is cancellable. This endpoint records each owned resource the
 * moment the source hands it over, and every acquisition step re-checks a
 * cancellation token, so a source callback that stops the binding mid-install
 * cannot leave a watch or a viewer behind and can never be resumed into a
 * resurrected subscription.
 *
 * Retirement is evidenced, never assumed. A binding settles only after a
 * bounded attempt to retire its own watch, its message handler, and its own
 * viewer, and after every content-channel close it requested has itself
 * settled. Success requires positive confirmation of all of them: a source that
 * cannot confirm a viewer release or a watch unsubscribe, a handler that cannot
 * be detached, and a channel close that rejects or never settles all keep their
 * handles recorded here and settle as the one fixed
 * {@link SessionContentHostCloseError}. That failure is never retried to green,
 * never reported as a peer receipt or a session shutdown, and it makes the host
 * itself refuse further content bindings, so an unknown participant cannot be
 * accumulated by a replacement binding. Uncertainty is latched at the operation
 * that failed, not only when a binding finally settles, so admission is fenced
 * immediately while a bounded close may still be pending.
 */

import { randomUUID } from "node:crypto";
import type {
	OwningHostInventorySnapshot,
	OwningHostService,
	OwningHostSessionContentSnapshot,
	OwningHostSessionContentWatch,
	SessionViewerState,
	SessionViewerUpdateResult,
} from "../owning-host-service";
import type { PeerByteChannel } from "./channel";
import type { PeerKey } from "./identity";
import { DEFAULT_ROSTER_BRIDGE_BOUNDS, type RosterBridgeBounds } from "./roster-bridge-protocol";
import {
	SESSION_CONTENT_MAJOR,
	SESSION_CONTENT_MINOR,
	SESSION_CONTENT_REQUIRED_CAPABILITY,
	SESSION_CONTENT_SERVICE,
	buildSessionContentTransfer,
	decodeSessionContentFrame,
	encodeSessionContentFrame,
	isSessionContentProtocolError,
	negotiateSessionContentHello,
	resolveSessionContentBounds,
	sessionContentWireCodeForFailure,
	type SessionContentBounds,
	type SessionContentBuiltTransfer,
	type SessionContentErrorCode,
	type SessionContentFrame,
	type SessionContentHelloFrame,
	type SessionContentResizeFrame,
	type SessionContentSubscribeFrame,
} from "./session-content-protocol";

/**
 * The only owner capabilities this endpoint needs: one row's read-only content
 * watch, one read-only inventory snapshot per subscribe, and the manager's own
 * per-session viewer registration. There is no row mutator, no direct resize,
 * no session lifecycle call, and no second listing path here.
 */
export type SessionContentSource = Pick<
	OwningHostService,
	"watchSessionContent" | "readInventorySnapshot" | "openViewer" | "readViewer" | "updateViewer" | "closeViewer"
>;

/**
 * Trusted synchronous authorization decision for one exact verified peer key.
 * Return `true` to allow this content channel to proceed; `false` or a thrown
 * exception means no viewport may be registered, changed, or written. It is
 * called per request and immediately before each protected write, so a
 * revocation takes effect before the next frame.
 */
export type SessionContentAuthorizer = (peerKey: PeerKey) => boolean;

/** Fixed diagnostic codes. Never a frame, label, key, path, row id, or exception. */
export type SessionContentHostDiagnosticCode =
	| "hello_accepted"
	| "hello_refused"
	| "subscribed"
	| "unsubscribed"
	| "viewport_published"
	| "viewport_pending_replaced"
	| "viewport_failed"
	| "authorization_refused"
	| "source_unavailable"
	| "run_changed"
	| "protocol_violation"
	| "send_failed"
	| "send_timeout"
	| "channel_closed"
	| "binding_stopped"
	| "viewer_release_uncertain"
	| "watch_release_uncertain"
	| "handler_release_uncertain"
	| "channel_close_uncertain";

export interface SessionContentHostDiagnostic {
	readonly code: SessionContentHostDiagnosticCode;
	readonly role: "owner";
	/** Publish sequence of a completed viewport transfer, when one completed. */
	readonly sequence?: number;
	/** Message chunks written for that transfer, when one completed. */
	readonly chunks?: number;
}

export type SessionContentHostDiagnosticSink = (event: SessionContentHostDiagnostic) => void;

/**
 * Fixed identity of an unconfirmed content-owner retirement. It carries one
 * constant code and message and never wraps the exception, label, key, path, or
 * frame that surfaced the uncertainty: cleanup that was not proven is reported
 * as exactly one kind of failure, and nothing else.
 */
export const SESSION_CONTENT_HOST_CLOSE_ERROR_CODE = "content_retirement_unconfirmed";
export const SESSION_CONTENT_HOST_CLOSE_ERROR_MESSAGE = "session content host retirement could not be confirmed";

export class SessionContentHostCloseError extends Error {
	static readonly code: typeof SESSION_CONTENT_HOST_CLOSE_ERROR_CODE = SESSION_CONTENT_HOST_CLOSE_ERROR_CODE;
	static readonly message: typeof SESSION_CONTENT_HOST_CLOSE_ERROR_MESSAGE = SESSION_CONTENT_HOST_CLOSE_ERROR_MESSAGE;

	readonly code: typeof SESSION_CONTENT_HOST_CLOSE_ERROR_CODE = SESSION_CONTENT_HOST_CLOSE_ERROR_CODE;

	constructor() {
		super(SESSION_CONTENT_HOST_CLOSE_ERROR_MESSAGE);
		this.name = "SessionContentHostCloseError";
	}
}

export interface SessionContentHostOptions {
	/** The host's one authoritative content source (the owning-host service). */
	readonly source: SessionContentSource;
	/** Required explicit policy: no authorizer means no viewport is ever written. */
	readonly authorizePeer: SessionContentAuthorizer;
	readonly bounds?: Partial<SessionContentBounds>;
	/**
	 * Finite overrides for the owner-side protocol deadlines that already exist
	 * in the roster bridge bounds. Only positive safe integers are accepted; the
	 * owner uses `helloTimeoutMs` for the hello guard and `transferIdleTimeoutMs`
	 * as the deadline for every outstanding write and for the bounded final flush.
	 */
	readonly timeouts?: Partial<
		Pick<
			RosterBridgeBounds,
			"helloTimeoutMs" | "handshakeTimeoutMs" | "snapshotStartTimeoutMs" | "transferIdleTimeoutMs" | "stopAckTimeoutMs"
		>
	>;
	readonly onDiagnostic?: SessionContentHostDiagnosticSink;
}

/** One attached content channel. Stopping it ends viewport delivery and nothing else. */
export interface SessionContentChannelBinding {
	/** Exact verified peer identity of this channel. */
	readonly peerKey: PeerKey;
	/** Bounded display label from the certificate; never identity or authority. */
	readonly label: string | null;
	readonly subscriptionId: string | null;
	/**
	 * This endpoint's OWN registered viewer. It is recorded the moment the source
	 * returns it — including during an installation that later fails — and is
	 * retained until the source confirms release. A value that remains after
	 * retirement therefore means release could not be proven, which is reported as
	 * uncertainty rather than as settled cleanup, and it blocks a replacement
	 * viewer or watch instead of accumulating one.
	 */
	readonly viewerId: string | null;
	readonly subscribed: boolean;
	/**
	 * Cancel transfers, retire the watch and own viewer, detach the handler, and
	 * close this content channel through its own bounded close. Idempotent: it
	 * resolves only when every one of those was positively confirmed, and
	 * otherwise rejects with the fixed {@link SessionContentHostCloseError} with
	 * every retained handle still recorded here. A repeated call returns the same
	 * settlement and never retries an unconfirmed retirement into success.
	 */
	stop(): Promise<void>;
	/**
	 * Settles with the same outcome as {@link stop}: resolves once every owned
	 * resource's retirement was confirmed, and rejects with the fixed failure
	 * otherwise. It never settles before the bounded retirement attempt and any
	 * close this binding requested have themselves settled.
	 */
	readonly closed: Promise<void>;
}

export interface SessionContentHost {
	/**
	 * Attach one admitted CONTENT lane channel. Call this synchronously from the
	 * transport's content-lane callback: the message handler is installed before
	 * this function returns and the owner sends nothing until the viewer says
	 * hello. A channel on any other lane is refused here, before anything is
	 * installed, sent, or mutated. On a host whose own retirement was already
	 * unconfirmed this refuses before a handler, watch, or viewer exists, so an
	 * unknown participant is never accumulated.
	 */
	attach(channel: PeerByteChannel): SessionContentChannelBinding;
	/**
	 * Bindings this host still owns. A binding is removed only when its own
	 * settlement positively confirmed retirement, so an unconfirmed viewer, watch,
	 * or handler keeps its binding — and therefore its evidence — counted here.
	 */
	readonly activeBindingCount: number;
	/**
	 * Subscriptions whose local retirement this host has not confirmed, including
	 * a subscription that already stopped being answered but whose own viewer is
	 * still retained. A zero here therefore never implies that a retired owner
	 * viewer is gone.
	 */
	readonly activeSubscriptionCount: number;
	/**
	 * Stop every binding's viewport delivery and join every owned retirement.
	 * Never touches a session. Every owned binding is attempted even when this host
	 * already carries a sticky failure, so a healthy sibling still retires. Rejects
	 * with the fixed {@link SessionContentHostCloseError} when any retirement is
	 * unconfirmed; the failed binding stays owned and a repeated call cannot turn
	 * it into success.
	 */
	stopAll(): Promise<void>;
}

type OwnerState = "awaiting_hello" | "ready" | "subscribed" | "finished";

/** The exact owner-side deadlines this endpoint uses, resolved once. */
type SessionContentTimeouts = Readonly<
	Pick<RosterBridgeBounds, "helloTimeoutMs" | "transferIdleTimeoutMs" | "stopAckTimeoutMs">
>;

/** Outcome of one installation attempt; only `installed` adopted a subscription. */
type InstallOutcome = "installed" | "refused" | "cancelled";

const TIMEOUT_KEYS = [
	"helloTimeoutMs",
	"handshakeTimeoutMs",
	"snapshotStartTimeoutMs",
	"transferIdleTimeoutMs",
	"stopAckTimeoutMs",
] as const;

type TimeoutOverrides = Partial<Pick<RosterBridgeBounds, (typeof TIMEOUT_KEYS)[number]>>;

/**
 * Bounded backlog of control frames for the one serialized writer. Control
 * writes are refused/closed on overflow instead of accumulating: a peer that
 * keeps requesting while the socket cannot drain is not answered from an
 * unbounded queue.
 */
const MAX_PENDING_CONTROLS = 8;

/**
 * Resolve the owner-side deadlines against the fixed roster-bridge defaults.
 * Every override must be a positive, finite, safe integer; nothing here treats
 * zero or a non-number as "no limit", and an unknown key fails closed.
 */
function resolveTimeouts(overrides: TimeoutOverrides | undefined): SessionContentTimeouts {
	const resolved: Record<(typeof TIMEOUT_KEYS)[number], number> = {
		helloTimeoutMs: DEFAULT_ROSTER_BRIDGE_BOUNDS.helloTimeoutMs,
		handshakeTimeoutMs: DEFAULT_ROSTER_BRIDGE_BOUNDS.handshakeTimeoutMs,
		snapshotStartTimeoutMs: DEFAULT_ROSTER_BRIDGE_BOUNDS.snapshotStartTimeoutMs,
		transferIdleTimeoutMs: DEFAULT_ROSTER_BRIDGE_BOUNDS.transferIdleTimeoutMs,
		stopAckTimeoutMs: DEFAULT_ROSTER_BRIDGE_BOUNDS.stopAckTimeoutMs,
	};
	if (overrides !== undefined) {
		// A caller that is not an ordinary object is refused rather than read.
		const candidate: unknown = overrides;
		if (typeof candidate !== "object" || candidate === null) {
			throw new TypeError("session content host requires finite timeout overrides");
		}
		for (const key of Object.getOwnPropertyNames(candidate)) {
			if (!(TIMEOUT_KEYS as readonly string[]).includes(key)) {
				throw new TypeError("session content host requires finite timeout overrides");
			}
		}
		const values = candidate as Record<string, unknown>;
		for (const key of TIMEOUT_KEYS) {
			const value = values[key];
			if (value === undefined) continue;
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
				throw new TypeError("session content host requires finite timeout overrides");
			}
			resolved[key] = value;
		}
	}
	return Object.freeze({
		helloTimeoutMs: resolved.helloTimeoutMs,
		transferIdleTimeoutMs: resolved.transferIdleTimeoutMs,
		stopAckTimeoutMs: resolved.stopAckTimeoutMs,
	});
}

/** One complete transfer that has been built and is being written, chunk by chunk. */
interface InFlightTransfer {
	/** `content_begin`, every `content_chunk`, then `content_end`, in order. */
	readonly frames: readonly Buffer[];
	readonly subscriptionId: string;
	readonly hostRunId: string;
	readonly sequence: number;
	readonly chunks: number;
	/** The subscription generation this transfer belongs to; a fence retires it. */
	readonly generation: number;
	index: number;
}

/**
 * One control frame waiting for the single send slot. `requiresAuthority` marks
 * the positive frames (acknowledgements) that re-check the peer's current
 * authority at write time; refusals and owner notifications carry no authority
 * and are always deliverable. `generation` lets a superseded positive
 * acknowledgement be dropped instead of describing a retired subscription.
 */
interface QueuedControl {
	readonly bytes: Buffer;
	readonly requiresAuthority: boolean;
	readonly generation: number;
	readonly subscriptionId?: string;
}

interface DiagnosticExtra {
	readonly sequence?: number;
	readonly chunks?: number;
}

class OwnerBinding implements SessionContentChannelBinding {
	readonly peerKey: PeerKey;
	readonly label: string | null;

	readonly #channel: PeerByteChannel;
	readonly #options: SessionContentHostOptions;
	readonly #bounds: SessionContentBounds;
	readonly #timeouts: SessionContentTimeouts;
	readonly #diagnostic: (code: SessionContentHostDiagnosticCode, extra?: DiagnosticExtra) => void;
	/** Told the moment cleanup first becomes uncertain, independently of settlement. */
	readonly #onUncertain: () => void;
	readonly #closed: Promise<void>;
	#resolveClosed: () => void = () => undefined;
	#rejectClosed: (error: Error) => void = () => undefined;
	/**
	 * Resolves `true` only when every owned resource's retirement was positively
	 * confirmed. The host registry removes a binding on this signal alone.
	 */
	readonly #settlement: Promise<boolean>;
	#resolveSettlement: (confirmed: boolean) => void = () => undefined;
	#detach: (() => void) | null = null;
	#helloTimer: NodeJS.Timeout | null = null;
	#sendTimer: NodeJS.Timeout | null = null;
	#state: OwnerState = "awaiting_hello";
	#fenced = false;
	#fenceCode: SessionContentErrorCode = "bad_frame";
	/** True for the whole install of one subscription, including the viewer change. */
	#installing = false;
	#installUnavailable = false;
	#installSnapshot: OwningHostSessionContentSnapshot | null = null;
	#subscriptionId: string | null = null;
	#subscriptionRun: string | null = null;
	#sessionId: string | null = null;
	#viewerId: string | null = null;
	#watch: OwningHostSessionContentWatch | null = null;
	/**
	 * Latched the first time one of this binding's own handles could not be
	 * retired. It is binding-lifetime state, not a per-pass result: a later
	 * retirement attempt never retries that handle and never reports success.
	 */
	#cleanupUncertain = false;
	#viewerReleaseFailed = false;
	#watchReleaseFailed = false;
	#detachReleaseFailed = false;
	#transfer: InFlightTransfer | null = null;
	/** At most ONE newest-wins retained snapshot. */
	#pending: OwningHostSessionContentSnapshot | null = null;
	/** The one bounded backlog of control frames behind the current write. */
	#control: QueuedControl[] = [];
	#sending = false;
	/** Identity of the one write holding the send slot; a timed-out write is detached. */
	#writeToken: object | null = null;
	/** Resolvers waiting for the writer to become idle (used by a bounded stop). */
	#idleWaiters: Array<() => void> = [];
	#publishedSequence = 0;
	/** Subscription generation; every write and every install step is fenced by it. */
	#generation = 0;
	#stopPromise: Promise<void> | null = null;
	/** The one bounded content-channel close this binding requested, if any. */
	#closePromise: Promise<void> | null = null;

	constructor(
		channel: PeerByteChannel,
		options: SessionContentHostOptions,
		bounds: SessionContentBounds,
		timeouts: SessionContentTimeouts,
		diagnostic: (code: SessionContentHostDiagnosticCode, extra?: DiagnosticExtra) => void,
		onUncertain: () => void,
	) {
		this.#channel = channel;
		this.#options = options;
		this.#bounds = bounds;
		this.#timeouts = timeouts;
		this.#diagnostic = diagnostic;
		this.#onUncertain = onUncertain;
		this.peerKey = channel.peerKey;
		this.label = channel.label;
		this.#closed = new Promise<void>((resolve, reject) => {
			this.#resolveClosed = resolve;
			this.#rejectClosed = reject;
		});
		// The fixed failure is owned internally as well as exposed, so no teardown
		// path can leave an unhandled rejection behind.
		void this.#closed.catch(() => undefined);
		this.#settlement = new Promise<boolean>((resolve) => {
			this.#resolveSettlement = resolve;
		});
		// The receiver goes on first, synchronously, so no early frame is missed.
		this.#detach = channel.onMessage((bytes) => this.#onMessage(bytes));
		// The hello guard is one finite deadline taken from the existing roster
		// defaults; it is never extended and never replaced by a second timer.
		this.#helloTimer = setTimeout(() => {
			this.#helloTimer = null;
			if (this.#state !== "awaiting_hello") return;
			this.#diagnostic("hello_refused");
			this.#enqueueControl({ type: "error", code: "protocol_violation" });
			this.#fence("protocol_violation");
		}, timeouts.helloTimeoutMs);
		this.#helloTimer.unref?.();
		void channel.closed.then(() => {
			this.#diagnostic("channel_closed");
			void this.#finish("channel_closed");
		}, () => {
			void this.#finish("channel_closed");
		});
	}

	get subscriptionId(): string | null {
		return this.#subscriptionId;
	}

	get viewerId(): string | null {
		return this.#viewerId;
	}

	get subscribed(): boolean {
		return this.#state === "subscribed";
	}

	get closed(): Promise<void> {
		return this.#closed;
	}

	/** Settlement signal for the host registry; `true` means confirmed retirement. */
	get settlement(): Promise<boolean> {
		return this.#settlement;
	}

	/**
	 * True while this binding still owns a watch or viewer whose retirement was
	 * not confirmed. Those handles are evidence, not bookkeeping: they stay
	 * recorded until the source positively confirms them.
	 */
	get holdsUnretiredResources(): boolean {
		return this.#watch !== null || this.#viewerId !== null;
	}

	stop(): Promise<void> {
		// Settlement is decided exactly once. A repeated stop never turns an
		// unconfirmed retirement into a claimed success: it returns the same fixed
		// failure, with every retained handle still recorded as evidence.
		// An explicit stop retires local resources first, then admits its final frame
		// through the bounded writer and closes this content channel through its own
		// bounded close. Sessions are never touched.
		return this.#finish("stopped", { closeChannel: true });
	}

	/* --------------------------------------------------------------------- *
	 * Inbound
	 * --------------------------------------------------------------------- */

	#onMessage(bytes: Buffer): void {
		// Synchronous by contract: every asynchronous step owns its own rejection,
		// because the transport only contains a throw from this handler.
		if (this.#state === "finished") return;
		let frame: SessionContentFrame;
		try {
			frame = decodeSessionContentFrame(bytes, this.#bounds);
		} catch {
			this.#violation();
			return;
		}
		try {
			this.#handle(frame);
		} catch {
			this.#violation();
		}
	}

	#handle(frame: SessionContentFrame): void {
		switch (frame.type) {
			case "hello":
				this.#onHello(frame);
				return;
			case "subscribe":
			case "resize":
			case "unsubscribe":
				// Every protected request is fenced by the exact peer identity's current
				// authority — including a duplicate subscribe, an unknown subscription id,
				// and a request that arrives before the hello. A revoked peer can neither
				// keep its viewer alive by repeating requests nor talk its way past a
				// refusal.
				if (!this.#authorize()) {
					this.#refuseUnauthorized(frame.subscriptionId);
					return;
				}
				if (frame.type === "subscribe") this.#onSubscribe(frame);
				else if (frame.type === "resize") this.#onResize(frame);
				else this.#onUnsubscribe(frame.subscriptionId);
				return;
			default:
				// Everything else is a frame this side never receives: its own
				// acknowledgement or end, and every transfer frame. Answer once.
				this.#violation();
		}
	}

	#onHello(frame: SessionContentHelloFrame): void {
		if (this.#state !== "awaiting_hello") {
			this.#violation();
			return;
		}
		this.#clearHelloTimer();
		const decision = negotiateSessionContentHello(frame);
		if (!decision.ok) {
			this.#diagnostic("hello_refused");
			this.#enqueueControl({ type: "error", code: decision.code });
			this.#fence(decision.code);
			return;
		}
		if (!this.#authorize()) {
			this.#refuseUnauthorized(undefined);
			return;
		}
		this.#state = "ready";
		this.#diagnostic("hello_accepted");
		// The acknowledgement carries no viewport content. Nothing else is sent
		// until the viewer subscribes: the owner is never eager.
		this.#enqueueControl({
			type: "hello_ack",
			service: SESSION_CONTENT_SERVICE,
			major: SESSION_CONTENT_MAJOR,
			minor: Math.min(frame.minor, SESSION_CONTENT_MINOR),
			// Negotiation can only narrow what either side may assume: this side
			// states the required baseline it implements plus the optional
			// capabilities both sides actually offered. The negotiated optional list
			// alone would omit the baseline every viewer must see.
			capabilities: Object.freeze([SESSION_CONTENT_REQUIRED_CAPABILITY, ...decision.capabilities]),
		});
	}

	#onSubscribe(frame: SessionContentSubscribeFrame): void {
		if (this.#state === "finished") return;
		if (this.#fenced) {
			this.#refuse();
			return;
		}
		if (this.#state === "awaiting_hello") {
			this.#violation();
			return;
		}
		if (this.#state === "subscribed") {
			// One content subscription per channel. A replacement is expressed as an
			// explicit unsubscribe first, never as a second subscription.
			this.#enqueueControl({
				type: "error",
				code: "too_many_subscriptions",
				subscriptionId: this.#subscriptionId ?? undefined,
			});
			this.#diagnostic("protocol_violation");
			return;
		}
		if (this.#viewerId !== null || this.#watch !== null) {
			// A previous retirement was never confirmed. Registering another watch or
			// viewer would accumulate participants on a source that cannot prove
			// cleanup, so this endpoint refuses instead of replacing evidence.
			this.#diagnostic("viewer_release_uncertain");
			this.#enqueueControl({ type: "error", code: "unavailable", subscriptionId: frame.subscriptionId });
			return;
		}
		// Fence the request against the owning service BEFORE any viewer mutation:
		// the requested owner run and row must be exactly what this service now
		// reports. A stale or unknown request installs nothing at all.
		let inventory: OwningHostInventorySnapshot | undefined;
		try {
			inventory = this.#options.source.readInventorySnapshot();
		} catch {
			inventory = undefined;
		}
		if (inventory === undefined) {
			this.#diagnostic("source_unavailable");
			this.#enqueueControl({ type: "error", code: "unavailable", subscriptionId: frame.subscriptionId });
			return;
		}
		if (inventory.hostRunId !== frame.hostRunId) {
			this.#diagnostic("run_changed");
			this.#enqueueControl({ type: "error", code: "unavailable", subscriptionId: frame.subscriptionId });
			return;
		}
		if (!inventory.rows.some((row) => row.id === frame.sessionId)) {
			this.#diagnostic("source_unavailable");
			this.#enqueueControl({ type: "error", code: "unavailable", subscriptionId: frame.subscriptionId });
			return;
		}

		// The install guard covers the source watch AND the viewer change, so a
		// change the source delivers reentrantly (for example from the manager's
		// own resize recompute) is retained as the newest observation instead of
		// being dropped or overwriting a newer sample with the install snapshot.
		this.#installing = true;
		this.#installUnavailable = false;
		this.#installSnapshot = null;
		this.#pending = null;
		let outcome: InstallOutcome = "cancelled";
		try {
			outcome = this.#installSubscription(frame);
		} finally {
			this.#installing = false;
		}
		// The source calls above may synchronously replace these observations.
		// Read through the typed seam rather than TypeScript's pre-call null
		// narrowing: callbacks really can populate both snapshots during install.
		const { initial, retained, unavailableDuringInstall } = this.#readInstallObservations();
		this.#pending = null;
		this.#installSnapshot = null;
		this.#installUnavailable = false;
		if (outcome !== "installed") {
			// A refused or cancelled install adopted nothing. A reentrant stop has
			// already retired every resource it acquired, so nothing is announced.
			return;
		}
		const subscriptionId = this.#subscriptionId;
		if (initial === null || subscriptionId === null) {
			// Unreachable by construction; refuse instead of publishing a guess.
			this.#terminateSubscription("unavailable", "source_unavailable");
			return;
		}
		if (unavailableDuringInstall) {
			// The row became unobservable while the subscription was being installed,
			// so the install sample is not current content and is never published.
			this.#terminateSubscription("unavailable", "source_unavailable");
			return;
		}
		if (!this.subscribed || this.#fenced) {
			// A reentrant stop or fence landed after the final acquisition step. The
			// getter is used deliberately: a field read here would be narrowed by the
			// earlier state checks, while the state genuinely can change from inside a
			// source call.
			this.#retireSubscription();
			return;
		}
		if (!this.#authorize()) {
			// Authority is re-checked immediately before the positive acknowledgement
			// that would tell the viewer this subscription is current.
			this.#refuseUnauthorized(subscriptionId);
			return;
		}
		this.#diagnostic("subscribed");
		// `subscribed` is written before any content, so a viewer can never see
		// viewport frames for a subscription it has not been told about.
		this.#enqueueControl({
			type: "subscribed",
			subscriptionId,
			sessionId: initial.sessionId,
			hostRunId: initial.hostRunId,
		}, subscriptionId);
		// A post-resize observation retained during installation is newer than the
		// install sample, so it is what gets published first.
		const newest = retained !== null && retained.sequence > initial.sequence ? retained : initial;
		this.#beginTransfer(newest);
		this.#drain();
	}

	#readInstallObservations(): {
		readonly initial: OwningHostSessionContentSnapshot | null;
		readonly retained: OwningHostSessionContentSnapshot | null;
		readonly unavailableDuringInstall: boolean;
	} {
		return {
			initial: this.#installSnapshot,
			retained: this.#pending,
			unavailableDuringInstall: this.#installUnavailable,
		};
	}

	/**
	 * Install one subscription: the row's content watch, then this endpoint's ONE
	 * independent viewer, then the requested pane size.
	 *
	 * Every resource is recorded on this binding the moment the source hands it
	 * over, and every step re-checks the install generation. If a source callback
	 * stops, fences, or retires this binding mid-install, the attempt is
	 * `cancelled`: the acquired watch and viewer are retired (their ids stay
	 * visible only when release cannot be proven) and nothing is announced.
	 */
	#installSubscription(frame: SessionContentSubscribeFrame): InstallOutcome {
		const generation = this.#generation;
		let watch: OwningHostSessionContentWatch | undefined;
		try {
			watch = this.#options.source.watchSessionContent(frame.sessionId, (snapshot) => this.#onContent(snapshot));
		} catch {
			watch = undefined;
		}
		if (!this.#installActive(generation)) {
			if (watch !== undefined) this.#retireWatch(watch);
			return "cancelled";
		}
		if (watch === undefined || this.#installUnavailable) {
			if (watch !== undefined) this.#retireWatch(watch);
			this.#diagnostic("source_unavailable");
			this.#enqueueControl({ type: "error", code: "unavailable", subscriptionId: frame.subscriptionId });
			return "refused";
		}
		const initial = watch.snapshot;
		// The observed snapshot must belong to the exact requested run AND row
		// before any mutating call is made on the source.
		if (initial.hostRunId !== frame.hostRunId || initial.sessionId !== frame.sessionId) {
			this.#retireWatch(watch);
			this.#diagnostic("run_changed");
			this.#enqueueControl({ type: "error", code: "unavailable", subscriptionId: frame.subscriptionId });
			return "refused";
		}
		// This attempt now owns the watch: retire through the binding from here on.
		this.#watch = watch;
		if (!this.#authorize()) {
			this.#retireSubscription();
			this.#refuseUnauthorized(frame.subscriptionId);
			return "refused";
		}
		let viewer: SessionViewerState | undefined;
		try {
			viewer = this.#options.source.openViewer();
		} catch {
			viewer = undefined;
		}
		if (viewer === undefined) {
			// A cancellation can also be observed while an unavailable viewer is being
			// reported; it still retires the watch this attempt already owns.
			if (!this.#installActive(generation)) {
				this.#retireSubscription();
				return "cancelled";
			}
			this.#retireSubscription();
			this.#diagnostic("source_unavailable");
			this.#enqueueControl({ type: "error", code: "unavailable", subscriptionId: frame.subscriptionId });
			return "refused";
		}
		// Ownership is recorded the moment the source hands the viewer over — before
		// any cancellation check or later call can fail — so a viewer allocated by a
		// reentrantly stopping source is retired rather than forgotten.
		this.#viewerId = viewer.viewerId;
		if (!this.#installActive(generation)) {
			// A reentrant stop was observed while the viewer was being allocated. The
			// returned viewer is already recorded as this binding's own, so retirement
			// releases it (or keeps a truthful uncertainty) instead of losing it.
			this.#retireSubscription();
			return "cancelled";
		}
		if (!this.#authorize()) {
			this.#retireSubscription();
			this.#refuseUnauthorized(frame.subscriptionId);
			return "refused";
		}
		let update: SessionViewerUpdateResult | undefined;
		try {
			update = this.#options.source.updateViewer(viewer.viewerId, {
				sessionId: frame.sessionId,
				cols: frame.cols,
				rows: frame.rows,
				expectedRevision: viewer.revision,
			});
		} catch {
			update = undefined;
		}
		if (!this.#installActive(generation)) {
			// A reentrant stop retired the watch and this viewer already; nothing is
			// resumed and nothing is announced.
			this.#retireSubscription();
			return "cancelled";
		}
		if (update === undefined || update.applied !== true) {
			// Nothing is adopted: the watch and the viewer this attempt acquired are
			// retired through the binding, so no row geometry is claimed on a refusal.
			this.#retireSubscription();
			this.#diagnostic("source_unavailable");
			this.#enqueueControl({ type: "error", code: "unavailable", subscriptionId: frame.subscriptionId });
			return "refused";
		}
		// Adopt the subscription identity only after every source call succeeded.
		this.#subscriptionId = frame.subscriptionId;
		this.#subscriptionRun = initial.hostRunId;
		this.#sessionId = frame.sessionId;
		this.#publishedSequence = 0;
		this.#installSnapshot = initial;
		this.#state = "subscribed";
		return "installed";
	}

	/** True while this installation attempt may still acquire and adopt resources. */
	#installActive(generation: number): boolean {
		return this.#state !== "finished" && !this.#fenced && this.#generation === generation;
	}

	#onResize(frame: SessionContentResizeFrame): void {
		if (this.#state === "finished") return;
		if (this.#fenced) {
			this.#refuse();
			return;
		}
		if (this.#state !== "subscribed" || frame.subscriptionId !== this.#subscriptionId) {
			// An unknown or retired subscription changes nothing and is answered
			// with one fixed refusal.
			this.#diagnostic("protocol_violation");
			this.#enqueueControl({ type: "error", code: "protocol_violation", subscriptionId: frame.subscriptionId });
			return;
		}
		const viewerId = this.#viewerId;
		if (viewerId === null) {
			this.#terminateSubscription("unavailable", "source_unavailable");
			return;
		}
		let current: SessionViewerState | undefined;
		try {
			current = this.#options.source.readViewer(viewerId);
		} catch {
			current = undefined;
		}
		if (current === undefined || current.sessionId !== this.#sessionId) {
			// This endpoint's own viewer is gone or now displays something else: the
			// subscription can no longer be describing this row.
			this.#terminateSubscription("unavailable", "source_unavailable");
			return;
		}
		if (!this.#authorize()) {
			// Re-checked immediately before the protected viewer write.
			this.#refuseUnauthorized(frame.subscriptionId);
			return;
		}
		let applied: SessionViewerUpdateResult | undefined;
		try {
			applied = this.#options.source.updateViewer(viewerId, {
				cols: frame.cols,
				rows: frame.rows,
				expectedRevision: current.revision,
			});
		} catch {
			applied = undefined;
		}
		if (!this.subscribed || this.#fenced) {
			// The getter is used so a reentrant retirement is observed even though the
			// earlier guard narrowed the field to `subscribed`.
			this.#retireSubscription();
			return;
		}
		if (applied === undefined || applied.applied !== true) {
			// A refused pane change is not silently retried and never falls back to a
			// guessed size; the subscription ends and its viewer is released.
			this.#terminateSubscription("unavailable", "source_unavailable");
			return;
		}
		// Nothing is sent here. The manager's own canonical geometry arrives through
		// the live content watch, so only that geometry ever reaches the wire.
	}

	#onUnsubscribe(subscriptionId: string): void {
		if (this.#state === "subscribed" && subscriptionId === this.#subscriptionId) {
			// Local retirement happens first: the watch is retired, the viewer is
			// released, queued content is cancelled, and late callbacks are fenced.
			this.#retireSubscription();
			this.#state = "ready";
			this.#diagnostic("unsubscribed");
		}
		// Idempotent acknowledgement for the exact requested subscription id, after
		// retirement. No session is affected either way and the channel stays open
		// for an explicit fresh subscription.
		this.#enqueueControl({ type: "unsubscribed", subscriptionId }, subscriptionId);
	}

	/* --------------------------------------------------------------------- *
	 * Source watch
	 * --------------------------------------------------------------------- */

	#onContent(snapshot: OwningHostSessionContentSnapshot | undefined): void {
		if (this.#installing) {
			// Nothing is published or sent yet. Retain the newest observation (or the
			// unavailability) for the subscription that is being installed, so the
			// older install sample can never overwrite a newer post-resize callback.
			if (snapshot === undefined) {
				this.#installUnavailable = true;
				return;
			}
			if (this.#pending === null || snapshot.sequence > this.#pending.sequence) this.#pending = snapshot;
			return;
		}
		if (this.#state !== "subscribed" || this.#fenced) return;
		if (snapshot === undefined) {
			this.#terminateSubscription("unavailable", "source_unavailable");
			return;
		}
		if (this.#subscriptionRun === null || snapshot.hostRunId !== this.#subscriptionRun) {
			// A snapshot from another manager run can never continue this viewport.
			this.#terminateSubscription("unavailable", "run_changed");
			return;
		}
		if (this.#sessionId === null || snapshot.sessionId !== this.#sessionId) {
			// A replaced row is never published to a running subscription.
			this.#terminateSubscription("unavailable", "run_changed");
			return;
		}
		const inFlight = this.#transfer === null ? 0 : this.#transfer.sequence;
		const newest = Math.max(this.#publishedSequence, inFlight);
		if (snapshot.sequence <= newest) return;
		if (this.#pending !== null && snapshot.sequence <= this.#pending.sequence) return;
		const replaced = this.#pending !== null;
		this.#pending = snapshot;
		if (replaced) this.#diagnostic("viewport_pending_replaced");
		// With no transfer in flight this newer snapshot starts immediately; with one
		// in flight it waits as the single newest-wins pending snapshot.
		this.#drain();
	}

	/* --------------------------------------------------------------------- *
	 * One serialized, bounded writer
	 * --------------------------------------------------------------------- */

	/**
	 * The single writer. Control frames go first (they are the peer's refusals,
	 * acknowledgements, and owner notifications), then the next frame of the one
	 * in-flight transfer. Only one write is ever outstanding, so no control frame
	 * can race a viewport begin and no request flood can multiply outstanding
	 * writes.
	 */
	#drain(): void {
		if (this.#sending) return;
		let control = this.#control.shift();
		// A positive acknowledgement whose subscription generation has already
		// passed describes a retired viewport and is dropped, never written.
		while (control !== undefined && control.requiresAuthority && control.generation !== this.#generation) {
			control = this.#control.shift();
		}
		if (control !== undefined) {
			if (control.requiresAuthority && !this.#authorize()) {
				this.#refuseUnauthorized(control.subscriptionId);
				return;
			}
			this.#write(control.bytes, null);
			return;
		}
		if (this.#state === "finished" || this.#fenced || this.#state !== "subscribed") {
			this.#notifyWriterIdle();
			return;
		}
		if (this.#transfer === null) {
			const pending = this.#pending;
			if (pending === null) {
				this.#notifyWriterIdle();
				return;
			}
			this.#pending = null;
			this.#beginTransfer(pending);
			if (this.#transfer === null) {
				this.#notifyWriterIdle();
				return;
			}
		}
		const transfer = this.#transfer;
		if (transfer.generation !== this.#generation || transfer.hostRunId !== this.#subscriptionRun
			|| transfer.subscriptionId !== this.#subscriptionId) {
			// A retired subscription's transfer is never resumed.
			this.#transfer = null;
			this.#notifyWriterIdle();
			return;
		}
		if (transfer.index >= transfer.frames.length) {
			this.#transfer = null;
			this.#publishedSequence = transfer.sequence;
			this.#diagnostic("viewport_published", { sequence: transfer.sequence, chunks: transfer.chunks });
			const pending = this.#pending;
			this.#pending = null;
			if (pending !== null) this.#beginTransfer(pending);
			this.#drain();
			return;
		}
		// Authorization is re-checked before every protected write, including a
		// chunk or end frame queued before a revocation.
		if (!this.#authorize()) {
			this.#refuseUnauthorized(this.#subscriptionId ?? undefined);
			return;
		}
		const frame = transfer.frames[transfer.index];
		if (frame === undefined) {
			this.#transfer = null;
			this.#terminateSubscription("send_failed", "viewport_failed");
			return;
		}
		this.#write(frame, transfer);
	}

	#beginTransfer(snapshot: OwningHostSessionContentSnapshot): void {
		if (this.#state !== "subscribed" || this.#transfer !== null) return;
		const subscriptionId = this.#subscriptionId;
		if (subscriptionId === null) return;
		if (this.#subscriptionRun !== snapshot.hostRunId || this.#sessionId !== snapshot.sessionId) {
			// Stale continuation: the snapshot no longer belongs to this subscription.
			this.#terminateSubscription("unavailable", "run_changed");
			return;
		}
		if (snapshot.sequence <= this.#publishedSequence) return;
		let built: SessionContentBuiltTransfer;
		try {
			// The codec produces the complete immutable transfer: begin, sequential
			// chunks of the exact canonical native viewport, then end. Nothing is
			// trimmed, filtered, or re-serialized here.
			built = buildSessionContentTransfer({
				subscriptionId,
				transferId: randomUUID(),
				hostRunId: snapshot.hostRunId,
				sessionId: snapshot.sessionId,
				nativeSession: snapshot.nativeSession,
				sequence: snapshot.sequence,
				geometry: snapshot.geometry,
				inputModes: snapshot.inputModes,
				frame: snapshot.frame,
				bounds: this.#bounds,
			});
		} catch (error) {
			const code = isSessionContentProtocolError(error)
				? sessionContentWireCodeForFailure(error.code)
				: "bad_frame";
			this.#terminateSubscription(code, "viewport_failed");
			return;
		}
		this.#transfer = {
			frames: built.frames,
			subscriptionId,
			hostRunId: snapshot.hostRunId,
			sequence: snapshot.sequence,
			chunks: built.chunkCount,
			generation: this.#generation,
			index: 0,
		};
	}

	/**
	 * Take the one send slot for exactly one message and bound it. `transfer` is
	 * null for a control frame and the owning transfer for a content frame.
	 */
	#write(bytes: Buffer, transfer: InFlightTransfer | null): void {
		const token = {};
		this.#sending = true;
		this.#writeToken = token;
		this.#startSendDeadline();
		let written: Promise<void>;
		try {
			written = this.#channel.send(bytes);
		} catch {
			written = Promise.reject(new Error("send rejected"));
		}
		// A resolved write means the bytes were admitted to the socket, not that the
		// peer received them. The rejection and settlement paths are both owned.
		void written.then(() => {
			if (!this.#settleWrite(token)) return;
			if (transfer !== null && this.#transfer !== transfer) {
				// A stop, unsubscribe, or replacement during the write cancelled the
				// rest of this transfer. That write was holding the single send slot,
				// so whatever replaced it has to be picked up here.
				this.#drain();
				return;
			}
			if (transfer !== null) transfer.index += 1;
			this.#drain();
		}, () => {
			if (!this.#settleWrite(token)) return;
			if (transfer !== null && this.#transfer !== transfer) {
				this.#drain();
				return;
			}
			if (transfer === null) {
				// A control frame the peer never received: this binding has no way to
				// keep the viewer's view truthful, so it retires and closes.
				this.#failWriter();
				return;
			}
			this.#transfer = null;
			this.#pending = null;
			this.#diagnostic("send_failed");
			this.#terminateSubscription("send_failed", "send_failed", { closeChannel: true });
		});
	}

	/**
	 * Release the send slot for exactly this write. A write the deadline already
	 * abandoned is ignored here, so a late settlement can never free a slot that a
	 * newer write now holds.
	 */
	#settleWrite(token: object): boolean {
		if (this.#writeToken !== token) return false;
		this.#writeToken = null;
		this.#sending = false;
		this.#clearSendTimer();
		return true;
	}

	#startSendDeadline(): void {
		this.#clearSendTimer();
		this.#sendTimer = setTimeout(() => {
			this.#sendTimer = null;
			// The write is still outstanding: this is a stalled transport, not an
			// unchanged idle viewport. Abandon the slot, drop the backlog, retire.
			this.#writeToken = null;
			this.#sending = false;
			this.#control = [];
			this.#transfer = null;
			this.#pending = null;
			this.#diagnostic("send_timeout");
			this.#fence("send_failed", { closeChannel: true });
			// The failed writer also requests the same one bounded close directly, so
			// the close never depends on a settlement that may already be settled.
			void this.#closeChannel();
			this.#notifyWriterIdle();
		}, this.#timeouts.transferIdleTimeoutMs);
		this.#sendTimer.unref?.();
	}

	/* --------------------------------------------------------------------- *
	 * Retirement
	 * --------------------------------------------------------------------- */

	/**
	 * Retire this binding's viewport subscription: fence every queued frame, late
	 * settle, in-flight install step and late source callback, then retire its own
	 * watch and release only its own viewer.
	 *
	 * Returns `true` only when every retirement was positively confirmed. A source
	 * that cannot confirm one keeps its handle recorded on this binding, so the
	 * unretired geometry participant or source capture stays visible instead of
	 * being dropped by a caught exception.
	 */
	#retireSubscription(): boolean {
		// Bumping the generation fences every queued frame, late settle, in-flight
		// install step, and late source callback against resurrecting this
		// subscription.
		this.#generation += 1;
		this.#transfer = null;
		this.#pending = null;
		this.#installSnapshot = null;
		this.#subscriptionRun = null;
		this.#publishedSequence = 0;
		const watch = this.#watch;
		this.#watch = null;
		const viewerId = this.#viewerId;
		this.#subscriptionId = null;
		this.#sessionId = null;
		let confirmed = true;
		if (watch !== null && !this.#retireWatch(watch)) confirmed = false;
		if (viewerId !== null && !this.#releaseViewer(viewerId)) confirmed = false;
		// Uncertainty latched by an earlier retirement belongs to this binding's whole
		// lifetime: no later pass can report settled cleanup for it.
		return confirmed && !this.#cleanupUncertain;
	}

	/**
	 * Latch cleanup uncertainty the moment it is observed. The host is told
	 * synchronously here, before any settlement, so a stop that is still waiting on
	 * its bounded close already fences new content admission.
	 */
	#markCleanupUncertain(): void {
		if (this.#cleanupUncertain) return;
		this.#cleanupUncertain = true;
		this.#onUncertain();
	}

	/**
	 * Retire one watch this binding owns. A failed unsubscribe is not "best
	 * effort": the watch stays recorded as owned evidence, a replacement watch can
	 * no longer be installed beside it, the failure is latched for this binding's
	 * lifetime, and the same uncertain handle is never retried into success.
	 */
	#retireWatch(watch: OwningHostSessionContentWatch): boolean {
		if (this.#watchReleaseFailed) {
			this.#watch = watch;
			return false;
		}
		try {
			watch.unsubscribe();
		} catch {
			this.#watch = watch;
			this.#watchReleaseFailed = true;
			this.#markCleanupUncertain();
			this.#diagnostic("watch_release_uncertain");
			return false;
		}
		if (this.#watch === watch) this.#watch = null;
		return true;
	}

	/**
	 * Release only this endpoint's own viewer. A source that cannot confirm the
	 * release leaves the id recorded and is reported as uncertainty: cleanup that
	 * was not proven is never presented as settled, and the recorded id blocks a
	 * replacement viewer from being registered on top of it.
	 *
	 * A `false` return or a thrown release is never upgraded to success by a
	 * follow-up read: the injected read reports absence and a swallowed manager
	 * failure identically, so it cannot positively prove that this participant is
	 * gone. Only the source's own confirmed release counts as evidence, the failure
	 * is latched for this binding's lifetime, and the id is never retried for a
	 * success the source already declined to give.
	 */
	#releaseViewer(viewerId: string): boolean {
		if (this.#viewerReleaseFailed) return false;
		let released = false;
		try {
			released = this.#options.source.closeViewer(viewerId) === true;
		} catch {
			released = false;
		}
		if (released) {
			if (this.#viewerId === viewerId) this.#viewerId = null;
			return true;
		}
		this.#viewerReleaseFailed = true;
		this.#markCleanupUncertain();
		this.#diagnostic("viewer_release_uncertain");
		return false;
	}

	#terminateSubscription(
		code: SessionContentErrorCode,
		diagnostic: SessionContentHostDiagnosticCode,
		options: { readonly closeChannel?: boolean } = {},
	): void {
		if (this.#state === "finished") return;
		const subscriptionId = this.#subscriptionId;
		this.#retireSubscription();
		this.#diagnostic(diagnostic);
		if (code === "not_authorized") this.#fenced = true;
		if (this.#state === "subscribed") this.#state = "ready";
		if (subscriptionId !== null) {
			this.#enqueueControl({ type: "error", code, subscriptionId });
		} else {
			this.#enqueueControl({ type: "error", code });
		}
		// A failed or stalled write is not proof the peer saw the abort, so a
		// transport-level failure also fences this binding and closes the content
		// channel through its own bounded close — after the bounded writer had a
		// chance to admit the refusal it just queued.
		if (options.closeChannel === true) {
			this.#fenced = true;
			this.#fenceCode = code;
			void this.#finish("fenced", { closeChannel: true });
		}
	}

	#violation(): void {
		if (this.#state === "finished") return;
		this.#diagnostic("protocol_violation");
		this.#enqueueControl({ type: "error", code: "bad_frame" });
		this.#fence("bad_frame", { closeChannel: true });
	}

	/** Answer a request on a fenced channel with the same fixed refusal, nothing else. */
	#refuse(): void {
		if (this.#state === "finished") return;
		this.#enqueueControl({ type: "error", code: this.#fenceCode });
	}

	/**
	 * Authorization is unavailable: retire this endpoint, release its own watch and
	 * viewer, and close this content channel. The fixed refusal is queued first so
	 * it is still admitted while the channel is open. Nothing about a session, a
	 * local view, or another binding changes.
	 */
	#refuseUnauthorized(subscriptionId: string | undefined): void {
		this.#diagnostic("authorization_refused");
		this.#enqueueControl({
			type: "error",
			code: "not_authorized",
			...(subscriptionId === undefined ? {} : { subscriptionId }),
		});
		this.#fence("not_authorized", { closeChannel: true });
	}

	/** Stop answering this channel. Viewport delivery only: sessions stay as they are. */
	#fence(code: SessionContentErrorCode, options: { readonly closeChannel?: boolean } = {}): void {
		this.#fenced = true;
		this.#fenceCode = code;
		this.#retireSubscription();
		void this.#finish("fenced", options);
	}

	#finish(reason: string, options: { readonly closeChannel?: boolean } = {}): Promise<void> {
		const existing = this.#stopPromise;
		if (existing !== null) return existing;
		// The exposed settlement promise exists before the first source call, so a
		// reentrant finish (a source hook calling stop during retirement) joins it
		// instead of starting a second settlement.
		const promise = this.#settlement.then((confirmed) => {
			if (!confirmed) throw new SessionContentHostCloseError();
		});
		this.#stopPromise = promise;
		// The fixed failure is owned internally as well as exposed: every teardown
		// path can request this settlement without leaving an unhandled rejection.
		void promise.catch(() => undefined);
		void this.#settle(reason, options.closeChannel === true).catch(() => {
			// A settlement that could not run is uncertainty, never success.
			this.#finalize(false);
		});
		return promise;
	}

	/**
	 * The one settlement path. Local retirement is attempted first and bounded,
	 * then this binding reports success only when its watch, its message handler,
	 * its own viewer, and any content-channel close it requested were all
	 * positively confirmed. Everything else settles as the fixed failure, with
	 * every unconfirmed handle still recorded on this binding.
	 */
	async #settle(reason: string, closeChannel: boolean): Promise<void> {
		this.#clearHelloTimer();
		const subscriptionId = this.#subscriptionId;
		// Fence the handler, the source, queued native frames and the authorized
		// subscription immediately, before the first await.
		let confirmed = this.#retireSubscription();
		if (this.#state !== "finished") {
			if (subscriptionId !== null && reason === "stopped") {
				// An owner-initiated stop tells the viewer its observations are no
				// longer current; it never fabricates empty content.
				this.#enqueueControl({ type: "end", subscriptionId, code: "stopped" });
			}
			this.#state = "finished";
			if (reason === "stopped") this.#diagnostic("binding_stopped");
		}
		if (!this.#detachHandler()) confirmed = false;
		// Every retirement path joins its final writer attempt under the existing
		// finite stop-acknowledgement budget, never the much longer transfer deadline:
		// a stalled writer must not outlive the coordinator's own ownership deadline.
		// Even a non-closing fence joins its final refusal, because a failed write can
		// request a close whose outcome belongs to this settlement. Nothing here
		// claims receipt.
		await this.#awaitWriterIdle(this.#timeouts.stopAckTimeoutMs);
		if (closeChannel || !this.#isWriterIdle()) {
			// The flush stalled: invalidate the remaining writer work so no outstanding
			// or queued write can request new cleanup after this settlement, then join
			// the one bounded close.
			this.#writeToken = null;
			this.#sending = false;
			this.#clearSendTimer();
			this.#control = [];
			void this.#closeChannel();
		}
		// A fence or writer failure may already have requested this one bounded
		// close; settlement joins it instead of starting a second.
		const closing = this.#closePromise;
		if (closing !== null) {
			try {
				// The one cached close promise is the truthful outcome: its rejection is
				// uncertainty, never a completed close.
				await closing;
			} catch {
				confirmed = false;
			}
		}
		// A reentrant install step (a source hook that stopped this binding while it
		// was still handing over a viewer) or any other late callback can record an
		// owned resource after the first retirement attempt. Retirement is therefore
		// attempted once more inside this same bounded settlement, and anything still
		// retained at settlement time is uncertainty rather than cleanup.
		if (!this.#retireSubscription()) confirmed = false;
		// Any uncertainty latched by an earlier retirement pass is part of this
		// settlement too, even when the retained handle is no longer re-examined.
		if (this.#cleanupUncertain) confirmed = false;
		if (this.#holdsRetainedResources()) confirmed = false;
		this.#finalize(confirmed);
	}

	/** True while any owned handle is still recorded here as unretired evidence. */
	#holdsRetainedResources(): boolean {
		return this.#watch !== null || this.#viewerId !== null || this.#detach !== null;
	}

	/** Report the single settlement outcome, truthfully and exactly once. */
	#finalize(confirmed: boolean): void {
		if (confirmed) this.#resolveClosed();
		else this.#rejectClosed(new SessionContentHostCloseError());
		this.#resolveSettlement(confirmed);
	}

	/**
	 * Detach this binding's message handler. A disposer that throws is not "best
	 * effort": the handle stays recorded as evidence and the uncertainty is
	 * reported, so a handler that may still be installed is never presented as a
	 * cleanly retired endpoint.
	 */
	#detachHandler(): boolean {
		const detach = this.#detach;
		if (detach === null) return true;
		if (this.#detachReleaseFailed) return false;
		try {
			detach();
		} catch {
			this.#detachReleaseFailed = true;
			this.#markCleanupUncertain();
			this.#diagnostic("handler_release_uncertain");
			return false;
		}
		this.#detach = null;
		return true;
	}

	/** Drop the whole backlog and retire after a write the peer never received. */
	#failWriter(): void {
		this.#control = [];
		this.#transfer = null;
		this.#pending = null;
		this.#diagnostic("send_failed");
		this.#fenced = true;
		this.#retireSubscription();
		this.#notifyWriterIdle();
		void this.#finish("send_failed", { closeChannel: true });
		// The close is requested here as well as by the settlement above: both join
		// the same one bounded close, and settlement still waits for it.
		void this.#closeChannel();
	}

	/** True only when no write is outstanding, nothing is queued, and no work is retained. */
	#isWriterIdle(): boolean {
		if (this.#sending) return false;
		if (this.#control.length > 0) return false;
		if (this.#state === "subscribed" && (this.#transfer !== null || this.#pending !== null)) return false;
		return true;
	}

	#notifyWriterIdle(): void {
		if (!this.#isWriterIdle()) return;
		const waiters = this.#idleWaiters;
		this.#idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/**
	 * Wait, under the given finite deadline, for the bounded writer to become idle
	 * so a stop can admit its final frame before closing. A stalled transport
	 * simply reaches the deadline; the close still happens.
	 */
	#awaitWriterIdle(timeoutMs: number): Promise<void> {
		if (this.#isWriterIdle()) return Promise.resolve();
		return new Promise<void>((resolve) => {
			let done = false;
			let timer: NodeJS.Timeout | null = null;
			const finish = (): void => {
				if (done) return;
				done = true;
				if (timer !== null) clearTimeout(timer);
				const index = this.#idleWaiters.indexOf(finish);
				if (index >= 0) this.#idleWaiters.splice(index, 1);
				resolve();
			};
			timer = setTimeout(finish, timeoutMs);
			timer.unref?.();
			this.#idleWaiters.push(finish);
		});
	}

	/**
	 * Close this content channel through the channel's own bounded close, exactly
	 * once. The one cached promise IS the close: a second caller joins the same
	 * in-flight attempt instead of observing an early completion, and every caller
	 * sees the same truthful outcome. It resolves only when the close settled, and
	 * rejects with the fixed {@link SessionContentHostCloseError} when the close was
	 * rejected or did not settle inside the existing stop-acknowledgement budget —
	 * an unconfirmed close is never reported as a completed one.
	 */
	#closeChannel(): Promise<void> {
		if (this.#closePromise !== null) return this.#closePromise;
		let closing: Promise<void>;
		try {
			closing = this.#channel.close();
		} catch {
			closing = Promise.reject(new Error("content channel close threw"));
		}
		const bounded = (async () => {
			if (await this.#settleWithin(closing, this.#timeouts.stopAckTimeoutMs)) return;
			// Latch before reporting: an uncertain close fences admission exactly like
			// every other unconfirmed owned handle.
			this.#markCleanupUncertain();
			this.#diagnostic("channel_close_uncertain");
			throw new SessionContentHostCloseError();
		})();
		this.#closePromise = bounded;
		// The rejection is owned internally as well as exposed: a teardown path that
		// cannot await this close never leaks an unhandled rejection, and it never
		// turns the failure into success either.
		void bounded.catch(() => undefined);
		return bounded;
	}

	/** Await `work` for at most `timeoutMs`; `true` only on its own settlement. */
	async #settleWithin(work: Promise<void>, timeoutMs: number): Promise<boolean> {
		let timer: NodeJS.Timeout | null = null;
		const deadline = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
			timer.unref?.();
		});
		try {
			// Both outcomes of `work` are owned here, so a rejection never escapes as an
			// unhandled rejection from the deadline path either.
			return await Promise.race<boolean>([work.then(() => true, () => false), deadline]);
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	/* --------------------------------------------------------------------- *
	 * Writes
	 * --------------------------------------------------------------------- */

	#authorize(): boolean {
		if (this.#fenced) return false;
		try {
			return this.#options.authorizePeer(this.#channel.peerKey) === true;
		} catch {
			// An unavailable authorization decision is no decision at all.
			return false;
		}
	}

	/**
	 * Queue one control frame for the single writer. Control frames carry no
	 * viewport content. A backlog that exceeds its fixed ceiling is refused and the
	 * channel closed, so a flood can never retain unbounded outstanding requests.
	 */
	#enqueueControl(frame: SessionContentFrame, subscriptionId?: string): void {
		if (this.#state === "finished") return;
		let bytes: Buffer;
		try {
			bytes = encodeSessionContentFrame(frame, this.#bounds);
		} catch {
			this.#failWriter();
			return;
		}
		const requiresAuthority = frame.type === "hello_ack" || frame.type === "subscribed"
			|| frame.type === "unsubscribed";
		// An identical pending refusal is never queued twice: a burst of the same
		// request is answered once, so repeating one frame cannot grow the backlog.
		if (!requiresAuthority && this.#control.some((queued) => queued.bytes.equals(bytes))) return;
		if (this.#control.length >= MAX_PENDING_CONTROLS) {
			// A bounded writer that cannot drain distinct frames is a protocol failure,
			// never an unbounded queue.
			this.#diagnostic("protocol_violation");
			this.#fence("protocol_violation", { closeChannel: true });
			return;
		}
		this.#control.push({
			bytes,
			requiresAuthority,
			generation: this.#generation,
			...(subscriptionId === undefined ? {} : { subscriptionId }),
		});
		this.#drain();
	}

	#clearHelloTimer(): void {
		if (this.#helloTimer === null) return;
		clearTimeout(this.#helloTimer);
		this.#helloTimer = null;
	}

	#clearSendTimer(): void {
		if (this.#sendTimer === null) return;
		clearTimeout(this.#sendTimer);
		this.#sendTimer = null;
	}
}

/**
 * Create the owner side of the native viewport content endpoint. Nothing happens
 * until {@link SessionContentHost.attach} is called with an admitted content
 * channel, and nothing on that channel is readable until the viewer says hello,
 * passes the injected authorization, and subscribes to one row.
 */
export function createSessionContentHost(options: SessionContentHostOptions): SessionContentHost {
	const candidate: unknown = options;
	if (typeof candidate !== "object" || candidate === null) {
		throw new TypeError("session content host requires options");
	}
	if (typeof options.source?.watchSessionContent !== "function") {
		throw new TypeError("session content host requires a session content watch source");
	}
	if (typeof options.source?.readInventorySnapshot !== "function") {
		throw new TypeError("session content host requires a read-only inventory source");
	}
	for (const method of ["openViewer", "readViewer", "updateViewer", "closeViewer"] as const) {
		if (typeof options.source?.[method] !== "function") {
			throw new TypeError("session content host requires the manager's own viewer registration");
		}
	}
	if (typeof options.authorizePeer !== "function") {
		// No implicit policy: without an explicit authorizer no viewport is written.
		throw new TypeError("session content host requires an explicit peer authorizer");
	}
	const bounds = resolveSessionContentBounds(options.bounds);
	const timeouts = resolveTimeouts(options.timeouts);
	const bindings = new Set<OwnerBinding>();
	/**
	 * Sticky fail-closed state: once any owned retirement is unconfirmed this host
	 * admits no further content binding, so an unknown watch, handler, or viewer
	 * cannot be accumulated by a replacement. It never affects the metadata,
	 * listener, or native-session paths, which this module does not own.
	 */
	let cleanupUnconfirmed = false;
	let diagnosticsEnabled = true;
	const diagnostic = (code: SessionContentHostDiagnosticCode, extra?: DiagnosticExtra): void => {
		if (!diagnosticsEnabled || options.onDiagnostic === undefined) return;
		try {
			options.onDiagnostic({
				code,
				role: "owner",
				...(extra?.sequence === undefined ? {} : { sequence: extra.sequence }),
				...(extra?.chunks === undefined ? {} : { chunks: extra.chunks }),
			});
		} catch {
			// A consumer that cannot record a diagnostic never affects a viewport.
			diagnosticsEnabled = false;
		}
	};

	const host: SessionContentHost = {
		attach(channel: PeerByteChannel): SessionContentChannelBinding {
			if (channel === null || typeof channel !== "object" || typeof channel.onMessage !== "function") {
				throw new TypeError("session content host requires a peer byte channel");
			}
			if (channel.lane !== "content") {
				// This endpoint speaks the content lane only. Refusing here installs no
				// handler, writes nothing, mutates no source, and leaves the untouched
				// legacy application lane exactly as it is.
				throw new TypeError("session content host requires a content lane channel");
			}
			if (cleanupUnconfirmed) {
				// Refused before a handler, watch, or viewer exists: a host whose owned
				// resources could not be retired never registers another participant.
				throw new SessionContentHostCloseError();
			}
			const binding = new OwnerBinding(channel, options, bounds, timeouts, diagnostic, () => {
				// Admission is fenced the instant cleanup becomes uncertain, before any
				// settlement and before the bounded close has finished.
				cleanupUnconfirmed = true;
			});
			bindings.add(binding);
			// The binding stays owned — and counted — until its own settlement
			// positively confirmed retirement. A bare channel close or a logically
			// finished binding is never enough to drop it.
			void binding.settlement.then((confirmed) => {
				if (confirmed) {
					bindings.delete(binding);
					return;
				}
				cleanupUnconfirmed = true;
			});
			return binding;
		},
		get activeBindingCount() {
			return bindings.size;
		},
		get activeSubscriptionCount() {
			let count = 0;
			for (const binding of bindings) {
				// A stopped subscription whose own viewer or watch is retained is still
				// an owner-side participant, so it stays counted and this number never
				// implies that a retired owner viewer is gone.
				if (binding.subscribed || binding.holdsUnretiredResources) count += 1;
			}
			return count;
		},
		async stopAll(): Promise<void> {
			// Every owned binding is always attempted, even when this host already
			// carries a sticky failure: a healthy sibling is retired here rather than
			// left delivering a viewport because some other binding failed.
			const current = [...bindings];
			// The registry is never cleared before the attempt, and only a confirmed
			// settlement removes a binding, so a failed retirement stays visible to
			// every later call instead of being erased by a successful sweep.
			const outcomes = await Promise.all(
				current.map((binding) => binding.stop().then(() => true, () => false)),
			);
			// Never close a session: only this endpoint's own viewport deliveries.
			// The live sticky state is read AFTER the sweep: an attachment admitted
			// while this sweep was pending can latch uncertainty that never appears in
			// these outcomes, and a successful-looking aggregate would misrepresent it.
			if (cleanupUnconfirmed || outcomes.includes(false)) {
				cleanupUnconfirmed = true;
				throw new SessionContentHostCloseError();
			}
		},
	};
	return host;
}
