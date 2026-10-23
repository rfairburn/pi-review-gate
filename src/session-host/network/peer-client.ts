/**
 * Client half of the inert paired peer transport.
 *
 * Every request goes through `GatedHttpsAgent`, so the server key must match the
 * exact remembered identity (or be explicitly accepted by the injected local
 * approver on first use) before the first HTTP byte is written.
 *
 * Pairing is one bounded `POST /pair` carrying only a friendly label and this
 * side's actual canonical key. Trust is remembered only after the receiving side
 * accepted the key that this connection actually proved. Application traffic is
 * a separate fixed WSS upgrade that the receiving side admits only with its own
 * current directional grant. A remote acceptance whose reply is lost leaves the
 * local side untrusted and returns an error; re-pairing is idempotent and can
 * confirm the already-accepted identity without pretending the first reply
 * arrived.
 */

import https from "node:https";
import net from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";
import WebSocket from "ws";
import {
	APP_PATH,
	PAIRING_PATH,
	PEER_KEY_HEADER,
	PEER_LABEL_HEADER,
	resolvePeerTransportBounds,
	emitDiagnostic,
	isPeerTransportError,
	isValidPeerLabel,
	peerAppLaneForSubprotocol,
	peerError,
	peerSubprotocolForLane,
	type PeerAppLane,
	type PeerDiagnostic,
	type PeerDiagnosticCode,
	type PeerDiagnosticSink,
	type PeerTransportBounds,
	type PeerWireErrorCode,
} from "./protocol";
import {
	isWellFormedPeerKey,
	loadOwnedPeerIdentity,
	peerKeysEqual,
	type OwnedPeerIdentity,
	type PeerIdentityMaterial,
	type PeerKey,
} from "./identity";
import { GatedHttpsAgent, type PeerServerKeyApprover, type PeerServerKeyDecision, type PeerServerHandshake } from "./gated-agent";
import type { RememberedPeerKeyStore } from "./trust";
import { createPeerByteChannel, type PeerByteChannel } from "./channel";

export type PeerPairStatus = "accepted" | "already_accepted" | "denied" | "timeout" | "aborted" | "http_error";

export interface PeerPairResult {
	readonly ok: boolean;
	readonly status: PeerPairStatus;
	readonly httpStatus: number;
	/** Exact server identity this side remembered, or null when untrusted. */
	readonly serverKey: PeerKey | null;
	/** Fixed sanitized wire code, never raw peer text. */
	readonly wireError: PeerWireErrorCode | null;
}

export interface PeerPairOptions {
	/** Target address; defaults to loopback. The listener side never defaults. */
	readonly host?: string;
	readonly port: number;
	readonly signal?: AbortSignal;
	/** Friendly display label; never identity. Defaults to the client's label. */
	readonly label?: string;
	/** Include this side's actual canonical key as a claim (default true). */
	readonly claimKey?: boolean;
	/** Per-connection local server-key approver; overrides the client default. */
	readonly approveServerKey?: PeerServerKeyApprover;
}

export interface PeerAppOptions {
	/** Target address; defaults to loopback. The listener side never defaults. */
	readonly host?: string;
	readonly port: number;
	readonly signal?: AbortSignal;
	/**
	 * Exact lane for this connection. Defaults to the unchanged legacy `app`
	 * lane; `content` offers the additive `pi-peer-content-v1` subprotocol and
	 * opens only when the receiving host supplied a content callback. This client
	 * never offers both protocols. The negotiated lane must match this value.
	 */
	readonly lane?: PeerAppLane;
	/** Extra application headers; only sent after the server key is accepted. */
	readonly headers?: Readonly<Record<string, string>>;
	/** Per-connection local server-key approver; overrides the client default. */
	readonly approveServerKey?: PeerServerKeyApprover;
}

export type PeerAppChannel = PeerByteChannel;

export interface PeerClientStats {
	pairAttempts: number;
	pairAccepted: number;
	pairRefused: number;
	appAttempts: number;
	appOpened: number;
}

export interface PeerClientOptions {
	readonly identity: OwnedPeerIdentity | PeerIdentityMaterial;
	readonly remembered: RememberedPeerKeyStore;
	readonly onServerKey?: PeerServerKeyApprover;
	readonly bounds?: Partial<PeerTransportBounds>;
	readonly onDiagnostic?: PeerDiagnosticSink;
}

export interface PeerClient {
	readonly identity: OwnedPeerIdentity;
	readonly key: PeerKey;
	readonly stats: PeerClientStats;
	readonly activeOperationCount: number;
	readonly pendingConsentCount: number;
	pair(options: PeerPairOptions): Promise<PeerPairResult>;
	connectApp(options: PeerAppOptions): Promise<PeerAppChannel>;
	dispose(): void;
}

const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
	"connection",
	"content-length",
	"expect",
	"host",
	"keep-alive",
	"proxy-connection",
	"sec-websocket-extensions",
	"sec-websocket-key",
	"sec-websocket-protocol",
	"sec-websocket-version",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

const WIRE_ERRORS: ReadonlySet<string> = new Set<PeerWireErrorCode>([
	"aborted",
	"app_unavailable",
	"bad_request",
	"claim_mismatch",
	"denied",
	"header_too_large",
	"invalid_label",
	"method_not_allowed",
	"no_client_certificate",
	"no_http_endpoint",
	"not_authorized",
	"pairing_failed",
	"timeout",
	"too_many_connections",
	"too_many_pending",
	"unexpected_body",
	"unknown_path",
	"unsupported_subprotocol",
	"upgrade_not_allowed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEndpoint(host: unknown, port: unknown): { host: string; port: number } {
	if (
		typeof host !== "string" ||
		host.length === 0 ||
		host.length > 255 ||
		/[\s/\\?#@]/.test(host) ||
		typeof port !== "number" ||
		!Number.isInteger(port) ||
		port <= 0 ||
		port > 65_535
	) {
		throw peerError("INVALID_ARGUMENT");
	}
	return { host, port };
}

function validateCallerHeaders(
	headers: Readonly<Record<string, string>> | undefined,
	bounds: PeerTransportBounds,
): Record<string, string> {
	if (headers === undefined) return {};
	if (!isRecord(headers)) throw peerError("INVALID_ARGUMENT");
	const entries = Object.entries(headers);
	if (entries.length > bounds.maxHttpHeaders) throw peerError("INVALID_ARGUMENT");
	const result: Record<string, string> = {};
	const seen = new Set<string>();
	let totalBytes = 0;
	for (const [name, value] of entries) {
		if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw peerError("INVALID_ARGUMENT");
		const lower = name.toLowerCase();
		if (FORBIDDEN_HEADERS.has(lower) || seen.has(lower)) throw peerError("INVALID_ARGUMENT");
		seen.add(lower);
		if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
			throw peerError("INVALID_ARGUMENT");
		}
		totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
		if (totalBytes > bounds.maxHttpHeaderBytes) throw peerError("INVALID_ARGUMENT");
		result[name] = value;
	}
	return result;
}

function readRemembered(store: RememberedPeerKeyStore): PeerKey | null {
	try {
		const value = store.read();
		if (value === null) return null;
		if (!isWellFormedPeerKey(value)) throw peerError("TRUST_STORE_FAILED");
		return value;
	} catch (error) {
		if (isPeerTransportError(error)) throw error;
		throw peerError("TRUST_STORE_FAILED");
	}
}

function wssUrl(host: string, port: number): string {
	const hostPart = net.isIP(host) === 6 ? `[${host}]` : host;
	return `wss://${hostPart}:${port}${APP_PATH}`;
}

function mapRequestError(error: unknown, signal: AbortSignal | undefined): Error {
	if (signal?.aborted) return peerError("ABORTED");
	if (isPeerTransportError(error)) return error;
	return peerError("PAIRING_FAILED");
}

function requestPairing(
	agent: GatedHttpsAgent,
	bounds: PeerTransportBounds,
	options: { host: string; port: number; headers: Record<string, string>; signal?: AbortSignal },
): Promise<{ statusCode: number; body: Buffer }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let request: ClientRequest | null = null;
		let response: IncomingMessage | null = null;
		let responseTimer: NodeJS.Timeout | null = null;
		const clearResponseTimer = (): void => {
			if (!responseTimer) return;
			clearTimeout(responseTimer);
			responseTimer = null;
		};
		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearResponseTimer();
			if (options.signal) options.signal.removeEventListener("abort", onAbort);
			fn();
		};
		const fail = (code: "ABORTED" | "PAIRING_TIMEOUT"): void => {
			if (settled) return;
			// Settle with the intended owned cause before destroying the request:
			// destroying it emits its own error and must not replace this decision.
			settle(() => reject(peerError(code)));
			try {
				response?.destroy();
			} catch {
				// Already gone.
			}
			try {
				request?.destroy();
			} catch {
				// Already gone.
			}
			agent.dispose();
		};
		const startResponseTimer = (): void => {
			if (settled || responseTimer) return;
			responseTimer = setTimeout(() => fail("PAIRING_TIMEOUT"), bounds.pairingResponseTimeoutMs);
			responseTimer.unref?.();
		};
		const onAbort = (): void => {
			fail("ABORTED");
		};

		try {
			request = https.request(
				{
					host: options.host,
					port: options.port,
					method: "POST",
					path: PAIRING_PATH,
					agent,
					headers: { ...options.headers, connection: "close", "content-length": "0" },
					maxHeaderSize: bounds.maxHttpHeaderBytes,
				},
				(responseMessage: IncomingMessage) => {
					response = responseMessage;
					// The socket event starts the owned deadline at handoff; this is a
					// fallback for any stack where the response arrives first.
					startResponseTimer();
					const chunks: Buffer[] = [];
					let total = 0;
					let tooLarge = false;
					responseMessage.on("data", (chunk: Buffer) => {
						if (tooLarge) return;
						total += chunk.length;
						if (total > bounds.maxPairResponseBytes) {
							tooLarge = true;
							chunks.length = 0;
							responseMessage.destroy();
							return;
						}
						chunks.push(chunk);
					});
					responseMessage.on("end", () => {
						settle(() =>
							tooLarge
								? reject(peerError("PAIRING_RESPONSE_TOO_LARGE"))
								: resolve({ statusCode: responseMessage.statusCode ?? 0, body: Buffer.concat(chunks) }),
						);
					});
					responseMessage.on("error", (error: unknown) => {
						settle(() =>
							reject(tooLarge ? peerError("PAIRING_RESPONSE_TOO_LARGE") : mapRequestError(error, options.signal)),
						);
					});
				},
			);
		} catch {
			settle(() => reject(peerError("PAIRING_FAILED")));
			return;
		}

		request.once("socket", startResponseTimer);
		if (request.socket) startResponseTimer();
		request.on("error", (error: unknown) => {
			settle(() => reject(mapRequestError(error, options.signal)));
		});
		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
		request.end();
	});
}

function parsePairBody(body: Buffer): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(body.toString("utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function pairStatusOf(body: Record<string, unknown> | null): PeerPairStatus {
	const status = body?.status;
	if (status === "accepted" || status === "already_accepted") return status;
	if (status === "denied" || status === "timeout" || status === "aborted") return status;
	return "http_error";
}

function wireErrorOf(body: Record<string, unknown> | null): PeerWireErrorCode | null {
	const value = body?.error;
	return typeof value === "string" && WIRE_ERRORS.has(value) ? (value as PeerWireErrorCode) : null;
}

export function createPeerClient(options: PeerClientOptions): PeerClient {
	if (!options || typeof options !== "object") throw peerError("INVALID_ARGUMENT");
	const identity = loadOwnedPeerIdentity(options.identity);
	if (
		typeof options.remembered?.read !== "function" ||
		typeof options.remembered.write !== "function" ||
		typeof options.remembered.clear !== "function"
	) {
		throw peerError("INVALID_ARGUMENT");
	}
	const bounds = resolvePeerTransportBounds(options.bounds);
	const remembered = options.remembered;
	const approveServerKey = options.onServerKey ?? (() => "reject" as const);
	const onDiagnostic = options.onDiagnostic;
	let diagnosticSinkEnabled = true;
	const diagnostic = (code: PeerDiagnosticCode, statusCode?: number): void => {
		if (!diagnosticSinkEnabled) return;
		const event: PeerDiagnostic =
			statusCode === undefined ? { code, role: "client" } : { code, role: "client", statusCode };
		diagnosticSinkEnabled = emitDiagnostic(onDiagnostic, event);
	};
	const stats: PeerClientStats = {
		pairAttempts: 0,
		pairAccepted: 0,
		pairRefused: 0,
		appAttempts: 0,
		appOpened: 0,
	};
	const agents = new Set<GatedHttpsAgent>();
	const channels = new Set<PeerAppChannel>();
	let disposed = false;
	let activeOperations = 0;
	let pendingConsents = 0;

	const reserveOperation = (): boolean => {
		if (activeOperations >= bounds.maxClientOperations) return false;
		activeOperations++;
		return true;
	};
	const releaseOperation = (): void => {
		if (activeOperations > 0) activeOperations--;
	};
	const withConsentLimit = (approver: PeerServerKeyApprover): PeerServerKeyApprover => {
		return (prompt) => {
			if (pendingConsents >= bounds.maxPendingConsents) {
				return Promise.reject(peerError("CONSENT_LIMIT_REACHED"));
			}
			pendingConsents++;
			return new Promise<PeerServerKeyDecision>((resolve, reject) => {
				let settled = false;
				let timer: NodeJS.Timeout | null = null;
				const finish = (fn: () => void): void => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					if (pendingConsents > 0) pendingConsents--;
					fn();
				};
				// The wrapper promise itself settles on timeout, so the consent slot
				// corresponds to an agent-visible approval rather than a caller promise
				// that may never resolve.
				timer = setTimeout(
					() => finish(() => reject(peerError("PEER_KEY_PROMPT_TIMEOUT"))),
					bounds.consentTimeoutMs,
				);
				timer.unref?.();
				let decision: PeerServerKeyDecision | Promise<PeerServerKeyDecision>;
				try {
					decision = approver(prompt);
				} catch (error) {
					finish(() => reject(error));
					return;
				}
				Promise.resolve(decision).then(
					(value) => finish(() => resolve(value)),
					(error: unknown) => finish(() => reject(error)),
				);
			});
		};
	};

	const newAgent = (approver: PeerServerKeyApprover = approveServerKey): GatedHttpsAgent => {
		const agent = new GatedHttpsAgent({
			identity,
			remembered,
			approveServerKey: withConsentLimit(approver),
			bounds,
			onDiagnostic,
		});
		agents.add(agent);
		return agent;
	};

	const client: PeerClient = {
		identity,
		key: identity.key,
		stats,
		get activeOperationCount() {
			return activeOperations;
		},
		get pendingConsentCount() {
			return pendingConsents;
		},
		async pair(pairOptions: PeerPairOptions): Promise<PeerPairResult> {
			if (disposed) throw peerError("HOST_CLOSED");
			const { host, port } = validateEndpoint(pairOptions.host ?? "127.0.0.1", pairOptions.port);
			const signal = pairOptions.signal;
			if (signal?.aborted) throw peerError("ABORTED");
			const label = pairOptions.label ?? identity.label;
			if (!isValidPeerLabel(label, bounds.maxLabelBytes)) throw peerError("INVALID_ARGUMENT");
			const claimKey = pairOptions.claimKey ?? true;
			if (!reserveOperation()) throw peerError("CLIENT_LIMIT_REACHED");
			stats.pairAttempts++;
			let agent: GatedHttpsAgent | null = null;
			try {
				agent = newAgent(pairOptions.approveServerKey ?? approveServerKey);
				const headers: Record<string, string> = { [PEER_LABEL_HEADER]: label };
				if (claimKey) headers[PEER_KEY_HEADER] = identity.key.keyId;
				const response = await requestPairing(agent, bounds, { host, port, headers, signal });
				const body = parsePairBody(response.body);
				const wireError = wireErrorOf(body);
				if (response.statusCode !== 200) {
					stats.pairRefused++;
					const refusedStatus: PeerPairStatus =
						response.statusCode === 408
							? "timeout"
							: response.statusCode === 403
								? "denied"
								: "http_error";
					return {
						ok: false,
						status: refusedStatus,
						httpStatus: response.statusCode,
						serverKey: null,
						wireError,
					};
				}
				const status = pairStatusOf(body);
				if (status !== "accepted" && status !== "already_accepted") {
					throw peerError("PAIRING_RESPONSE_INVALID");
				}
				if (body === null || typeof body.acceptedPeerKey !== "string") {
					throw peerError("PAIRING_RESPONSE_INVALID");
				}
				if (body.acceptedPeerKey !== identity.key.keyId) {
					throw peerError("PAIRING_KEY_ECHO_MISMATCH");
				}
				if (agent.handshakes.length !== 1) {
					throw peerError("PAIRING_HANDSHAKE_COUNT_MISMATCH");
				}
				if (signal?.aborted || disposed) throw peerError(signal?.aborted ? "ABORTED" : "HOST_CLOSED");
				const handshake: PeerServerHandshake = agent.handshakes[0];
				const current = readRemembered(remembered);
				if (handshake.mode === "remembered") {
					// The gate used a pinned key for this handshake. If local trust was
					// cleared while receiving approval was pending, do not resurrect it by
					// writing the handshake key back into the store.
					if (current === null || !peerKeysEqual(current, handshake.key)) {
						throw peerError("PEER_KEY_CHANGED");
					}
				} else if (current !== null && !peerKeysEqual(current, handshake.key)) {
					throw peerError("PEER_KEY_CHANGED");
				}
				if (current === null) {
					try {
						remembered.write(handshake.key);
					} catch {
						throw peerError("TRUST_STORE_FAILED");
					}
				}
				stats.pairAccepted++;
				return {
					ok: true,
					status,
					httpStatus: response.statusCode,
					serverKey: handshake.key,
					wireError: null,
				};
			} finally {
				agent?.dispose();
				if (agent) agents.delete(agent);
				releaseOperation();
			}
		},
		async connectApp(appOptions: PeerAppOptions): Promise<PeerAppChannel> {
			if (disposed) throw peerError("HOST_CLOSED");
			const { host, port } = validateEndpoint(appOptions.host ?? "127.0.0.1", appOptions.port);
			const signal = appOptions.signal;
			if (signal?.aborted) throw peerError("ABORTED");
			const lane = appOptions.lane ?? "app";
			if (lane !== "app" && lane !== "content") throw peerError("INVALID_ARGUMENT");
			const subprotocol = peerSubprotocolForLane(lane);
			const extraHeaders = validateCallerHeaders(appOptions.headers, bounds);
			if (!reserveOperation()) throw peerError("CLIENT_LIMIT_REACHED");
			stats.appAttempts++;
			let operationReleased = false;
			const releaseReservedOperation = (): void => {
				if (operationReleased) return;
				operationReleased = true;
				releaseOperation();
			};
			let agent: GatedHttpsAgent;
			try {
				agent = newAgent(appOptions.approveServerKey ?? approveServerKey);
			} catch (error) {
				releaseReservedOperation();
				throw error;
			}
			let ws: InstanceType<typeof WebSocket>;
			try {
				ws = new WebSocket(wssUrl(host, port), subprotocol, {
					agent,
					headers: extraHeaders,
					perMessageDeflate: false,
					autoPong: false,
					maxPayload: bounds.maxWebSocketMessageBytes,
					handshakeTimeout: bounds.openTimeoutMs,
					followRedirects: false,
					// ws 8.22.0 supports closeTimeout; the pinned @types/ws 8.18.2 does not declare it.
					closeTimeout: bounds.closeTimeoutMs,
				} as WebSocket.ClientOptions & { closeTimeout: number });
			} catch {
				agent.dispose();
				agents.delete(agent);
				releaseReservedOperation();
				throw peerError("APP_REFUSED");
			}

			let opened = false;
			let lastGateError: Error | null = null;
			let openResolve: () => void = () => undefined;
			let openReject: (error: Error) => void = () => undefined;
			const openPromise = new Promise<void>((resolve, reject) => {
				openResolve = resolve;
				openReject = reject;
			});
			let settled = false;
			const settle = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				if (signal) signal.removeEventListener("abort", onAbort);
				fn();
			};
			const onAbort = (): void => {
				settle(() => openReject(peerError("ABORTED")));
				try {
					ws.terminate();
				} catch {
					// Already gone.
				}
				agent.dispose();
			};

			ws.once("open", () => {
				opened = true;
				settle(() => openResolve());
			});
			ws.on("error", (error: Error) => {
				lastGateError = error;
				settle(() => openReject(isPeerTransportError(error) ? error : peerError("APP_REFUSED")));
			});
			ws.on("unexpected-response", (_request: ClientRequest, response: IncomingMessage) => {
				const status = response.statusCode ?? 0;
				diagnostic("app_refused", status);
				try {
					response.destroy();
				} catch {
					// Already gone.
				}
				settle(() => openReject(peerError("APP_REFUSED", status)));
			});
			ws.once("close", (code: number) => {
				settle(() => openReject(peerError("APP_REFUSED", code === 1006 ? undefined : code)));
			});
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			try {
				await openPromise;
				if (disposed) throw peerError("HOST_CLOSED");
				if (signal?.aborted) throw peerError("ABORTED");
				if (!opened) throw lastGateError ?? peerError("APP_REFUSED");
				if (agent.handshakes.length !== 1) throw peerError("PEER_KEY_MISMATCH");
				const handshake: PeerServerHandshake = agent.handshakes[0];
				// Trust only the protocol the server actually selected, and only when it
				// is exactly the lane this connection asked for. A server that selects
				// nothing or something else is refused rather than reinterpreted.
				const negotiatedLane = peerAppLaneForSubprotocol(ws.protocol);
				if (negotiatedLane === null || negotiatedLane !== lane) throw peerError("APP_REFUSED");
				if (signal) signal.removeEventListener("abort", onAbort);
				const channel = createPeerByteChannel({
					ws,
					peerKey: handshake.key,
					lane: negotiatedLane,
					label: handshake.label,
					bounds,
					isServer: false,
					diagnostic,
					onFinalized: () => {
						channels.delete(channel);
						agent.dispose();
						agents.delete(agent);
						releaseReservedOperation();
					},
				});
				channels.add(channel);
				stats.appOpened++;
				diagnostic("app_channel_opened");
				return channel;
			} catch (error) {
				if (signal) signal.removeEventListener("abort", onAbort);
				try {
					ws.terminate();
				} catch {
					// Already gone.
				}
				agent.dispose();
				agents.delete(agent);
				releaseReservedOperation();
				throw isPeerTransportError(error) ? error : peerError("APP_REFUSED");
			}
		},
		dispose(): void {
			disposed = true;
			for (const channel of [...channels]) {
				void channel.close();
			}
			channels.clear();
			for (const agent of [...agents]) agent.dispose();
			agents.clear();
			activeOperations = 0;
			pendingConsents = 0;
		},
	};
	return client;
}
