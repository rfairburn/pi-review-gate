/**
 * Viewer side of the authenticated native viewport content channel (#389
 * selection content phase).
 *
 * This module attaches a single-target viewer endpoint to one
 * already-authenticated {@link PeerByteChannel}. It connects nothing, trusts
 * nobody, pairs nobody, and creates no grant, permission, view-only policy, or
 * identity: reaching this code at all already means the caller holds the same
 * directional `app` grant the legacy application lane requires, holds a channel
 * the transport already verified, and decided which session to watch. By
 * default no input, clipboard, OSC, or raw PTY byte is written or accepted
 * here; the observed `inputModes` are carried as inert facts inside a published
 * snapshot. The optional native IO extension is offered only when the caller
 * gives explicit callbacks, an owner acknowledges it, and every write is
 * re-authorized against the source this endpoint itself currently published.
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
 *
 * Native input and text-copy traffic exist here only behind the explicit,
 * default-inert `nativeIo` callbacks and an acknowledgement of the offered
 * `native-input-copy-v1` capability. Input is submitted against the exact
 * source and modes of the currently published snapshot, re-checks that source,
 * the endpoint state, and the caller's dynamic authorization guard immediately
 * before every protected write, and streams one bounded frame at a time in
 * per-binding order (a paste's pages never interleave another input's pages).
 * A logical operation is one of at most `MAX_QUEUED_CONTROL_SENDS` pending
 * operations, and no operation is queued before the handshake acknowledged the
 * subscription. `submitted` only means every local transport write returned;
 * anything invoked and then rejected, retired, lost, or invalidated by a source
 * change is `unknown`, never a false "nothing was sent". Copies are assembled
 * atomically by the protocol helper, are delivered only to this endpoint's own
 * callback while the copy's exact source is still current, and are otherwise
 * discarded (one discard slot) without resets that would revive partial data.
 * Nothing here reads the OS clipboard, emits OSC 52, or writes a PTY.
 */

import { randomUUID } from "node:crypto";
import type { TerminalInputModes } from "../terminal-surface";
import type { PeerByteChannel } from "./channel";
import { resolveRosterBridgeBounds, type RosterBridgeBounds } from "./roster-bridge-protocol";
import {
	SESSION_CONTENT_MAJOR,
	SESSION_CONTENT_MINOR,
	SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
	SESSION_CONTENT_NATIVE_IO_CAPABILITY,
	SESSION_CONTENT_REQUIRED_CAPABILITY,
	SESSION_CONTENT_SERVICE,
	buildNativeInputInline,
	buildNativeInputPaste,
	createNativeCopyAssembler,
	createSessionContentTransferAssembler,
	decodeSessionContentFrame,
	encodeSessionContentFrame,
	isNativeIoStartupSource,
	isSessionContentProtocolError,
	nativeIoSourceEquals,
	resolveSessionContentBounds,
	reviewSessionContentHelloAck,
	type NativeCopyAssembler,
	type NativeIoBuiltTransfer,
	type NativeIoCompletedCopy,
	type NativeIoInputKind,
	type NativeIoInputSource,
	type NativeIoSource,
	type SessionContentBeginFrame,
	type SessionContentBounds,
	type SessionContentChunkFrame,
	type SessionContentCopyBeginFrame,
	type SessionContentCopyChunkFrame,
	type SessionContentCopyEndFrame,
	type SessionContentCopyFrame,
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

/**
 * Optional native input / text-copy callbacks. Both functions are required for
 * the extension to be offered at all; omitting the whole option keeps the exact
 * legacy display-only behavior, hello bytes included. Supplying them is not a
 * permission: the endpoint still proves its own state, current source, and
 * current input modes before anything is written.
 */
export interface SessionContentViewerNativeIo {
	/**
	 * Dynamic focus/source guard, re-evaluated at admission and immediately before
	 * every protected wire write. Anything but `true` (or a throw) refuses the
	 * write: this endpoint treats it as a live proof seam supplied by the caller
	 * that owns the written native source, never as a cached permission, token,
	 * descriptor, or grant. The expected source is a conversation source or, when
	 * startup input was negotiated, a tuple-less startup source.
	 */
	readonly authorizeInput: (expected: NativeIoInputSource) => boolean;
	/**
	 * Called at most once per atomically assembled native text copy, and only while
	 * that copy's exact source is still this endpoint's current published source.
	 * The payload is canonical base64 text or a fixed unavailable reason: never a
	 * raw OSC 52 sequence, image data, another binding's copy, or a terminal write.
	 */
	readonly onCopy: (copy: NativeIoCompletedCopy) => void;
}

/** One caller-normalized native input submission against one exact source. */
export interface SessionContentViewerInputRequest {
	/** Exact expected source (conversation or startup); it must equal this endpoint's current published one. */
	readonly source: NativeIoInputSource;
	/** Exact expected observed input modes of that same current snapshot. */
	readonly inputModes: TerminalInputModes;
	readonly kind: NativeIoInputKind;
	/**
	 * Already-normalized payload: one protocol keyboard packet, the UTF-8 text
	 * body of a paste (at most 1 MiB of decoded bytes), or one canonical
	 * content-space SGR mouse report. Never a system clipboard read, a raw OSC byte
	 * stream, or an image/file payload.
	 */
	readonly text: string;
}

/** Fixed reasons an input was refused before any write was even attempted. */
export type NativeInputNotSentReason =
	| "not-negotiated"
	| "not-ready"
	| "stale-source"
	| "stale-modes"
	| "unauthorized"
	| "busy"
	| "invalid-input"
	| "too-large"
	| "stopped";

/**
 * Outcome of one submission. `submitted` means every local transport write of
 * this logical input returned; it says nothing about the child having processed
 * a byte. `not-sent` is only ever returned before any `channel.send` invocation,
 * so it can never be reported for an input whose bytes may already be gone.
 * `unknown` is returned once any write was invoked and its full return is not
 * known (rejection, retirement, source change, channel loss). There is no retry,
 * replay, reconnect, or optimistic success.
 */
export type NativeInputSendResult =
	| { readonly status: "submitted" }
	| { readonly status: "not-sent"; readonly reason: NativeInputNotSentReason }
	| { readonly status: "unknown" };

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
	/**
	 * Optional native input / text-copy callbacks. Omitted (the default) keeps the
	 * exact legacy hello, control, resize, stop, timeout, and display behavior with
	 * no native IO capability offered, accepted, or acted on.
	 */
	readonly nativeIo?: SessionContentViewerNativeIo;
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
	 * The immutable native input source of the currently published snapshot, or
	 * `undefined` while the extension is unoffered, unacknowledged, not streaming,
	 * retired, or that snapshot carries no source. Descriptive facts only: the
	 * source is never authority to write, and it is never inferred from a newer
	 * target. Before the owner's first conversation tuple this may be the explicit
	 * tuple-less startup source (only when startup input was negotiated).
	 */
	readNativeInputSource(): NativeIoInputSource | undefined;
	/**
	 * Submit one typed, caller-normalized native input against the exact source and
	 * modes of the current published snapshot. The source, endpoint state, and the
	 * caller's dynamic guard are re-checked immediately before every write; nothing
	 * is retried, replayed, or reconnected. Resolves to a fixed truthful outcome and
	 * never rejects.
	 */
	sendInput(request: SessionContentViewerInputRequest): Promise<NativeInputSendResult>;
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

/**
 * Queued control writes: hello, subscribe, resize, unsubscribe, and one error.
 * The same finite bound governs pending logical input operations.
 *
 * The size is an explicit sizing assumption, not a measured mapping. The browser
 * input reference (https://developer.chrome.com/blog/aligning-input-events/)
 * describes mouse input at roughly 100 Hz, touch at 60–120 Hz, and continuous
 * wheel dispatch aligned to frames; normalized terminal packets are assumed to
 * arrive at 60–120 per second, so 32 slots cover roughly 0.27–0.53 s of arrivals
 * with no drain at all, and each slot is released as its own send settles. This
 * is a capacity choice for one viewer on one binding, not a universal flick
 * count: the parser forwards one normalized packet per logical operation and
 * never carries a scroll-delta magnitude. Admission stays fail-closed — an
 * operation above the bound is refused as `busy` before anything is queued or
 * written, and a control backlog still refuses further queueing.
 */
const MAX_QUEUED_CONTROL_SENDS = 32;

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

/** One logical input operation: its frames are contiguous and order-preserving. */
interface PendingInput {
	/** True once any `channel.send` for this operation has been invoked. */
	invoked: boolean;
	/** True once the returned promise settled; no later frame may be written. */
	settled: boolean;
	/** The endpoint's own facts this operation's frames were validated against. */
	readonly source: NativeIoInputSource;
	readonly inputModes: TerminalInputModes;
	/**
	 * True once a newer publication stopped matching the source/modes this operation
	 * was admitted against. Retained until the operation ends, so an operation whose
	 * last write is still outstanding can never report `submitted`, and an exact
	 * A -> B -> A return does not revive the old input lifetime.
	 */
	invalidated: boolean;
	readonly result: Promise<NativeInputSendResult>;
	settle(result: NativeInputSendResult): void;
	/** Retirement: settle truthfully and stop the operation. */
	abort(): void;
}

type InputFrameOutcome =
	| { readonly outcome: "written" }
	| { readonly outcome: "blocked"; readonly reason: NativeInputNotSentReason }
	| { readonly outcome: "failed" };

type InputGate =
	| { readonly ok: true; readonly source: NativeIoInputSource; readonly inputModes: TerminalInputModes }
	| { readonly ok: false; readonly reason: NativeInputNotSentReason };

function isNativeIoSourceShape(value: unknown): value is NativeIoInputSource {
	if (value === null || typeof value !== "object") return false;
	const source = value as Record<string, unknown>;
	const nativeSession = source.nativeSession;
	const geometry = source.geometry;
	// A startup source names its phase and carries no tuple; a conversation source
	// carries a tuple. Exact equality against the published source decides the rest.
	const tupleShape = Object.prototype.hasOwnProperty.call(source, "phase")
		? source.phase === "startup" && !Object.prototype.hasOwnProperty.call(source, "nativeSession")
		: nativeSession !== null && typeof nativeSession === "object";
	return tupleShape
		&& geometry !== null && typeof geometry === "object"
		&& typeof source.hostRunId === "string"
		&& typeof source.sessionId === "string"
		&& typeof source.viewerRevision === "number"
		&& typeof source.sourceToken === "string";
}

function isInputModesShape(value: unknown): value is TerminalInputModes {
	if (value === null || typeof value !== "object") return false;
	const modes = value as Record<string, unknown>;
	return typeof modes.kittyFlags === "number"
		&& typeof modes.applicationCursorKeys === "boolean"
		&& typeof modes.applicationKeypad === "boolean"
		&& typeof modes.bracketedPaste === "boolean"
		&& typeof modes.mouseTracking === "string"
		&& typeof modes.modifyOtherKeys === "number"
		&& typeof modes.mouseEncoding === "string";
}

function isInputModesEqual(left: TerminalInputModes, right: TerminalInputModes): boolean {
	return left.kittyFlags === right.kittyFlags
		&& left.applicationCursorKeys === right.applicationCursorKeys
		&& left.applicationKeypad === right.applicationKeypad
		&& left.bracketedPaste === right.bracketedPaste
		&& left.mouseTracking === right.mouseTracking
		&& left.modifyOtherKeys === right.modifyOtherKeys
		&& left.mouseEncoding === right.mouseEncoding;
}

function isNativeIoInputKindValue(value: unknown): value is NativeIoInputKind {
	return value === "keyboard" || value === "paste" || value === "mouse";
}

function isInputRequestShape(value: unknown): value is SessionContentViewerInputRequest {
	if (value === null || typeof value !== "object") return false;
	const request = value as Record<string, unknown>;
	return isNativeIoSourceShape(request.source)
		&& isInputModesShape(request.inputModes)
		&& isNativeIoInputKindValue(request.kind)
		&& typeof request.text === "string";
}

/**
 * Strict UTF-16 well-formedness, so no payload is silently replacement-mutated
 * while being encoded: a lone surrogate is an invalid input, not a packet.
 */
function isWellFormedText(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit < 0xd800 || unit > 0xdfff) continue;
		if (unit > 0xdbff) return false;
		const low = text.charCodeAt(index + 1);
		if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
		index += 1;
	}
	return true;
}

/**
 * Validate the optional callbacks. A present but malformed option is refused
 * before a handler exists, a frame is sent, or a capability is offered, so a
 * broken option can never silently enable the extension.
 */
function resolveNativeIo(value: unknown): SessionContentViewerNativeIo | null {
	if (value === undefined) return null;
	if (value === null || typeof value !== "object") {
		throw new TypeError("session content viewer nativeIo requires an object with both callbacks");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.authorizeInput !== "function" || typeof candidate.onCopy !== "function") {
		throw new TypeError("session content viewer nativeIo requires authorizeInput and onCopy");
	}
	return Object.freeze({
		authorizeInput: candidate.authorizeInput as SessionContentViewerNativeIo["authorizeInput"],
		onCopy: candidate.onCopy as SessionContentViewerNativeIo["onCopy"],
	});
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
	/** Validated caller callbacks, or null for the exact legacy display-only mode. */
	readonly #authorizeInput: SessionContentViewerNativeIo["authorizeInput"] | null;
	readonly #onCopy: SessionContentViewerNativeIo["onCopy"] | null;
	/** True only after the owner acknowledged the capability this side offered. */
	#nativeIoNegotiated = false;
	/** True only after the owner ALSO acknowledged startup input beside native IO. */
	#startupInputNegotiated = false;

	readonly #assembler: SessionContentTransferAssembler;
	readonly #copyAssembler: NativeCopyAssembler;
	/** Independent copy-assembly deadline; never the viewport idle deadline. */
	#copyIdleTimer: NodeJS.Timeout | null = null;
	/** The one copy currently being consumed but withheld because its source is not current. */
	#copyDiscardId: string | null = null;
	/** The paged copy whose header was admitted, until its assembly completes. */
	#copyHeaderId: string | null = null;
	#copyHeaderSource: NativeIoSource | null = null; // copy headers are conversation-only
	/** Ordered logical input operations; one operation's frames never interleave. */
	#inputTail: Promise<void> = Promise.resolve();
	readonly #pendingInputs = new Set<PendingInput>();
	#nextInputOrdinal = 1;
	/**
	 * Monotonic semantic source/mode generation. It changes only when a publication
	 * replaces the current source or the observed input modes, never for an
	 * ordinary text update, and lets a caller callback that performs an exact
	 * A -> B -> A transition be detected by comparison instead of present equality.
	 */
	#inputGeneration = 0;
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
		nativeIo: SessionContentViewerNativeIo | null,
	) {
		this.subscriptionId = subscriptionId;
		this.#channel = options.channel;
		this.#bounds = bounds;
		this.#timeouts = timeouts;
		this.#expectedRun = options.hostRunId;
		this.#expectedSession = options.sessionId;
		this.#diagnostic = diagnostic;
		this.#authorizeInput = nativeIo === null ? null : nativeIo.authorizeInput;
		this.#onCopy = nativeIo === null ? null : nativeIo.onCopy;
		// The optional capabilities are offered only for explicit, validated callbacks;
		// the default hello keeps its exact single-capability shape and bytes. Startup
		// input is offered only beside the native IO capability it depends on.
		this.#capabilities = Object.freeze(nativeIo === null
			? [SESSION_CONTENT_REQUIRED_CAPABILITY]
			: [
				SESSION_CONTENT_REQUIRED_CAPABILITY,
				SESSION_CONTENT_NATIVE_IO_CAPABILITY,
				SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
			]);
		this.#requested = { cols: options.cols, rows: options.rows };
		this.#activeSubscriptionId = subscriptionId;
		this.#assembler = createSessionContentTransferAssembler(bounds);
		this.#copyAssembler = createNativeCopyAssembler(bounds);
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

	readNativeInputSource(): NativeIoInputSource | undefined {
		if (!this.#nativeIoNegotiated || this.#retired || this.#stopRequested) return undefined;
		if (this.#state !== "streaming" || this.#activeSubscriptionId !== this.subscriptionId) return undefined;
		const snapshot = this.#snapshot;
		if (snapshot === undefined) return undefined;
		// Only this endpoint's own exact, currently published snapshot can describe a
		// source; the facts stay descriptive and never become authority.
		if (snapshot.meta.subscriptionId !== this.subscriptionId
			|| snapshot.meta.hostRunId !== this.#expectedRun
			|| snapshot.meta.sessionId !== this.#expectedSession) {
			return undefined;
		}
		const source = snapshot.meta.inputSource;
		if (source === undefined || source === null) return undefined;
		return source;
	}

	sendInput(request: SessionContentViewerInputRequest): Promise<NativeInputSendResult> {
		// A hostile or malformed argument is a refusal, never a thrown or rejected call.
		const gate = ((): InputGate => {
			try {
				if (!isInputRequestShape(request)) return { ok: false, reason: "invalid-input" };
				return this.#inputGate(request.source, request.inputModes);
			} catch {
				return { ok: false, reason: "invalid-input" };
			}
		})();
		if (!gate.ok) return Promise.resolve<NativeInputSendResult>({ status: "not-sent", reason: gate.reason });
		if (this.#pendingInputs.size >= MAX_QUEUED_CONTROL_SENDS) {
			// The existing control bound governs logical input operations too; a page is
			// not a pending operation, so one paste never consumes several slots.
			return Promise.resolve<NativeInputSendResult>({ status: "not-sent", reason: "busy" });
		}
		const ordinal = this.#nextInputOrdinal;
		const ownedSource = gate.source;
		const ownedModes = gate.inputModes;
		const prepared = ((): { readonly ok: true; readonly built: NativeIoBuiltTransfer }
			| { readonly ok: false; readonly reason: NativeInputNotSentReason } => {
			try {
				const built = this.#buildInput({ source: ownedSource, inputModes: ownedModes, kind: request.kind, text: request.text }, randomUUID(), ordinal);
				if (built === "invalid") return { ok: false, reason: "invalid-input" };
				return { ok: true, built };
			} catch (error) {
				const tooLarge = isSessionContentProtocolError(error) && error.code === "transfer_too_large";
				return { ok: false, reason: tooLarge ? "too-large" : "invalid-input" };
			}
		})();
		if (!prepared.ok) {
			return Promise.resolve<NativeInputSendResult>({ status: "not-sent", reason: prepared.reason });
		}
		const built = prepared.built;
		this.#nextInputOrdinal = ordinal + 1;
		const settled = deferred<NativeInputSendResult>();
		const pending: PendingInput = {
			invoked: false,
			settled: false,
			source: ownedSource,
			inputModes: ownedModes,
			invalidated: false,
			result: settled.promise,
			settle: (result) => {
				if (pending.settled) return;
				pending.settled = true;
				settled.resolve(result);
			},
			abort: () => {
				// Truthful on retirement: bytes that were never invoked are not sent, and
				// bytes that may already be on the wire are never called unsent.
				pending.settle(pending.invoked ? { status: "unknown" } : { status: "not-sent", reason: "stopped" });
			},
		};
		this.#pendingInputs.add(pending);
		// Claimed synchronously in call order: one operation's frames complete before
		// the next one's begin, so a paste's pages can never interleave.
		const start = this.#inputTail;
		let release = (): void => undefined;
		this.#inputTail = new Promise<void>((resolve) => {
			release = () => resolve();
		});
		void this.#runInput(pending, built, start, release);
		return pending.result;
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
		this.#copyAssembler.reset();
		this.#copyDiscardId = null;
		this.#copyHeaderId = null;
		this.#copyHeaderSource = null;
		this.#clearCopyTimer();
		// Every pending logical input ends now with its truthful invocation status.
		this.#abortPendingInputs();
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
		this.#copyAssembler.reset();
		this.#copyDiscardId = null;
		this.#copyHeaderId = null;
		this.#copyHeaderSource = null;
		this.#clearCopyTimer();
		// No pending input may be left dangling or keep a slot after retirement.
		this.#abortPendingInputs();
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
			case "copy":
			case "copy_begin":
			case "copy_chunk":
			case "copy_end":
				this.#onCopyFrame(frame);
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
		// Only an explicitly offered capability the owner actually acknowledged turns
		// the extension on; a plain acknowledgement leaves the viewer display-only.
		if (this.#authorizeInput !== null
			&& verdict.capabilities.includes(SESSION_CONTENT_NATIVE_IO_CAPABILITY)) {
			this.#nativeIoNegotiated = true;
			// The ack review already refuses startup without native IO.
			if (verdict.capabilities.includes(SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY)) {
				this.#startupInputNegotiated = true;
			}
		}
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
		if (frame.inputSource !== undefined && !this.#nativeIoNegotiated) {
			// A source this side never offered and the owner never acknowledged is not
			// silently dropped: the extension was not negotiated on this channel.
			this.#protocolFailure();
			return;
		}
		if (frame.inputSource !== undefined && frame.inputSource !== null
			&& isNativeIoStartupSource(frame.inputSource) && !this.#startupInputNegotiated) {
			// Startup data this side never negotiated is not silently dropped either.
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
		// Semantic generation first: it is the only proof that survives an exact
		// A -> B -> A transition inside caller code, where present equality looks
		// unchanged. Ordinary text-only publications do not advance it.
		const previous = this.#snapshot;
		const before = previous?.meta.inputSource;
		const after = snapshot.meta.inputSource;
		const sourceChanged = before === undefined || before === null
			|| after === undefined || after === null
			? before !== after
			: !nativeIoSourceEquals(before, after);
		if (previous === undefined || sourceChanged
			|| !isInputModesEqual(previous.meta.inputModes, snapshot.meta.inputModes)) {
			this.#inputGeneration += 1;
		}
		this.#snapshot = snapshot;
		// A newer publication is a new source lifetime: pending input admitted against
		// a different source can never finish as `submitted`, and a copy whose header
		// belonged to a different source is withheld for good (an exact A -> B -> A
		// return is still a new lifetime, so equality alone is not enough).
		this.#invalidateInputsFor(snapshot);
		this.#withholdActiveCopy(snapshot);
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

	/**
	 * Invalidate pending input operations whose admitted source/modes no longer match
	 * the snapshot that just became current. The flag is permanent for that operation:
	 * a later return to the same source does not restore its lifetime, and the
	 * invalidation is retained through the completion of a write already in flight.
	 */
	#invalidateInputsFor(snapshot: SessionContentSnapshot): void {
		if (this.#pendingInputs.size === 0) return;
		const current = snapshot.meta.inputSource;
		for (const pending of this.#pendingInputs) {
			if (pending.settled) continue;
			if (current === undefined || current === null
				|| !nativeIoSourceEquals(pending.source, current)
				|| !isInputModesEqual(pending.inputModes, snapshot.meta.inputModes)) {
				pending.invalidated = true;
			}
		}
	}

	/**
	 * Withhold the copy assembly that is currently being consumed when a publication
	 * leaves that copy's exact header source. The single discard slot is retained until
	 * the assembly ends, so its remaining pages are still consumed (and validated) but
	 * never routed.
	 */
	#withholdActiveCopy(snapshot: SessionContentSnapshot): void {
		const copyId = this.#copyHeaderId;
		const source = this.#copyHeaderSource;
		if (copyId === null || source === null) return;
		const current = snapshot.meta.inputSource;
		if (current === undefined || current === null || !nativeIoSourceEquals(source, current)) {
			this.#copyDiscardId = copyId;
		}
	}

	/* --------------------------------------------------------------------- *
	 * Native input (optional capability, default inert)
	 * --------------------------------------------------------------------- */

	/**
	 * The one admission/re-write gate. It is evaluated at submission and again
	 * inside every protected wire write, because the source, the modes, the
	 * endpoint state, or the caller's own guard can change between frames. It
	 * never caches a verdict, a token, or a permission.
	 */
	#inputGate(source: NativeIoInputSource, inputModes: TerminalInputModes): InputGate {
		if (!this.#nativeIoNegotiated || this.#authorizeInput === null) {
			return { ok: false, reason: "not-negotiated" };
		}
		const target = this.#currentInputTarget(source, inputModes);
		if (!target.ok) return target;
		const generation = this.#inputGeneration;
		if (!this.#authorize(target.source)) return { ok: false, reason: "unauthorized" };
		// The guard is caller code: it can stop this endpoint or replace the source
		// synchronously (even A -> B -> A) and still return `true`. Its answer is never
		// trusted, so both the semantic generation and the whole target are re-proved
		// after it returns.
		if (generation !== this.#inputGeneration) return { ok: false, reason: "stale-source" };
		return this.#currentInputTarget(source, inputModes);
	}

	/**
	 * The endpoint's own view of the exact current input target. Separate from the
	 * caller's guard so it can be proven again after arbitrary caller code ran.
	 */
	#currentInputTarget(source: NativeIoInputSource, inputModes: TerminalInputModes): InputGate {
		if (this.#retired || this.#stopRequested || this.#activeSubscriptionId === null) {
			return { ok: false, reason: "stopped" };
		}
		if (this.#state !== "streaming") return { ok: false, reason: "not-ready" };
		const snapshot = this.#snapshot;
		if (snapshot === undefined) return { ok: false, reason: "not-ready" };
		if (snapshot.meta.subscriptionId !== this.subscriptionId
			|| snapshot.meta.hostRunId !== this.#expectedRun
			|| snapshot.meta.sessionId !== this.#expectedSession) {
			return { ok: false, reason: "stale-source" };
		}
		const current = snapshot.meta.inputSource;
		if (current === undefined || current === null) return { ok: false, reason: "stale-source" };
		// A startup source is usable only on a channel that negotiated startup input.
		if (isNativeIoStartupSource(current) && !this.#startupInputNegotiated) {
			return { ok: false, reason: "stale-source" };
		}
		// Exact expected source against this endpoint's own current published facts:
		// token, run, row, native tuple and epoch, geometry revision, viewer revision.
		if (!nativeIoSourceEquals(source, current)) return { ok: false, reason: "stale-source" };
		if (!isInputModesEqual(inputModes, snapshot.meta.inputModes)) {
			return { ok: false, reason: "stale-modes" };
		}
		// Only this endpoint's own immutable facts are ever used for the wire, never the
		// caller's mutable objects that merely had to compare equal to them.
		return { ok: true, source: current, inputModes: snapshot.meta.inputModes };
	}

	/** The caller's dynamic proof seam; only an explicit boolean `true` allows a write. */
	#authorize(expected: NativeIoInputSource): boolean {
		const guard = this.#authorizeInput;
		if (guard === null) return false;
		try {
			return guard(expected) === true;
		} catch {
			return false;
		}
	}

	/**
	 * Pack one logical input with the actual protocol helpers. Everything is
	 * validated (kind, strict text, 1 MiB paste bound) before a single frame exists,
	 * and an inline packet is used only while the payload fits one bounded chunk.
	 */
	#buildInput(
		request: SessionContentViewerInputRequest,
		inputId: string,
		ordinal: number,
	): NativeIoBuiltTransfer | "invalid" {
		if (!isWellFormedText(request.text)) return "invalid";
		const identity = {
			subscriptionId: this.subscriptionId,
			inputId,
			ordinal,
			source: request.source,
			inputModes: request.inputModes,
			bounds: this.#bounds,
		};
		if (request.kind === "paste"
			&& Buffer.byteLength(request.text, "utf8") > this.#bounds.maxChunkPayloadBytes) {
			// Only a text paste pages; keyboard and mouse packets stay inline.
			return buildNativeInputPaste({ ...identity, text: request.text });
		}
		return buildNativeInputInline({ ...identity, kind: request.kind, data: request.text });
	}

	/**
	 * Stream one logical operation: one frame at a time, in order, each awaited on
	 * the existing ordered writer and bounded per-send deadline. Another input
	 * cannot interleave its pages because operations are serialized on their own
	 * tail; ordinary control writes may still slot between frames.
	 */
	async #runInput(
		pending: PendingInput,
		built: NativeIoBuiltTransfer,
		start: Promise<void>,
		release: () => void,
	): Promise<void> {
		/** Truthful end of an operation whose admitted source lifetime is gone. */
		const settleInvalidated = (): void => {
			pending.settle(pending.invoked
				? { status: "unknown" }
				: { status: "not-sent", reason: "stale-source" });
		};
		try {
			await start;
			for (const frame of built.frames) {
				if (pending.settled) return;
				// A publication that changed the source while this operation was pending
				// stops it for good: no remaining page is written, and an invoked operation
				// is never reported as submitted afterwards.
				if (pending.invalidated) {
					settleInvalidated();
					return;
				}
				const outcome = await this.#emitInputFrame(frame, pending);
				if (pending.settled) return;
				if (pending.invalidated) {
					settleInvalidated();
					return;
				}
				switch (outcome.outcome) {
					case "written":
						continue;
					case "blocked":
						// Re-checked at the actual write: only a frame that never reached the
						// transport may still be reported as unsent.
						pending.settle(pending.invoked
							? { status: "unknown" }
							: { status: "not-sent", reason: outcome.reason });
						return;
					default:
						// `channel.send` was invoked; a rejection, deadline, or late failure is
						// never reported as an input that was definitely not sent.
						pending.settle({ status: "unknown" });
						return;
				}
			}
			pending.settle({ status: "submitted" });
		} catch {
			pending.settle(pending.invoked
				? { status: "unknown" }
				: { status: "not-sent", reason: "invalid-input" });
		} finally {
			release();
			this.#pendingInputs.delete(pending);
		}
	}

	/**
	 * One protected input write. The gate is evaluated inside the ordered tail, at
	 * the exact moment the already-packed bytes would be handed over, so a source
	 * change, a retirement, or a caller guard that turned false in between prevents
	 * the write instead of being masked by queueing.
	 */
	#emitInputFrame(
		bytes: Buffer,
		pending: PendingInput,
	): Promise<InputFrameOutcome> {
		const write = (): Promise<InputFrameOutcome> => {
			// The actual writer owns the final word. A queued write can wait behind a held
			// control write while the admitted source lifetime is replaced (an exact
			// A -> B -> A included), so the operation's own settled/invalidated state is
			// checked before anything else and again after the caller's guard ran.
			if (pending.settled) {
				return Promise.resolve<InputFrameOutcome>({ outcome: "blocked", reason: "stopped" });
			}
			if (pending.invalidated) {
				return Promise.resolve<InputFrameOutcome>({ outcome: "blocked", reason: "stale-source" });
			}
			const gate = this.#inputGate(pending.source, pending.inputModes);
			if (pending.settled) {
				return Promise.resolve<InputFrameOutcome>({ outcome: "blocked", reason: "stopped" });
			}
			if (pending.invalidated) {
				return Promise.resolve<InputFrameOutcome>({ outcome: "blocked", reason: "stale-source" });
			}
			if (!gate.ok) return Promise.resolve<InputFrameOutcome>({ outcome: "blocked", reason: gate.reason });
			// Recorded before the call: a synchronous reply or close may re-enter the
			// endpoint from inside `send`, and the invocation is what matters.
			pending.invoked = true;
			let written: Promise<void>;
			try {
				written = Promise.resolve(this.#channel.send(bytes));
			} catch {
				return Promise.resolve<InputFrameOutcome>({ outcome: "failed" });
			}
			return this.#withinSendDeadline(written).then(
				(): InputFrameOutcome => ({ outcome: "written" }),
				(): InputFrameOutcome => ({ outcome: "failed" }),
			);
		};
		const result = this.#sendTail.then(write, write);
		this.#sendTail = result.then(() => undefined, () => undefined);
		return result;
	}

	#abortPendingInputs(): void {
		for (const pending of [...this.#pendingInputs]) pending.abort();
	}

	/* --------------------------------------------------------------------- *
	 * Native copies (owner -> viewer, optional capability)
	 * --------------------------------------------------------------------- */

	#onCopyFrame(
		frame: SessionContentCopyFrame
			| SessionContentCopyBeginFrame
			| SessionContentCopyChunkFrame
			| SessionContentCopyEndFrame,
	): void {
		if (!this.#nativeIoNegotiated) {
			// Nothing offered this frame type: an unnegotiated extension is a violation.
			this.#protocolFailure();
			return;
		}
		if (frame.subscriptionId !== this.subscriptionId) {
			this.#protocolFailure();
			return;
		}
		if (frame.type === "copy" || frame.type === "copy_begin") {
			const source = frame.source;
			if (source.hostRunId !== this.#expectedRun || source.sessionId !== this.#expectedSession) {
				// Another run or another owner row is never this viewer's copy.
				this.#protocolFailure();
				return;
			}
			// The header's exact source decides routability for this one assembly. Only one
			// copy is ever consumed at a time, so the header identity is the discard slot's
			// lifetime marker.
			this.#copyHeaderId = frame.copyId;
			this.#copyHeaderSource = source;
			this.#copyDiscardId = this.#copyRoutable(source) ? null : frame.copyId;
		}
		// The assembler enforces the exact subscription/copy tuple, contiguous chunk
		// order, declared length, canonical text, one assembly, and the per-binding
		// copy sequence. A refusal fails the current channel closed.
		const completed = this.#copyAssembler.accept(frame);
		if (completed === undefined) {
			if (frame.type === "copy_begin" || frame.type === "copy_chunk") this.#armCopyTimer();
			return;
		}
		this.#clearCopyTimer();
		this.#deliverCopy(completed);
	}

	/** Whether a copy's exact source is this endpoint's own current published source. */
	#copyRoutable(source: NativeIoSource): boolean {
		if (!this.#nativeIoNegotiated || this.#retired || this.#stopRequested) return false;
		if (this.#state !== "streaming" || this.#activeSubscriptionId !== this.subscriptionId) return false;
		const snapshot = this.#snapshot;
		if (snapshot === undefined) return false;
		if (snapshot.meta.subscriptionId !== this.subscriptionId
			|| snapshot.meta.hostRunId !== this.#expectedRun
			|| snapshot.meta.sessionId !== this.#expectedSession) {
			return false;
		}
		const current = snapshot.meta.inputSource;
		if (current === undefined || current === null) return false;
		// Exact equality, so an A -> B -> A change never routes the old A data.
		return nativeIoSourceEquals(source, current);
	}

	#deliverCopy(copy: NativeIoCompletedCopy): void {
		const withheld = this.#copyDiscardId !== null;
		this.#copyDiscardId = null;
		this.#copyHeaderId = null;
		this.#copyHeaderSource = null;
		if (withheld) {
			// The one withheld assembly just ended (the helper allows exactly one), so its
			// slot is released without ever routing its data.
			return;
		}
		// Completed data is re-checked, not just the header: a source change while
		// the pages arrived must never hand the copy to a newer view.
		if (!this.#copyRoutable(copy.source)) return;
		const onCopy = this.#onCopy;
		if (onCopy === null) return;
		try {
			onCopy(copy);
		} catch {
			// A copy callback is never load-bearing for the endpoint.
		}
	}

	/**
	 * The copy-assembly deadline is the existing finite transfer idle bound, owned
	 * and cancelled here like every other timer. It is deliberately separate from the
	 * viewport idle deadline, so copy progress can never mask a stalled viewport.
	 */
	#armCopyTimer(): void {
		this.#copyIdleTimer = this.#arm(this.#copyIdleTimer, this.#timeouts.transferIdleTimeoutMs, () => {
			this.#copyIdleTimer = null;
			if (this.#retired) return;
			// An incomplete copy fails the current channel closed; nothing is retried
			// and nothing remote is stopped.
			this.#copyAssembler.reset();
			this.#copyDiscardId = null;
			this.#copyHeaderId = null;
			this.#copyHeaderSource = null;
			void this.#retire({ readyError: "transfer-failed", diagnostic: "content_rejected" });
		});
	}

	#clearCopyTimer(): void {
		if (this.#copyIdleTimer === null) return;
		clearTimeout(this.#copyIdleTimer);
		this.#copyIdleTimer = null;
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
	// A present but malformed native IO option is refused here, before any handler,
	// frame, timer, or capability offer; the default remains display only.
	const nativeIo = resolveNativeIo(options.nativeIo);
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
	return new ContentViewerBinding(options, bounds, timeouts, subscriptionId, diagnostic, nativeIo);
}
