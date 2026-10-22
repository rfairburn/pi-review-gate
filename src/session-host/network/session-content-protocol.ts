/**
 * Bounded native viewport content wire protocol (#389 selection content phase).
 *
 * This module is a pure contract: fixed frame shapes, finite bounds, feature
 * negotiation, message encode/decode, complete-viewport transfer packing, and
 * atomic receive assembly. It performs no IO, reads no ambient configuration,
 * opens no socket or listener, starts no timer, and is not imported by the
 * extension entry point, session host, sidebar, instances, owning-host service,
 * or any peer endpoint. Importing it allocates nothing that outlives the call.
 *
 * The content lane itself is already authenticated and separated by the
 * transport (`pi-peer-content-v1` on the existing `/app` TLS listener, same
 * directional `app` grant). This module adds no authority of its own: it creates
 * no permission, grant, view-only policy, identity, or authorization decision,
 * and the required capability below is feature negotiation only. Reaching this
 * codec at all already means the caller holds the same directional grant the
 * legacy application lane requires.
 *
 * One binary WebSocket message carries exactly one complete UTF-8 JSON protocol
 * frame. `maxFrameBytes` therefore bounds ONE MESSAGE, not a whole viewport: it
 * matches the existing transport message bound and nothing here treats it as a
 * frame-content ceiling. A complete {@link TerminalFrame} — all rows, generated
 * SGR styling, structured style runs, cursor, input modes, and the existing
 * typed Kitty PNG images/placements/fallbacks — is serialized as one canonical
 * UTF-8 JSON payload and carried as `content_begin` / sequential
 * `content_chunk` / `content_end`, reusing the roster snapshot begin/page/end
 * discipline rather than introducing a generic RPC or multiplexing layer.
 *
 * Assembly is atomic and bounded. Chunks are copied into one contiguous
 * assembly buffer of exactly the declared payload size and the payload is UTF-8
 * decoded and JSON parsed only after the complete declared byte count has
 * arrived, so a chunk may split a UTF-8 sequence, the payload is never copied a
 * second time, and a hostile chunk count cannot retain one object per chunk.
 * Every transfer pins
 * its `(subscriptionId, transferId)` tuple on begin, chunk, and end; end must
 * repeat the begin sequence and exactly fill the declared bytes and chunk count.
 * A malformed, missing, reordered, duplicated, overlapping, cross-transfer,
 * oversized, or mismatched transfer is refused with a fixed code and its partial
 * state is discarded; nothing partial is ever published, trimmed, or filtered.
 * `maxTransferBytes` is a defensive assembly-memory ceiling, never permission to
 * drop ordinary native content such as PNG payloads.
 *
 * The publisher maps one already-observed owning-host snapshot into a transfer;
 * this schema can express only that session's owner row id, a bounded native
 * session id/epoch pair, geometry, input modes, and the native frame itself.
 * The viewport payload has no transcript, configuration, auth, current-file, or
 * clipboard capsule field, and no raw child PTY byte or escape payload: frame
 * line text is restricted to the native serializer's visible text plus exactly
 * the SGR forms its own generator emits (allowlisted attributes and bounded
 * palette/RGB groups), and typing is validated by the same Kitty PNG validator
 * the native surface uses rather than by a weaker duplicate.
 *
 * The optional native input / text-copy frames at the end of this module are an
 * additive, default-off extension of the same lane: this file defines and
 * validates their exact shapes, refuses any frame whose source and snapshot (or
 * event) metadata describe different native tuples or geometry revisions, and
 * packs and assembles them atomically. It offers and acknowledges no capability
 * by default, wires no endpoint, listener, or provider, and never writes input or
 * clipboard data anywhere. Until a future owner adapter re-checks its own current
 * source and grant, a decoded native IO frame is a well-formed message and
 * nothing more.
 */

import { Buffer } from "node:buffer";
import { isRecord } from "../../record-guard";
import {
	validateTerminalGraphicsPng,
	type TerminalGraphicsClip,
	type TerminalGraphicsCrop,
	type TerminalGraphicsFallback,
	type TerminalGraphicsFrame,
	type TerminalGraphicsImage,
	type TerminalGraphicsPlacement,
} from "../kitty-graphics";
import type { SessionGeometry } from "../instances";
import type { NativeClipboardEvent } from "../native-clipboard";
import type {
	TerminalCellRun,
	TerminalColorSpec,
	TerminalFrame,
	TerminalInputModes,
	TerminalLineStyles,
} from "../terminal-surface";

/** Service identity of the content channel; distinct from the roster bridge. */
export const SESSION_CONTENT_SERVICE = "pi-peer-session-content-v1";
/** Incompatible-change version. A mismatch is refused, never adapted. */
export const SESSION_CONTENT_MAJOR = 1;
/** Additive-change version. Grants no capability and enables no behavior. */
export const SESSION_CONTENT_MINOR = 0;
/**
 * Required baseline capability. This is feature negotiation only: it never
 * creates an app permission, grant, or view-only policy.
 */
export const SESSION_CONTENT_REQUIRED_CAPABILITY = "native-viewport-v1";
/**
 * Optional capability naming the native input / text-copy frames below.
 *
 * Knowing this identifier is never an offer and never an acknowledgement.
 * Negotiation requires an explicit supported set whose default is empty, so an
 * existing host or client keeps its exact legacy behavior — display only, no
 * input authority, no clipboard transport — until a real provider that owns a
 * written native source opts in.
 */
export const SESSION_CONTENT_NATIVE_IO_CAPABILITY = "native-input-copy-v1";
/**
 * Optional capabilities this lane negotiates without an explicit opt-in. There
 * are none: unlike a purely additive capability, the native IO extension can
 * carry input and clipboard data, so offering or acknowledging it on the
 * strength of a peer's hello alone would be an activation. This value stays
 * empty; {@link SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES} names what
 * an explicit opt-in may enable.
 */
export const SESSION_CONTENT_KNOWN_OPTIONAL_CAPABILITIES: readonly string[] = Object.freeze([]);
/**
 * Optional capabilities this build can implement once a provider explicitly
 * enables them. Being implementable is never an offer: negotiation still needs
 * an explicit supported set whose default is empty, and an acknowledgement may
 * never claim one this side did not offer.
 */
export const SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES: readonly string[] = Object.freeze([
	SESSION_CONTENT_NATIVE_IO_CAPABILITY,
]);

/**
 * Decoded UTF-8 bytes accepted by one atomic native text paste: exactly 1 MiB.
 * This is a text bound, not a transport bound: messages stay within
 * `maxFrameBytes` and one raw chunk stays within `maxChunkPayloadBytes`.
 */
export const NATIVE_TEXT_PASTE_MAX_BYTES = 1_048_576;
/**
 * Canonical encoded characters in one native text copy — the unchanged native
 * producer bound (the pinned runtime's OSC 52 text limit), carried whole across
 * bounded pages rather than reduced to a transport message size.
 */
export const NATIVE_COPY_MAX_ENCODED_CHARS = 100_000;
/** Bytes in one host-issued native IO source token. */
export const NATIVE_IO_MAX_SOURCE_TOKEN_BYTES = 128;

/** One content subscription per channel; not configurable. */
export const SESSION_CONTENT_MAX_SUBSCRIPTIONS_PER_CHANNEL = 1;
/** One viewport transfer in flight per channel; not configurable. */
export const SESSION_CONTENT_MAX_IN_FLIGHT_TRANSFERS = 1;

/**
 * Explicit, finite content bounds. Overrides are validated, and 0 never means
 * unlimited. There is deliberately no deadline field: hello and transfer
 * deadlines belong to the endpoint state machines and reuse the existing
 * protocol bounds rather than being invented here.
 */
export interface SessionContentBounds {
	/** Complete encoded channel message (also the transport message bound). */
	readonly maxFrameBytes: number;
	/** Decoded payload ceiling for one complete native viewport; defensive only. */
	readonly maxTransferBytes: number;
	/** Decoded payload bytes in one `content_chunk` before base64 encoding. */
	readonly maxChunkPayloadBytes: number;
	/** Bytes in one subscription, transfer, host-run, or owner row identifier. */
	readonly maxIdentifierBytes: number;
	/** Capability identifiers in one hello. */
	readonly maxCapabilities: number;
	/** Bytes in one capability identifier. */
	readonly maxCapabilityIdBytes: number;
	/** Viewport columns; matches the existing terminal surface dimension bound. */
	readonly maxCols: number;
	/** Viewport rows; matches the existing terminal surface dimension bound. */
	readonly maxRows: number;
}

export const DEFAULT_SESSION_CONTENT_BOUNDS: SessionContentBounds = Object.freeze({
	maxFrameBytes: 65_536,
	maxTransferBytes: 64 * 1024 * 1024,
	maxChunkPayloadBytes: 32 * 1024,
	maxIdentifierBytes: 64,
	maxCapabilities: 16,
	maxCapabilityIdBytes: 64,
	maxCols: 1_000,
	maxRows: 1_000,
});

const BOUND_KEYS = Object.keys(DEFAULT_SESSION_CONTENT_BOUNDS) as ReadonlyArray<keyof SessionContentBounds>;

/** Largest PNG dimension a validated native graphics image can carry (u32). */
const MAX_GRAPHICS_DIMENSION = 4_294_967_295;

/**
 * Resolve explicit overrides against the fixed defaults. Every value must be a
 * finite positive integer, a chunk must be able to fit one message once base64
 * encoded, and a chunk must fit one transfer. No override can raise the fixed
 * one-subscription / one-in-flight ceilings, and an unknown or invalid override
 * fails closed instead of being ignored.
 */
export function resolveSessionContentBounds(overrides: Partial<SessionContentBounds> = {}): SessionContentBounds {
	if (overrides !== undefined && !isRecord(overrides)) fail("invalid_bounds");
	for (const key of Object.getOwnPropertyNames(overrides)) {
		if (!(BOUND_KEYS as readonly string[]).includes(key)) fail("invalid_bounds");
	}
	const resolved: Record<keyof SessionContentBounds, number> = { ...DEFAULT_SESSION_CONTENT_BOUNDS };
	for (const key of BOUND_KEYS) {
		const value = overrides[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail("invalid_bounds");
		resolved[key] = value;
	}
	// Base64 of a full chunk must still fit one message with its envelope.
	if (resolved.maxChunkPayloadBytes >= resolved.maxFrameBytes) fail("invalid_bounds");
	if (4 * Math.ceil(resolved.maxChunkPayloadBytes / 3) >= resolved.maxFrameBytes) fail("invalid_bounds");
	if (resolved.maxTransferBytes < resolved.maxChunkPayloadBytes) fail("invalid_bounds");
	return Object.freeze(resolved);
}

/** Fixed wire failure codes. No raw frame, path, peer text, or exception detail. */
export type SessionContentErrorCode =
	| "bad_frame"
	| "frame_too_large"
	| "unsupported_version"
	| "missing_capability"
	| "not_authorized"
	| "unavailable"
	| "protocol_violation"
	| "too_many_subscriptions"
	| "transfer_failed"
	| "send_failed";

const WIRE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
	"bad_frame",
	"frame_too_large",
	"unsupported_version",
	"missing_capability",
	"not_authorized",
	"unavailable",
	"protocol_violation",
	"too_many_subscriptions",
	"transfer_failed",
	"send_failed",
]);

export function isSessionContentErrorCode(value: unknown): value is SessionContentErrorCode {
	return typeof value === "string" && WIRE_ERROR_CODES.has(value);
}

/** Fixed reasons one subscription may end; no free text is expressible. */
export type SessionContentEndCode = "closed" | "replaced" | "stopped" | "unavailable";

const END_CODES: ReadonlySet<string> = new Set<string>(["closed", "replaced", "stopped", "unavailable"]);

export function isSessionContentEndCode(value: unknown): value is SessionContentEndCode {
	return typeof value === "string" && END_CODES.has(value);
}

/** Local failure codes for decode, encode, packing, and assembly. */
export type SessionContentFailureCode =
	| "invalid_bounds"
	| "invalid_frame"
	| "frame_too_large"
	| "bad_frame"
	| "transfer_too_large"
	| "transfer_failed";

const FAILURE_MESSAGES: Record<SessionContentFailureCode, string> = {
	invalid_bounds: "session content bounds are invalid",
	invalid_frame: "session content frame is invalid",
	frame_too_large: "session content frame exceeds its message bound",
	bad_frame: "session content frame could not be decoded",
	transfer_too_large: "session content transfer exceeds a bounded limit",
	transfer_failed: "session content transfer could not be assembled",
};

/** Fixed-code failure for anything this protocol cannot represent. */
export class SessionContentProtocolError extends Error {
	readonly code: SessionContentFailureCode;

	constructor(code: SessionContentFailureCode) {
		super(FAILURE_MESSAGES[code]);
		this.name = "SessionContentProtocolError";
		this.code = code;
	}
}

export function isSessionContentProtocolError(value: unknown): value is SessionContentProtocolError {
	return value instanceof SessionContentProtocolError;
}

function fail(code: SessionContentFailureCode): never {
	throw new SessionContentProtocolError(code);
}

/** Map a local failure onto the fixed wire code sent to the peer. */
export function sessionContentWireCodeForFailure(code: SessionContentFailureCode): SessionContentErrorCode {
	if (code === "frame_too_large") return "frame_too_large";
	if (code === "transfer_too_large" || code === "transfer_failed") return "transfer_failed";
	if (code === "invalid_bounds") return "protocol_violation";
	return "bad_frame";
}

/** Exact session geometry carried by a transfer; identical to `SessionGeometry`. */
export type SessionContentGeometry = SessionGeometry;

/** The only native conversation identity a content transfer may carry. */
export interface SessionContentNativeSessionRef {
	readonly sessionId: string;
	/** Positive conversation epoch; a new conversation is a different value. */
	readonly epoch: number;
}

export interface SessionContentHelloFrame {
	readonly type: "hello";
	readonly service: string;
	readonly major: number;
	readonly minor: number;
	readonly capabilities: readonly string[];
}

export interface SessionContentHelloAckFrame {
	readonly type: "hello_ack";
	readonly service: string;
	readonly major: number;
	readonly minor: number;
	readonly capabilities: readonly string[];
}

export interface SessionContentSubscribeFrame {
	readonly type: "subscribe";
	readonly subscriptionId: string;
	/** Exact observed owner run; checked before registering a geometry viewer. */
	readonly hostRunId: string;
	/** Owner row id of the session whose native viewport is requested. */
	readonly sessionId: string;
	readonly cols: number;
	readonly rows: number;
}

export interface SessionContentSubscribedFrame {
	readonly type: "subscribed";
	readonly subscriptionId: string;
	readonly sessionId: string;
	readonly hostRunId: string;
}

export interface SessionContentResizeFrame {
	readonly type: "resize";
	readonly subscriptionId: string;
	readonly cols: number;
	readonly rows: number;
}

export interface SessionContentUnsubscribeFrame {
	readonly type: "unsubscribe";
	readonly subscriptionId: string;
}

export interface SessionContentUnsubscribedFrame {
	readonly type: "unsubscribed";
	readonly subscriptionId: string;
}

export interface SessionContentEndFrame {
	readonly type: "end";
	readonly subscriptionId: string;
	readonly code: SessionContentEndCode;
}

export interface SessionContentErrorFrame {
	readonly type: "error";
	readonly code: SessionContentErrorCode;
	/** Present only when the failure belongs to one subscription. */
	readonly subscriptionId?: string;
}

export interface SessionContentBeginFrame {
	readonly type: "content_begin";
	readonly subscriptionId: string;
	readonly transferId: string;
	readonly hostRunId: string;
	/** Owner row id; the same value the subscription named. */
	readonly sessionId: string;
	readonly nativeSession: SessionContentNativeSessionRef | null;
	/** Positive, never wrapping, per-subscription publish sequence. */
	readonly sequence: number;
	readonly geometry: SessionContentGeometry;
	readonly inputModes: TerminalInputModes;
	/**
	 * Host-written native IO source. Present only when the optional native IO
	 * capability was negotiated explicitly; null means the owner cannot state
	 * one. Absent for every legacy publish, so an old view keeps its exact key
	 * set and shape validation stays separate from any runtime capability gate.
	 */
	readonly inputSource?: NativeIoSource | null;
	/** Exact decoded payload bytes of the canonical viewport JSON below. */
	readonly byteLength: number;
	readonly chunkCount: number;
}

export interface SessionContentChunkFrame {
	readonly type: "content_chunk";
	readonly subscriptionId: string;
	readonly transferId: string;
	readonly index: number;
	/** Canonical base64 of one sequential payload slice. */
	readonly data: string;
}

export interface SessionContentEndTransferFrame {
	readonly type: "content_end";
	readonly subscriptionId: string;
	readonly transferId: string;
	/** Repeats the begin sequence so an end cannot belong to another publish. */
	readonly sequence: number;
}

/* ------------------------------------------------------------------------- *
 * Native IO frame types (optional capability)
 * ------------------------------------------------------------------------- */

/**
 * Exact host-written native IO source for one input or copy frame.
 *
 * `sourceToken` is an opaque commitment the owning host writes and later
 * re-checks against its own live binding; nothing in this module derives it or
 * treats it — nor the tuple, geometry, or modes — as authority for a write.
 * There is deliberately no bootstrap secret, agent path, current file,
 * configuration, permission, or lease field.
 */
export interface NativeIoSource {
	readonly hostRunId: string;
	/** Owner row id of the session, never a native conversation id. */
	readonly sessionId: string;
	readonly nativeSession: SessionContentNativeSessionRef;
	readonly geometry: SessionContentGeometry;
	/** Positive viewer revision: equal dimensions alone never identify a viewport. */
	readonly viewerRevision: number;
	readonly sourceToken: string;
}

/** Native input payload kinds. Image and file payloads are not expressible. */
export type NativeIoInputKind = "keyboard" | "paste" | "mouse";

/** One inline native input packet; only payloads that fit one message use it. */
export interface SessionContentInputFrame {
	readonly type: "input";
	readonly subscriptionId: string;
	readonly inputId: string;
	/** Positive per-binding dispatch ordinal; never a u32-limited counter. */
	readonly ordinal: number;
	readonly source: NativeIoSource;
	readonly inputModes: TerminalInputModes;
	readonly kind: NativeIoInputKind;
	/** Canonical base64 of the UTF-8 payload bytes. */
	readonly data: string;
}

/** Begin of one atomic paged native text paste. */
export interface SessionContentInputBeginFrame {
	readonly type: "input_begin";
	readonly subscriptionId: string;
	readonly inputId: string;
	readonly ordinal: number;
	readonly source: NativeIoSource;
	readonly inputModes: TerminalInputModes;
	/** Only text pastes page; keyboard and mouse packets stay inline. */
	readonly kind: "paste";
	readonly byteLength: number;
	readonly chunkCount: number;
}

export interface SessionContentInputChunkFrame {
	readonly type: "input_chunk";
	readonly subscriptionId: string;
	readonly inputId: string;
	readonly index: number;
	/** Canonical base64 of one sequential payload slice. */
	readonly data: string;
}

export interface SessionContentInputEndFrame {
	readonly type: "input_end";
	readonly subscriptionId: string;
	readonly inputId: string;
	readonly ordinal: number;
}

/**
 * Fixed reasons a native copy can be unavailable; mirrors the producer's closed
 * set in `./native-clipboard` without importing its runtime module.
 */
export type NativeIoCopyUnavailableReason = Extract<NativeClipboardEvent, { kind: "unavailable" }>["reason"];

/**
 * Copy payload carried by the wire: canonical base64 text, or a fixed reason,
 * always together with the authenticated native tuple of the copy that caused
 * it. Never a raw OSC 52 sequence and never image data.
 *
 * The tuple is the producer's own `sessionId`/`sessionEpoch`; it must agree with
 * the frame's `source.nativeSession`, so a payload can never be attributed to a
 * different native conversation than the one it was emitted for.
 */
export type NativeIoCopyEvent =
	| {
		readonly kind: "copy";
		readonly encoded: string;
		readonly sessionId: string;
		readonly sessionEpoch: number;
	}
	| {
		readonly kind: "unavailable";
		readonly reason: NativeIoCopyUnavailableReason;
		readonly sessionId: string;
		readonly sessionEpoch: number;
	};

/** One inline native text copy that fits a single message. */
export interface SessionContentCopyFrame {
	readonly type: "copy";
	readonly subscriptionId: string;
	readonly copyId: string;
	/** Positive emission order per binding; independent of `dispatchId`. */
	readonly sequence: number;
	readonly source: NativeIoSource;
	/**
	 * Native input dispatch that caused this copy. Informational only: it may
	 * arrive out of order (an asynchronous copy from input A can follow B), so it
	 * never orders, fences, or drops a copy.
	 */
	readonly dispatchId: number;
	/**
	 * Producer event for this copy. Its `sessionId`/`sessionEpoch` must equal
	 * `source.nativeSession`; a frame that names two different conversations is
	 * refused rather than merged.
	 */
	readonly event: NativeIoCopyEvent;
}

/** Begin of one atomic paged native text copy; never carries the payload. */
export interface SessionContentCopyBeginFrame {
	readonly type: "copy_begin";
	readonly subscriptionId: string;
	readonly copyId: string;
	readonly sequence: number;
	readonly source: NativeIoSource;
	readonly dispatchId: number;
	readonly byteLength: number;
	readonly chunkCount: number;
}

export interface SessionContentCopyChunkFrame {
	readonly type: "copy_chunk";
	readonly subscriptionId: string;
	readonly copyId: string;
	readonly index: number;
	/** Canonical base64 of one sequential slice of the ASCII encoded payload. */
	readonly data: string;
}

export interface SessionContentCopyEndFrame {
	readonly type: "copy_end";
	readonly subscriptionId: string;
	readonly copyId: string;
	/** Repeats the begin sequence so an end cannot belong to another emission. */
	readonly sequence: number;
}

export type SessionContentControlFrame =
	| SessionContentHelloFrame
	| SessionContentHelloAckFrame
	| SessionContentSubscribeFrame
	| SessionContentSubscribedFrame
	| SessionContentResizeFrame
	| SessionContentUnsubscribeFrame
	| SessionContentUnsubscribedFrame
	| SessionContentEndFrame
	| SessionContentErrorFrame;

export type SessionContentTransferFrame =
	| SessionContentBeginFrame
	| SessionContentChunkFrame
	| SessionContentEndTransferFrame;

/**
 * Optional native IO frames. No endpoint, listener, or provider consumes them
 * yet: the reader recognizes them so a negotiated capability can use them
 * later, and every current owner/viewer binding still refuses them as unknown.
 */
export type SessionContentNativeIoFrame =
	| SessionContentInputFrame
	| SessionContentInputBeginFrame
	| SessionContentInputChunkFrame
	| SessionContentInputEndFrame
	| SessionContentCopyFrame
	| SessionContentCopyBeginFrame
	| SessionContentCopyChunkFrame
	| SessionContentCopyEndFrame;

export type SessionContentFrame =
	| SessionContentControlFrame
	| SessionContentTransferFrame
	| SessionContentNativeIoFrame;

const FRAME_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
	hello: new Set(["type", "service", "major", "minor", "capabilities"]),
	hello_ack: new Set(["type", "service", "major", "minor", "capabilities"]),
	subscribe: new Set(["type", "subscriptionId", "hostRunId", "sessionId", "cols", "rows"]),
	subscribed: new Set(["type", "subscriptionId", "sessionId", "hostRunId"]),
	resize: new Set(["type", "subscriptionId", "cols", "rows"]),
	unsubscribe: new Set(["type", "subscriptionId"]),
	unsubscribed: new Set(["type", "subscriptionId"]),
	end: new Set(["type", "subscriptionId", "code"]),
	error: new Set(["type", "code", "subscriptionId"]),
	content_begin: new Set([
		"type",
		"subscriptionId",
		"transferId",
		"hostRunId",
		"sessionId",
		"nativeSession",
		"sequence",
		"geometry",
		"inputModes",
		"byteLength",
		"chunkCount",
		"inputSource",
	]),
	content_chunk: new Set(["type", "subscriptionId", "transferId", "index", "data"]),
	content_end: new Set(["type", "subscriptionId", "transferId", "sequence"]),
	input: new Set([
		"type",
		"subscriptionId",
		"inputId",
		"ordinal",
		"source",
		"inputModes",
		"kind",
		"data",
	]),
	input_begin: new Set([
		"type",
		"subscriptionId",
		"inputId",
		"ordinal",
		"source",
		"inputModes",
		"kind",
		"byteLength",
		"chunkCount",
	]),
	input_chunk: new Set(["type", "subscriptionId", "inputId", "index", "data"]),
	input_end: new Set(["type", "subscriptionId", "inputId", "ordinal"]),
	copy: new Set([
		"type",
		"subscriptionId",
		"copyId",
		"sequence",
		"source",
		"dispatchId",
		"event",
	]),
	copy_begin: new Set([
		"type",
		"subscriptionId",
		"copyId",
		"sequence",
		"source",
		"dispatchId",
		"byteLength",
		"chunkCount",
	]),
	copy_chunk: new Set(["type", "subscriptionId", "copyId", "index", "data"]),
	copy_end: new Set(["type", "subscriptionId", "copyId", "sequence"]),
});

const REQUIRED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
	hello: new Set(["service", "major", "minor", "capabilities"]),
	hello_ack: new Set(["service", "major", "minor", "capabilities"]),
	subscribe: new Set(["subscriptionId", "hostRunId", "sessionId", "cols", "rows"]),
	subscribed: new Set(["subscriptionId", "sessionId", "hostRunId"]),
	resize: new Set(["subscriptionId", "cols", "rows"]),
	unsubscribe: new Set(["subscriptionId"]),
	unsubscribed: new Set(["subscriptionId"]),
	end: new Set(["subscriptionId", "code"]),
	error: new Set(["code"]),
	content_begin: new Set([
		"subscriptionId",
		"transferId",
		"hostRunId",
		"sessionId",
		"nativeSession",
		"sequence",
		"geometry",
		"inputModes",
		"byteLength",
		"chunkCount",
	]),
	content_chunk: new Set(["subscriptionId", "transferId", "index", "data"]),
	content_end: new Set(["subscriptionId", "transferId", "sequence"]),
	input: new Set([
		"subscriptionId",
		"inputId",
		"ordinal",
		"source",
		"inputModes",
		"kind",
		"data",
	]),
	input_begin: new Set([
		"subscriptionId",
		"inputId",
		"ordinal",
		"source",
		"inputModes",
		"kind",
		"byteLength",
		"chunkCount",
	]),
	input_chunk: new Set(["subscriptionId", "inputId", "index", "data"]),
	input_end: new Set(["subscriptionId", "inputId", "ordinal"]),
	copy: new Set(["subscriptionId", "copyId", "sequence", "source", "dispatchId", "event"]),
	copy_begin: new Set([
		"subscriptionId",
		"copyId",
		"sequence",
		"source",
		"dispatchId",
		"byteLength",
		"chunkCount",
	]),
	copy_chunk: new Set(["subscriptionId", "copyId", "index", "data"]),
	copy_end: new Set(["subscriptionId", "copyId", "sequence"]),
});

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** Only text and exactly the SGR forms the native serializer generates. */
const VISIBLE_TEXT_RE = /^[^\u0000-\u001f\u007f-\u009f]+$/;
/** The only attribute parameters `generateSgr` emits, in its exact order. */
const SGR_ATTRIBUTE_ORDER: readonly string[] = Object.freeze(["1", "2", "3", "4", "5", "7", "8", "9", "53"]);
/** One SGR parameter: plain decimal, no sign, no leading zero, at most 3 digits. */
const SGR_PARAM_RE = /^(?:0|[1-9][0-9]{0,2})$/;
const SGR_FG_SIMPLE_RANGES: ReadonlyArray<readonly [number, number]> = Object.freeze([
	Object.freeze([30, 37] as const),
	Object.freeze([90, 97] as const),
]);
const SGR_BG_SIMPLE_RANGES: ReadonlyArray<readonly [number, number]> = Object.freeze([
	Object.freeze([40, 47] as const),
	Object.freeze([100, 107] as const),
]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownField(record: Record<string, unknown>, key: string): unknown {
	return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Own-property-only lookup into a fixed frame table. Inherited names such as
 * `toString`, `constructor`, or `__proto__` are not frame types and must not
 * resolve to prototype members.
 */
function frameTableEntry(
	table: Readonly<Record<string, ReadonlySet<string>>>,
	type: unknown,
): ReadonlySet<string> | undefined {
	if (typeof type !== "string") return undefined;
	if (!Object.prototype.hasOwnProperty.call(table, type)) return undefined;
	return table[type];
}

/**
 * Refuse any own key outside `allowed` (unknown keys, private owner fields, and
 * non-enumerable decoys included) and require every key in `required`.
 */
function readExactKeys(
	record: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	required: ReadonlySet<string>,
	code: SessionContentFailureCode,
): void {
	for (const key of Object.getOwnPropertyNames(record)) {
		if (!allowed.has(key)) fail(code);
	}
	for (const key of required) {
		if (!Object.prototype.hasOwnProperty.call(record, key)) fail(code);
	}
}

function readIdentifier(value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0) fail("bad_frame");
	if (Buffer.byteLength(value, "utf8") > maxBytes) fail("bad_frame");
	if (!IDENTIFIER_RE.test(value)) fail("bad_frame");
	return value;
}

function readOpaqueId(value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0) fail("bad_frame");
	if (Buffer.byteLength(value, "utf8") > maxBytes) fail("bad_frame");
	if (UNSAFE_TEXT_RE.test(value)) fail("bad_frame");
	return value;
}

function readService(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) fail("bad_frame");
	if (Buffer.byteLength(value, "utf8") > 128) fail("bad_frame");
	if (UNSAFE_TEXT_RE.test(value)) fail("bad_frame");
	return value;
}

function readInteger(value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("bad_frame");
	if (value < min || value > max) fail("bad_frame");
	return value;
}

function readBoolean(value: unknown): boolean {
	if (typeof value !== "boolean") fail("bad_frame");
	return value;
}

function readCapabilities(value: unknown, bounds: SessionContentBounds): readonly string[] {
	if (!Array.isArray(value)) fail("bad_frame");
	if (value.length > bounds.maxCapabilities) fail("bad_frame");
	const seen = new Set<string>();
	const capabilities: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") fail("bad_frame");
		if (Buffer.byteLength(entry, "utf8") > bounds.maxCapabilityIdBytes) fail("bad_frame");
		if (!IDENTIFIER_RE.test(entry)) fail("bad_frame");
		if (seen.has(entry)) fail("bad_frame");
		seen.add(entry);
		capabilities.push(entry);
	}
	return Object.freeze(capabilities);
}

const GEOMETRY_KEYS: ReadonlySet<string> = new Set(["cols", "rows", "revision"]);
const NATIVE_SESSION_KEYS: ReadonlySet<string> = new Set(["sessionId", "epoch"]);

function readGeometry(value: unknown, bounds: SessionContentBounds): SessionContentGeometry {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, GEOMETRY_KEYS, GEOMETRY_KEYS, "bad_frame");
	return Object.freeze({
		cols: readInteger(ownField(value, "cols"), 1, bounds.maxCols),
		rows: readInteger(ownField(value, "rows"), 1, bounds.maxRows),
		// The owning manager's geometry revision starts at zero.
		revision: readInteger(ownField(value, "revision"), 0, Number.MAX_SAFE_INTEGER),
	});
}

const INPUT_MODE_KEYS: ReadonlySet<string> = new Set([
	"kittyFlags",
	"applicationCursorKeys",
	"applicationKeypad",
	"bracketedPaste",
	"mouseTracking",
	"modifyOtherKeys",
	"mouseEncoding",
]);
const MOUSE_TRACKING = new Set(["none", "x10", "vt200", "drag", "any"]);
const MOUSE_ENCODING = new Set(["default", "sgr", "sgr-pixels"]);

function readInputModes(value: unknown): TerminalInputModes {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, INPUT_MODE_KEYS, INPUT_MODE_KEYS, "bad_frame");
	const mouseTracking = ownField(value, "mouseTracking");
	if (typeof mouseTracking !== "string" || !MOUSE_TRACKING.has(mouseTracking)) fail("bad_frame");
	const mouseEncoding = ownField(value, "mouseEncoding");
	if (typeof mouseEncoding !== "string" || !MOUSE_ENCODING.has(mouseEncoding)) fail("bad_frame");
	return Object.freeze({
		kittyFlags: readInteger(ownField(value, "kittyFlags"), 0, 7),
		applicationCursorKeys: readBoolean(ownField(value, "applicationCursorKeys")),
		applicationKeypad: readBoolean(ownField(value, "applicationKeypad")),
		bracketedPaste: readBoolean(ownField(value, "bracketedPaste")),
		mouseTracking: mouseTracking as TerminalInputModes["mouseTracking"],
		modifyOtherKeys: readInteger(ownField(value, "modifyOtherKeys"), 0, 2) as TerminalInputModes["modifyOtherKeys"],
		mouseEncoding: mouseEncoding as TerminalInputModes["mouseEncoding"],
	});
}

function readNativeSession(value: unknown, bounds: SessionContentBounds): SessionContentNativeSessionRef | null {
	if (value === null) return null;
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, NATIVE_SESSION_KEYS, NATIVE_SESSION_KEYS, "bad_frame");
	return Object.freeze({
		sessionId: readOpaqueId(ownField(value, "sessionId"), bounds.maxIdentifierBytes),
		epoch: readInteger(ownField(value, "epoch"), 1, Number.MAX_SAFE_INTEGER),
	});
}

/** Decode one canonical base64 chunk payload, bounded before allocation. */
function readChunkPayload(value: unknown, bounds: SessionContentBounds): Buffer {
	if (typeof value !== "string" || value.length === 0) fail("bad_frame");
	if (!BASE64_RE.test(value)) fail("bad_frame");
	// Base64 length alone already proves an oversized decoded payload, so the
	// budget is enforced before any decoded buffer is allocated.
	if ((value.length / 4) * 3 - 2 > bounds.maxChunkPayloadBytes) fail("frame_too_large");
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) fail("bad_frame");
	if (bytes.length === 0) fail("bad_frame");
	if (bytes.length > bounds.maxChunkPayloadBytes) fail("frame_too_large");
	return bytes;
}

/* ------------------------------------------------------------------------- *
 * Optional native IO readers
 *
 * Every shape here is closed and bounded. These readers only establish what a
 * frame may express: they never decide that a capability was negotiated, that a
 * source is current, or that a write is allowed. Each helper returns owned,
 * deeply frozen copies so no caller object can be aliased into a published
 * frame.
 * ------------------------------------------------------------------------- */

const NATIVE_IO_SOURCE_KEYS: ReadonlySet<string> = new Set([
	"hostRunId",
	"sessionId",
	"nativeSession",
	"geometry",
	"viewerRevision",
	"sourceToken",
]);
/** Host-issued opaque commitment: bounded printable ASCII, never interpreted. */
const NATIVE_IO_SOURCE_TOKEN_RE = /^[\x21-\x7e]+$/;
/**
 * One canonical viewer SGR mouse packet in CONTENT coordinates. Host-screen
 * coordinates, legacy X10 packets, and pixel encodings are not expressible.
 */
const NATIVE_IO_MOUSE_RE = /^\x1b\[<(?:0|[1-9][0-9]{0,2});(?:[1-9][0-9]{0,3});(?:[1-9][0-9]{0,3})[Mm]$/;
const NATIVE_IO_COPY_EVENT_KEYS: ReadonlySet<string> = new Set(["kind", "encoded", "sessionId", "sessionEpoch"]);
const NATIVE_IO_COPY_UNAVAILABLE_KEYS: ReadonlySet<string> = new Set([
	"kind",
	"reason",
	"sessionId",
	"sessionEpoch",
]);
/** Fixed unavailable reasons; the union type keeps this set tied to the producer. */
const NATIVE_IO_COPY_UNAVAILABLE_REASONS: ReadonlySet<NativeIoCopyUnavailableReason> =
	new Set<NativeIoCopyUnavailableReason>(["unverified-native-origin", "unsupported-runtime"]);
/**
 * Native IO text decoder. Unlike the viewport decoder it keeps a leading BOM:
 * U+FEFF is ordinary user text in an input or clipboard payload, so stripping it
 * would change what the peer typed or copied, and would also hide a BOM-prefixed
 * non-base64 copy payload from the canonical-encoding check. The viewport decoder
 * is deliberately left unchanged.
 */
const nativeIoUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Strict UTF-8 with exact text preservation. Invalid, overlong, or lone-surrogate
 * encodings are refused: a payload is text or it is not transportable at all,
 * never silently repaired, and never silently rewritten.
 */
function decodeNativeIoText(bytes: Uint8Array): string {
	try {
		return nativeIoUtf8.decode(bytes);
	} catch {
		fail("bad_frame");
	}
}

function readNativeIoSourceToken(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) fail("bad_frame");
	if (value.length > NATIVE_IO_MAX_SOURCE_TOKEN_BYTES) fail("bad_frame");
	if (!NATIVE_IO_SOURCE_TOKEN_RE.test(value)) fail("bad_frame");
	return value;
}

function isNativeIoInputKind(value: unknown): value is NativeIoInputKind {
	return value === "keyboard" || value === "paste" || value === "mouse";
}

/** Validate one exact native IO source; the native tuple is always non-null. */
function readNativeIoSource(value: unknown, bounds: SessionContentBounds): NativeIoSource {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, NATIVE_IO_SOURCE_KEYS, NATIVE_IO_SOURCE_KEYS, "bad_frame");
	const nativeSession = readNativeSession(ownField(value, "nativeSession"), bounds);
	if (nativeSession === null) fail("bad_frame");
	return Object.freeze({
		hostRunId: readIdentifier(ownField(value, "hostRunId"), bounds.maxIdentifierBytes),
		sessionId: readIdentifier(ownField(value, "sessionId"), bounds.maxIdentifierBytes),
		nativeSession,
		geometry: readGeometry(ownField(value, "geometry"), bounds),
		// A viewer revision is a positive count, never the zero a geometry starts at.
		viewerRevision: readInteger(ownField(value, "viewerRevision"), 1, Number.MAX_SAFE_INTEGER),
		sourceToken: readNativeIoSourceToken(ownField(value, "sourceToken")),
	});
}

/**
 * Exact structural equality of two sources. Equal dimensions are never enough:
 * the epoch, the geometry revision, the viewer revision, and the host token must
 * all agree, so an A→B→A viewport change is never treated as the original A.
 * This is a comparison only; it grants and implies no authority.
 */
export function nativeIoSourceEquals(left: NativeIoSource, right: NativeIoSource): boolean {
	return left.hostRunId === right.hostRunId
		&& left.sessionId === right.sessionId
		&& left.nativeSession.sessionId === right.nativeSession.sessionId
		&& left.nativeSession.epoch === right.nativeSession.epoch
		&& left.geometry.cols === right.geometry.cols
		&& left.geometry.rows === right.geometry.rows
		&& left.geometry.revision === right.geometry.revision
		&& left.viewerRevision === right.viewerRevision
		&& left.sourceToken === right.sourceToken;
}

/** One bounded native input payload slice, decoded by kind. */
function readNativeInputData(value: unknown, kind: NativeIoInputKind, bounds: SessionContentBounds): Buffer {
	const bytes = readChunkPayload(value, bounds);
	if (kind === "paste" && bytes.length > NATIVE_TEXT_PASTE_MAX_BYTES) fail("transfer_too_large");
	const text = decodeNativeIoText(bytes);
	if (kind === "mouse" && !NATIVE_IO_MOUSE_RE.test(text)) fail("bad_frame");
	return bytes;
}

/** Declared decoded byte length of one paged native text paste. */
function readNativePasteByteLength(value: unknown, bounds: SessionContentBounds): number {
	return readInteger(value, 1, Math.min(NATIVE_TEXT_PASTE_MAX_BYTES, bounds.maxTransferBytes));
}

/**
 * One whole native text-copy payload: canonical base64 of UTF-8 text, bounded by
 * the unchanged producer limit. Binary/image clipboard data is refused here.
 */
function readNativeCopyEncoded(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) fail("bad_frame");
	if (value.length > NATIVE_COPY_MAX_ENCODED_CHARS) fail("transfer_too_large");
	if (!BASE64_RE.test(value)) fail("bad_frame");
	const bytes = Buffer.from(value, "base64");
	if (bytes.length === 0 || bytes.toString("base64") !== value) fail("bad_frame");
	decodeNativeIoText(bytes);
	return value;
}

function readNativeCopyEvent(value: unknown, bounds: SessionContentBounds): NativeIoCopyEvent {
	if (!isPlainRecord(value)) fail("bad_frame");
	const kind = ownField(value, "kind");
	if (kind !== "copy" && kind !== "unavailable") fail("bad_frame");
	// Closed keys first: nothing outside the producer's event shape rides along.
	readExactKeys(
		value,
		kind === "copy" ? NATIVE_IO_COPY_EVENT_KEYS : NATIVE_IO_COPY_UNAVAILABLE_KEYS,
		kind === "copy" ? NATIVE_IO_COPY_EVENT_KEYS : NATIVE_IO_COPY_UNAVAILABLE_KEYS,
		"bad_frame",
	);
	const tuple = {
		// The same bound the native tuple uses on the wire, so the two are
		// comparable; native id policy itself belongs to the producer.
		sessionId: readOpaqueId(ownField(value, "sessionId"), bounds.maxIdentifierBytes),
		sessionEpoch: readInteger(ownField(value, "sessionEpoch"), 1, Number.MAX_SAFE_INTEGER),
	};
	if (kind === "copy") {
		return Object.freeze({ kind, encoded: readNativeCopyEncoded(ownField(value, "encoded")), ...tuple });
	}
	const reason = ownField(value, "reason");
	if (typeof reason !== "string") fail("bad_frame");
	if (!(NATIVE_IO_COPY_UNAVAILABLE_REASONS as ReadonlySet<string>).has(reason)) fail("bad_frame");
	return Object.freeze({ kind, reason: reason as NativeIoCopyUnavailableReason, ...tuple });
}

/**
 * A `content_begin` may describe a native IO source only for ITS OWN native
 * snapshot: the source must name the same owner run, the same owner row, the
 * same native tuple, and exactly the same geometry including its revision as the
 * frame that carries it, and a frame that reports no native session cannot be
 * handed a live tuple by its source. Two independently well-formed objects that
 * describe different snapshots are refused, never merged into one publish.
 *
 * This is a coherence check and nothing else: it creates no permission, gate, or
 * lease, and the source token remains non-authoritative.
 */
function checkInputSourceCoherence(inputSource: NativeIoSource, frame: {
	readonly hostRunId: string;
	readonly sessionId: string;
	readonly nativeSession: SessionContentNativeSessionRef | null;
	readonly geometry: SessionContentGeometry;
}): void {
	const nativeSession = frame.nativeSession;
	// No native session in the frame means there is no tuple a source may claim.
	if (nativeSession === null) fail("bad_frame");
	if (inputSource.hostRunId !== frame.hostRunId) fail("bad_frame");
	if (inputSource.sessionId !== frame.sessionId) fail("bad_frame");
	if (inputSource.nativeSession.sessionId !== nativeSession.sessionId) fail("bad_frame");
	if (inputSource.nativeSession.epoch !== nativeSession.epoch) fail("bad_frame");
	// Equal dimensions are not enough: the geometry revision is part of identity.
	if (inputSource.geometry.cols !== frame.geometry.cols
		|| inputSource.geometry.rows !== frame.geometry.rows
		|| inputSource.geometry.revision !== frame.geometry.revision) {
		fail("bad_frame");
	}
}

/**
 * A copy names one authenticated native conversation twice: in the frame source
 * and in the producer's event. The two must agree, so an inline payload can
 * never be attributed to a different tuple, and an assembled copy keeps the
 * header source and the event tuple consistent.
 *
 * Coherence only; no permission, gate, or lease is created here.
 */
function checkCopyTupleCoherence(source: NativeIoSource, event: NativeIoCopyEvent): void {
	if (event.sessionId !== source.nativeSession.sessionId) fail("bad_frame");
	if (event.sessionEpoch !== source.nativeSession.epoch) fail("bad_frame");
}

function validateFrame(frame: SessionContentFrame, bounds: SessionContentBounds): SessionContentFrame {
	switch (frame.type) {
		case "hello":
		case "hello_ack": {
			readService(frame.service);
			if (!Number.isSafeInteger(frame.major) || frame.major < 0 || frame.major > 4_294_967_295) fail("invalid_frame");
			if (!Number.isSafeInteger(frame.minor) || frame.minor < 0 || frame.minor > 4_294_967_295) fail("invalid_frame");
			readCapabilities(frame.capabilities, bounds);
			return frame;
		}
		case "subscribe": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.hostRunId, bounds.maxIdentifierBytes);
			readIdentifier(frame.sessionId, bounds.maxIdentifierBytes);
			readInteger(frame.cols, 1, bounds.maxCols);
			readInteger(frame.rows, 1, bounds.maxRows);
			return frame;
		}
		case "subscribed": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.sessionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.hostRunId, bounds.maxIdentifierBytes);
			return frame;
		}
		case "resize": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readInteger(frame.cols, 1, bounds.maxCols);
			readInteger(frame.rows, 1, bounds.maxRows);
			return frame;
		}
		case "unsubscribe":
		case "unsubscribed": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			return frame;
		}
		case "end": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			if (!isSessionContentEndCode(frame.code)) fail("invalid_frame");
			return frame;
		}
		case "error": {
			if (!isSessionContentErrorCode(frame.code)) fail("invalid_frame");
			if (frame.subscriptionId !== undefined) readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			return frame;
		}
		case "content_begin": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.transferId, bounds.maxIdentifierBytes);
			const hostRunId = readIdentifier(frame.hostRunId, bounds.maxIdentifierBytes);
			const sessionId = readIdentifier(frame.sessionId, bounds.maxIdentifierBytes);
			const nativeSession = readNativeSession(frame.nativeSession, bounds);
			readInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER);
			const geometry = readGeometry(frame.geometry, bounds);
			readInputModes(frame.inputModes);
			const byteLength = readInteger(frame.byteLength, 1, bounds.maxTransferBytes);
			const chunkCount = readInteger(frame.chunkCount, 1, byteLength);
			const minimumChunks = Math.ceil(byteLength / bounds.maxChunkPayloadBytes);
			if (chunkCount < minimumChunks) fail("invalid_frame");
			// `inputSource` may exist only when the optional native IO capability was
			// negotiated. Shape validation never asks whether it was: that gate belongs
			// to a future endpoint, which this module does not wire or authorize. It
			// must, however, describe THIS frame's own native snapshot.
			if (Object.prototype.hasOwnProperty.call(frame, "inputSource")) {
				if (frame.inputSource === undefined) fail("invalid_frame");
				if (frame.inputSource !== null) {
					checkInputSourceCoherence(
						readNativeIoSource(frame.inputSource, bounds),
						{ hostRunId, sessionId, nativeSession, geometry },
					);
				}
			}
			return frame;
		}
		case "content_chunk": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.transferId, bounds.maxIdentifierBytes);
			readInteger(frame.index, 0, Number.MAX_SAFE_INTEGER);
			readChunkPayload(frame.data, bounds);
			return frame;
		}
		case "content_end": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.transferId, bounds.maxIdentifierBytes);
			readInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER);
			return frame;
		}
		case "input": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.inputId, bounds.maxIdentifierBytes);
			readInteger(frame.ordinal, 1, Number.MAX_SAFE_INTEGER);
			readNativeIoSource(frame.source, bounds);
			readInputModes(frame.inputModes);
			if (!isNativeIoInputKind(frame.kind)) fail("invalid_frame");
			readNativeInputData(frame.data, frame.kind, bounds);
			return frame;
		}
		case "input_begin": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.inputId, bounds.maxIdentifierBytes);
			readInteger(frame.ordinal, 1, Number.MAX_SAFE_INTEGER);
			readNativeIoSource(frame.source, bounds);
			readInputModes(frame.inputModes);
			if (frame.kind !== "paste") fail("invalid_frame");
			const byteLength = readNativePasteByteLength(frame.byteLength, bounds);
			const chunkCount = readInteger(frame.chunkCount, 1, byteLength);
			if (chunkCount < Math.ceil(byteLength / bounds.maxChunkPayloadBytes)) fail("invalid_frame");
			return frame;
		}
		case "input_chunk": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.inputId, bounds.maxIdentifierBytes);
			readInteger(frame.index, 0, Number.MAX_SAFE_INTEGER);
			readChunkPayload(frame.data, bounds);
			return frame;
		}
		case "input_end": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.inputId, bounds.maxIdentifierBytes);
			readInteger(frame.ordinal, 1, Number.MAX_SAFE_INTEGER);
			return frame;
		}
		case "copy": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.copyId, bounds.maxIdentifierBytes);
			readInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER);
			const source = readNativeIoSource(frame.source, bounds);
			readInteger(frame.dispatchId, 1, Number.MAX_SAFE_INTEGER);
			// The producer's event tuple must be the source's native tuple.
			checkCopyTupleCoherence(source, readNativeCopyEvent(frame.event, bounds));
			return frame;
		}
		case "copy_begin": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.copyId, bounds.maxIdentifierBytes);
			readInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER);
			readNativeIoSource(frame.source, bounds);
			readInteger(frame.dispatchId, 1, Number.MAX_SAFE_INTEGER);
			const byteLength = readInteger(frame.byteLength, 1, NATIVE_COPY_MAX_ENCODED_CHARS);
			const chunkCount = readInteger(frame.chunkCount, 1, byteLength);
			if (chunkCount < Math.ceil(byteLength / bounds.maxChunkPayloadBytes)) fail("invalid_frame");
			return frame;
		}
		case "copy_chunk": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.copyId, bounds.maxIdentifierBytes);
			readInteger(frame.index, 0, Number.MAX_SAFE_INTEGER);
			readChunkPayload(frame.data, bounds);
			return frame;
		}
		case "copy_end": {
			readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
			readIdentifier(frame.copyId, bounds.maxIdentifierBytes);
			readInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER);
			return frame;
		}
		default:
			fail("invalid_frame");
	}
}

/**
 * Encode one frame as the complete payload of one binary channel message. The
 * frame is validated first and the encoded bytes must fit the per-message
 * bound; an oversized message is an error, never a truncated or split message.
 */
export function encodeSessionContentFrame(
	frame: SessionContentFrame,
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): Buffer {
	if (!isPlainRecord(frame)) fail("invalid_frame");
	const allowed = frameTableEntry(FRAME_KEYS, frame.type);
	if (allowed === undefined) fail("invalid_frame");
	const required = frameTableEntry(REQUIRED_KEYS, frame.type);
	if (required === undefined) fail("invalid_frame");
	readExactKeys(frame, allowed, required, "invalid_frame");
	try {
		validateFrame(frame, bounds);
	} catch (error) {
		// A frame this side built wrongly is a programming failure, not a peer one.
		if (isSessionContentProtocolError(error) && error.code === "bad_frame") fail("invalid_frame");
		throw error;
	}
	let text: string;
	try {
		text = JSON.stringify(frame);
	} catch {
		fail("invalid_frame");
	}
	if (typeof text !== "string") fail("invalid_frame");
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length > bounds.maxFrameBytes) fail("frame_too_large");
	return bytes;
}

function buildFrame(record: Record<string, unknown>, bounds: SessionContentBounds): SessionContentFrame {
	const type = record.type;
	if (typeof type !== "string") fail("bad_frame");
	const allowed = frameTableEntry(FRAME_KEYS, type);
	if (allowed === undefined) fail("bad_frame");
	const required = frameTableEntry(REQUIRED_KEYS, type);
	if (required === undefined) fail("bad_frame");
	// Unknown keys (including any private owner field) are refused, so nothing
	// outside this schema can ride along on a content frame.
	readExactKeys(record, allowed, required, "bad_frame");
	switch (type) {
		case "hello":
		case "hello_ack": {
			return Object.freeze({
				type,
				service: readService(ownField(record, "service")),
				major: readInteger(ownField(record, "major"), 0, 4_294_967_295),
				minor: readInteger(ownField(record, "minor"), 0, 4_294_967_295),
				capabilities: readCapabilities(ownField(record, "capabilities"), bounds),
			});
		}
		case "subscribe": {
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				hostRunId: readIdentifier(ownField(record, "hostRunId"), bounds.maxIdentifierBytes),
				sessionId: readIdentifier(ownField(record, "sessionId"), bounds.maxIdentifierBytes),
				cols: readInteger(ownField(record, "cols"), 1, bounds.maxCols),
				rows: readInteger(ownField(record, "rows"), 1, bounds.maxRows),
			});
		}
		case "subscribed": {
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				sessionId: readIdentifier(ownField(record, "sessionId"), bounds.maxIdentifierBytes),
				hostRunId: readIdentifier(ownField(record, "hostRunId"), bounds.maxIdentifierBytes),
			});
		}
		case "resize": {
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				cols: readInteger(ownField(record, "cols"), 1, bounds.maxCols),
				rows: readInteger(ownField(record, "rows"), 1, bounds.maxRows),
			});
		}
		case "unsubscribe":
		case "unsubscribed": {
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
			});
		}
		case "end": {
			const code = ownField(record, "code");
			if (!isSessionContentEndCode(code)) fail("bad_frame");
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				code,
			});
		}
		case "error": {
			const code = ownField(record, "code");
			if (!isSessionContentErrorCode(code)) fail("bad_frame");
			const subscriptionId = ownField(record, "subscriptionId");
			return Object.freeze({
				type,
				code,
				...(subscriptionId === undefined
					? {}
					: { subscriptionId: readIdentifier(subscriptionId, bounds.maxIdentifierBytes) }),
			});
		}
		case "content_begin": {
			const byteLength = readInteger(ownField(record, "byteLength"), 1, bounds.maxTransferBytes);
			const chunkCount = readInteger(ownField(record, "chunkCount"), 1, byteLength);
			if (chunkCount < Math.ceil(byteLength / bounds.maxChunkPayloadBytes)) fail("bad_frame");
			const hostRunId = readIdentifier(ownField(record, "hostRunId"), bounds.maxIdentifierBytes);
			const sessionId = readIdentifier(ownField(record, "sessionId"), bounds.maxIdentifierBytes);
			const nativeSession = readNativeSession(ownField(record, "nativeSession"), bounds);
			const geometry = readGeometry(ownField(record, "geometry"), bounds);
			const rawInputSource = ownField(record, "inputSource");
			const inputSource = rawInputSource === undefined
				? undefined
				: rawInputSource === null ? null : readNativeIoSource(rawInputSource, bounds);
			if (inputSource !== undefined && inputSource !== null) {
				// Mixed A-frame / B-source metadata is refused, not merged.
				checkInputSourceCoherence(inputSource, { hostRunId, sessionId, nativeSession, geometry });
			}
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				transferId: readIdentifier(ownField(record, "transferId"), bounds.maxIdentifierBytes),
				hostRunId,
				sessionId,
				nativeSession,
				sequence: readInteger(ownField(record, "sequence"), 1, Number.MAX_SAFE_INTEGER),
				geometry,
				inputModes: readInputModes(ownField(record, "inputModes")),
				byteLength,
				chunkCount,
				// Absent unless the wire actually carried it, so a legacy begin keeps
				// its exact key set and an old view is never handed a new field.
				...(inputSource === undefined ? {} : { inputSource }),
			});
		}
		case "content_chunk": {
			const data = ownField(record, "data");
			const payload = readChunkPayload(data, bounds);
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				transferId: readIdentifier(ownField(record, "transferId"), bounds.maxIdentifierBytes),
				index: readInteger(ownField(record, "index"), 0, Number.MAX_SAFE_INTEGER),
				data: payload.toString("base64"),
			});
		}
		case "content_end": {
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				transferId: readIdentifier(ownField(record, "transferId"), bounds.maxIdentifierBytes),
				sequence: readInteger(ownField(record, "sequence"), 1, Number.MAX_SAFE_INTEGER),
			});
		}
		case "input": {
			const kind = ownField(record, "kind");
			if (!isNativeIoInputKind(kind)) fail("bad_frame");
			const payload = readNativeInputData(ownField(record, "data"), kind, bounds);
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				inputId: readIdentifier(ownField(record, "inputId"), bounds.maxIdentifierBytes),
				ordinal: readInteger(ownField(record, "ordinal"), 1, Number.MAX_SAFE_INTEGER),
				source: readNativeIoSource(ownField(record, "source"), bounds),
				inputModes: readInputModes(ownField(record, "inputModes")),
				kind,
				data: payload.toString("base64"),
			});
		}
		case "input_begin": {
			const byteLength = readNativePasteByteLength(ownField(record, "byteLength"), bounds);
			const chunkCount = readInteger(ownField(record, "chunkCount"), 1, byteLength);
			if (chunkCount < Math.ceil(byteLength / bounds.maxChunkPayloadBytes)) fail("bad_frame");
			if (ownField(record, "kind") !== "paste") fail("bad_frame");
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				inputId: readIdentifier(ownField(record, "inputId"), bounds.maxIdentifierBytes),
				ordinal: readInteger(ownField(record, "ordinal"), 1, Number.MAX_SAFE_INTEGER),
				source: readNativeIoSource(ownField(record, "source"), bounds),
				inputModes: readInputModes(ownField(record, "inputModes")),
				kind: "paste",
				byteLength,
				chunkCount,
			});
		}
		case "input_chunk": {
			const payload = readChunkPayload(ownField(record, "data"), bounds);
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				inputId: readIdentifier(ownField(record, "inputId"), bounds.maxIdentifierBytes),
				index: readInteger(ownField(record, "index"), 0, Number.MAX_SAFE_INTEGER),
				data: payload.toString("base64"),
			});
		}
		case "input_end": {
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				inputId: readIdentifier(ownField(record, "inputId"), bounds.maxIdentifierBytes),
				ordinal: readInteger(ownField(record, "ordinal"), 1, Number.MAX_SAFE_INTEGER),
			});
		}
		case "copy": {
			const source = readNativeIoSource(ownField(record, "source"), bounds);
			const event = readNativeCopyEvent(ownField(record, "event"), bounds);
			// The event tuple and the source tuple name the same conversation.
			checkCopyTupleCoherence(source, event);
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				copyId: readIdentifier(ownField(record, "copyId"), bounds.maxIdentifierBytes),
				sequence: readInteger(ownField(record, "sequence"), 1, Number.MAX_SAFE_INTEGER),
				source,
				dispatchId: readInteger(ownField(record, "dispatchId"), 1, Number.MAX_SAFE_INTEGER),
				event,
			});
		}
		case "copy_begin": {
			const byteLength = readInteger(ownField(record, "byteLength"), 1, NATIVE_COPY_MAX_ENCODED_CHARS);
			const chunkCount = readInteger(ownField(record, "chunkCount"), 1, byteLength);
			if (chunkCount < Math.ceil(byteLength / bounds.maxChunkPayloadBytes)) fail("bad_frame");
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				copyId: readIdentifier(ownField(record, "copyId"), bounds.maxIdentifierBytes),
				sequence: readInteger(ownField(record, "sequence"), 1, Number.MAX_SAFE_INTEGER),
				source: readNativeIoSource(ownField(record, "source"), bounds),
				dispatchId: readInteger(ownField(record, "dispatchId"), 1, Number.MAX_SAFE_INTEGER),
				byteLength,
				chunkCount,
			});
		}
		case "copy_chunk": {
			const payload = readChunkPayload(ownField(record, "data"), bounds);
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				copyId: readIdentifier(ownField(record, "copyId"), bounds.maxIdentifierBytes),
				index: readInteger(ownField(record, "index"), 0, Number.MAX_SAFE_INTEGER),
				data: payload.toString("base64"),
			});
		}
		case "copy_end": {
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				copyId: readIdentifier(ownField(record, "copyId"), bounds.maxIdentifierBytes),
				sequence: readInteger(ownField(record, "sequence"), 1, Number.MAX_SAFE_INTEGER),
			});
		}
		default:
			fail("bad_frame");
	}
}

/**
 * Decode one complete binary message into one frame. Bytes that are not valid
 * UTF-8, not a single JSON object, structurally invalid, oversized, or carrying
 * any key outside this schema are refused with a fixed code; nothing partial is
 * ever returned and no peer content is included in the failure.
 */
export function decodeSessionContentFrame(
	bytes: Uint8Array,
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): SessionContentFrame {
	if (!(bytes instanceof Uint8Array)) fail("bad_frame");
	if (bytes.length === 0) fail("bad_frame");
	if (bytes.length > bounds.maxFrameBytes) fail("frame_too_large");
	let text: string;
	try {
		text = utf8.decode(bytes);
	} catch {
		fail("bad_frame");
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		fail("bad_frame");
	}
	if (!isPlainRecord(value)) fail("bad_frame");
	return buildFrame(value, bounds);
}

export type SessionContentNegotiation =
	| {
		readonly ok: true;
		readonly major: number;
		readonly minor: number;
		readonly capabilities: readonly string[];
	}
	| { readonly ok: false; readonly code: "unsupported_version" | "missing_capability" };

/**
 * Explicit optional-capability opt-in. The default (`undefined`, `{}`, or an
 * empty list) offers and accepts nothing, so knowing a capability never enables
 * it and an existing host or client keeps its legacy, display-only behavior.
 */
export interface SessionContentNegotiationOptions {
	readonly supportedOptionalCapabilities?: readonly string[];
}

const NEGOTIATION_OPTION_KEYS: ReadonlySet<string> = new Set(["supportedOptionalCapabilities"]);
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Resolve the explicitly enabled optional capabilities. Only identifiers this
 * build implements may be enabled, and a malformed, duplicated, oversized, or
 * unimplementable entry fails closed instead of being silently dropped.
 */
function enabledOptionalCapabilities(options: unknown): readonly string[] {
	if (options === undefined) return Object.freeze([]);
	if (!isPlainRecord(options)) fail("invalid_bounds");
	readExactKeys(options, NEGOTIATION_OPTION_KEYS, NO_KEYS, "invalid_bounds");
	const raw = ownField(options, "supportedOptionalCapabilities");
	if (raw === undefined) return Object.freeze([]);
	if (!Array.isArray(raw)) fail("invalid_bounds");
	if (raw.length > DEFAULT_SESSION_CONTENT_BOUNDS.maxCapabilities) fail("invalid_bounds");
	const enabled: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") fail("invalid_bounds");
		if (Buffer.byteLength(entry, "utf8") > DEFAULT_SESSION_CONTENT_BOUNDS.maxCapabilityIdBytes) {
			fail("invalid_bounds");
		}
		if (!IDENTIFIER_RE.test(entry)) fail("invalid_bounds");
		if (!SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES.includes(entry)) fail("invalid_bounds");
		if (enabled.includes(entry)) fail("invalid_bounds");
		enabled.push(entry);
	}
	return Object.freeze(enabled);
}

/**
 * Owner-side decision on one hello. A different service or major version is
 * refused, and a hello without the native-viewport capability is refused.
 * Optional capabilities are recorded only when they appear in the explicit
 * enabled set — never merely because the peer offered a known identifier — so
 * the default decision acknowledges the baseline alone. The negotiated minor is
 * the lower of the two so a newer peer cannot imply behavior this implementation
 * does not have.
 */
export function negotiateSessionContentHello(
	hello: SessionContentHelloFrame,
	options?: SessionContentNegotiationOptions,
): SessionContentNegotiation {
	const enabled = enabledOptionalCapabilities(options);
	if (hello.service !== SESSION_CONTENT_SERVICE || hello.major !== SESSION_CONTENT_MAJOR) {
		return { ok: false, code: "unsupported_version" };
	}
	if (!hello.capabilities.includes(SESSION_CONTENT_REQUIRED_CAPABILITY)) {
		return { ok: false, code: "missing_capability" };
	}
	const negotiated = hello.capabilities.filter((capability) =>
		capability !== SESSION_CONTENT_REQUIRED_CAPABILITY && enabled.includes(capability));
	return Object.freeze({
		ok: true,
		major: SESSION_CONTENT_MAJOR,
		minor: Math.min(hello.minor, SESSION_CONTENT_MINOR),
		capabilities: Object.freeze(negotiated),
	});
}

export type SessionContentAckVerdict =
	| { readonly ok: true; readonly minor: number; readonly capabilities: readonly string[] }
	| { readonly ok: false; readonly code: "unsupported_version" | "missing_capability" | "protocol_violation" };

/**
 * Viewer-side decision on one `hello_ack`. The owner must confirm this side's
 * service and major version and must acknowledge the requested capability. An
 * acknowledgement that claims a capability this side never offered, or one this
 * build cannot implement, or a minor above the one offered, is a protocol
 * violation: negotiation can only narrow what either side may assume, never
 * widen it.
 */
export function reviewSessionContentHelloAck(
	ack: SessionContentHelloAckFrame,
	offered: { readonly capabilities: readonly string[] },
): SessionContentAckVerdict {
	if (ack.service !== SESSION_CONTENT_SERVICE || ack.major !== SESSION_CONTENT_MAJOR) {
		return { ok: false, code: "unsupported_version" };
	}
	if (!ack.capabilities.includes(SESSION_CONTENT_REQUIRED_CAPABILITY)) {
		return { ok: false, code: "missing_capability" };
	}
	if (ack.minor > SESSION_CONTENT_MINOR) return { ok: false, code: "protocol_violation" };
	for (const capability of ack.capabilities) {
		// A capability this build cannot implement is never accepted, even when a
		// caller mistakenly listed it as offered.
		if (capability !== SESSION_CONTENT_REQUIRED_CAPABILITY
			&& !SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES.includes(capability)) {
			return { ok: false, code: "protocol_violation" };
		}
		if (!offered.capabilities.includes(capability)) return { ok: false, code: "protocol_violation" };
	}
	return Object.freeze({ ok: true, minor: ack.minor, capabilities: Object.freeze([...ack.capabilities]) });
}

/* ------------------------------------------------------------------------- *
 * Native viewport payload
 * ------------------------------------------------------------------------- */

const COLOR_KEYS: ReadonlySet<string> = new Set(["mode", "value"]);
const RUN_KEYS: ReadonlySet<string> = new Set([
	"startColumn",
	"text",
	"fg",
	"bg",
	"bold",
	"dim",
	"italic",
	"underline",
	"inverse",
	"blink",
	"invisible",
	"strikethrough",
	"overline",
]);
const RUN_REQUIRED_KEYS: ReadonlySet<string> = new Set(["startColumn", "text"]);
const ATTRIBUTE_KEYS = [
	"bold",
	"dim",
	"italic",
	"underline",
	"inverse",
	"blink",
	"invisible",
	"strikethrough",
	"overline",
] as const;
const STYLE_LINE_KEYS: ReadonlySet<string> = new Set(["line", "runs"]);
const VIEWPORT_KEYS: ReadonlySet<string> = new Set(["cols", "rows", "lines", "cursor", "styles", "graphics"]);
const VIEWPORT_REQUIRED_KEYS: ReadonlySet<string> = new Set(["cols", "rows", "lines", "cursor"]);
const CURSOR_KEYS: ReadonlySet<string> = new Set(["column", "row", "visible"]);
const GRAPHICS_KEYS: ReadonlySet<string> = new Set(["images", "placements", "fallbacks"]);
const IMAGE_KEYS: ReadonlySet<string> = new Set(["id", "mimeType", "widthPx", "heightPx", "base64"]);
const PLACEMENT_KEYS: ReadonlySet<string> = new Set([
	"id",
	"imageId",
	"column",
	"row",
	"columns",
	"rows",
	"crop",
	"clip",
]);
const FALLBACK_KEYS: ReadonlySet<string> = new Set([
	"id",
	"mimeType",
	"widthPx",
	"heightPx",
	"column",
	"row",
	"columns",
	"rows",
	"clip",
]);
const FALLBACK_REQUIRED_KEYS: ReadonlySet<string> = new Set([
	"id",
	"mimeType",
	"column",
	"row",
	"columns",
	"rows",
	"clip",
]);
const CROP_KEYS: ReadonlySet<string> = new Set(["x", "y", "width", "height"]);
const CLIP_KEYS: ReadonlySet<string> = new Set(["leftColumns", "topRows", "rightColumns", "bottomRows"]);

function readVisibleText(value: unknown): string {
	if (typeof value !== "string") fail("bad_frame");
	if (!VISIBLE_TEXT_RE.test(value)) fail("bad_frame");
	return value;
}

/** A single bounded color component parameter (0-255), or undefined. */
function sgrColorComponent(value: string | undefined): number | undefined {
	if (value === undefined || !SGR_PARAM_RE.test(value)) return undefined;
	const numeric = Number(value);
	return numeric <= 255 ? numeric : undefined;
}

/**
 * Consume at most one palette/RGB color group, exactly as `generateSgr` emits it:
 * a simple `30-37`/`90-97` (foreground) or `40-47`/`100-107` (background) form,
 * or the extended `38;5;n` / `38;2;r;g;b` (`48;...`) form with components in
 * 0-255. Returns the index after the group, or `start` when no such group is
 * present; an incomplete or out-of-range group is left unconsumed so the whole
 * parameter list is refused.
 */
function skipNativeColorGroup(
	parts: readonly string[],
	start: number,
	extended: string,
	simpleRanges: ReadonlyArray<readonly [number, number]>,
): number {
	if (start >= parts.length) return start;
	if (parts[start] === extended) {
		if (parts[start + 1] === "5") {
			return sgrColorComponent(parts[start + 2]) === undefined ? start : start + 3;
		}
		if (parts[start + 1] === "2") {
			if (sgrColorComponent(parts[start + 2]) === undefined
				|| sgrColorComponent(parts[start + 3]) === undefined
				|| sgrColorComponent(parts[start + 4]) === undefined) {
				return start;
			}
			return start + 5;
		}
		return start;
	}
	const value = sgrColorComponent(parts[start]);
	if (value !== undefined && simpleRanges.some(([min, max]) => value >= min && value <= max)) {
		return start + 1;
	}
	return start;
}

/**
 * Whether one generated SGR parameter list is a form the native serializer can
 * produce: `0` alone, or the ascending allowlisted attributes followed by at
 * most one foreground and at most one background color group. Anything else —
 * unsupported attributes such as `51`, out-of-range colors, reordered or
 * incomplete groups, and empty lists — is not native output.
 */
function isNativeSgrParams(params: string): boolean {
	if (params === "0") return true;
	if (params.length === 0) return false;
	const parts = params.split(";");
	for (const part of parts) {
		if (!SGR_PARAM_RE.test(part)) return false;
	}
	let index = 0;
	// Attributes must appear as an ascending subsequence of the serializer's own
	// order, so `\x1b[53m` (overline alone) and `\x1b[4;53m` are native forms while
	// `\x1b[9;8m` (reordered) and `\x1b[51m` (never emitted) are not.
	let attributeCursor = 0;
	while (index < parts.length && attributeCursor < SGR_ATTRIBUTE_ORDER.length) {
		let nextAttribute = attributeCursor;
		while (nextAttribute < SGR_ATTRIBUTE_ORDER.length
			&& SGR_ATTRIBUTE_ORDER[nextAttribute] !== parts[index]) {
			nextAttribute += 1;
		}
		if (nextAttribute === SGR_ATTRIBUTE_ORDER.length) break;
		attributeCursor = nextAttribute + 1;
		index += 1;
	}
	index = skipNativeColorGroup(parts, index, "38", SGR_FG_SIMPLE_RANGES);
	index = skipNativeColorGroup(parts, index, "48", SGR_BG_SIMPLE_RANGES);
	return index === parts.length;
}

/**
 * Validate one frame row: visible text plus only SGR sequences generated by the
 * native serializer. No OSC/CSI/APC/DCS control, cursor, clipboard, or raw
 * attribute payload can pass; legitimate Unicode (combining marks, wide cells)
 * is preserved exactly.
 */
function isNativeFrameLine(line: string): boolean {
	let index = 0;
	while (index < line.length) {
		const code = line.charCodeAt(index);
		if (code === 0x1b) {
			if (line.charCodeAt(index + 1) !== 0x5b) return false;
			const terminator = line.indexOf("m", index + 2);
			if (terminator < 0) return false;
			if (!isNativeSgrParams(line.slice(index + 2, terminator))) return false;
			index = terminator + 1;
			continue;
		}
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
		index += 1;
	}
	return true;
}

function readColorSpec(value: unknown): TerminalColorSpec {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, COLOR_KEYS, COLOR_KEYS, "bad_frame");
	const mode = ownField(value, "mode");
	const rawValue = ownField(value, "value");
	if (mode === "default") {
		readInteger(rawValue, 0, 0);
		return Object.freeze({ mode, value: 0 });
	}
	if (mode === "palette") {
		return Object.freeze({ mode, value: readInteger(rawValue, 0, 255) });
	}
	if (mode === "rgb") {
		return Object.freeze({ mode, value: readInteger(rawValue, 0, 0xff_ff_ff) });
	}
	fail("bad_frame");
}

function readCellRun(value: unknown, cols: number): TerminalCellRun {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, RUN_KEYS, RUN_REQUIRED_KEYS, "bad_frame");
	const startColumn = readInteger(ownField(value, "startColumn"), 0, cols - 1);
	const text = readVisibleText(ownField(value, "text"));
	const fgValue = ownField(value, "fg");
	const bgValue = ownField(value, "bg");
	const attributes: Partial<Record<(typeof ATTRIBUTE_KEYS)[number], true>> = {};
	for (const key of ATTRIBUTE_KEYS) {
		const attribute = ownField(value, key);
		if (attribute === undefined) continue;
		// The native serializer omits default attributes; it never emits false.
		if (attribute !== true) fail("bad_frame");
		attributes[key] = true;
	}
	return Object.freeze({
		startColumn,
		text,
		...(fgValue === undefined ? {} : { fg: readColorSpec(fgValue) }),
		...(bgValue === undefined ? {} : { bg: readColorSpec(bgValue) }),
		...attributes,
	});
}

function readStyleLine(value: unknown, cols: number, rows: number): TerminalLineStyles {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, STYLE_LINE_KEYS, STYLE_LINE_KEYS, "bad_frame");
	const line = readInteger(ownField(value, "line"), 0, rows - 1);
	const rawRuns = ownField(value, "runs");
	if (!Array.isArray(rawRuns) || rawRuns.length === 0) fail("bad_frame");
	const runs: TerminalCellRun[] = [];
	let previousColumn = -1;
	for (const rawRun of rawRuns) {
		const run = readCellRun(rawRun, cols);
		if (run.startColumn <= previousColumn) fail("bad_frame");
		previousColumn = run.startColumn;
		runs.push(run);
	}
	return Object.freeze({ line, runs: Object.freeze(runs) });
}

function readStyles(value: unknown, cols: number, rows: number): readonly TerminalLineStyles[] {
	if (!Array.isArray(value)) fail("bad_frame");
	const styles: TerminalLineStyles[] = [];
	let previousLine = -1;
	for (const entry of value) {
		const style = readStyleLine(entry, cols, rows);
		if (style.line <= previousLine) fail("bad_frame");
		previousLine = style.line;
		styles.push(style);
	}
	return Object.freeze(styles);
}

function readCursor(value: unknown, cols: number, rows: number): TerminalFrame["cursor"] {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, CURSOR_KEYS, CURSOR_KEYS, "bad_frame");
	return Object.freeze({
		column: readInteger(ownField(value, "column"), 0, cols - 1),
		row: readInteger(ownField(value, "row"), 0, rows - 1),
		visible: readBoolean(ownField(value, "visible")),
	});
}

interface NormalizedImages {
	readonly list: readonly TerminalGraphicsImage[];
	readonly byId: ReadonlyMap<string, TerminalGraphicsImage>;
}

/**
 * Images reuse the exact native validator: canonical base64, PNG signature,
 * per-chunk CRCs, IHDR depth/color/interlace rules, decoded/base64 byte bounds,
 * dimension and pixel bounds, and refusal of animated PNGs all come from
 * `validateTerminalGraphicsPng`, never from a weaker local copy.
 */
function readImages(value: unknown, bounds: SessionContentBounds): NormalizedImages {
	if (!Array.isArray(value)) fail("bad_frame");
	const list: TerminalGraphicsImage[] = [];
	const byId = new Map<string, TerminalGraphicsImage>();
	for (const entry of value) {
		if (!isPlainRecord(entry)) fail("bad_frame");
		readExactKeys(entry, IMAGE_KEYS, IMAGE_KEYS, "bad_frame");
		const id = readOpaqueId(ownField(entry, "id"), bounds.maxIdentifierBytes);
		if (byId.has(id)) fail("bad_frame");
		if (ownField(entry, "mimeType") !== "image/png") fail("bad_frame");
		if (typeof ownField(entry, "base64") !== "string") fail("bad_frame");
		const base64 = ownField(entry, "base64") as string;
		const validated = validateTerminalGraphicsPng(base64);
		if (validated === undefined) fail("bad_frame");
		const widthPx = readInteger(ownField(entry, "widthPx"), 1, MAX_GRAPHICS_DIMENSION);
		const heightPx = readInteger(ownField(entry, "heightPx"), 1, MAX_GRAPHICS_DIMENSION);
		if (widthPx !== validated.widthPx || heightPx !== validated.heightPx) fail("bad_frame");
		const image: TerminalGraphicsImage = Object.freeze({
			id,
			mimeType: "image/png",
			widthPx,
			heightPx,
			base64,
		});
		byId.set(id, image);
		list.push(image);
	}
	return { list: Object.freeze(list), byId };
}

function readCrop(value: unknown, image: TerminalGraphicsImage): TerminalGraphicsCrop {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, CROP_KEYS, CROP_KEYS, "bad_frame");
	const crop = {
		x: readInteger(ownField(value, "x"), 0, MAX_GRAPHICS_DIMENSION),
		y: readInteger(ownField(value, "y"), 0, MAX_GRAPHICS_DIMENSION),
		width: readInteger(ownField(value, "width"), 1, MAX_GRAPHICS_DIMENSION),
		height: readInteger(ownField(value, "height"), 1, MAX_GRAPHICS_DIMENSION),
	};
	if (crop.x + crop.width > image.widthPx || crop.y + crop.height > image.heightPx) fail("bad_frame");
	return Object.freeze(crop);
}

function readClip(value: unknown): TerminalGraphicsClip {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, CLIP_KEYS, CLIP_KEYS, "bad_frame");
	return Object.freeze({
		leftColumns: readInteger(ownField(value, "leftColumns"), 0, Number.MAX_SAFE_INTEGER),
		topRows: readInteger(ownField(value, "topRows"), 0, Number.MAX_SAFE_INTEGER),
		rightColumns: readInteger(ownField(value, "rightColumns"), 0, Number.MAX_SAFE_INTEGER),
		bottomRows: readInteger(ownField(value, "bottomRows"), 0, Number.MAX_SAFE_INTEGER),
	});
}

/** The exact viewport-edge clip the native graphics frame derives for a placement. */
function expectedClip(
	column: number,
	row: number,
	columns: number,
	rows: number,
	viewportCols: number,
	viewportRows: number,
): TerminalGraphicsClip {
	return {
		leftColumns: Math.max(0, -column),
		topRows: Math.max(0, -row),
		rightColumns: Math.max(0, column + columns - viewportCols),
		bottomRows: Math.max(0, row + rows - viewportRows),
	};
}

function readFootprint(
	record: Record<string, unknown>,
	cols: number,
	rows: number,
	bounds: SessionContentBounds,
): { readonly column: number; readonly row: number; readonly columns: number; readonly rows: number; readonly clip: TerminalGraphicsClip } {
	const columns = readInteger(ownField(record, "columns"), 1, bounds.maxCols);
	const placementRows = readInteger(ownField(record, "rows"), 1, bounds.maxRows);
	// Native cell-space anchors: a placement starts inside the viewport
	// horizontally, but its row may sit far above a short viewport as long as
	// the placement's own footprint still contributes a visible cell.
	const column = readInteger(ownField(record, "column"), 0, cols - 1);
	const row = readInteger(ownField(record, "row"), -(placementRows - 1), rows - 1);
	const clip = readClip(ownField(record, "clip"));
	const expected = expectedClip(column, row, columns, placementRows, cols, rows);
	if (clip.leftColumns !== expected.leftColumns
		|| clip.topRows !== expected.topRows
		|| clip.rightColumns !== expected.rightColumns
		|| clip.bottomRows !== expected.bottomRows) {
		fail("bad_frame");
	}
	// Native clips refuse a placement that contributes no visible cell.
	if (expected.leftColumns >= columns || expected.topRows >= placementRows
		|| expected.rightColumns >= columns || expected.bottomRows >= placementRows
		|| expected.leftColumns + expected.rightColumns >= columns
		|| expected.topRows + expected.bottomRows >= placementRows) {
		fail("bad_frame");
	}
	return { column, row, columns, rows: placementRows, clip };
}

function readPlacements(
	value: unknown,
	images: NormalizedImages,
	cols: number,
	rows: number,
	bounds: SessionContentBounds,
): readonly TerminalGraphicsPlacement[] {
	if (!Array.isArray(value)) fail("bad_frame");
	const placements: TerminalGraphicsPlacement[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (!isPlainRecord(entry)) fail("bad_frame");
		readExactKeys(entry, PLACEMENT_KEYS, PLACEMENT_KEYS, "bad_frame");
		const id = readOpaqueId(ownField(entry, "id"), bounds.maxIdentifierBytes);
		if (seen.has(id)) fail("bad_frame");
		seen.add(id);
		const imageId = readOpaqueId(ownField(entry, "imageId"), bounds.maxIdentifierBytes);
		const image = images.byId.get(imageId);
		if (image === undefined) fail("bad_frame");
		const footprint = readFootprint(entry, cols, rows, bounds);
		placements.push(Object.freeze({
			id,
			imageId,
			column: footprint.column,
			row: footprint.row,
			columns: footprint.columns,
			rows: footprint.rows,
			crop: readCrop(ownField(entry, "crop"), image),
			clip: footprint.clip,
		}));
	}
	return Object.freeze(placements);
}

function readFallbacks(
	value: unknown,
	placements: readonly TerminalGraphicsPlacement[],
	cols: number,
	rows: number,
	bounds: SessionContentBounds,
): readonly TerminalGraphicsFallback[] {
	if (!Array.isArray(value)) fail("bad_frame");
	const byId = new Map(placements.map((placement) => [placement.id, placement] as const));
	const seen = new Set<string>();
	const fallbacks: TerminalGraphicsFallback[] = [];
	for (const entry of value) {
		if (!isPlainRecord(entry)) fail("bad_frame");
		readExactKeys(entry, FALLBACK_KEYS, FALLBACK_REQUIRED_KEYS, "bad_frame");
		const id = readOpaqueId(ownField(entry, "id"), bounds.maxIdentifierBytes);
		if (seen.has(id)) fail("bad_frame");
		seen.add(id);
		if (ownField(entry, "mimeType") !== "image/png") fail("bad_frame");
		const footprint = readFootprint(entry, cols, rows, bounds);
		const widthPxValue = ownField(entry, "widthPx");
		const heightPxValue = ownField(entry, "heightPx");
		const widthPx = widthPxValue === undefined
			? undefined
			: readInteger(widthPxValue, 1, MAX_GRAPHICS_DIMENSION);
		const heightPx = heightPxValue === undefined
			? undefined
			: readInteger(heightPxValue, 1, MAX_GRAPHICS_DIMENSION);
		const placement = byId.get(id);
		if (placement !== undefined) {
			// The native frame emits the payload-free alternative for the same
			// stored placement, so its footprint and clip must agree exactly.
			if (placement.column !== footprint.column
				|| placement.row !== footprint.row
				|| placement.columns !== footprint.columns
				|| placement.rows !== footprint.rows
				|| placement.clip.leftColumns !== footprint.clip.leftColumns
				|| placement.clip.topRows !== footprint.clip.topRows
				|| placement.clip.rightColumns !== footprint.clip.rightColumns
				|| placement.clip.bottomRows !== footprint.clip.bottomRows) {
				fail("bad_frame");
			}
		}
		fallbacks.push(Object.freeze({
			id,
			mimeType: "image/png",
			...(widthPx === undefined ? {} : { widthPx }),
			...(heightPx === undefined ? {} : { heightPx }),
			column: footprint.column,
			row: footprint.row,
			columns: footprint.columns,
			rows: footprint.rows,
			clip: footprint.clip,
		}));
	}
	return Object.freeze(fallbacks);
}

function readGraphics(
	value: unknown,
	cols: number,
	rows: number,
	bounds: SessionContentBounds,
): TerminalGraphicsFrame {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, GRAPHICS_KEYS, GRAPHICS_KEYS, "bad_frame");
	const images = readImages(ownField(value, "images"), bounds);
	const placements = readPlacements(ownField(value, "placements"), images, cols, rows, bounds);
	const fallbacks = readFallbacks(ownField(value, "fallbacks"), placements, cols, rows, bounds);
	return Object.freeze({ images: images.list, placements, fallbacks });
}

/**
 * Validate and copy one native viewport. The result owns fresh immutable
 * objects: no array, string, or object from `value` is aliased, so a caller's
 * later mutation cannot change a published snapshot. Visible text is preserved
 * exactly (Unicode, combining marks, and wide cells included); only controls
 * outside the native serializer's allowlisted SGR are refused.
 */
function normalizeTerminalFrame(value: unknown, bounds: SessionContentBounds): TerminalFrame {
	if (!isPlainRecord(value)) fail("bad_frame");
	readExactKeys(value, VIEWPORT_KEYS, VIEWPORT_REQUIRED_KEYS, "bad_frame");
	const cols = readInteger(ownField(value, "cols"), 1, bounds.maxCols);
	const rows = readInteger(ownField(value, "rows"), 1, bounds.maxRows);
	const rawLines = ownField(value, "lines");
	if (!Array.isArray(rawLines) || rawLines.length !== rows) fail("bad_frame");
	const lines: string[] = [];
	for (const rawLine of rawLines) {
		if (typeof rawLine !== "string" || !isNativeFrameLine(rawLine)) fail("bad_frame");
		lines.push(rawLine);
	}
	const cursor = readCursor(ownField(value, "cursor"), cols, rows);
	const rawStyles = ownField(value, "styles");
	const styles = rawStyles === undefined ? undefined : readStyles(rawStyles, cols, rows);
	const rawGraphics = ownField(value, "graphics");
	const graphics = rawGraphics === undefined ? undefined : readGraphics(rawGraphics, cols, rows, bounds);
	return Object.freeze({
		cols,
		rows,
		// Runtime-frozen; `TerminalFrame.lines` is a mutable array type.
		lines: Object.freeze(lines) as string[],
		cursor,
		...(styles === undefined ? {} : { styles }),
		...(graphics === undefined ? {} : { graphics }),
	});
}

/**
 * Encode the complete native viewport as the canonical UTF-8 JSON payload of a
 * transfer. The payload is validated first and must fit the transfer ceiling;
 * an oversized viewport is an honest error, never a trimmed or filtered frame.
 */
export function encodeSessionContentViewport(
	frame: TerminalFrame,
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): Buffer {
	try {
		const bytes = Buffer.from(JSON.stringify(normalizeTerminalFrame(frame, bounds)), "utf8");
		if (bytes.length > bounds.maxTransferBytes) fail("transfer_too_large");
		return bytes;
	} catch (error) {
		if (isSessionContentProtocolError(error) && error.code === "bad_frame") fail("invalid_frame");
		throw error;
	}
}

/** Decode and validate one complete reassembled native viewport payload. */
export function decodeSessionContentViewport(
	bytes: Uint8Array,
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): TerminalFrame {
	if (!(bytes instanceof Uint8Array)) fail("bad_frame");
	if (bytes.length === 0) fail("bad_frame");
	if (bytes.length > bounds.maxTransferBytes) fail("transfer_too_large");
	let text: string;
	try {
		text = utf8.decode(bytes);
	} catch {
		fail("bad_frame");
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		fail("bad_frame");
	}
	return normalizeTerminalFrame(value, bounds);
}

export interface SessionContentTransferMeta {
	readonly subscriptionId: string;
	readonly transferId: string;
	readonly hostRunId: string;
	/** Owner row id; never derived from screen text. */
	readonly sessionId: string;
	readonly nativeSession: SessionContentNativeSessionRef | null;
	readonly sequence: number;
	readonly geometry: SessionContentGeometry;
	readonly inputModes: TerminalInputModes;
	/**
	 * Present only when the publisher passed an explicit native IO source: the
	 * host-written source this publish belongs to, or null when unavailable. Never
	 * set by default, so a legacy snapshot keeps its exact shape.
	 */
	readonly inputSource?: NativeIoSource | null;
	readonly byteLength: number;
	readonly chunkCount: number;
}

/** One atomically completed native viewport: immutable meta plus valid frame. */
export interface SessionContentSnapshot {
	readonly meta: SessionContentTransferMeta;
	readonly frame: TerminalFrame;
}

export interface SessionContentBuiltTransfer {
	/** `content_begin`, every `content_chunk`, then `content_end`, in order. */
	readonly frames: readonly Buffer[];
	readonly meta: SessionContentTransferMeta;
	/** Encoded size of each message, in the same order as `frames`. */
	readonly messageBytes: readonly number[];
	readonly totalMessageBytes: number;
	readonly byteLength: number;
	readonly chunkCount: number;
}

/**
 * Build one complete native viewport transfer. Every message is encoded up front
 * under the per-message bound, so the sender can re-check its own guards
 * immediately before each write, and the whole transfer is refused (never
 * trimmed, filtered, or partially emitted) when it cannot be represented.
 */
export function buildSessionContentTransfer(options: {
	readonly subscriptionId: string;
	readonly transferId: string;
	readonly hostRunId: string;
	readonly sessionId: string;
	readonly nativeSession: SessionContentNativeSessionRef | null;
	readonly sequence: number;
	readonly geometry: SessionContentGeometry;
	readonly inputModes: TerminalInputModes;
	readonly frame: TerminalFrame;
	/**
	 * Explicit native IO source for this publish. Pass it only when the optional
	 * native IO capability was negotiated; omit it entirely (the default) so a
	 * legacy `content_begin` keeps its exact key set. `null` states that the owner
	 * has no source to report.
	 */
	readonly inputSource?: NativeIoSource | null;
	readonly bounds?: SessionContentBounds;
}): SessionContentBuiltTransfer {
	const bounds = options.bounds ?? DEFAULT_SESSION_CONTENT_BOUNDS;
	const payload = encodeSessionContentViewport(options.frame, bounds);
	if (options.frame.cols !== options.geometry.cols || options.frame.rows !== options.geometry.rows) {
		// Geometry is part of the subscription contract; a mismatch is never sent.
		fail("invalid_frame");
	}
	const byteLength = payload.length;
	const chunkCount = Math.max(1, Math.ceil(byteLength / bounds.maxChunkPayloadBytes));
	// Normalized copies keep the published meta independent of caller objects.
	const geometry = readGeometry(options.geometry, bounds);
	const inputModes = readInputModes(options.inputModes);
	const nativeSession = readNativeSession(options.nativeSession, bounds);
	const inputSource = options.inputSource === undefined
		? undefined
		: options.inputSource === null ? null : readNativeIoSource(options.inputSource, bounds);
	const begin: SessionContentBeginFrame = Object.freeze({
		type: "content_begin",
		subscriptionId: options.subscriptionId,
		transferId: options.transferId,
		hostRunId: options.hostRunId,
		sessionId: options.sessionId,
		nativeSession,
		sequence: options.sequence,
		geometry,
		inputModes,
		byteLength,
		chunkCount,
		...(inputSource === undefined ? {} : { inputSource }),
	});
	const frames: Buffer[] = [encodeSessionContentFrame(begin, bounds)];
	for (let index = 0; index < chunkCount; index += 1) {
		const data = payload
			.subarray(index * bounds.maxChunkPayloadBytes, (index + 1) * bounds.maxChunkPayloadBytes)
			.toString("base64");
		frames.push(encodeSessionContentFrame(Object.freeze({
			type: "content_chunk",
			subscriptionId: options.subscriptionId,
			transferId: options.transferId,
			index,
			data,
		}), bounds));
	}
	frames.push(encodeSessionContentFrame(Object.freeze({
		type: "content_end",
		subscriptionId: options.subscriptionId,
		transferId: options.transferId,
		sequence: options.sequence,
	}), bounds));
	const messageBytes = frames.map((bytes) => bytes.length);
	const meta: SessionContentTransferMeta = Object.freeze({
		subscriptionId: options.subscriptionId,
		transferId: options.transferId,
		hostRunId: options.hostRunId,
		sessionId: options.sessionId,
		nativeSession,
		sequence: options.sequence,
		geometry,
		inputModes,
		byteLength,
		chunkCount,
		...(inputSource === undefined ? {} : { inputSource }),
	});
	return Object.freeze({
		frames: Object.freeze(frames),
		meta,
		messageBytes: Object.freeze(messageBytes),
		totalMessageBytes: messageBytes.reduce((total, size) => total + size, 0),
		byteLength,
		chunkCount,
	});
}

interface PartialTransfer {
	readonly meta: SessionContentTransferMeta;
	/**
	 * One contiguous assembly buffer of exactly `meta.byteLength`, allocated on
	 * the first accepted chunk. Chunk count therefore never multiplies retained
	 * objects: a declared 64 MiB transfer with millions of one-byte chunks still
	 * costs at most one buffer of the declared, already-bounded payload size.
	 */
	buffer: Buffer | undefined;
	written: number;
	nextIndex: number;
}

/**
 * Receive-side transfer assembler. It holds at most one in-flight transfer,
 * rejects the declaration before allocating anything, and enforces the declared
 * payload budget before every copy, so an unrepresentable transfer cannot
 * allocate its way past `maxTransferBytes` and a hostile chunk count cannot
 * retain one object per chunk. `accept` returns a snapshot only for a
 * `content_end` that exactly completes the begin tuple, sequence, chunk count,
 * and byte length; otherwise it returns undefined for non-transfer controls and
 * refuses (with a fixed code, after discarding the partial transfer) anything
 * malformed, out of order, foreign, or inconsistent. The completed viewport is
 * decoded from an immutable view of the single assembly buffer, so no second
 * copy of the payload is made. Retiring other subscriptions is the endpoint's
 * business, not this assembler's.
 */
export interface SessionContentTransferAssembler {
	accept(frame: SessionContentFrame): SessionContentSnapshot | undefined;
	/** Drop any partial transfer. Idempotent; completed snapshots are unaffected. */
	reset(): void;
}

export function createSessionContentTransferAssembler(
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): SessionContentTransferAssembler {
	let partial: PartialTransfer | undefined;
	const discard = (): void => {
		partial = undefined;
	};
	const refuse: () => never = () => {
		discard();
		fail("transfer_failed");
	};
	return Object.freeze({
		accept: (frame: SessionContentFrame): SessionContentSnapshot | undefined => {
			if (frame.type === "content_begin") {
				if (partial !== undefined) refuse();
				readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
				readIdentifier(frame.transferId, bounds.maxIdentifierBytes);
				readIdentifier(frame.hostRunId, bounds.maxIdentifierBytes);
				readIdentifier(frame.sessionId, bounds.maxIdentifierBytes);
				const nativeSession = readNativeSession(frame.nativeSession, bounds);
				const sequence = readInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER);
				const geometry = readGeometry(frame.geometry, bounds);
				const inputModes = readInputModes(frame.inputModes);
				const byteLength = readInteger(frame.byteLength, 1, bounds.maxTransferBytes);
				const chunkCount = readInteger(frame.chunkCount, 1, byteLength);
				if (chunkCount < Math.ceil(byteLength / bounds.maxChunkPayloadBytes)) {
					// Structurally unrepresentable declaration: same fixed code the
					// wire decoder uses, and no partial transfer was staged yet.
					fail("bad_frame");
				}
				const rawInputSource = frame.inputSource;
				const inputSource = rawInputSource === undefined
					? undefined
					: rawInputSource === null ? null : readNativeIoSource(rawInputSource, bounds);
				if (inputSource !== undefined && inputSource !== null) {
					// The source must describe this same begin, not a neighbouring snapshot.
					checkInputSourceCoherence(inputSource, {
						hostRunId: frame.hostRunId,
						sessionId: frame.sessionId,
						nativeSession,
						geometry,
					});
				}
				const meta: SessionContentTransferMeta = Object.freeze({
					subscriptionId: frame.subscriptionId,
					transferId: frame.transferId,
					hostRunId: frame.hostRunId,
					sessionId: frame.sessionId,
					nativeSession,
					sequence,
					geometry,
					inputModes,
					byteLength,
					chunkCount,
					// Preserved exactly when the wire carried it; absent otherwise.
					...(inputSource === undefined ? {} : { inputSource }),
				});
				partial = { meta, buffer: undefined, written: 0, nextIndex: 0 };
				return undefined;
			}
			if (frame.type === "content_chunk") {
				const transfer = partial ?? refuse();
				if (frame.subscriptionId !== transfer.meta.subscriptionId
					|| frame.transferId !== transfer.meta.transferId) {
					refuse();
				}
				if (frame.index !== transfer.nextIndex || frame.index >= transfer.meta.chunkCount) refuse();
				let payload: Buffer;
				try {
					payload = readChunkPayload(frame.data, bounds);
				} catch (error) {
					// A malformed or oversized chunk discards the whole partial transfer.
					discard();
					throw error;
				}
				// Enforce the declared budget before allocating or copying anything.
				if (transfer.written + payload.length > transfer.meta.byteLength) refuse();
				let buffer = transfer.buffer;
				if (buffer === undefined) {
					try {
						buffer = Buffer.allocUnsafe(transfer.meta.byteLength);
					} catch {
						// An allocation the platform refuses is a bounded failure, not a crash.
						refuse();
					}
					transfer.buffer = buffer;
				}
				payload.copy(buffer, transfer.written);
				transfer.written += payload.length;
				transfer.nextIndex += 1;
				return undefined;
			}
			if (frame.type === "content_end") {
				const transfer = partial ?? refuse();
				if (frame.subscriptionId !== transfer.meta.subscriptionId
					|| frame.transferId !== transfer.meta.transferId
					|| frame.sequence !== transfer.meta.sequence) {
					refuse();
				}
				if (transfer.nextIndex !== transfer.meta.chunkCount || transfer.written !== transfer.meta.byteLength) {
					// Truncated, over-long, or chunk-count-inconsistent: never publish.
					refuse();
				}
				const buffer = transfer.buffer;
				discard();
				if (buffer === undefined) fail("transfer_failed");
				const viewport = decodeSessionContentViewport(buffer.subarray(0, transfer.written), bounds);
				if (viewport.cols !== transfer.meta.geometry.cols || viewport.rows !== transfer.meta.geometry.rows) {
					fail("bad_frame");
				}
				return Object.freeze({ meta: transfer.meta, frame: viewport });
			}
			// Control frames belong to the endpoint state machine.
			return undefined;
		},
		reset: () => {
			discard();
		},
	});
}

/* ------------------------------------------------------------------------- *
 * Optional native IO helpers: packers and atomic assemblers
 *
 * Everything below is pure. No function here writes to a PTY, a socket, the OS
 * clipboard, or an escape stream; none starts a timer, retries, queues, or
 * callback, and none grants, leases, or implies input authority. A future
 * endpoint must still re-authorize before every part and immediately before any
 * write, and must clear an assembly on tuple, geometry, generation, or grant
 * change. Packing and assembly state only that the bytes are well formed.
 * ------------------------------------------------------------------------- */

/** One atomically completed native input packet. */
export interface NativeIoCompletedInput {
	readonly subscriptionId: string;
	readonly inputId: string;
	readonly ordinal: number;
	readonly source: NativeIoSource;
	readonly inputModes: TerminalInputModes;
	readonly kind: NativeIoInputKind;
	/**
	 * Exactly the declared payload bytes. Owned by this result: the assembler
	 * never reuses, resizes, or mutates them afterwards.
	 */
	readonly data: Uint8Array;
	/** The same bytes decoded as strict UTF-8 text (or the normalized packet). */
	readonly text: string;
	readonly byteLength: number;
}

/**
 * One atomically completed native text copy. `event` carries canonical base64
 * text (or a fixed unavailable reason) together with the authenticated native
 * tuple of the copy, which is always the header source's own tuple — never a raw
 * OSC 52 sequence, and never a request to relay one.
 */
export interface NativeIoCompletedCopy {
	readonly subscriptionId: string;
	readonly copyId: string;
	readonly sequence: number;
	readonly source: NativeIoSource;
	readonly dispatchId: number;
	readonly event: NativeIoCopyEvent;
}

/** Encoded frames of one packed native IO unit, in wire order. */
export interface NativeIoBuiltTransfer {
	readonly frames: readonly Buffer[];
	readonly messageBytes: readonly number[];
	readonly totalMessageBytes: number;
	/** Decoded payload bytes; 0 for an inline copy-unavailable event. */
	readonly byteLength: number;
	readonly chunkCount: number;
}

/**
 * A builder's own refused input is a caller/programming failure, not a peer
 * frame: the same fixed local code `encodeSessionContentFrame` reports.
 */
function builderFailure<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (isSessionContentProtocolError(error) && error.code === "bad_frame") fail("invalid_frame");
		throw error;
	}
}

/** Owned bytes for one payload argument: text is UTF-8 encoded, bytes are copied. */
function nativeIoPayloadBytes(data: string | Uint8Array): Buffer {
	if (typeof data === "string") return Buffer.from(data, "utf8");
	if (data instanceof Uint8Array) return Buffer.from(data);
	fail("invalid_frame");
}

function nativeIoChunkCount(byteLength: number, chunkBytes: number): number {
	return Math.max(1, Math.ceil(byteLength / chunkBytes));
}

/**
 * Raw payload bytes one chunk may carry so that its WHOLE encoded message — the
 * JSON envelope, both identifiers, the widest possible index, and the base64
 * expansion — still fits `maxFrameBytes`. The result never exceeds
 * `maxChunkPayloadBytes`, and a tight message bound yields dynamically smaller
 * chunks instead of an unrepresentable frame. With the default bounds it is
 * exactly the raw chunk bound.
 */
function nativeIoChunkPayloadBytes(bounds: SessionContentBounds, template: SessionContentFrame): number {
	let envelopeBytes: number;
	try {
		// The exact envelope of this chunk shape with an empty payload and the widest
		// index, so the size is safe for every chunk of the transfer.
		envelopeBytes = Buffer.byteLength(
			JSON.stringify({ ...template, index: Number.MAX_SAFE_INTEGER, data: "" }),
			"utf8",
		);
	} catch {
		fail("frame_too_large");
	}
	const available = bounds.maxFrameBytes - envelopeBytes;
	if (available <= 0) fail("frame_too_large");
	let raw = Math.min(bounds.maxChunkPayloadBytes, Math.floor((available / 4) * 3));
	// Base64 pads to a multiple of four characters; back off until it fits.
	while (raw > 0 && 4 * Math.ceil(raw / 3) > available) raw -= 1;
	if (raw <= 0) fail("frame_too_large");
	return raw;
}

/**
 * Encode every frame of one unit up front under the per-message bound, so a
 * caller can re-check its own guards immediately before each write and a unit
 * that cannot be represented is refused whole, never trimmed or partially
 * emitted.
 */
function encodeNativeIoFrames(
	frames: readonly SessionContentFrame[],
	bounds: SessionContentBounds,
	byteLength: number,
	chunkCount: number,
): NativeIoBuiltTransfer {
	const encoded = frames.map((frame) => encodeSessionContentFrame(frame, bounds));
	const messageBytes = encoded.map((bytes) => bytes.length);
	return Object.freeze({
		frames: Object.freeze(encoded),
		messageBytes: Object.freeze(messageBytes),
		totalMessageBytes: messageBytes.reduce((total, size) => total + size, 0),
		byteLength,
		chunkCount,
	});
}

/**
 * Pack one inline native input packet.
 *
 * Inline frames are bounded by the raw chunk bound, which is a transport bound
 * and not the paste cap: a larger text paste uses {@link buildNativeInputPaste}
 * and is never truncated. `data` is the already-normalized keyboard packet, the
 * canonical content-coordinate SGR mouse packet, or the UTF-8 paste body; this
 * packer performs no new input parsing beyond that bounded shape check.
 */
export function buildNativeInputInline(options: {
	readonly subscriptionId: string;
	readonly inputId: string;
	readonly ordinal: number;
	readonly source: NativeIoSource;
	readonly inputModes: TerminalInputModes;
	readonly kind: NativeIoInputKind;
	readonly data: string | Uint8Array;
	readonly bounds?: SessionContentBounds;
}): NativeIoBuiltTransfer {
	return builderFailure(() => {
		const bounds = options.bounds ?? DEFAULT_SESSION_CONTENT_BOUNDS;
		const kind = options.kind;
		if (!isNativeIoInputKind(kind)) fail("invalid_frame");
		const bytes = nativeIoPayloadBytes(options.data);
		if (bytes.length === 0) fail("invalid_frame");
		if (bytes.length > bounds.maxChunkPayloadBytes) fail("transfer_too_large");
		if (kind === "paste" && bytes.length > NATIVE_TEXT_PASTE_MAX_BYTES) fail("transfer_too_large");
		const text = decodeNativeIoText(bytes);
		if (kind === "mouse" && !NATIVE_IO_MOUSE_RE.test(text)) fail("invalid_frame");
		const frame: SessionContentInputFrame = Object.freeze({
			type: "input",
			subscriptionId: options.subscriptionId,
			inputId: options.inputId,
			ordinal: options.ordinal,
			source: options.source,
			inputModes: options.inputModes,
			kind,
			data: bytes.toString("base64"),
		});
		return encodeNativeIoFrames([frame], bounds, bytes.length, 1);
	});
}

/**
 * Pack one atomic native text paste of up to exactly 1 MiB of decoded UTF-8.
 *
 * The entire payload is validated — bound and strict UTF-8 — before a single
 * frame exists, and one byte over the cap is refused rather than truncated.
 * Native bracketed-paste wrapping belongs to a future adapter and its current
 * modes, after assembly; nothing here reads or writes a system clipboard.
 */
export function buildNativeInputPaste(options: {
	readonly subscriptionId: string;
	readonly inputId: string;
	readonly ordinal: number;
	readonly source: NativeIoSource;
	readonly inputModes: TerminalInputModes;
	readonly text: string | Uint8Array;
	readonly bounds?: SessionContentBounds;
}): NativeIoBuiltTransfer {
	return builderFailure(() => {
		const bounds = options.bounds ?? DEFAULT_SESSION_CONTENT_BOUNDS;
		const bytes = nativeIoPayloadBytes(options.text);
		if (bytes.length === 0) fail("invalid_frame");
		if (bytes.length > NATIVE_TEXT_PASTE_MAX_BYTES || bytes.length > bounds.maxTransferBytes) {
			fail("transfer_too_large");
		}
		decodeNativeIoText(bytes);
		const chunkTemplate: SessionContentInputChunkFrame = Object.freeze({
			type: "input_chunk",
			subscriptionId: options.subscriptionId,
			inputId: options.inputId,
			index: 0,
			data: "",
		});
		const chunkBytes = nativeIoChunkPayloadBytes(bounds, chunkTemplate);
		const chunkCount = nativeIoChunkCount(bytes.length, chunkBytes);
		const begin: SessionContentInputBeginFrame = Object.freeze({
			type: "input_begin",
			subscriptionId: options.subscriptionId,
			inputId: options.inputId,
			ordinal: options.ordinal,
			source: options.source,
			inputModes: options.inputModes,
			kind: "paste",
			byteLength: bytes.length,
			chunkCount,
		});
		const frames: SessionContentFrame[] = [begin];
		for (let index = 0; index < chunkCount; index += 1) {
			const chunk: SessionContentInputChunkFrame = Object.freeze({
				...chunkTemplate,
				index,
				data: bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
			});
			frames.push(chunk);
		}
		const end: SessionContentInputEndFrame = Object.freeze({
			type: "input_end",
			subscriptionId: options.subscriptionId,
			inputId: options.inputId,
			ordinal: options.ordinal,
		});
		frames.push(end);
		return encodeNativeIoFrames(frames, bounds, bytes.length, chunkCount);
	});
}

/**
 * Pack one inline native copy. Use it for an event that fits one message; a
 * longer encoded text uses {@link buildNativeCopyPaged} and is never reduced to
 * a transport message size.
 */
export function buildNativeCopyInline(options: {
	readonly subscriptionId: string;
	readonly copyId: string;
	readonly sequence: number;
	readonly source: NativeIoSource;
	readonly dispatchId: number;
	readonly event: NativeIoCopyEvent;
	readonly bounds?: SessionContentBounds;
}): NativeIoBuiltTransfer {
	return builderFailure(() => {
		const bounds = options.bounds ?? DEFAULT_SESSION_CONTENT_BOUNDS;
		const event = readNativeCopyEvent(options.event, bounds);
		const frame: SessionContentCopyFrame = Object.freeze({
			type: "copy",
			subscriptionId: options.subscriptionId,
			copyId: options.copyId,
			sequence: options.sequence,
			source: options.source,
			dispatchId: options.dispatchId,
			event,
		});
		return encodeNativeIoFrames([frame], bounds, event.kind === "copy" ? event.encoded.length : 0, 1);
	});
}

/**
 * Pack one whole native text copy across bounded pages.
 *
 * The complete encoded payload — up to the unchanged 100,000-character producer
 * bound — is validated before any frame exists and is carried whole: the header
 * never contains it, and one character over the bound is refused rather than
 * removed. The paged header carries no event tuple, so the assembled copy
 * inherits the header source's native tuple and stays consistent with it by
 * construction.
 */
export function buildNativeCopyPaged(options: {
	readonly subscriptionId: string;
	readonly copyId: string;
	readonly sequence: number;
	readonly source: NativeIoSource;
	readonly dispatchId: number;
	readonly encoded: string;
	readonly bounds?: SessionContentBounds;
}): NativeIoBuiltTransfer {
	return builderFailure(() => {
		const bounds = options.bounds ?? DEFAULT_SESSION_CONTENT_BOUNDS;
		const encoded = readNativeCopyEncoded(options.encoded);
		const byteLength = encoded.length;
		const chunkTemplate: SessionContentCopyChunkFrame = Object.freeze({
			type: "copy_chunk",
			subscriptionId: options.subscriptionId,
			copyId: options.copyId,
			index: 0,
			data: "",
		});
		const chunkBytes = nativeIoChunkPayloadBytes(bounds, chunkTemplate);
		const chunkCount = nativeIoChunkCount(byteLength, chunkBytes);
		const begin: SessionContentCopyBeginFrame = Object.freeze({
			type: "copy_begin",
			subscriptionId: options.subscriptionId,
			copyId: options.copyId,
			sequence: options.sequence,
			source: options.source,
			dispatchId: options.dispatchId,
			byteLength,
			chunkCount,
		});
		const frames: SessionContentFrame[] = [begin];
		for (let index = 0; index < chunkCount; index += 1) {
			const chunk: SessionContentCopyChunkFrame = Object.freeze({
				...chunkTemplate,
				index,
				data: Buffer.from(
					encoded.slice(index * chunkBytes, (index + 1) * chunkBytes),
					"ascii",
				).toString("base64"),
			});
			frames.push(chunk);
		}
		const end: SessionContentCopyEndFrame = Object.freeze({
			type: "copy_end",
			subscriptionId: options.subscriptionId,
			copyId: options.copyId,
			sequence: options.sequence,
		});
		frames.push(end);
		return encodeNativeIoFrames(frames, bounds, byteLength, chunkCount);
	});
}

/** Receive-side atomic assembly of one native input at a time. */
export interface NativeInputAssembler {
	/**
	 * Consume one frame. Returns a completed input only for an inline packet that
	 * validates whole, or for an `input_end` that exactly completes the begin
	 * tuple, ordinal, chunk count, and declared byte length. Every other native IO
	 * frame yields undefined; non-IO control and transfer frames are the
	 * endpoint's business and are ignored.
	 */
	accept(frame: SessionContentFrame): NativeIoCompletedInput | undefined;
	/**
	 * Drop any partial assembly. Idempotent; completed inputs and the ordinal fence
	 * remain, because a replayed ordinal must never complete. A changed source or
	 * binding uses a new assembler rather than reviving this one.
	 */
	reset(): void;
}

interface PartialNativeInput {
	readonly subscriptionId: string;
	readonly inputId: string;
	readonly ordinal: number;
	readonly source: NativeIoSource;
	readonly inputModes: TerminalInputModes;
	readonly byteLength: number;
	readonly chunkCount: number;
	/** One contiguous buffer of exactly `byteLength`, allocated on the first chunk. */
	buffer: Buffer | undefined;
	written: number;
	nextIndex: number;
}

/**
 * Create the atomic native input assembler.
 *
 * It holds at most one assembly, refuses the declaration before allocating
 * anything, and never publishes partial data: a missing, duplicated, reordered,
 * foreign, oversized, length-mismatched, or non-UTF-8 transfer leaves no
 * completed input behind. A completed input is a well-formed packet and nothing
 * more — it carries no authorization to write it to a child PTY, and the caller
 * still owes its own current-source and grant re-check.
 */
export function createNativeInputAssembler(
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): NativeInputAssembler {
	let partial: PartialNativeInput | undefined;
	/** Highest ordinal already completed; a replay can never complete twice. */
	let completedOrdinal = 0;
	const discard = (): void => {
		partial = undefined;
	};
	const refuse = (): never => {
		discard();
		fail("transfer_failed");
	};
	const complete = (
		subscriptionId: string,
		inputId: string,
		ordinal: number,
		source: NativeIoSource,
		inputModes: TerminalInputModes,
		kind: NativeIoInputKind,
		data: Buffer,
	): NativeIoCompletedInput => {
		// Duplicate or reordered ordinals never emit a second completed input.
		if (ordinal <= completedOrdinal) refuse();
		const text = decodeNativeIoText(data);
		if (kind === "mouse" && !NATIVE_IO_MOUSE_RE.test(text)) refuse();
		completedOrdinal = ordinal;
		return Object.freeze({
			subscriptionId,
			inputId,
			ordinal,
			source,
			inputModes,
			kind,
			data,
			text,
			byteLength: data.length,
		});
	};
	return Object.freeze({
		accept: (frame: SessionContentFrame): NativeIoCompletedInput | undefined => {
			if (frame.type === "input") {
				// An inline packet never interleaves with an open paged paste.
				if (partial !== undefined) refuse();
				const subscriptionId = readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
				const inputId = readIdentifier(frame.inputId, bounds.maxIdentifierBytes);
				const ordinal = readInteger(frame.ordinal, 1, Number.MAX_SAFE_INTEGER);
				const source = readNativeIoSource(frame.source, bounds);
				const inputModes = readInputModes(frame.inputModes);
				const kind = frame.kind;
				if (!isNativeIoInputKind(kind)) refuse();
				let data: Buffer;
				try {
					data = readNativeInputData(frame.data, kind, bounds);
				} catch (error) {
					discard();
					throw error;
				}
				return complete(subscriptionId, inputId, ordinal, source, inputModes, kind, data);
			}
			if (frame.type === "input_begin") {
				if (partial !== undefined) refuse();
				const subscriptionId = readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
				const inputId = readIdentifier(frame.inputId, bounds.maxIdentifierBytes);
				const ordinal = readInteger(frame.ordinal, 1, Number.MAX_SAFE_INTEGER);
				const source = readNativeIoSource(frame.source, bounds);
				const inputModes = readInputModes(frame.inputModes);
				if (frame.kind !== "paste") fail("bad_frame");
				const byteLength = readNativePasteByteLength(frame.byteLength, bounds);
				const chunkCount = readInteger(frame.chunkCount, 1, byteLength);
				if (chunkCount < Math.ceil(byteLength / bounds.maxChunkPayloadBytes)) fail("bad_frame");
				// A replayed ordinal is refused before any assembly buffer exists.
				if (ordinal <= completedOrdinal) refuse();
				partial = {
					subscriptionId,
					inputId,
					ordinal,
					source,
					inputModes,
					byteLength,
					chunkCount,
					buffer: undefined,
					written: 0,
					nextIndex: 0,
				};
				return undefined;
			}
			if (frame.type === "input_chunk") {
				const transfer = partial ?? refuse();
				if (frame.subscriptionId !== transfer.subscriptionId || frame.inputId !== transfer.inputId) {
					refuse();
				}
				if (frame.index !== transfer.nextIndex || frame.index >= transfer.chunkCount) refuse();
				let payload: Buffer;
				try {
					payload = readChunkPayload(frame.data, bounds);
				} catch (error) {
					// A malformed or oversized chunk discards the whole partial transfer.
					discard();
					throw error;
				}
				// Enforce the declared payload budget before copying anything.
				if (transfer.written + payload.length > transfer.byteLength) refuse();
				let buffer = transfer.buffer;
				if (buffer === undefined) {
					try {
						buffer = Buffer.allocUnsafe(transfer.byteLength);
					} catch {
						// An allocation the platform refuses is a bounded failure, not a crash.
						return refuse();
					}
					transfer.buffer = buffer;
				}
				payload.copy(buffer, transfer.written);
				transfer.written += payload.length;
				transfer.nextIndex += 1;
				return undefined;
			}
			if (frame.type === "input_end") {
				const transfer = partial ?? refuse();
				if (frame.subscriptionId !== transfer.subscriptionId
					|| frame.inputId !== transfer.inputId
					|| frame.ordinal !== transfer.ordinal) {
					refuse();
				}
				if (transfer.nextIndex !== transfer.chunkCount || transfer.written !== transfer.byteLength) {
					// Truncated, over-long, or chunk-count-inconsistent: never publish.
					refuse();
				}
				const buffer = transfer.buffer;
				discard();
				if (buffer === undefined) fail("transfer_failed");
				return complete(
					transfer.subscriptionId,
					transfer.inputId,
					transfer.ordinal,
					transfer.source,
					transfer.inputModes,
					"paste",
					buffer,
				);
			}
			// Control and viewport transfer frames belong to the endpoint state machine.
			return undefined;
		},
		reset: () => {
			discard();
		},
	});
}

/** Receive-side atomic assembly of one native text copy at a time. */
export interface NativeCopyAssembler {
	/**
	 * Consume one frame. Returns a completed copy only for an inline event that
	 * validates whole, or for a `copy_end` that exactly completes the begin tuple,
	 * sequence, chunk count, and declared payload length. A completed copy carries
	 * canonical base64 text and nothing executable: no raw OSC 52 sequence is ever
	 * produced, reassembled, or forwarded here.
	 */
	accept(frame: SessionContentFrame): NativeIoCompletedCopy | undefined;
	/**
	 * Drop any partial assembly. Idempotent; completed sequences stay committed, so
	 * a replayed emission order can never publish twice. A new binding uses a new
	 * assembler rather than reviving this one.
	 */
	reset(): void;
}

interface PartialNativeCopy {
	readonly subscriptionId: string;
	readonly copyId: string;
	readonly sequence: number;
	readonly source: NativeIoSource;
	readonly dispatchId: number;
	readonly byteLength: number;
	readonly chunkCount: number;
	buffer: Buffer | undefined;
	written: number;
	nextIndex: number;
}

/**
 * Create the atomic native text-copy assembler.
 *
 * Ordering is the copy sequence — the per-binding emission order — and nothing
 * else. The native input dispatch id is carried, never consulted: an
 * asynchronous copy caused by input A may legitimately arrive after input B's,
 * so a dispatch-id fence would silently drop real copies. A sequence this helper
 * already completed is refused as a replay, which is why `reset` releases only
 * buffered bytes and keeps the committed sequence.
 */
export function createNativeCopyAssembler(
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): NativeCopyAssembler {
	let partial: PartialNativeCopy | undefined;
	/** Highest emission-order sequence already completed by this helper. */
	let completedSequence = 0;
	const discard = (): void => {
		partial = undefined;
	};
	const refuse = (): never => {
		discard();
		fail("transfer_failed");
	};
	const complete = (
		subscriptionId: string,
		copyId: string,
		sequence: number,
		source: NativeIoSource,
		dispatchId: number,
		event: NativeIoCopyEvent,
	): NativeIoCompletedCopy => {
		// Emission order is the copy sequence; `dispatchId` never orders or fences.
		if (sequence <= completedSequence) refuse();
		// The completed event always names the header source's own native tuple.
		checkCopyTupleCoherence(source, event);
		completedSequence = sequence;
		return Object.freeze({ subscriptionId, copyId, sequence, source, dispatchId, event });
	};
	return Object.freeze({
		accept: (frame: SessionContentFrame): NativeIoCompletedCopy | undefined => {
			if (frame.type === "copy") {
				if (partial !== undefined) refuse();
				const subscriptionId = readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
				const copyId = readIdentifier(frame.copyId, bounds.maxIdentifierBytes);
				const sequence = readInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER);
				const source = readNativeIoSource(frame.source, bounds);
				const dispatchId = readInteger(frame.dispatchId, 1, Number.MAX_SAFE_INTEGER);
				let event: NativeIoCopyEvent;
				try {
					event = readNativeCopyEvent(frame.event, bounds);
				} catch (error) {
					discard();
					throw error;
				}
				return complete(subscriptionId, copyId, sequence, source, dispatchId, event);
			}
			if (frame.type === "copy_begin") {
				if (partial !== undefined) refuse();
				const subscriptionId = readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
				const copyId = readIdentifier(frame.copyId, bounds.maxIdentifierBytes);
				const sequence = readInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER);
				const source = readNativeIoSource(frame.source, bounds);
				const dispatchId = readInteger(frame.dispatchId, 1, Number.MAX_SAFE_INTEGER);
				const byteLength = readInteger(frame.byteLength, 1, NATIVE_COPY_MAX_ENCODED_CHARS);
				const chunkCount = readInteger(frame.chunkCount, 1, byteLength);
				if (chunkCount < Math.ceil(byteLength / bounds.maxChunkPayloadBytes)) fail("bad_frame");
				if (sequence <= completedSequence) refuse();
				partial = {
					subscriptionId,
					copyId,
					sequence,
					source,
					dispatchId,
					byteLength,
					chunkCount,
					buffer: undefined,
					written: 0,
					nextIndex: 0,
				};
				return undefined;
			}
			if (frame.type === "copy_chunk") {
				const transfer = partial ?? refuse();
				if (frame.subscriptionId !== transfer.subscriptionId || frame.copyId !== transfer.copyId) {
					refuse();
				}
				if (frame.index !== transfer.nextIndex || frame.index >= transfer.chunkCount) refuse();
				let payload: Buffer;
				try {
					payload = readChunkPayload(frame.data, bounds);
				} catch (error) {
					discard();
					throw error;
				}
				if (transfer.written + payload.length > transfer.byteLength) refuse();
				let buffer = transfer.buffer;
				if (buffer === undefined) {
					try {
						buffer = Buffer.allocUnsafe(transfer.byteLength);
					} catch {
						return refuse();
					}
					transfer.buffer = buffer;
				}
				payload.copy(buffer, transfer.written);
				transfer.written += payload.length;
				transfer.nextIndex += 1;
				return undefined;
			}
			if (frame.type === "copy_end") {
				const transfer = partial ?? refuse();
				if (frame.subscriptionId !== transfer.subscriptionId
					|| frame.copyId !== transfer.copyId
					|| frame.sequence !== transfer.sequence) {
					refuse();
				}
				if (transfer.nextIndex !== transfer.chunkCount || transfer.written !== transfer.byteLength) {
					// A partial, over-long, or reordered payload never yields an event.
					refuse();
				}
				const buffer = transfer.buffer;
				discard();
				if (buffer === undefined) fail("transfer_failed");
				// The assembled payload must be the producer's canonical, UTF-8 text
				// encoding before it can become a completed copy.
				const encoded = readNativeCopyEncoded(decodeNativeIoText(buffer));
				// The assembled payload inherits the header source's authenticated tuple,
				// so the completed event and the header source stay consistent by
				// construction and are re-checked by `complete`.
				return complete(
					transfer.subscriptionId,
					transfer.copyId,
					transfer.sequence,
					transfer.source,
					transfer.dispatchId,
					Object.freeze({
						kind: "copy",
						encoded,
						sessionId: transfer.source.nativeSession.sessionId,
						sessionEpoch: transfer.source.nativeSession.epoch,
					}),
				);
			}
			// Control and viewport transfer frames belong to the endpoint state machine.
			return undefined;
		},
		reset: () => {
			discard();
		},
	});
}
