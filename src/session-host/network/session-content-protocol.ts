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
 * There is no transcript, configuration, auth, current-file, or clipboard
 * capsule field, and no raw child PTY byte or escape payload: frame line text is
 * restricted to the native serializer's visible text plus exactly the SGR forms
 * its own generator emits (allowlisted attributes and bounded palette/RGB
 * groups), and typing is validated by the same Kitty PNG validator the native
 * surface uses rather than by a weaker duplicate.
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
 * Optional capabilities this implementation knows. None exist yet, so an
 * identifier offered by a peer is recorded only when it appears here and is
 * otherwise ignored — an unimplemented capability can never be assumed.
 */
export const SESSION_CONTENT_KNOWN_OPTIONAL_CAPABILITIES: readonly string[] = Object.freeze([]);

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

export type SessionContentFrame = SessionContentControlFrame | SessionContentTransferFrame;

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
	]),
	content_chunk: new Set(["type", "subscriptionId", "transferId", "index", "data"]),
	content_end: new Set(["type", "subscriptionId", "transferId", "sequence"]),
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
			readIdentifier(frame.hostRunId, bounds.maxIdentifierBytes);
			readIdentifier(frame.sessionId, bounds.maxIdentifierBytes);
			readNativeSession(frame.nativeSession, bounds);
			readInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER);
			readGeometry(frame.geometry, bounds);
			readInputModes(frame.inputModes);
			const byteLength = readInteger(frame.byteLength, 1, bounds.maxTransferBytes);
			const chunkCount = readInteger(frame.chunkCount, 1, byteLength);
			const minimumChunks = Math.ceil(byteLength / bounds.maxChunkPayloadBytes);
			if (chunkCount < minimumChunks) fail("invalid_frame");
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
			return Object.freeze({
				type,
				subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
				transferId: readIdentifier(ownField(record, "transferId"), bounds.maxIdentifierBytes),
				hostRunId: readIdentifier(ownField(record, "hostRunId"), bounds.maxIdentifierBytes),
				sessionId: readIdentifier(ownField(record, "sessionId"), bounds.maxIdentifierBytes),
				nativeSession: readNativeSession(ownField(record, "nativeSession"), bounds),
				sequence: readInteger(ownField(record, "sequence"), 1, Number.MAX_SAFE_INTEGER),
				geometry: readGeometry(ownField(record, "geometry"), bounds),
				inputModes: readInputModes(ownField(record, "inputModes")),
				byteLength,
				chunkCount,
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
 * Owner-side decision on one hello. A different service or major version is
 * refused, and a hello without the native-viewport capability is refused.
 * Unknown optional capabilities are ignored rather than trusted, and the
 * negotiated minor is the lower of the two so a newer peer cannot imply
 * behavior this implementation does not have.
 */
export function negotiateSessionContentHello(hello: SessionContentHelloFrame): SessionContentNegotiation {
	if (hello.service !== SESSION_CONTENT_SERVICE || hello.major !== SESSION_CONTENT_MAJOR) {
		return { ok: false, code: "unsupported_version" };
	}
	if (!hello.capabilities.includes(SESSION_CONTENT_REQUIRED_CAPABILITY)) {
		return { ok: false, code: "missing_capability" };
	}
	const negotiated = hello.capabilities.filter((capability) =>
		capability !== SESSION_CONTENT_REQUIRED_CAPABILITY
		&& SESSION_CONTENT_KNOWN_OPTIONAL_CAPABILITIES.includes(capability));
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
 * acknowledgement that claims a capability this side never offered, or a minor
 * above the one offered, is a protocol violation: negotiation can only narrow
 * what either side may assume, never widen it.
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
