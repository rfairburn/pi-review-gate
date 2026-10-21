/**
 * Fixed wire contract for the inert paired peer transport (issue #475).
 *
 * This module is a shared contract only: constants, bounds, and validation. It
 * performs no IO and never reads ambient configuration.
 *
 * The transport has exactly two fixed request shapes on one TLS listener:
 *
 * - `POST /pair` carries bounded pairing metadata in headers (`x-peer-label` and
 *   an optional `x-peer-key` claim) and no body. It is the only pre-acceptance
 *   path and never creates a session, channel, or application callback.
 * - `GET /app` is a fixed WebSocket upgrade using the exact `pi-peer-app-v1`
 *   subprotocol. It is admitted only after the live TLS peer key matches an
 *   accepted identity and a current directional grant.
 *
 * Friendly labels are display metadata, never identity. Identity is always the
 * exact SPKI of the certificate the peer proved possession of during the
 * current TLS handshake.
 */

export const PAIRING_PATH = "/pair";
export const APP_PATH = "/app";
export const APP_SUBPROTOCOL = "pi-peer-app-v1";
export const PEER_LABEL_HEADER = "x-peer-label";
export const PEER_KEY_HEADER = "x-peer-key";

/** Grants are always inbound to the listener that recorded them. */
export const GRANT_DIRECTION = "peer->host";
/** The only capability this adapter knows; no per-session permission policy. */
export const GRANT_CAPABILITY = "app";

/** Bound on a canonical key id (base64 SPKI DER) carried in a header. */
export const MAX_PEER_KEY_ID_CHARS = 512;

/** Explicit, finite transport bounds. Callers may override individual values. */
export interface PeerTransportBounds {
	readonly maxLabelBytes: number;
	readonly maxHttpHeaderBytes: number;
	readonly maxHttpHeaders: number;
	readonly maxPairResponseBytes: number;
	readonly maxWebSocketMessageBytes: number;
	readonly maxPendingConsents: number;
	readonly maxConnections: number;
	readonly maxConnectionsPerPeer: number;
	/** Client-side bound across pending operations and active channels. */
	readonly maxClientOperations: number;
	/** Admission bound for raw TCP/TLS sockets before any authorization. */
	readonly maxTransportSockets: number;
	readonly maxOutboundQueueBytes: number;
	readonly tlsHandshakeTimeoutMs: number;
	readonly consentTimeoutMs: number;
	/** Deadline for pairing response headers and body after TLS/consent. */
	readonly pairingResponseTimeoutMs: number;
	readonly requestTimeoutMs: number;
	readonly httpHeadersTimeoutMs: number;
	readonly closeTimeoutMs: number;
	readonly openTimeoutMs: number;
}

export const DEFAULT_PEER_TRANSPORT_BOUNDS: PeerTransportBounds = Object.freeze({
	maxLabelBytes: 64,
	maxHttpHeaderBytes: 4096,
	maxHttpHeaders: 20,
	maxPairResponseBytes: 2048,
	maxWebSocketMessageBytes: 65_536,
	maxPendingConsents: 8,
	maxConnections: 16,
	maxConnectionsPerPeer: 4,
	maxClientOperations: 16,
	maxTransportSockets: 32,
	maxOutboundQueueBytes: 262_144,
	tlsHandshakeTimeoutMs: 5000,
	consentTimeoutMs: 15_000,
	pairingResponseTimeoutMs: 10_000,
	requestTimeoutMs: 10_000,
	httpHeadersTimeoutMs: 5000,
	closeTimeoutMs: 2000,
	openTimeoutMs: 5000,
});

const BOUND_KEYS = Object.keys(DEFAULT_PEER_TRANSPORT_BOUNDS) as ReadonlyArray<keyof PeerTransportBounds>;

/**
 * Resolve explicit overrides against the fixed defaults. Every value must be a
 * finite positive integer; there is no unbounded "0 means disabled" mode.
 */
export function resolvePeerTransportBounds(overrides: Partial<PeerTransportBounds> = {}): PeerTransportBounds {
	const resolved: Record<keyof PeerTransportBounds, number> = { ...DEFAULT_PEER_TRANSPORT_BOUNDS };
	for (const key of BOUND_KEYS) {
		const value = overrides[key];
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw peerError("INVALID_ARGUMENT");
		}
		resolved[key] = value;
	}
	return Object.freeze(resolved);
}

/** Fixed paths are matched exactly; queries and fragments are refused. */
export function matchFixedPeerPath(rawUrl: string | undefined): typeof PAIRING_PATH | typeof APP_PATH | null {
	if (typeof rawUrl !== "string") return null;
	let parsed: URL;
	try {
		parsed = new URL(rawUrl, "https://peer.invalid");
	} catch {
		return null;
	}
	if (parsed.search !== "" || parsed.hash !== "") return null;
	if (parsed.pathname === PAIRING_PATH) return PAIRING_PATH;
	if (parsed.pathname === APP_PATH) return APP_PATH;
	return null;
}

/**
 * Labels are bounded, line-safe display strings. They are never authority and
 * are never compared as identity.
 */
export function isValidPeerLabel(
	value: unknown,
	maxBytes: number = DEFAULT_PEER_TRANSPORT_BOUNDS.maxLabelBytes,
): value is string {
	if (typeof value !== "string") return false;
	if (value.length === 0) return false;
	if (Buffer.byteLength(value, "utf8") > maxBytes) return false;
	return /^[0-9A-Za-z ._@:()\-]+$/.test(value);
}

/** Structural bound for a canonical key id carried on the wire. */
export function isBoundedPeerKeyId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PEER_KEY_ID_CHARS) return false;
	return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** Fixed, sanitized wire error codes. No raw exception text is ever sent. */
export type PeerWireErrorCode =
	| "aborted"
	| "app_unavailable"
	| "bad_request"
	| "claim_mismatch"
	| "denied"
	| "header_too_large"
	| "invalid_label"
	| "method_not_allowed"
	| "no_client_certificate"
	| "no_http_endpoint"
	| "not_authorized"
	| "pairing_failed"
	| "timeout"
	| "too_many_connections"
	| "too_many_pending"
	| "unexpected_body"
	| "unknown_path"
	| "unsupported_subprotocol"
	| "upgrade_not_allowed";

/** Sanitized transport error codes used by callers and diagnostics. */
export type PeerTransportErrorCode =
	| "ABORTED"
	| "APP_REFUSED"
	| "APP_TIMEOUT"
	| "CALLER_HANDLER_FAILED"
	| "CHANNEL_CLOSED"
	| "CHANNEL_NOT_OPEN"
	| "CLIENT_LIMIT_REACHED"
	| "CONSENT_LIMIT_REACHED"
	| "HOST_CLOSED"
	| "IDENTITY_ENCODING_INVALID"
	| "IDENTITY_KEY_MISMATCH"
	| "INVALID_ARGUMENT"
	| "LISTENER_BIND_FAILED"
	| "MESSAGE_TOO_LARGE"
	| "OUTBOUND_QUEUE_FULL"
	| "PAIRING_DENIED"
	| "PAIRING_FAILED"
	| "PAIRING_HANDSHAKE_COUNT_MISMATCH"
	| "PAIRING_KEY_ECHO_MISMATCH"
	| "PAIRING_RESPONSE_INVALID"
	| "PAIRING_RESPONSE_TOO_LARGE"
	| "PAIRING_TIMEOUT"
	| "PEER_CERTIFICATE_INVALID"
	| "PEER_CERTIFICATE_MISSING"
	| "PEER_KEY_APPROVER_FAILED"
	| "PEER_KEY_CANCELLED"
	| "PEER_KEY_CHANGED"
	| "PEER_KEY_DECISION_INVALID"
	| "PEER_KEY_MISMATCH"
	| "PEER_KEY_PROMPT_TIMEOUT"
	| "PEER_KEY_REJECTED"
	| "SEND_FAILED"
	| "TLS_CONNECTION_CLOSED"
	| "TLS_HANDSHAKE_FAILED"
	| "TLS_HANDSHAKE_TIMEOUT"
	| "TLS_SESSION_RESUMED"
	| "TRUST_STORE_FAILED"
	| "UNSUPPORTED_KEY_TYPE";

const PEER_ERROR_MESSAGES: Record<PeerTransportErrorCode, string> = {
	ABORTED: "peer transport operation was aborted",
	APP_REFUSED: "peer application channel was refused",
	APP_TIMEOUT: "peer application channel did not open in time",
	CALLER_HANDLER_FAILED: "caller-provided peer handler failed",
	CHANNEL_CLOSED: "peer channel is closed",
	CHANNEL_NOT_OPEN: "peer channel is not open",
	CLIENT_LIMIT_REACHED: "client peer operation bound was reached",
	CONSENT_LIMIT_REACHED: "client peer consent bound was reached",
	HOST_CLOSED: "peer host is closed",
	IDENTITY_ENCODING_INVALID: "peer identity material is not a bounded supported encoding",
	IDENTITY_KEY_MISMATCH: "peer certificate does not match the supplied private key",
	INVALID_ARGUMENT: "invalid peer transport argument",
	LISTENER_BIND_FAILED: "peer listener could not bind the explicit address",
	MESSAGE_TOO_LARGE: "peer message exceeds the configured bound",
	OUTBOUND_QUEUE_FULL: "peer outbound queue bound was reached",
	PAIRING_DENIED: "peer pairing was denied",
	PAIRING_FAILED: "peer pairing failed",
	PAIRING_HANDSHAKE_COUNT_MISMATCH: "pairing decision did not arrive on one verified handshake",
	PAIRING_KEY_ECHO_MISMATCH: "peer accepted a key other than the one proved over TLS",
	PAIRING_RESPONSE_INVALID: "peer pairing response was invalid",
	PAIRING_RESPONSE_TOO_LARGE: "peer pairing response exceeded the configured bound",
	PAIRING_TIMEOUT: "peer pairing timed out",
	PEER_CERTIFICATE_INVALID: "peer presented an unusable certificate",
	PEER_CERTIFICATE_MISSING: "peer presented no certificate",
	PEER_KEY_APPROVER_FAILED: "local peer-key approval handler failed",
	PEER_KEY_CANCELLED: "local peer-key approval was cancelled",
	PEER_KEY_CHANGED: "remembered peer identity changed during the connection",
	PEER_KEY_DECISION_INVALID: "local peer-key approval returned an unsupported decision",
	PEER_KEY_MISMATCH: "peer key does not match the exact remembered identity",
	PEER_KEY_PROMPT_TIMEOUT: "local peer-key approval timed out",
	PEER_KEY_REJECTED: "local peer key was rejected",
	SEND_FAILED: "peer channel send failed",
	TLS_CONNECTION_CLOSED: "peer TLS connection closed before acceptance",
	TLS_HANDSHAKE_FAILED: "peer TLS handshake failed",
	TLS_HANDSHAKE_TIMEOUT: "peer TLS handshake did not complete in time",
	TLS_SESSION_RESUMED: "resumed TLS session has no fresh key proof",
	TRUST_STORE_FAILED: "injected peer trust store failed",
	UNSUPPORTED_KEY_TYPE: "peer identity key type is not supported by this transport",
};

/** Sanitized error: fixed code and fixed message, never raw TLS or peer data. */
export class PeerTransportError extends Error {
	readonly code: PeerTransportErrorCode;
	/** Non-sensitive HTTP status when a peer refused an application upgrade. */
	readonly statusCode: number | undefined;

	constructor(code: PeerTransportErrorCode, statusCode?: number) {
		super(PEER_ERROR_MESSAGES[code]);
		this.name = "PeerTransportError";
		this.code = code;
		this.statusCode = statusCode;
	}
}

export function peerError(code: PeerTransportErrorCode, statusCode?: number): PeerTransportError {
	return new PeerTransportError(code, statusCode);
}

export function isPeerTransportError(value: unknown): value is PeerTransportError {
	return value instanceof PeerTransportError;
}

/** Fixed diagnostic codes. No labels, keys, PEM, payloads, or paths. */
export type PeerDiagnosticCode =
	| "app_channel_closed"
	| "app_channel_opened"
	| "app_refused"
	| "client_connected"
	| "client_key_accepted"
	| "client_key_mismatch"
	| "client_key_observed"
	| "host_closed"
	| "host_connected"
	| "host_connection_refused"
	| "host_disconnected"
	| "host_resumption_rejected"
	| "pairing_aborted"
	| "pairing_accepted"
	| "pairing_denied"
	| "pairing_requested"
	| "pairing_timeout"
	| "tls_error";

export type PeerDiagnosticRole = "client" | "host";

export interface PeerDiagnostic {
	readonly code: PeerDiagnosticCode;
	readonly role: PeerDiagnosticRole;
	readonly statusCode?: number;
	readonly count?: number;
	readonly bytes?: number;
}

export type PeerDiagnosticSink = (event: PeerDiagnostic) => void;

/**
 * Diagnostics are optional and sanitized. A throwing sink is disabled for that
 * adapter instance rather than being allowed to affect security decisions.
 */
export function emitDiagnostic(sink: PeerDiagnosticSink | undefined, event: PeerDiagnostic): boolean {
	if (!sink) return true;
	try {
		sink(event);
		return true;
	} catch {
		return false;
	}
}
