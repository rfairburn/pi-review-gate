/**
 * Client-side trust gate for the inert paired peer transport.
 *
 * Node's documented `https.Agent#createConnection` seam is used to complete TLS
 * and inspect the exact key the server proved, before the HTTP client is given
 * a socket. Until this gate hands the socket back, the request has no socket and
 * cannot write a request line, header, cookie, token, or application byte.
 *
 * `checkServerIdentity` is deliberately not the gate: a self-signed peer
 * produces a chain verification error, so Node never calls that callback, and it
 * is also skipped on session resumption. Instead the handshake exposes the
 * presented certificate and this agent compares its exact SPKI with the locally
 * accepted or remembered key. `rejectUnauthorized: false` is used narrowly on
 * this transport only to let a self-signed key reach that exact comparison; no
 * other client or global TLS default is changed.
 */

import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import {
	emitDiagnostic,
	isPeerTransportError,
	peerError,
	type PeerDiagnosticCode,
	type PeerDiagnosticSink,
	type PeerTransportBounds,
	type PeerTransportErrorCode,
} from "./protocol";
import {
	isWellFormedPeerKey,
	peerKeyFromPeerCertificate,
	peerKeysEqual,
	type OwnedPeerIdentity,
	type PeerKey,
} from "./identity";
import type { RememberedPeerKeyStore } from "./trust";

export type PeerServerKeyDecision = "accept" | "reject" | "cancel";

export interface PeerServerKeyPrompt {
	/** The exact key observed on the completed handshake. */
	readonly key: PeerKey;
	/** Bounded display label from the peer certificate, never identity. */
	readonly label: string | null;
	/** Connection context for the local decision; never identity. */
	readonly host: string;
	readonly port: number;
}

export type PeerServerKeyApprover = (
	prompt: PeerServerKeyPrompt,
) => PeerServerKeyDecision | Promise<PeerServerKeyDecision>;

export interface PeerServerHandshake {
	readonly key: PeerKey;
	readonly label: string | null;
	readonly mode: "remembered" | "first-use";
}

export interface GatedHttpsAgentOptions {
	readonly identity: OwnedPeerIdentity;
	readonly remembered: RememberedPeerKeyStore;
	readonly approveServerKey: PeerServerKeyApprover;
	readonly bounds: PeerTransportBounds;
	readonly onDiagnostic?: PeerDiagnosticSink;
}

export interface GatedAgentStats {
	connectionAttempts: number;
	completedHandshakes: number;
	handedOff: number;
	prompts: number;
	preHttpFailures: number;
	lastFailureCode: PeerTransportErrorCode | null;
}

const MAX_HANDSHAKE_RECORDS = 8;
const DECISIONS: ReadonlySet<string> = new Set(["accept", "reject", "cancel"]);
const DISPLAY_LABEL = /^[0-9A-Za-z ._@:()\-]{1,64}$/;

function boundedWithDeadline<T>(promise: Promise<T>, ms: number, code: PeerTransportErrorCode): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(peerError(code)), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				if (isPeerTransportError(error)) reject(error);
				else reject(peerError("PEER_KEY_APPROVER_FAILED"));
			},
		);
	});
}

function displayLabelFromCertificate(peerCertificate: { subject?: { CN?: unknown } }): string | null {
	const commonName = peerCertificate.subject?.CN;
	return typeof commonName === "string" && DISPLAY_LABEL.test(commonName) ? commonName : null;
}

export class GatedHttpsAgent extends https.Agent {
	readonly stats: GatedAgentStats = {
		connectionAttempts: 0,
		completedHandshakes: 0,
		handedOff: 0,
		prompts: 0,
		preHttpFailures: 0,
		lastFailureCode: null,
	};
	private readonly identity: OwnedPeerIdentity;
	private readonly remembered: RememberedPeerKeyStore;
	private readonly approveServerKey: PeerServerKeyApprover;
	private readonly bounds: PeerTransportBounds;
	private readonly onDiagnostic: PeerDiagnosticSink | undefined;
	private readonly openSockets = new Set<TLSSocket>();
	private readonly handshakeRecords: PeerServerHandshake[] = [];
	private disposed = false;
	private diagnosticSinkEnabled = true;

	constructor(options: GatedHttpsAgentOptions) {
		super({ keepAlive: false, maxSockets: 1, maxFreeSockets: 0 });
		if (
			!options ||
			typeof options !== "object" ||
			!options.identity ||
			typeof options.identity.certificatePem !== "string" ||
			typeof options.identity.privateKeyPem !== "string" ||
			!isWellFormedPeerKey(options.identity.key) ||
			typeof options.remembered?.read !== "function" ||
			typeof options.approveServerKey !== "function" ||
			!options.bounds
		) {
			throw peerError("INVALID_ARGUMENT");
		}
		this.identity = options.identity;
		this.remembered = options.remembered;
		this.approveServerKey = options.approveServerKey;
		this.bounds = options.bounds;
		this.onDiagnostic = options.onDiagnostic;
	}

	get handshakes(): readonly PeerServerHandshake[] {
		return this.handshakeRecords;
	}

	private diagnostic(code: PeerDiagnosticCode, extra?: { statusCode?: number }): void {
		if (!this.diagnosticSinkEnabled) return;
		this.diagnosticSinkEnabled = emitDiagnostic(this.onDiagnostic, {
			code,
			role: "client",
			...(extra?.statusCode === undefined ? {} : { statusCode: extra.statusCode }),
		});
	}

	/** Destroy every socket this agent still owns; idempotent. */
	dispose(): void {
		this.disposed = true;
		for (const socket of this.openSockets) {
			try {
				socket.destroy();
			} catch {
				// Already gone.
			}
		}
		this.openSockets.clear();
	}

	private readRemembered(): PeerKey | null {
		try {
			const value = this.remembered.read();
			if (value === null) return null;
			if (!isWellFormedPeerKey(value)) throw peerError("TRUST_STORE_FAILED");
			return value;
		} catch (error) {
			if (isPeerTransportError(error)) throw error;
			throw peerError("TRUST_STORE_FAILED");
		}
	}

	override createConnection(
		options: https.RequestOptions,
		callback?: (err: Error | null, stream: Duplex) => void,
	): Duplex | null | undefined {
		const respond = callback ?? (() => undefined);
		if (this.disposed) {
			process.nextTick(() => respond(peerError("HOST_CLOSED"), null as unknown as Duplex));
			return undefined;
		}
		const host = typeof options.host === "string" && options.host.length > 0 ? options.host : "127.0.0.1";
		const port = typeof options.port === "number" ? options.port : Number(options.port);
		if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
			process.nextTick(() => respond(peerError("INVALID_ARGUMENT"), null as unknown as Duplex));
			return undefined;
		}

		this.stats.connectionAttempts++;
		const socket = tls.connect({
			host,
			port,
			servername: net.isIP(host) ? undefined : host,
			ALPNProtocols: ["http/1.1"],
			rejectUnauthorized: false,
			cert: this.identity.certificatePem,
			key: this.identity.privateKeyPem,
			minVersion: "TLSv1.2",
			maxVersion: "TLSv1.3",
			// No session is supplied and this agent never pools sockets, so every
			// connection must complete a fresh handshake with a fresh key proof.
		});
		socket.setNoDelay(true);
		this.openSockets.add(socket);
		socket.once("close", () => this.openSockets.delete(socket));

		let settled = false;
		let handshakeCompleted = false;
		let handshakeTimer: NodeJS.Timeout | null = null;

		const fail = (code: PeerTransportErrorCode): void => {
			if (settled) return;
			settled = true;
			if (handshakeTimer) {
				clearTimeout(handshakeTimer);
				handshakeTimer = null;
			}
			this.stats.preHttpFailures++;
			this.stats.lastFailureCode = code;
			this.diagnostic(code === "PEER_KEY_MISMATCH" ? "client_key_mismatch" : "tls_error");
			try {
				socket.destroy();
			} catch {
				// Already gone.
			}
			respond(peerError(code), null as unknown as Duplex);
		};

		const onError = (): void => {
			if (!settled) fail(handshakeCompleted ? "TLS_CONNECTION_CLOSED" : "TLS_HANDSHAKE_FAILED");
		};
		// Kept for the socket's lifetime so a late socket error can never become an
		// unhandled 'error' event after the HTTP client takes ownership.
		socket.on("error", onError);
		socket.once("close", () => {
			if (!settled) fail("TLS_CONNECTION_CLOSED");
		});
		handshakeTimer = setTimeout(() => fail("TLS_HANDSHAKE_TIMEOUT"), this.bounds.tlsHandshakeTimeoutMs);
		handshakeTimer.unref?.();

		socket.once("secureConnect", () => {
			if (handshakeTimer) {
				clearTimeout(handshakeTimer);
				handshakeTimer = null;
			}
			if (settled) return;
			if (this.disposed || socket.destroyed) {
				fail(this.disposed ? "HOST_CLOSED" : "TLS_CONNECTION_CLOSED");
				return;
			}
			if (socket.isSessionReused()) {
				fail("TLS_SESSION_RESUMED");
				return;
			}

			let observedKey: PeerKey | null;
			let label: string | null;
			try {
				const peerCertificate = socket.getPeerCertificate();
				observedKey = peerKeyFromPeerCertificate(peerCertificate);
				label = displayLabelFromCertificate(peerCertificate);
			} catch {
				fail("PEER_CERTIFICATE_INVALID");
				return;
			}
			if (!observedKey) {
				fail("PEER_CERTIFICATE_MISSING");
				return;
			}
			const peerKey: PeerKey = observedKey;
			this.stats.completedHandshakes++;
			handshakeCompleted = true;
			this.diagnostic("client_key_observed");

			let expected: PeerKey | null;
			try {
				expected = this.readRemembered();
			} catch (error) {
				fail(isPeerTransportError(error) ? error.code : "TRUST_STORE_FAILED");
				return;
			}

			const finalize = (mode: "remembered" | "first-use"): void => {
				if (settled) return;
				if (this.disposed) {
					fail("HOST_CLOSED");
					return;
				}
				if (socket.destroyed) {
					fail("TLS_CONNECTION_CLOSED");
					return;
				}
				let current: PeerKey | null;
				try {
					current = this.readRemembered();
				} catch (error) {
					fail(isPeerTransportError(error) ? error.code : "TRUST_STORE_FAILED");
					return;
				}
				if (expected !== null) {
					// Trust was revoked or replaced while this connection was pending.
					if (current === null || !peerKeysEqual(current, expected)) {
						fail("PEER_KEY_CHANGED");
						return;
					}
				} else if (current !== null && !peerKeysEqual(current, peerKey)) {
					fail("PEER_KEY_CHANGED");
					return;
				}
				if (current !== null && !peerKeysEqual(current, peerKey)) {
					fail("PEER_KEY_MISMATCH");
					return;
				}
				this.handshakeRecords.push(Object.freeze({ key: peerKey, label, mode }));
				if (this.handshakeRecords.length > MAX_HANDSHAKE_RECORDS) this.handshakeRecords.shift();
				settled = true;
				this.stats.handedOff++;
				this.diagnostic("client_key_accepted");
				// Only now does the HTTP client receive a socket and write bytes.
				respond(null, socket);
			};

			if (expected !== null) {
				if (!peerKeysEqual(expected, peerKey)) {
					fail("PEER_KEY_MISMATCH");
					return;
				}
				finalize("remembered");
				return;
			}

			this.stats.prompts++;
			let decision: PeerServerKeyDecision | Promise<PeerServerKeyDecision>;
			try {
				decision = this.approveServerKey({ key: peerKey, label, host, port });
			} catch {
				fail("PEER_KEY_APPROVER_FAILED");
				return;
			}
			const decisionPromise = Promise.resolve(decision);
			const bounded = boundedWithDeadline(decisionPromise, this.bounds.consentTimeoutMs, "PEER_KEY_PROMPT_TIMEOUT");
			bounded.then(
				(resolved) => {
					if (settled) return;
					if (typeof resolved !== "string" || !DECISIONS.has(resolved)) {
						fail("PEER_KEY_DECISION_INVALID");
						return;
					}
					if (resolved !== "accept") {
						fail(resolved === "cancel" ? "PEER_KEY_CANCELLED" : "PEER_KEY_REJECTED");
						return;
					}
					// A local socket may have closed while the human decided.
					if (socket.destroyed) {
						fail("TLS_CONNECTION_CLOSED");
						return;
					}
					finalize("first-use");
				},
				(error: unknown) => {
					if (settled) return;
					fail(isPeerTransportError(error) ? error.code : "PEER_KEY_APPROVER_FAILED");
				},
			);
		});

		return undefined;
	}
}
