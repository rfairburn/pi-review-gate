/**
 * Receiving half of the inert paired peer transport.
 *
 * One TLS listener (`https.Server`, `requestCert: true`,
 * `rejectUnauthorized: false` for its whole lifetime) carries exactly two fixed
 * request shapes:
 *
 * - `POST /pair`: bounded pairing metadata only. The injected receiving human
 *   approval is bound to the exact client key from the live TLS handshake and to
 *   this listener's stable receiving identity. Nothing application-shaped exists
 *   here.
 * - `GET /app`: fixed WSS upgrade. The gate re-derives the client key from the
 *   live certificate, requires the exact accepted identity and a current
 *   directional grant (`peer->host`) recorded for this stable receiving
 *   identity, and only then calls `wss.handleUpgrade`.
 *
 * Pairing and approval records are not scoped to a listener or process instance.
 * Closing and recreating a listener with the same identity and the same injected
 * stores preserves remembered access; a different receiving identity cannot use
 * those records. Pending approvals and cancellation remain instance-local and
 * fail closed after close.
 *
 * `rejectUnauthorized: false` is used narrowly so a self-signed peer key reaches
 * the exact local key comparison; it is not CA trust, and no requestCert mode
 * switching, renegotiation, private Node API, or synthetic connection event is
 * used. A resumed TLS session has no fresh key proof and is refused.
 *
 * Accepted identities and directional grants are injected stores. No filesystem,
 * ambient configuration, listener UI, or session policy is consulted.
 */

import { randomUUID } from "node:crypto";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import WebSocket from "ws";
import {
	APP_PATH,
	APP_SUBPROTOCOL,
	GRANT_CAPABILITY,
	GRANT_DIRECTION,
	PAIRING_PATH,
	PEER_KEY_HEADER,
	PEER_LABEL_HEADER,
	emitDiagnostic,
	isBoundedPeerKeyId,
	isPeerTransportError,
	isValidPeerLabel,
	matchFixedPeerPath,
	peerError,
	resolvePeerTransportBounds,
	type PeerDiagnostic,
	type PeerDiagnosticCode,
	type PeerDiagnosticSink,
	type PeerTransportBounds,
	type PeerWireErrorCode,
} from "./protocol";
import {
	loadOwnedPeerIdentity,
	isWellFormedPeerKey,
	peerKeyFromPeerCertificate,
	peerKeysEqual,
	type OwnedPeerIdentity,
	type PeerIdentityMaterial,
	type PeerKey,
} from "./identity";
import type { AcceptedPeerRecord, AcceptedPeerStore, DirectionalGrantRecord, DirectionalGrantStore } from "./trust";
import {
	createPeerByteChannel,
	type PeerByteChannel,
} from "./channel";

export interface PeerPairingRequest {
	/** Exact key from the live TLS handshake, never a claimed header value. */
	readonly peerKey: PeerKey;
	/** Bounded friendly label only; never identity. */
	readonly label: string;
	readonly requestedAt: number;
	isPending(): boolean;
	/** Commit acceptance and the inbound grant; false when the connection is gone. */
	approve(): boolean;
	/** Deny without creating any accepted identity or grant. */
	deny(): boolean;
}

export type PeerPairingRequestHandler = (request: PeerPairingRequest) => void | Promise<void>;
export type PeerAppChannelHandler = (channel: PeerByteChannel) => void | Promise<void>;
export type PeerHostChannel = PeerByteChannel;

export interface PeerHostStats {
	tlsConnections: number;
	tlsErrors: number;
	httpRequests: number;
	upgrades: number;
	resumptionsRejected: number;
	pairingRequests: number;
	pairingAccepted: number;
	pairingDenied: number;
	pairingTimeouts: number;
	pairingAborted: number;
	pairingFailed: number;
	appGateDenied: number;
	appChannelsOpened: number;
}

export interface PeerPairingTestHooks {
	/**
	 * Test-only fixture injection: observes each pending pairing connection with
	 * a destroy-only handle. It cannot write, authorize, or alter trust, and it
	 * exists so a test can reproduce a live socket disappearing before its close
	 * event is delivered. Production integration must not set this hook.
	 */
	readonly onPairingConnection?: (connection: { destroy(): void }) => void;
}

export interface PeerHostOptions {
	readonly identity: OwnedPeerIdentity | PeerIdentityMaterial;
	readonly acceptedPeers: AcceptedPeerStore;
	readonly grants: DirectionalGrantStore;
	readonly onPairingRequest?: PeerPairingRequestHandler;
	readonly onAppChannel?: PeerAppChannelHandler;
	readonly bounds?: Partial<PeerTransportBounds>;
	readonly onDiagnostic?: PeerDiagnosticSink;
	/** Test-only fixture injection; see `PeerPairingTestHooks`. */
	readonly testHooks?: PeerPairingTestHooks;
}

export interface PeerHostListenOptions {
	/** Explicit bind address; there is no public or wildcard default. */
	readonly host: string;
	/** Explicit port; tests normally use 0 for an owned loopback port. */
	readonly port: number;
}

export interface PeerHost {
	readonly identity: OwnedPeerIdentity;
	readonly key: PeerKey;
	readonly listening: boolean;
	readonly port: number | null;
	readonly pendingPairingCount: number;
	readonly activeChannelCount: number;
	/** Raw TCP/TLS sockets currently admitted, including pre-handshake sockets. */
	readonly transportSocketCount: number;
	readonly stats: PeerHostStats;
	listen(options: PeerHostListenOptions): Promise<{ host: string; port: number }>;
	close(): Promise<void>;
	/** Remove accepted identity and grant for a key; active channels stay untouched. */
	revoke(key: PeerKey | string): boolean;
}

type PairingOutcome = "accepted" | "denied" | "timeout" | "aborted";

interface PendingPairing {
	readonly connectionId: string;
	readonly peerKey: PeerKey;
	readonly decide: (outcome: PairingOutcome) => boolean;
}

const STATUS_REASONS: Readonly<Record<number, string>> = Object.freeze({
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	408: "Request Timeout",
	429: "Too Many Requests",
	431: "Request Header Fields Too Large",
	500: "Internal Server Error",
	503: "Service Unavailable",
});

const WEBSOCKET_KEY = /^[+/0-9A-Za-z]{22}==$/;

function firstHeader(value: string | string[] | undefined): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.length === 1) return value[0];
	return null;
}

function rawHeaderCount(request: IncomingMessage): number {
	return Math.floor(request.rawHeaders.length / 2);
}

function rawHeaderBytes(request: IncomingMessage): number {
	let total = 0;
	for (const value of request.rawHeaders) total += Buffer.byteLength(value, "utf8") + 2;
	return total;
}

function peerKeyOfSocket(socket: unknown): PeerKey | null {
	const candidate = socket as { getPeerCertificate?: () => unknown };
	if (typeof candidate.getPeerCertificate !== "function") return null;
	try {
		return peerKeyFromPeerCertificate(candidate.getPeerCertificate());
	} catch {
		return null;
	}
}

function fixedResponseBody(code: PeerWireErrorCode): string {
	return JSON.stringify({ error: code });
}

function writeHttpResponse(
	response: ServerResponse,
	status: number,
	payload: Record<string, unknown>,
): void {
	if (response.writableEnded || response.destroyed) return;
	const body = JSON.stringify(payload);
	try {
		response.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(body),
			"cache-control": "no-store",
			connection: "close",
		});
		response.end(body);
	} catch {
		try {
			response.destroy();
		} catch {
			// Already gone.
		}
	}
}

function rejectHttp(response: ServerResponse, status: number, code: PeerWireErrorCode): void {
	writeHttpResponse(response, status, { error: code });
}

function rejectSocket(socket: Duplex, status: number, code: PeerWireErrorCode): void {
	if (socket.destroyed) return;
	const body = fixedResponseBody(code);
	const head =
		`HTTP/1.1 ${status} ${STATUS_REASONS[status] ?? "Error"}\r\n` +
		"content-type: application/json\r\n" +
		`content-length: ${Buffer.byteLength(body)}\r\n` +
		"cache-control: no-store\r\n" +
		"connection: close\r\n\r\n";
	try {
		socket.end(head + body);
	} catch {
		try {
			socket.destroy();
		} catch {
			// Already gone.
		}
	}
}

function validateListenAddress(host: unknown, port: unknown): { host: string; port: number } {
	if (
		typeof host !== "string" ||
		host.length === 0 ||
		host.length > 255 ||
		/[\s/\\?#@]/.test(host) ||
		typeof port !== "number" ||
		!Number.isInteger(port) ||
		port < 0 ||
		port > 65_535
	) {
		throw peerError("INVALID_ARGUMENT");
	}
	return { host, port };
}

export function createPeerHost(options: PeerHostOptions): PeerHost {
	if (!options || typeof options !== "object") throw peerError("INVALID_ARGUMENT");
	const identity = loadOwnedPeerIdentity(options.identity);
	if (
		typeof options.acceptedPeers?.get !== "function" ||
		typeof options.acceptedPeers.set !== "function" ||
		typeof options.acceptedPeers.delete !== "function" ||
		typeof options.grants?.get !== "function" ||
		typeof options.grants.set !== "function" ||
		typeof options.grants.delete !== "function"
	) {
		throw peerError("INVALID_ARGUMENT");
	}
	const bounds = resolvePeerTransportBounds(options.bounds);
	const acceptedPeers = options.acceptedPeers;
	const grants = options.grants;
	const onDiagnostic = options.onDiagnostic;
	const receiverKeyId = identity.key.keyId;
	const stats: PeerHostStats = {
		tlsConnections: 0,
		tlsErrors: 0,
		httpRequests: 0,
		upgrades: 0,
		resumptionsRejected: 0,
		pairingRequests: 0,
		pairingAccepted: 0,
		pairingDenied: 0,
		pairingTimeouts: 0,
		pairingAborted: 0,
		pairingFailed: 0,
		appGateDenied: 0,
		appChannelsOpened: 0,
	};

	let diagnosticSinkEnabled = true;
	const diagnostic = (code: PeerDiagnosticCode, extra?: { statusCode?: number; count?: number }): void => {
		if (!diagnosticSinkEnabled) return;
		const event: PeerDiagnostic = {
			code,
			role: "host",
			...(extra?.statusCode === undefined ? {} : { statusCode: extra.statusCode }),
			...(extra?.count === undefined ? {} : { count: extra.count }),
		};
		diagnosticSinkEnabled = emitDiagnostic(onDiagnostic, event);
	};

	const pending = new Map<string, PendingPairing>();
	const pendingTimers = new Set<NodeJS.Timeout>();
	const rawSockets = new Set<Duplex>();
	const tlsSockets = new Set<TLSSocket>();
	const appChannels = new Map<InstanceType<typeof WebSocket>, PeerByteChannel>();
	const activePerPeer = new Map<string, number>();
	const pendingPerPeer = new Map<string, number>();
	let pendingUpgrades = 0;
	let listenStartup: Promise<void> | null = null;
	let serverClosePromise: Promise<void> | null = null;
	let closing: Promise<void> | null = null;
	let closed = false;

	const wss = new WebSocket.WebSocketServer({
		noServer: true,
		clientTracking: false,
		perMessageDeflate: false,
		autoPong: false,
		maxPayload: bounds.maxWebSocketMessageBytes,
		handleProtocols: (protocols: Set<string>) => (protocols.has(APP_SUBPROTOCOL) ? APP_SUBPROTOCOL : false),
		// ws 8.22.0 supports closeTimeout; the pinned @types/ws 8.18.2 does not declare it.
		closeTimeout: bounds.closeTimeoutMs,
	} as WebSocket.ServerOptions & { closeTimeout: number });
	wss.on("error", () => diagnostic("tls_error"));
	wss.on("wsClientError", (_error: Error, socket: Duplex) => {
		// ws can abort a malformed upgrade before our handler sees it; keep the
		// refusal sanitized and the socket owned.
		rejectSocket(socket, 400, "bad_request");
	});

	const server = https.createServer(
		{
			key: identity.privateKeyPem,
			cert: identity.certificatePem,
			requestCert: true,
			rejectUnauthorized: false,
			minVersion: "TLSv1.2",
			maxVersion: "TLSv1.3",
			maxHeaderSize: bounds.maxHttpHeaderBytes,
			handshakeTimeout: bounds.tlsHandshakeTimeoutMs,
		},
		handleRequest,
	);
	server.maxHeadersCount = bounds.maxHttpHeaders;
	server.requestTimeout = bounds.requestTimeoutMs;
	server.headersTimeout = Math.min(bounds.httpHeadersTimeoutMs, bounds.requestTimeoutMs);
	server.keepAliveTimeout = 500;
	server.on("error", () => diagnostic("tls_error"));

	const closeListener = (): Promise<void> => {
		if (serverClosePromise) return serverClosePromise;
		serverClosePromise = new Promise<void>((resolve) => {
			if (!server.listening) {
				resolve();
				return;
			}
			server.closeAllConnections?.();
			server.closeIdleConnections?.();
			try {
				server.close(() => resolve());
			} catch {
				resolve();
			}
		});
		return serverClosePromise;
	};

	server.prependListener("connection", (socket: Duplex) => {
		if (rawSockets.size >= bounds.maxTransportSockets) {
			// Admission is bounded before TLS or application work. Destroy the
			// excess raw socket immediately so unauthenticated peers cannot grow
			// descriptor or buffer state without limit.
			diagnostic("host_connection_refused");
			try {
				socket.destroy();
			} catch {
				// Already gone.
			}
			return;
		}
		rawSockets.add(socket);
		socket.once("close", () => {
			rawSockets.delete(socket);
			diagnostic("host_disconnected");
		});
		socket.on("error", () => {
			// Owned socket errors are expected during teardown.
		});
		diagnostic("host_connected");
	});

	server.on("secureConnection", (socket: TLSSocket) => {
		stats.tlsConnections++;
		tlsSockets.add(socket);
		socket.once("close", () => tlsSockets.delete(socket));
		socket.on("error", () => {
			// Owned socket errors are expected during teardown.
		});
		if (socket.isSessionReused()) {
			// A resumed session has no fresh CertificateVerify, so a key's
			// proof-of-possession would be stale. Refuse rather than bind trust to
			// unproven session state.
			stats.resumptionsRejected++;
			diagnostic("host_resumption_rejected");
			try {
				socket.destroy();
			} catch {
				// Already gone.
			}
			return;
		}
		try {
			socket.disableRenegotiation();
		} catch {
			// TLS 1.3 has no renegotiation; older stacks may already disable it.
		}
	});

	server.on("tlsClientError", (_error: Error, socket: Duplex) => {
		stats.tlsErrors++;
		diagnostic("tls_error");
		try {
			socket.destroy();
		} catch {
			// Already gone.
		}
	});

	server.on("clientError", (error: Error, socket: Duplex) => {
		const status = (error as { code?: string }).code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
		rejectSocket(socket, status, status === 431 ? "header_too_large" : "bad_request");
	});

	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		handleUpgrade(request, socket, head);
	});

	function safeAccepted(keyId: string): AcceptedPeerRecord | undefined {
		return acceptedPeers.get(keyId);
	}

	function safeGrant(keyId: string): DirectionalGrantRecord | undefined {
		return grants.get(keyId);
	}

	function isCurrentAccepted(record: AcceptedPeerRecord | undefined, peerKey: PeerKey): boolean {
		return (
			record !== undefined &&
			record.receiverKeyId === receiverKeyId &&
			isWellFormedPeerKey(record.key) &&
			peerKeysEqual(record.key, peerKey)
		);
	}

	function isCurrentGrant(record: DirectionalGrantRecord | undefined, peerKey: PeerKey): boolean {
		return (
			record !== undefined &&
			record.receiverKeyId === receiverKeyId &&
			record.peerKeyId === peerKey.keyId &&
			record.direction === GRANT_DIRECTION &&
			record.capability === GRANT_CAPABILITY
		);
	}

	function respondAlreadyAccepted(response: ServerResponse, peerKey: PeerKey): void {
		writeHttpResponse(response, 200, {
			status: "already_accepted",
			acceptedPeerKey: peerKey.keyId,
		});
	}

	function handleRequest(request: IncomingMessage, response: ServerResponse): void {
		stats.httpRequests++;
		const peerKey = peerKeyOfSocket(request.socket);
		if (rawHeaderBytes(request) > bounds.maxHttpHeaderBytes || rawHeaderCount(request) > bounds.maxHttpHeaders) {
			rejectHttp(response, 431, "header_too_large");
			return;
		}
		const path = matchFixedPeerPath(request.url);
		if (path !== PAIRING_PATH) {
			rejectHttp(response, 404, "unknown_path");
			return;
		}
		if (request.method !== "POST") {
			rejectHttp(response, 405, "method_not_allowed");
			return;
		}
		if (!peerKey) {
			rejectHttp(response, 401, "no_client_certificate");
			return;
		}
		if (request.headers.upgrade !== undefined) {
			rejectHttp(response, 400, "upgrade_not_allowed");
			return;
		}
		const labelHeader = request.headers[PEER_LABEL_HEADER];
		const label = typeof labelHeader === "string" ? labelHeader.trim() : "";
		if (!isValidPeerLabel(label, bounds.maxLabelBytes)) {
			rejectHttp(response, 400, "invalid_label");
			return;
		}
		if (request.headers["transfer-encoding"] !== undefined || request.headers.expect !== undefined) {
			rejectHttp(response, 400, "unexpected_body");
			return;
		}
		const rawLength = request.headers["content-length"];
		if (rawLength !== undefined) {
			const contentLength = Number(rawLength);
			if (!Number.isSafeInteger(contentLength) || contentLength !== 0) {
				rejectHttp(response, 400, "unexpected_body");
				return;
			}
		}
		const claimHeader = request.headers[PEER_KEY_HEADER];
		const claim = typeof claimHeader === "string" ? claimHeader.trim() : undefined;
		if (claimHeader !== undefined && claim !== undefined && claim !== peerKey.keyId) {
			// Names and claimed keys are not identity. The live TLS certificate is.
			rejectHttp(response, 400, "claim_mismatch");
			return;
		}
		if (claimHeader !== undefined && (claim === undefined || !isBoundedPeerKeyId(claim))) {
			rejectHttp(response, 400, "claim_mismatch");
			return;
		}
		handlePairing(request, response, peerKey, label);
	}

	function handlePairing(
		request: IncomingMessage,
		response: ServerResponse,
		peerKey: PeerKey,
		label: string,
	): void {
		stats.pairingRequests++;
		if (closed) {
			rejectHttp(response, 503, "pairing_failed");
			return;
		}
		if (pending.size >= bounds.maxPendingConsents) {
			rejectHttp(response, 429, "too_many_pending");
			return;
		}

		let existingAccepted: AcceptedPeerRecord | undefined;
		let existingGrant: DirectionalGrantRecord | undefined;
		try {
			existingAccepted = safeAccepted(peerKey.keyId);
			existingGrant = safeGrant(peerKey.keyId);
		} catch {
			rejectHttp(response, 500, "pairing_failed");
			return;
		}
		if (isCurrentAccepted(existingAccepted, peerKey) && isCurrentGrant(existingGrant, peerKey)) {
			// Idempotent confirmation of a key this receiving identity already accepted.
			respondAlreadyAccepted(response, peerKey);
			return;
		}

		diagnostic("pairing_requested");
		const connectionId = randomUUID();
		let settled = false;
		let timer: NodeJS.Timeout | null = null;

		const connectionIsLive = (): boolean =>
			!closed &&
			!request.destroyed &&
			!request.socket.destroyed &&
			!request.socket.readableEnded &&
			!response.destroyed &&
			!response.writableEnded &&
			!response.writableFinished;

		const decide = (outcome: PairingOutcome): boolean => {
			if (settled) return false;
			let effective = outcome;
			if (outcome === "accepted" && !connectionIsLive()) effective = "aborted";
			settled = true;
			if (timer) {
				clearTimeout(timer);
				pendingTimers.delete(timer);
				timer = null;
			}
			pending.delete(connectionId);

			if (effective === "accepted") {
				try {
					acceptedPeers.set({
						key: peerKey,
						label,
						acceptedAt: Date.now(),
						receiverKeyId,
					});
					try {
						grants.set({
							peerKeyId: peerKey.keyId,
							direction: GRANT_DIRECTION,
							capability: GRANT_CAPABILITY,
							grantedAt: Date.now(),
							receiverKeyId,
						});
					} catch (error) {
						try {
							acceptedPeers.delete(peerKey.keyId);
						} catch {
							// Store failure is already fail-closed; no grant exists.
						}
						throw error;
					}
				} catch {
					stats.pairingFailed++;
					diagnostic("pairing_denied");
					rejectHttp(response, 500, "pairing_failed");
					return false;
				}
				stats.pairingAccepted++;
				diagnostic("pairing_accepted");
				writeHttpResponse(response, 200, { status: "accepted", acceptedPeerKey: peerKey.keyId });
				return true;
			}
			if (effective === "timeout") {
				stats.pairingTimeouts++;
				diagnostic("pairing_timeout");
				writeHttpResponse(response, 408, { status: "timeout" });
			} else if (effective === "denied") {
				stats.pairingDenied++;
				diagnostic("pairing_denied");
				writeHttpResponse(response, 403, { status: "denied" });
			} else {
				stats.pairingAborted++;
				diagnostic("pairing_aborted");
				writeHttpResponse(response, 400, { status: "aborted" });
			}
			return effective === outcome;
		};

		const pairingRequest: PeerPairingRequest = Object.freeze({
			peerKey,
			label,
			requestedAt: Date.now(),
			isPending: () => !settled,
			approve: () => decide("accepted"),
			deny: () => decide("denied"),
		});
		pending.set(connectionId, { connectionId, peerKey, decide });
		timer = setTimeout(() => decide("timeout"), bounds.consentTimeoutMs);
		timer.unref?.();
		pendingTimers.add(timer);

		request.socket.once("close", () => {
			if (!settled) decide("aborted");
		});
		response.once("close", () => {
			if (!settled) decide("aborted");
		});

		if (options.testHooks !== undefined) {
			if (typeof options.testHooks !== "object" || options.testHooks === null) {
				decide("denied");
				return;
			}
			const testHook = options.testHooks.onPairingConnection;
			if (testHook !== undefined) {
				if (typeof testHook !== "function") {
					decide("denied");
					return;
				}
				try {
					testHook({
						destroy: () => {
							try {
								request.socket.destroy();
							} catch {
								// Already gone.
							}
						},
					});
				} catch {
					// A fixture failure is fail-closed, like any caller exception.
					decide("denied");
					return;
				}
			}
		}

		const handler = options.onPairingRequest;
		if (typeof handler !== "function") {
			decide("denied");
			return;
		}
		try {
			const result = handler(pairingRequest);
			if (result && typeof (result as Promise<void>).then === "function") {
				(result as Promise<void>).catch(() => {
					decide("denied");
				});
			}
		} catch {
			// A caller exception is fail-closed: no acceptance, no grant.
			decide("denied");
		}
	}

	function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		stats.upgrades++;
		if (rawHeaderBytes(request) > bounds.maxHttpHeaderBytes || rawHeaderCount(request) > bounds.maxHttpHeaders) {
			rejectSocket(socket, 431, "header_too_large");
			return;
		}
		const peerKey = peerKeyOfSocket(socket);
		if (!peerKey) {
			rejectSocket(socket, 401, "no_client_certificate");
			return;
		}
		const path = matchFixedPeerPath(request.url);
		if (path !== APP_PATH) {
			rejectSocket(socket, 404, "unknown_path");
			return;
		}
		if (request.method !== "GET") {
			rejectSocket(socket, 405, "method_not_allowed");
			return;
		}
		const upgradeHeader = firstHeader(request.headers.upgrade);
		const connectionHeader = firstHeader(request.headers.connection);
		const keyHeader = firstHeader(request.headers["sec-websocket-key"]);
		const versionHeader = firstHeader(request.headers["sec-websocket-version"]);
		const protocolHeader = firstHeader(request.headers["sec-websocket-protocol"]);
		if (
			upgradeHeader?.toLowerCase() !== "websocket" ||
			!connectionHeader
				?.toLowerCase()
				.split(",")
				.some((token) => token.trim() === "upgrade") ||
			!keyHeader ||
			!WEBSOCKET_KEY.test(keyHeader) ||
			versionHeader !== "13" ||
			request.headers["sec-websocket-extensions"] !== undefined
		) {
			rejectSocket(socket, 400, "bad_request");
			return;
		}
		const offered = protocolHeader?.split(",").map((value) => value.trim()) ?? [];
		if (!offered.includes(APP_SUBPROTOCOL)) {
			rejectSocket(socket, 400, "unsupported_subprotocol");
			return;
		}

		let acceptedRecord: AcceptedPeerRecord | undefined;
		let grantRecord: DirectionalGrantRecord | undefined;
		try {
			acceptedRecord = safeAccepted(peerKey.keyId);
			grantRecord = safeGrant(peerKey.keyId);
		} catch {
			rejectSocket(socket, 403, "not_authorized");
			return;
		}
		if (!isCurrentAccepted(acceptedRecord, peerKey) || !isCurrentGrant(grantRecord, peerKey)) {
			stats.appGateDenied++;
			diagnostic("app_refused", { statusCode: 403 });
			rejectSocket(socket, 403, "not_authorized");
			return;
		}
		if (typeof options.onAppChannel !== "function") {
			rejectSocket(socket, 503, "app_unavailable");
			return;
		}
		if (closed || appChannels.size + pendingUpgrades >= bounds.maxConnections) {
			rejectSocket(socket, 503, "too_many_connections");
			return;
		}
		const currentPerPeer = (activePerPeer.get(peerKey.keyId) ?? 0) + (pendingPerPeer.get(peerKey.keyId) ?? 0);
		if (currentPerPeer >= bounds.maxConnectionsPerPeer) {
			rejectSocket(socket, 503, "too_many_connections");
			return;
		}

		pendingUpgrades++;
		pendingPerPeer.set(peerKey.keyId, (pendingPerPeer.get(peerKey.keyId) ?? 0) + 1);
		let released = false;
		const releaseReservation = (): void => {
			if (released) return;
			released = true;
			pendingUpgrades--;
			const remaining = (pendingPerPeer.get(peerKey.keyId) ?? 1) - 1;
			if (remaining <= 0) pendingPerPeer.delete(peerKey.keyId);
			else pendingPerPeer.set(peerKey.keyId, remaining);
		};

		let admitted = false;
		try {
			wss.handleUpgrade(request, socket, head, (ws: InstanceType<typeof WebSocket>) => {
				admitted = true;
				releaseReservation();
				try {
					if (closed) {
						try {
							ws.terminate();
						} catch {
							// Already gone.
						}
						return;
					}
					const channel = createPeerByteChannel({
						ws,
						peerKey,
						label: acceptedRecord?.label ?? null,
						bounds,
						isServer: true,
						diagnostic,
						onFinalized: () => {
							appChannels.delete(ws);
							const active = (activePerPeer.get(peerKey.keyId) ?? 1) - 1;
							if (active <= 0) activePerPeer.delete(peerKey.keyId);
							else activePerPeer.set(peerKey.keyId, active);
						},
					});
					appChannels.set(ws, channel);
					activePerPeer.set(peerKey.keyId, (activePerPeer.get(peerKey.keyId) ?? 0) + 1);
					stats.appChannelsOpened++;
					diagnostic("app_channel_opened");
					try {
						const result = options.onAppChannel?.(channel);
						if (result && typeof (result as Promise<void>).then === "function") {
							(result as Promise<void>).catch(() => {
								void channel.close();
							});
						}
					} catch {
						// Caller exceptions close rather than leaving an unsupervised channel.
						void channel.close();
					}
				} catch {
					try {
						ws.terminate();
					} catch {
						// Already gone.
					}
				}
			});
		} catch {
			rejectSocket(socket, 503, "pairing_failed");
		} finally {
			// ws calls the callback synchronously on success; if it aborted without
			// calling back, the reservation must not leak.
			if (!admitted) releaseReservation();
		}
	}

	let port: number | null = null;
	const host: PeerHost = {
		identity,
		key: identity.key,
		stats,
		get listening() {
			return server.listening;
		},
		get port() {
			return port;
		},
		get pendingPairingCount() {
			return pending.size;
		},
		get activeChannelCount() {
			return appChannels.size;
		},
		get transportSocketCount() {
			return rawSockets.size;
		},
		async listen(listenOptions: PeerHostListenOptions): Promise<{ host: string; port: number }> {
			if (closed) throw peerError("HOST_CLOSED");
			if (server.listening || listenStartup !== null) throw peerError("INVALID_ARGUMENT");
			const address = validateListenAddress(listenOptions?.host, listenOptions?.port);
			let startupFinished = false;
			const startup = new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					startupFinished = true;
					server.off("error", onError);
					server.off("listening", onListening);
					listenStartup = null;
					if (error) reject(error);
					else resolve();
				};
				const onError = (): void => finish(peerError("LISTENER_BIND_FAILED"));
				const onListening = (): void => {
					if (closed) {
						// The bind won the race with close(). Destroy anything the brief
						// listening window admitted, then stop the listener before settling
						// the startup promise so close() cannot finish ahead of it.
						for (const socket of [...tlsSockets]) {
							try {
								socket.destroy();
							} catch {
								// Already gone.
							}
						}
						for (const socket of [...rawSockets]) {
							try {
								socket.destroy();
							} catch {
								// Already gone.
							}
						}
						void closeListener().finally(() => finish(peerError("HOST_CLOSED")));
						return;
					}
					finish();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				try {
					server.listen({ host: address.host, port: address.port });
				} catch {
					finish(peerError("LISTENER_BIND_FAILED"));
				}
			});
			if (!startupFinished) listenStartup = startup;
			try {
				await startup;
			} catch (error) {
				throw isPeerTransportError(error) ? error : peerError("LISTENER_BIND_FAILED");
			}
			if (closed) {
				try {
					server.close();
				} catch {
					// Already closed by the coordinated close path.
				}
				throw peerError("HOST_CLOSED");
			}
			const bound = server.address();
			if (!bound || typeof bound === "string") {
				throw peerError("LISTENER_BIND_FAILED");
			}
			port = bound.port;
			return { host: address.host, port: bound.port };
		},
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			closing = (async () => {
				// A pending bind/address lookup must settle before teardown so close()
				// cannot report completion while a late listener can still appear.
				const startup = listenStartup;
				if (startup !== null) {
					try {
						await startup;
					} catch {
						// A bind that lost the race to close() is already stopped by the
						// startup handler; continue tearing down any remainder.
					}
				}
				for (const entry of [...pending.values()]) entry.decide("aborted");
				pending.clear();
				for (const timer of pendingTimers) clearTimeout(timer);
				pendingTimers.clear();
				const channels = [...appChannels.values()];
				await Promise.allSettled(channels.map((channel) => channel.close()));
				appChannels.clear();
				activePerPeer.clear();
				pendingPerPeer.clear();
				pendingUpgrades = 0;
				for (const socket of [...tlsSockets]) {
					try {
						socket.destroy();
					} catch {
						// Already gone.
					}
				}
				tlsSockets.clear();
				for (const socket of [...rawSockets]) {
					try {
						socket.destroy();
					} catch {
						// Already gone.
					}
				}
				rawSockets.clear();
				await closeListener();
				try {
					wss.close();
				} catch {
					// Already closed.
				}
				diagnostic("host_closed");
				port = null;
			})();
			return closing;
		},
		revoke(key: PeerKey | string): boolean {
			const keyId = typeof key === "string" ? key : key.keyId;
			if (!isBoundedPeerKeyId(keyId)) return false;
			let hadGrant = false;
			let hadAccepted = false;
			try {
				hadGrant = grants.delete(keyId);
				hadAccepted = acceptedPeers.delete(keyId);
			} catch {
				return false;
			}
			return hadGrant || hadAccepted;
		},
	};
	return host;
}
