/**
 * Viewer side of the authenticated native viewport content channel (#389
 * selection content phase).
 *
 * This module attaches a single-target viewer endpoint to one
 * already-authenticated {@link PeerByteChannel}. It connects nothing, trusts
 * nobody, pairs nobody, and creates no grant, permission, view-only policy, or
 * identity: reaching this code at all already means the caller holds the same
 * directional `app` grant the legacy application lane requires, holds a channel
 * the transport already verified, and decided which session to watch. No input,
 * clipboard, OSC, or raw PTY byte is written or accepted here; the observed
 * `inputModes` are carried as inert facts inside a published snapshot.
 *
 * Ordering is fixed and the receiver is installed before the hello is sent, so
 * an acknowledgement delivered from inside a send callback cannot be missed.
 * The sequence is exactly `hello` → validated `hello_ack` → one `subscribe` →
 * exact `subscribed` (host run, owner row, and subscription id) → atomic
 * transfers. `ready` means that exact acknowledgement was accepted; it is not
 * the first visible, written, or rendered frame.
 *
 * One viewer observes exactly one target: the expected owner run and owner row
 * are immutable for its lifetime, and the subscription identifier is one fresh
 * UUID that is never reused. Switching targets means retiring this viewer and
 * creating another one over a new content channel, so there is no resync,
 * reconnect, retry, backoff, or heartbeat policy here. Attaching to an `app`
 * lane is refused before a handler is installed, a frame is sent, or the
 * application channel is closed.
 *
 * A complete native viewport is published only when the assembler accepts one
 * full, atomic transfer and its tuple matches this viewer's exact active
 * subscription, pinned run, owner row, positive monotonic sequence (jumps are
 * allowed, duplicates and regressions are not), and the frame agrees with the
 * transfer's own declared geometry. Everything else — wrong run or row, a
 * foreign subscription or transfer, a partial, missing, reordered, overlapping,
 * or malformed transfer, a schema violation — fails closed with a fixed code,
 * clears the published frame, and retires the endpoint. Frames the owner had
 * already admitted for this viewer's own retired subscription are discarded as
 * retirement noise instead of being mistaken for a fresh subscription; a
 * foreign identifier is never silently dropped.
 *
 * Deadlines are finite and come from the existing roster bridge bounds:
 * handshake 5 s, first transfer 15 s, in-flight transfer idle 30 s, and stop
 * acknowledgement 2 s. There is deliberately no idle-current-frame timeout, no
 * trust-age expiry, and no keepalive: an unchanged viewport stays current, and
 * a control write that never settles is bounded by the existing transfer
 * deadline instead of stalling the endpoint forever. `stop` records its intent
 * and clears the published frame synchronously, names its own subscription in at
 * most one `unsubscribe` only when the subscribe was actually handed to the
 * transport, waits at most the stop deadline for that acknowledgement, and then
 * closes the dedicated content channel through its own bounded API whether or
 * not the owner ever answered. Control writes are serialized and re-checked when
 * they execute, so a hello, subscribe, or resize queued before stop can never
 * reach the transport afterwards; only the unsubscribe notice and the fixed
 * refusal error are still attempted. Nothing here stops a
 * remote process. Every send rejection is owned here as well as reported, and
 * every public promise rejection is owned internally, so constructing a viewer
 * cannot produce an unhandled rejection.
 */

import { randomUUID } from "node:crypto";
import type { PeerByteChannel } from "./channel";
import { resolveRosterBridgeBounds, type RosterBridgeBounds } from "./roster-bridge-protocol";
import {
	SESSION_CONTENT_MAJOR,
	SESSION_CONTENT_MINOR,
	SESSION_CONTENT_REQUIRED_CAPABILITY,
	SESSION_CONTENT_SERVICE,
	createSessionContentTransferAssembler,
	decodeSessionContentFrame,
	encodeSessionContentFrame,
	resolveSessionContentBounds,
	reviewSessionContentHelloAck,
	type SessionContentBeginFrame,
	type SessionContentBounds,
	type SessionContentChunkFrame,
	type SessionContentEndTransferFrame,
	type SessionContentFrame,
	type SessionContentHelloAckFrame,
	type SessionContentSnapshot,
	type SessionContentSubscribedFrame,
	type SessionContentTransferAssembler,
} from "./session-content-protocol";

/** The finite deadlines this endpoint reuses; overrides must be positive integers. */
export type SessionContentViewerTimeouts = Partial<
	Pick<
		RosterBridgeBounds,
		"helloTimeoutMs" | "handshakeTimeoutMs" | "snapshotStartTimeoutMs" | "transferIdleTimeoutMs" | "stopAckTimeoutMs"
	>
>;

/** Fixed local failure codes for the viewer endpoint. Never peer content. */
export type SessionContentViewerErrorCode =
	| "stopped"
	| "refused"
	| "timeout"
	| "send-failed"
	| "transfer-failed"
	| "protocol-violation"
	| "channel-closed"
	| "unavailable";

const VIEWER_ERROR_MESSAGES: Record<SessionContentViewerErrorCode, string> = {
	stopped: "session content viewer was stopped",
	refused: "session content owner refused the request",
	timeout: "session content request did not complete in time",
	"send-failed": "session content send failed",
	"transfer-failed": "session content transfer failed",
	"protocol-violation": "session content protocol violation",
	"channel-closed": "session content channel closed",
	unavailable: "session content is unavailable",
};

export class SessionContentViewerError extends Error {
	readonly code: SessionContentViewerErrorCode;

	constructor(code: SessionContentViewerErrorCode) {
		super(VIEWER_ERROR_MESSAGES[code]);
		this.name = "SessionContentViewerError";
		this.code = code;
	}
}

export function isSessionContentViewerError(value: unknown): value is SessionContentViewerError {
	return value instanceof SessionContentViewerError;
}

/** Fixed diagnostic codes. Never a frame, path, identity, or exception detail. */
export type SessionContentViewerDiagnosticCode =
	| "hello_accepted"
	| "hello_refused"
	| "subscribed"
	| "snapshot_published"
	| "unsubscribed"
	| "content_rejected"
	| "owner_error"
	| "protocol_violation"
	| "send_failed"
	| "channel_closed"
	| "viewer_stopped";

export interface SessionContentViewerDiagnostic {
	readonly code: SessionContentViewerDiagnosticCode;
	readonly role: "viewer";
	/** Sequence of the published viewport, when the event names one. */
	readonly sequence?: number;
	/** Chunks in the published viewport, when the event names one. */
	readonly chunkCount?: number;
}

export type SessionContentViewerDiagnosticSink = (event: SessionContentViewerDiagnostic) => void;

export interface SessionContentViewerOptions {
	/**
	 * An authenticated channel already negotiated on the additive `content`
	 * lane. The viewer never connects, pairs, or verifies anything itself, and it
	 * closes this dedicated channel on retirement; the surrounding peer
	 * connection stays caller-owned.
	 */
	readonly channel: PeerByteChannel;
	/** Exact observed owner run this viewer is allowed to accept content from. */
	readonly hostRunId: string;
	/** Exact owner row id of the one session whose native viewport is requested. */
	readonly sessionId: string;
	/** Requested viewport columns; the owner reports its own geometry in frames. */
	readonly cols: number;
	/** Requested viewport rows; the owner reports its own geometry in frames. */
	readonly rows: number;
	/** Content bounds overrides; chunk and transfer ceilings stay bounded. */
	readonly bounds?: Partial<SessionContentBounds>;
	/** Finite deadline overrides; `helloTimeoutMs` belongs to the owner side. */
	readonly timeouts?: SessionContentViewerTimeouts;
	/** Whole validated current view, or `undefined` the moment it stops being current. */
	readonly onSnapshot?: (snapshot: SessionContentSnapshot | undefined) => void;
	readonly onDiagnostic?: SessionContentViewerDiagnosticSink;
}

export interface SessionContentViewer {
	/** The one fresh subscription identifier this viewer ever uses. */
	readonly subscriptionId: string;
	/**
	 * Resolves when this viewer's exact `subscribed` acknowledgement is accepted.
	 * It never means a first frame was written, observed, or rendered. It rejects
	 * truthfully (and is always owned internally) if the endpoint retires first.
	 */
	readonly ready: Promise<void>;
	/**
	 * Resolves when the endpoint has logically retired: the handler is detached,
	 * every timer is cleared, the published frame is `undefined`, and the
	 * dedicated content channel's own bounded close has settled. It never rejects
	 * and never means the remote owner saw or stopped anything.
	 */
	readonly closed: Promise<void>;
	/** The one atomically complete, currently valid viewport, or `undefined`. */
	readSnapshot(): SessionContentSnapshot | undefined;
	/**
	 * Request new viewport dimensions. At most one newest request is retained
	 * across the handshake and backpressure, one `resize` write is in flight at a
	 * time, and the published geometry only changes when the owner reports a
	 * frame. Invalid dimensions are a programming error and throw; a call after
	 * retirement is ignored so it can never restart a subscription.
	 */
	resize(cols: number, rows: number): void;
	/** Idempotent local retirement: clear, unsubscribe, wait bounded, close. */
	stop(): Promise<void>;
}

/** Queued control writes: hello, subscribe, resize, unsubscribe, and one error. */
const MAX_QUEUED_CONTROL_SENDS = 4;

type ViewerState = "awaiting_ack" | "subscribing" | "streaming";

interface Dimensions {
	readonly cols: number;
	readonly rows: number;
}

/** The finite deadlines this endpoint applies, resolved once at attach. */
interface ViewerTimeouts {
	readonly handshakeTimeoutMs: number;
	readonly snapshotStartTimeoutMs: number;
	readonly transferIdleTimeoutMs: number;
	readonly stopAckTimeoutMs: number;
}

type DiagnosticSink = (
	code: SessionContentViewerDiagnosticCode,
	extra?: { readonly sequence?: number; readonly chunkCount?: number },
) => void;

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// A rejection nobody is waiting on yet must never surface as unhandled: the
	// caller learns the outcome through the returned promise as well.
	promise.catch(() => undefined);
	return { promise, resolve, reject };
}

/** The subscription id a frame names, when its shape names one. */
function frameSubscriptionId(frame: SessionContentFrame): string | undefined {
	if (frame.type === "hello" || frame.type === "hello_ack") return undefined;
	return frame.subscriptionId;
}

function isDimensionsEqual(left: Dimensions, right: Dimensions): boolean {
	return left.cols === right.cols && left.rows === right.rows;
}

class ContentViewerBinding implements SessionContentViewer {
	readonly subscriptionId: string;

	readonly #channel: PeerByteChannel;
	readonly #bounds: SessionContentBounds;
	readonly #timeouts: ViewerTimeouts;
	/** Immutable target: another run or row requires a different viewer. */
	readonly #expectedRun: string;
	readonly #expectedSession: string;
	readonly #capabilities: readonly string[];
	readonly #ready = deferred<void>();
	readonly #closed = deferred<void>();
	readonly #onSnapshot: ((snapshot: SessionContentSnapshot | undefined) => void) | undefined;
	readonly #diagnostic: DiagnosticSink;

	readonly #assembler: SessionContentTransferAssembler;
	#snapshot: SessionContentSnapshot | undefined = undefined;
	#state: ViewerState = "awaiting_ack";
	/** Live subscription id, or null while the endpoint is retiring. */
	#activeSubscriptionId: string | null;
	/** This viewer's own retired subscription id, kept only to drop its late frames. */
	#retiringId: string | null = null;
	#lastSequence = 0;
	#requested: Dimensions;
	/** Dimensions of the last `subscribe` or `resize` actually written. */
	#sentDims: Dimensions | null = null;
	/** At most one newest requested resize awaiting a free write slot. */
	#pendingResize: Dimensions | null = null;
	#resizeInFlight = false;
	/** Terminal stop intent, recorded synchronously so nothing can resubscribe. */
	#stopRequested = false;
	/** Whether the subscribe bytes were actually handed to the transport. */
	#subscribeEmitted = false;
	#retired = false;
	#readySettled = false;
	#closedSettled = false;
	#stopPromise: Promise<void> | null = null;
	#finishPromise: Promise<void> | null = null;
	#detach: (() => void) | null = null;
	#handshakeTimer: NodeJS.Timeout | null = null;
	#startTimer: NodeJS.Timeout | null = null;
	#idleTimer: NodeJS.Timeout | null = null;
	#stopAckTimer: NodeJS.Timeout | null = null;
	#stopAck: Deferred<void> | null = null;
	#sendTail: Promise<void> = Promise.resolve();
	/**
	 * Cancellation for every outstanding bounded-send deadline. Retirement cancels
	 * them so no timer can outlive `closed` and report a late `send_failed`.
	 */
	readonly #cancelSendDeadlines = new Set<() => void>();
	#queuedSends = 0;

	constructor(
		options: SessionContentViewerOptions,
		bounds: SessionContentBounds,
		timeouts: ViewerTimeouts,
		subscriptionId: string,
		diagnostic: DiagnosticSink,
	) {
		this.subscriptionId = subscriptionId;
		this.#channel = options.channel;
		this.#bounds = bounds;
		this.#timeouts = timeouts;
		this.#expectedRun = options.hostRunId;
		this.#expectedSession = options.sessionId;
		this.#diagnostic = diagnostic;
		this.#capabilities = Object.freeze([SESSION_CONTENT_REQUIRED_CAPABILITY]);
		this.#requested = { cols: options.cols, rows: options.rows };
		this.#activeSubscriptionId = subscriptionId;
		this.#assembler = createSessionContentTransferAssembler(bounds);
		this.#onSnapshot = typeof options.onSnapshot === "function" ? options.onSnapshot : undefined;
		// Receiver first, hello second: an acknowledgement delivered from inside
		// the send callback is not missed. Nothing else is sent until it arrives.
		this.#detach = options.channel.onMessage((bytes) => this.#onMessage(bytes));
		void options.channel.closed.then(() => this.#onChannelClosed(), () => this.#onChannelClosed());
		this.#armHandshakeTimer();
		void this.#sendControl({
			type: "hello",
			service: SESSION_CONTENT_SERVICE,
			major: SESSION_CONTENT_MAJOR,
			minor: SESSION_CONTENT_MINOR,
			capabilities: this.#capabilities,
		}).catch(() => {
			if (this.#retired || this.#state !== "awaiting_ack") return;
			void this.#retire({ readyError: "send-failed", diagnostic: "send_failed" });
		});
	}

	get ready(): Promise<void> {
		return this.#ready.promise;
	}

	get closed(): Promise<void> {
		return this.#closed.promise;
	}

	readSnapshot(): SessionContentSnapshot | undefined {
		return this.#snapshot;
	}

	resize(cols: number, rows: number): void {
		if (typeof cols !== "number" || !Number.isSafeInteger(cols) || cols <= 0 || cols > this.#bounds.maxCols) {
			throw new RangeError("session content resize columns are invalid");
		}
		if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows <= 0 || rows > this.#bounds.maxRows) {
			throw new RangeError("session content resize rows are invalid");
		}
		// After stop or retirement a resize is inert: nothing may restart delivery.
		if (this.#retired || this.#stopRequested) return;
		const next = { cols, rows };
		this.#requested = next;
		// One slot only: repeated requests while a write is in flight keep the
		// newest dimensions and drop the older ones instead of queueing them.
		this.#pendingResize = next;
		this.#flushResize();
	}

	stop(): Promise<void> {
		if (this.#stopPromise !== null) return this.#stopPromise;
		if (this.#finishPromise !== null) return this.#finishPromise;
		// Claimed before any snapshot callback runs: `#clearSnapshot` notifies a
		// listener synchronously, and a listener that calls stop must join this one
		// instead of starting a second stop with its own unsubscribe.
		const settle = deferred<void>();
		this.#stopPromise = settle.promise;
		// Only a subscribe the transport actually received is owed an unsubscribe.
		const announce = this.#subscribeEmitted;
		// Recorded synchronously, so no continuation already in flight can start or
		// continue a subscription after this call.
		this.#stopRequested = true;
		this.#activeSubscriptionId = null;
		this.#retiringId = this.subscriptionId;
		this.#clearSnapshot();
		this.#clearHandshakeTimer();
		this.#clearStartTimer();
		this.#clearIdleTimer();
		this.#assembler.reset();
		this.#pendingResize = null;
		this.#rejectReady(new SessionContentViewerError("stopped"));
		void this.#runStop(announce).then(() => settle.resolve(), (error: unknown) => settle.reject(error));
		return this.#stopPromise;
	}

	async #runStop(announce: boolean): Promise<void> {
		if (announce) {
			const ack = deferred<void>();
			this.#stopAck = ack;
			this.#stopAckTimer = this.#arm(this.#stopAckTimer, this.#timeouts.stopAckTimeoutMs, () => {
				this.#stopAckTimer = null;
				this.#settleStopAck();
			});
			void this.#sendControl({ type: "unsubscribe", subscriptionId: this.subscriptionId })
				.catch(() => this.#settleStopAck());
			await ack.promise;
		}
		await this.#retire({ readyError: "stopped", diagnostic: "viewer_stopped" });
	}

	/* --------------------------------------------------------------------- *
	 * Retirement
	 * --------------------------------------------------------------------- */

	/**
	 * Retire the endpoint for good. The published frame is cleared, `ready` is
	 * rejected if it has not settled, every timer and the outstanding stop
	 * barrier are cleared, the handler is detached, and the dedicated content
	 * channel is closed through its own bounded API — independent of whether the
	 * owner ever confirms or even receives anything.
	 */
	#retire(options: {
		readonly readyError: SessionContentViewerErrorCode;
		readonly diagnostic: SessionContentViewerDiagnosticCode;
	}): Promise<void> {
		if (this.#finishPromise !== null) return this.#finishPromise;
		this.#retired = true;
		// Claimed first and settled on a later turn: the clear below runs a
		// listener synchronously, and a re-entrant stop must join this retirement
		// instead of starting a second close.
		const finishing = (async () => {
			await Promise.resolve();
			try {
				await this.#channel.close();
			} catch {
				// The channel's bounded close already settled or threw; the endpoint is
				// retired either way and must never reject its own closure promise.
			}
			this.#resolveClosed();
		})();
		this.#finishPromise = finishing;
		// A held write must not leave a deadline that fires after `closed` resolves.
		// Cancelling settles the send as an intentional no-op; a late transport
		// completion or rejection is still owned by the handlers already attached.
		for (const cancel of [...this.#cancelSendDeadlines]) cancel();
		this.#activeSubscriptionId = null;
		this.#retiringId = this.subscriptionId;
		this.#pendingResize = null;
		this.#clearSnapshot();
		this.#clearHandshakeTimer();
		this.#clearStartTimer();
		this.#clearIdleTimer();
		this.#assembler.reset();
		this.#rejectReady(new SessionContentViewerError(options.readyError));
		this.#diagnostic(options.diagnostic);
		// A stop waiting on its acknowledgement must not outlive the endpoint.
		this.#settleStopAck();
		this.#detachHandler();
		return finishing;
	}

	#resolveClosed(): void {
		if (this.#closedSettled) return;
		this.#closedSettled = true;
		this.#closed.resolve();
	}

	#resolveReady(): void {
		if (this.#readySettled) return;
		this.#readySettled = true;
		this.#ready.resolve();
	}

	#rejectReady(error: SessionContentViewerError): void {
		if (this.#readySettled) return;
		this.#readySettled = true;
		this.#ready.reject(error);
	}

	/* --------------------------------------------------------------------- *
	 * Inbound frames
	 * --------------------------------------------------------------------- */

	#onMessage(bytes: Buffer): void {
		if (this.#retired) return;
		let frame: SessionContentFrame;
		try {
			frame = decodeSessionContentFrame(bytes, this.#bounds);
		} catch {
			this.#protocolFailure();
			return;
		}
		try {
			if (this.#activeSubscriptionId === null) this.#onRetirementFrame(frame);
			else this.#handle(frame);
		} catch {
			// Any handler failure is a protocol failure, never a partial publish.
			this.#protocolFailure();
		}
	}

	#handle(frame: SessionContentFrame): void {
		switch (frame.type) {
			case "hello_ack":
				this.#onHelloAck(frame);
				return;
			case "subscribed":
				this.#onSubscribed(frame);
				return;
			case "content_begin":
				this.#onContentBegin(frame);
				return;
			case "content_chunk":
				this.#onContentChunk(frame);
				return;
			case "content_end":
				this.#onContentEnd(frame);
				return;
			case "unsubscribed":
				this.#onOwnerEnded(frame.subscriptionId, "unsubscribed");
				return;
			case "end":
				this.#onOwnerEnded(frame.subscriptionId, "unsubscribed");
				return;
			case "error":
				this.#onOwnerEnded(frame.subscriptionId, "owner_error");
				return;
			default:
				// The viewer speaks hello, subscribe, resize, unsubscribe, and errors;
				// anything else from the owner means it is not speaking this protocol.
				this.#protocolFailure();
		}
	}

	/**
	 * Retirement is the one window in which frames for this viewer's own, already
	 * retired subscription are expected: the owner admitted them before its
	 * unsubscribe arrived. They are dropped without reactivating anything. An
	 * identifier that is not this viewer's own is never treated as noise.
	 */
	#onRetirementFrame(frame: SessionContentFrame): void {
		const retiringId = this.#retiringId;
		const named = frameSubscriptionId(frame);
		if (retiringId !== null && named === retiringId) {
			if (frame.type === "unsubscribed" || frame.type === "end" || frame.type === "error") {
				// The owner confirmed this subscription is gone.
				this.#settleStopAck();
			}
			// A late `subscribed`, chunk, or end for the retired identifier is a
			// leftover of a subscription this side already ended: dropped, never
			// published, and never a second subscription.
			return;
		}
		if (named === undefined && frame.type === "error") {
			// A channel-scoped owner error also ends this viewer's subscription.
			this.#settleStopAck();
			return;
		}
		this.#protocolFailure();
	}

	#protocolFailure(): void {
		if (this.#retired) return;
		// One fixed refusal, sent before retirement. Closing the dedicated channel
		// afterwards is what makes the failure observable even if this write could
		// not be admitted.
		void this.#sendControl({ type: "error", code: "bad_frame" }).catch(() => undefined);
		void this.#retire({ readyError: "protocol-violation", diagnostic: "protocol_violation" });
	}

	#onHelloAck(frame: SessionContentHelloAckFrame): void {
		if (this.#state !== "awaiting_ack") {
			this.#protocolFailure();
			return;
		}
		this.#clearHandshakeTimer();
		const verdict = reviewSessionContentHelloAck(frame, { capabilities: this.#capabilities });
		if (!verdict.ok) {
			// A refused acknowledgement, an unsupported version, and an
			// acknowledgement that claims more than was offered all retire here.
			void this.#retire({ readyError: "refused", diagnostic: "hello_refused" });
			return;
		}
		this.#diagnostic("hello_accepted");
		// The sink is caller code: it can stop the viewer synchronously, and the rest
		// of the handshake must not run (no subscribe, no timer) after that.
		if (this.#retired || this.#stopRequested) return;
		this.#state = "subscribing";
		const dims = this.#requested;
		this.#sentDims = dims;
		// The first transfer deadline starts with the subscription, not with the
		// handshake, and is cleared by the first admitted transfer.
		this.#armStartTimer();
		void this.#sendControl({
			type: "subscribe",
			subscriptionId: this.subscriptionId,
			// Exact observed owner run and owner row: the owner checks both before
			// registering a geometry viewer, and they are never reconstructed here.
			hostRunId: this.#expectedRun,
			sessionId: this.#expectedSession,
			cols: dims.cols,
			rows: dims.rows,
		}).catch(() => {
			if (this.#retired || this.#state !== "subscribing") return;
			void this.#retire({ readyError: "send-failed", diagnostic: "send_failed" });
		});
	}

	#onSubscribed(frame: SessionContentSubscribedFrame): void {
		if (this.#state !== "subscribing") {
			this.#protocolFailure();
			return;
		}
		if (frame.subscriptionId !== this.subscriptionId
			|| frame.hostRunId !== this.#expectedRun
			|| frame.sessionId !== this.#expectedSession) {
			// An acknowledgement for another subscription, run, or row cannot make
			// this viewer ready.
			this.#protocolFailure();
			return;
		}
		this.#clearStartTimer();
		this.#state = "streaming";
		this.#diagnostic("subscribed");
		// A diagnostic sink that stops here must not leave ready resolved, a first
		// transfer deadline armed, or a resize written behind the stop.
		if (this.#retired || this.#stopRequested) return;
		this.#resolveReady();
		// Ready is the exact acknowledgement, not a frame. The first-transfer
		// deadline therefore restarts after it, so an owner that acknowledges and
		// then never publishes is still bounded rather than waited on forever.
		this.#armStartTimer();
		// A resize requested during the handshake is sent now, against the exact
		// subscription, without inventing a geometry the owner never reported.
		this.#flushResize();
	}

	#onContentBegin(frame: SessionContentBeginFrame): void {
		if (this.#state !== "streaming" || frame.subscriptionId !== this.subscriptionId) {
			// No frame may be published or staged before the exact acknowledgement.
			this.#protocolFailure();
			return;
		}
		if (frame.hostRunId !== this.#expectedRun || frame.sessionId !== this.#expectedSession) {
			// Wrong run or wrong owner row: never published, never retargeted.
			this.#protocolFailure();
			return;
		}
		if (!(frame.sequence > this.#lastSequence)) {
			// Duplicate or regressed publish sequence; jumps forward are allowed.
			this.#protocolFailure();
			return;
		}
		this.#lastSequence = frame.sequence;
		this.#clearStartTimer();
		// The assembler validates the declaration, the transfer tuple, and the
		// declared byte/chunk arithmetic before anything is staged.
		this.#assembler.accept(frame);
		this.#armIdleTimer();
	}

	#onContentChunk(frame: SessionContentChunkFrame): void {
		if (this.#state !== "streaming" || frame.subscriptionId !== this.subscriptionId) {
			this.#protocolFailure();
			return;
		}
		// Index order, duplicates, cross-transfer chunks, and declared byte budgets
		// are enforced by the assembler; a refusal discards the whole transfer.
		this.#assembler.accept(frame);
		this.#armIdleTimer();
	}

	#onContentEnd(frame: SessionContentEndTransferFrame): void {
		if (this.#state !== "streaming" || frame.subscriptionId !== this.subscriptionId) {
			this.#protocolFailure();
			return;
		}
		const snapshot = this.#assembler.accept(frame);
		this.#clearIdleTimer();
		if (snapshot === undefined) {
			// `content_end` either completes a transfer or refuses; there is nothing
			// to publish from a control frame.
			this.#protocolFailure();
			return;
		}
		if (snapshot.meta.subscriptionId !== this.subscriptionId
			|| snapshot.meta.hostRunId !== this.#expectedRun
			|| snapshot.meta.sessionId !== this.#expectedSession
			|| snapshot.meta.sequence !== this.#lastSequence) {
			this.#protocolFailure();
			return;
		}
		this.#publish(snapshot);
	}

	#onOwnerEnded(subscriptionId: string | undefined, diagnostic: SessionContentViewerDiagnosticCode): void {
		if (subscriptionId !== undefined && subscriptionId !== this.subscriptionId) {
			// A frame about another subscription is not this viewer's business.
			this.#protocolFailure();
			return;
		}
		// The owner ended or refused the subscription itself, so nothing is owed to
		// it; the frame stops being current immediately and never returns.
		void this.#retire({ readyError: "unavailable", diagnostic });
	}

	#onChannelClosed(): void {
		if (this.#retired) return;
		void this.#retire({ readyError: "channel-closed", diagnostic: "channel_closed" });
	}

	/* --------------------------------------------------------------------- *
	 * Publishing
	 * --------------------------------------------------------------------- */

	#publish(snapshot: SessionContentSnapshot): void {
		this.#snapshot = snapshot;
		this.#diagnostic("snapshot_published", {
			sequence: snapshot.meta.sequence,
			chunkCount: snapshot.meta.chunkCount,
		});
		// A diagnostic sink that stops the viewer clears the frame; this publish must
		// then not hand the retired snapshot to the listener after that clearing.
		if (this.#retired || this.#stopRequested || this.#snapshot !== snapshot) return;
		this.#notify(snapshot);
	}

	/**
	 * Clear the published frame. Nothing is retained as a fallback: an absent,
	 * stale, refused, retargeted, or retired view is `undefined`, never an empty
	 * frame, a guessed geometry, or the last native frame presented as current.
	 */
	#clearSnapshot(): void {
		if (this.#snapshot === undefined) return;
		this.#snapshot = undefined;
		this.#notify(undefined);
	}

	#notify(snapshot: SessionContentSnapshot | undefined): void {
		const listener = this.#onSnapshot;
		if (listener === undefined) return;
		try {
			listener(snapshot);
		} catch {
			// A presentation callback is never load-bearing for the endpoint.
		}
	}

	/* --------------------------------------------------------------------- *
	 * Resize (latest only, serialized)
	 * --------------------------------------------------------------------- */

	#flushResize(): void {
		if (this.#retired || this.#stopRequested) return;
		if (this.#resizeInFlight || this.#state !== "streaming") return;
		const pending = this.#pendingResize;
		if (pending === null) return;
		this.#pendingResize = null;
		const sent = this.#sentDims;
		if (sent !== null && isDimensionsEqual(sent, pending)) {
			// The owner was already told exactly this; there is nothing new to send.
			return;
		}
		const subscriptionId = this.#activeSubscriptionId;
		if (subscriptionId === null) return;
		this.#sentDims = pending;
		this.#resizeInFlight = true;
		void this.#sendControl({
			type: "resize",
			subscriptionId,
			cols: pending.cols,
			rows: pending.rows,
		}).then(() => {
			this.#resizeInFlight = false;
			this.#flushResize();
		}, () => {
			this.#resizeInFlight = false;
			if (this.#retired) return;
			void this.#retire({ readyError: "send-failed", diagnostic: "send_failed" });
		});
	}

	/* --------------------------------------------------------------------- *
	 * Bounded control writes
	 * --------------------------------------------------------------------- */

	#sendControl(frame: SessionContentFrame): Promise<void> {
		if (this.#retired) return Promise.reject(new SessionContentViewerError("stopped"));
		if (this.#queuedSends >= MAX_QUEUED_CONTROL_SENDS) {
			// Control traffic is tiny and sequential by design; a backlog means the
			// channel is not draining, so nothing further is queued.
			this.#diagnostic("send_failed");
			return Promise.reject(new SessionContentViewerError("send-failed"));
		}
		this.#queuedSends += 1;
		const write = (): Promise<void> => {
			// Cancellation is rechecked here, when the write actually executes, not
			// when it was queued: a hello, subscribe, or resize queued before stop (or
			// before retirement) must never reach the transport afterwards. Only the
			// two retirement notices — the unsubscribe and the fixed refusal error —
			// are still attempted, so the owner is told and a refusal stays observable.
			if ((this.#retired || this.#stopRequested) && frame.type !== "unsubscribe" && frame.type !== "error") {
				// An intentional no-op, not a failure: nothing was owed to the wire.
				return Promise.resolve();
			}
			let bytes: Buffer;
			try {
				bytes = encodeSessionContentFrame(frame, this.#bounds);
			} catch {
				this.#diagnostic("send_failed");
				return Promise.reject(new SessionContentViewerError("send-failed"));
			}
			// Recorded at the actual emission, not at queueing: stop only owes an
			// unsubscribe for a subscribe the transport really received. Set before the
			// call, because a synchronous reply can re-enter `stop` from inside `send`.
			if (frame.type === "subscribe") this.#subscribeEmitted = true;
			let written: Promise<void>;
			try {
				written = Promise.resolve(this.#channel.send(bytes));
			} catch {
				written = Promise.reject(new SessionContentViewerError("send-failed"));
			}
			// Resolution means the bytes were admitted to the socket, nothing more,
			// and a write that never settles is bounded by the transfer deadline.
			return this.#withinSendDeadline(written);
		};
		const result = this.#sendTail.then(write, write);
		this.#sendTail = result.then(() => undefined, () => undefined);
		const release = (): void => {
			this.#queuedSends = Math.max(0, this.#queuedSends - 1);
		};
		void result.then(release, release);
		return result;
	}

	#withinSendDeadline(written: Promise<void>): Promise<void> {
		const deadline = this.#timeouts.transferIdleTimeoutMs;
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | null = null;
			const finishDeadline = (): boolean => {
				if (settled) return false;
				settled = true;
				if (timer !== null) {
					clearTimeout(timer);
					timer = null;
				}
				return true;
			};
			// Retirement cancels the deadline instead of inventing a failure.
			const cancel = (): void => {
				if (!finishDeadline()) return;
				this.#cancelSendDeadlines.delete(cancel);
				resolve();
			};
			timer = setTimeout(() => {
				if (!finishDeadline()) return;
				this.#cancelSendDeadlines.delete(cancel);
				this.#diagnostic("send_failed");
				reject(new SessionContentViewerError("send-failed"));
			}, deadline);
			timer.unref?.();
			this.#cancelSendDeadlines.add(cancel);
			written.then(() => {
				if (!finishDeadline()) return;
				this.#cancelSendDeadlines.delete(cancel);
				resolve();
			}, () => {
				if (!finishDeadline()) return;
				this.#cancelSendDeadlines.delete(cancel);
				this.#diagnostic("send_failed");
				reject(new SessionContentViewerError("send-failed"));
			});
			// A synchronous transport callback can retire the endpoint before this
			// promise is even returned, so the deadline is cancelled immediately.
			if (this.#retired) cancel();
		});
	}

	/* --------------------------------------------------------------------- *
	 * Deadlines
	 * --------------------------------------------------------------------- */

	#arm(current: NodeJS.Timeout | null, ms: number, onElapsed: () => void): NodeJS.Timeout {
		if (current !== null) clearTimeout(current);
		const timer = setTimeout(onElapsed, ms);
		timer.unref?.();
		return timer;
	}

	#armHandshakeTimer(): void {
		this.#handshakeTimer = this.#arm(this.#handshakeTimer, this.#timeouts.handshakeTimeoutMs, () => {
			this.#handshakeTimer = null;
			if (this.#retired || this.#state !== "awaiting_ack") return;
			void this.#retire({ readyError: "timeout", diagnostic: "hello_refused" });
		});
	}

	#armStartTimer(): void {
		this.#startTimer = this.#arm(this.#startTimer, this.#timeouts.snapshotStartTimeoutMs, () => {
			this.#startTimer = null;
			if (this.#retired || this.#stopRequested) return;
			// The same finite deadline covers waiting for the subscription
			// acknowledgement and waiting for the first transfer after it, so an owner
			// that accepts the subscribe and then goes silent still retires here.
			if (this.#state !== "subscribing" && this.#state !== "streaming") return;
			void this.#retire({ readyError: "timeout", diagnostic: "content_rejected" });
		});
	}
	/**
	 * In-flight transfer deadline only. It is armed when a transfer starts and
	 * re-armed for each admitted frame of that transfer; a published view arms
	 * nothing, so an unchanged current frame never expires.
	 */
	#armIdleTimer(): void {
		this.#idleTimer = this.#arm(this.#idleTimer, this.#timeouts.transferIdleTimeoutMs, () => {
			this.#idleTimer = null;
			if (this.#retired || this.#state !== "streaming") return;
			// The staged payload is discarded whole and never published.
			this.#assembler.reset();
			void this.#retire({ readyError: "transfer-failed", diagnostic: "content_rejected" });
		});
	}

	#clearHandshakeTimer(): void {
		if (this.#handshakeTimer === null) return;
		clearTimeout(this.#handshakeTimer);
		this.#handshakeTimer = null;
	}

	#clearStartTimer(): void {
		if (this.#startTimer === null) return;
		clearTimeout(this.#startTimer);
		this.#startTimer = null;
	}

	#clearIdleTimer(): void {
		if (this.#idleTimer === null) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = null;
	}

	#clearStopAckTimer(): void {
		if (this.#stopAckTimer === null) return;
		clearTimeout(this.#stopAckTimer);
		this.#stopAckTimer = null;
	}

	#settleStopAck(): void {
		this.#clearStopAckTimer();
		const ack = this.#stopAck;
		this.#stopAck = null;
		ack?.resolve();
	}

	#detachHandler(): void {
		const detach = this.#detach;
		this.#detach = null;
		if (detach === null) return;
		try {
			detach();
		} catch {
			// Detaching is best effort.
		}
	}
}

function resolveTimeouts(timeouts: SessionContentViewerTimeouts | undefined): ViewerTimeouts {
	// Reuses the existing roster bridge defaults and validation: every override
	// must be a positive integer, there is no "0 means unlimited", and the
	// owner-side hello deadline is resolved but unused here.
	const resolved = resolveRosterBridgeBounds(timeouts);
	return {
		handshakeTimeoutMs: resolved.handshakeTimeoutMs,
		snapshotStartTimeoutMs: resolved.snapshotStartTimeoutMs,
		transferIdleTimeoutMs: resolved.transferIdleTimeoutMs,
		stopAckTimeoutMs: resolved.stopAckTimeoutMs,
	};
}

/**
 * Attach one single-target native viewport viewer to an already authenticated
 * `content` channel. The channel's TLS-verified peer key is required exactly as
 * the transport already established it; nothing here connects, pairs, trusts,
 * grants, or widens anything. Attaching to an application-lane channel is
 * refused before a handler is installed, a frame is sent, or that channel is
 * closed. The returned viewer owns closing this dedicated channel on retirement
 * and never stops a remote process.
 */
export function attachSessionContentViewer(options: SessionContentViewerOptions): SessionContentViewer {
	if (options === null || typeof options !== "object") {
		throw new TypeError("session content viewer requires options");
	}
	const channel = options.channel;
	if (channel === null || typeof channel !== "object"
		|| typeof channel.onMessage !== "function"
		|| typeof channel.send !== "function"
		|| typeof channel.close !== "function"
		|| typeof channel.closed?.then !== "function") {
		throw new TypeError("session content viewer requires a peer byte channel");
	}
	// The additive content lane only. Attaching to the legacy `app` lane would
	// mix this viewer into a lane it does not own, so it is refused before any
	// handler, frame, or close touches that channel.
	if (channel.lane !== "content") {
		throw new TypeError("session content viewer requires the content lane");
	}
	// The exact peer identity verified on this TLS connection is the only identity
	// accepted here; a channel without one cannot be pinned.
	const peerKey = channel.peerKey;
	if (peerKey === null || typeof peerKey !== "object"
		|| typeof peerKey.keyId !== "string" || peerKey.keyId.length === 0
		|| typeof peerKey.fingerprint !== "string" || peerKey.fingerprint.length === 0) {
		throw new TypeError("session content viewer requires the exact verified peer key");
	}
	if (typeof options.hostRunId !== "string" || options.hostRunId.length === 0) {
		throw new TypeError("session content viewer requires an owner run id");
	}
	if (typeof options.sessionId !== "string" || options.sessionId.length === 0) {
		throw new TypeError("session content viewer requires an owner session id");
	}
	const bounds = resolveSessionContentBounds(options.bounds);
	const timeouts = resolveTimeouts(options.timeouts);
	const subscriptionId = randomUUID();
	// Validate the immutable target tuple exactly as the wire encoder will, so a
	// value this protocol cannot represent is refused before anything exists on
	// the channel.
	encodeSessionContentFrame({
		type: "subscribe",
		subscriptionId,
		hostRunId: options.hostRunId,
		sessionId: options.sessionId,
		cols: options.cols,
		rows: options.rows,
	}, bounds);
	let diagnosticsEnabled = true;
	const diagnostic = (code: SessionContentViewerDiagnosticCode, extra?: {
		readonly sequence?: number;
		readonly chunkCount?: number;
	}): void => {
		if (!diagnosticsEnabled || options.onDiagnostic === undefined) return;
		try {
			options.onDiagnostic({
				code,
				role: "viewer",
				...(extra?.sequence === undefined ? {} : { sequence: extra.sequence }),
				...(extra?.chunkCount === undefined ? {} : { chunkCount: extra.chunkCount }),
			});
		} catch {
			// A diagnostic sink that throws is never load-bearing.
			diagnosticsEnabled = false;
		}
	};
	return new ContentViewerBinding(options, bounds, timeouts, subscriptionId, diagnostic);
}
