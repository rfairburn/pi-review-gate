/**
 * Focused helpers for the inert paired peer transport tests. Every fixture is
 * synthetic, in-memory, and bound to owned loopback ports; no product state,
 * keys, files, or listeners outside the test process are touched.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import type { TestContext } from "node:test";
import {
	APP_SUBPROTOCOL,
	createInMemoryAcceptedPeerStore,
	createInMemoryDirectionalGrantStore,
	createInMemoryRememberedPeerKeyStore,
	createPeerClient,
	createPeerHost,
	generatePeerIdentity,
	type AcceptedPeerStore,
	type DirectionalGrantStore,
	type OwnedPeerIdentity,
	type PeerClient,
	type PeerClientOptions,
	type PeerHost,
	type PeerHostOptions,
	type PeerKey,
	type PeerTransportBounds,
	type RememberedPeerKeyStore,
} from "../src/session-host/network/index";

export { assert };

export async function newIdentity(label: string): Promise<OwnedPeerIdentity> {
	return generatePeerIdentity(label);
}

export interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		timer.unref?.();
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

export interface HostFixture {
	readonly host: PeerHost;
	readonly identity: OwnedPeerIdentity;
	readonly acceptedPeers: AcceptedPeerStore;
	readonly grants: DirectionalGrantStore;
	readonly port: number;
	readonly stats: PeerHost["stats"];
	readonly pendingPairingCount: number;
	readonly activeChannelCount: number;
}

export async function startHost(
	t: TestContext,
	options: Omit<PeerHostOptions, "acceptedPeers" | "grants"> & {
		readonly identity: OwnedPeerIdentity;
		readonly acceptedPeers?: AcceptedPeerStore;
		readonly grants?: DirectionalGrantStore;
		readonly bounds?: Partial<PeerTransportBounds>;
	},
): Promise<HostFixture> {
	const acceptedPeers = options.acceptedPeers ?? createInMemoryAcceptedPeerStore();
	const grants = options.grants ?? createInMemoryDirectionalGrantStore();
	const host = createPeerHost({ ...options, acceptedPeers, grants });
	const bound = await host.listen({ host: "127.0.0.1", port: 0 });
	t.after(async () => {
		await host.close();
	});
	return {
		host,
		identity: options.identity,
		acceptedPeers,
		grants,
		port: bound.port,
		get stats() {
			return host.stats;
		},
		get pendingPairingCount() {
			return host.pendingPairingCount;
		},
		get activeChannelCount() {
			return host.activeChannelCount;
		},
	};
}

export interface ClientFixture {
	readonly client: PeerClient;
	readonly identity: OwnedPeerIdentity;
	readonly remembered: RememberedPeerKeyStore;
}

export function startClient(
	t: TestContext,
	identity: OwnedPeerIdentity,
	options: Omit<PeerClientOptions, "identity" | "remembered"> & {
		readonly remembered?: RememberedPeerKeyStore;
	} = {},
): ClientFixture {
	const remembered = options.remembered ?? createInMemoryRememberedPeerKeyStore();
	const client = createPeerClient({ ...options, identity, remembered });
	t.after(() => client.dispose());
	return { client, identity, remembered };
}

export interface TlsProbeStats {
	connections: number;
	handshakes: number;
	decryptedBytes: number;
	dataEvents: number;
	tlsErrors: number;
	captured: Buffer;
}

export interface TlsProbe {
	readonly port: number;
	readonly identity: OwnedPeerIdentity;
	readonly stats: TlsProbeStats;
	readonly firstData: Promise<void>;
	destroyConnections(): void;
	close(): Promise<void>;
}

/**
 * Bare TLS listener used only as a measurement probe: it counts decrypted
 * post-handshake bytes and never speaks HTTP or WebSocket. It proves that a
 * rejected substitute server received zero request bytes, and the same probe
 * records a control request when the client's gate is explicitly bypassed.
 */
export async function startTlsProbe(t: TestContext, identity?: OwnedPeerIdentity): Promise<TlsProbe> {
	const probeIdentity = identity ?? (await newIdentity("probe"));
	const stats: TlsProbeStats = {
		connections: 0,
		handshakes: 0,
		decryptedBytes: 0,
		dataEvents: 0,
		tlsErrors: 0,
		captured: Buffer.alloc(0),
	};
	const sockets = new Set<TLSSocket>();
	const rawSockets = new Set<Duplex>();
	let firstDataResolve: () => void = () => undefined;
	const firstData = new Promise<void>((resolve) => {
		firstDataResolve = resolve;
	});

	const server = tls.createServer(
		{
			key: probeIdentity.privateKeyPem,
			cert: probeIdentity.certificatePem,
			requestCert: true,
			rejectUnauthorized: false,
			minVersion: "TLSv1.2",
			maxVersion: "TLSv1.3",
			handshakeTimeout: 3000,
		},
		(socket: TLSSocket) => {
			stats.handshakes++;
			sockets.add(socket);
			socket.on("error", () => {
				// Probe sockets are intentionally disposable.
			});
			socket.on("data", (chunk: Buffer) => {
				stats.dataEvents++;
				stats.decryptedBytes += chunk.length;
				if (stats.captured.length < 2048) {
					stats.captured = Buffer.concat([stats.captured, chunk]).subarray(0, 2048);
				}
				firstDataResolve();
			});
			socket.once("close", () => sockets.delete(socket));
		},
	);
	server.on("connection", (socket: Duplex) => {
		stats.connections++;
		rawSockets.add(socket);
		socket.once("close", () => rawSockets.delete(socket));
		socket.on("error", () => {
			// Disposable probe socket.
		});
	});
	server.on("tlsClientError", (_error: Error, socket: Duplex) => {
		stats.tlsErrors++;
		try {
			socket.destroy();
		} catch {
			// Already gone.
		}
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") reject(new Error("probe did not bind a TCP port"));
			else resolve(address.port);
		});
	});

	const close = async (): Promise<void> => {
		for (const socket of sockets) {
			try {
				socket.destroy();
			} catch {
				// Already gone.
			}
		}
		sockets.clear();
		for (const socket of rawSockets) {
			try {
				socket.destroy();
			} catch {
				// Already gone.
			}
		}
		rawSockets.clear();
		if (server.listening) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
	t.after(close);

	return {
		port,
		identity: probeIdentity,
		stats,
		firstData,
		destroyConnections() {
			for (const socket of sockets) {
				try {
					socket.destroy();
				} catch {
					// Already gone.
				}
			}
			for (const socket of rawSockets) {
				try {
					socket.destroy();
				} catch {
					// Already gone.
				}
			}
		},
		close,
	};
}

export interface RawTlsResult {
	readonly text: string;
	readonly handshakeOk: boolean;
	readonly closed: boolean;
}

export async function rawTlsExchange(options: {
	readonly port: number;
	readonly identity?: OwnedPeerIdentity;
	readonly request: string | Buffer;
	readonly payloadAfterRequest?: Buffer;
	readonly timeoutMs?: number;
	readonly maxVersion?: "TLSv1.2" | "TLSv1.3";
	readonly session?: Buffer;
}): Promise<RawTlsResult> {
	const socket = tls.connect({
		host: "127.0.0.1",
		port: options.port,
		...(options.identity
			? { cert: options.identity.certificatePem, key: options.identity.privateKeyPem }
			: {}),
		rejectUnauthorized: false,
		...(options.maxVersion ? { maxVersion: options.maxVersion } : {}),
		...(options.session ? { session: options.session } : {}),
	});
	socket.on("error", () => {
		// Expected for negative controls.
	});
	const chunks: Buffer[] = [];
	socket.on("data", (chunk: Buffer) => chunks.push(chunk));
	try {
		await withTimeout(
			new Promise<void>((resolve, reject) => {
				socket.once("secureConnect", resolve);
				socket.once("error", reject);
			}),
			options.timeoutMs ?? 2000,
			"raw TLS handshake timed out",
		);
	} catch {
		socket.destroy();
		return { text: "", handshakeOk: false, closed: true };
	}
	const writeBuffer = Buffer.concat([
		typeof options.request === "string" ? Buffer.from(options.request) : options.request,
		options.payloadAfterRequest ?? Buffer.alloc(0),
	]);
	socket.write(writeBuffer);
	const closed = await new Promise<boolean>((resolve) => {
		let done = false;
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			resolve(false);
		}, options.timeoutMs ?? 1500);
		timer.unref?.();
		socket.once("close", () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(true);
		});
	});
	socket.destroy();
	return { text: Buffer.concat(chunks).toString("utf8"), handshakeOk: true, closed };
}

export async function tlsHandshakeOutcome(options: {
	readonly port: number;
	readonly certificatePem: string;
	readonly privateKeyPem: string;
	readonly timeoutMs?: number;
}): Promise<{ ok: boolean; errorCode: string | null }> {
	let socket: TLSSocket;
	try {
		socket = tls.connect({
			host: "127.0.0.1",
			port: options.port,
			cert: options.certificatePem,
			key: options.privateKeyPem,
			rejectUnauthorized: false,
		});
	} catch (error) {
		return { ok: false, errorCode: (error as { code?: string }).code ?? "THROW" };
	}
	socket.on("error", () => {
		// Captured by the race below.
	});
	try {
		await withTimeout(
			new Promise<void>((resolve, reject) => {
				socket.once("secureConnect", resolve);
				socket.once("error", reject);
			}),
			options.timeoutMs ?? 2000,
			"TLS handshake timed out",
		);
		return { ok: true, errorCode: null };
	} catch (error) {
		return { ok: false, errorCode: (error as { code?: string }).code ?? "ERROR" };
	} finally {
		socket.destroy();
	}
}

export function upgradeRequestText(options: {
	readonly path?: string;
	readonly protocol?: string | null;
	readonly method?: string;
	readonly extraHeaders?: string;
} = {}): string {
	const key = randomBytes(16).toString("base64");
	const path = options.path ?? "/app";
	const method = options.method ?? "GET";
	const protocol =
		options.protocol === null
			? ""
			: `Sec-WebSocket-Protocol: ${options.protocol ?? APP_SUBPROTOCOL}\r\n`;
	return (
		`${method} ${path} HTTP/1.1\r\n` +
		"Host: peer.invalid\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		`Sec-WebSocket-Key: ${key}\r\n` +
		"Sec-WebSocket-Version: 13\r\n" +
		protocol +
		(options.extraHeaders ?? "") +
		"\r\n"
	);
}

export function pairRequestText(options: {
	readonly label: string;
	readonly path?: string;
	readonly method?: string;
	readonly claimKey?: PeerKey | null;
	readonly extraHeaders?: string;
} = { label: "peer" }): string {
	const claim = options.claimKey ? `x-peer-key: ${options.claimKey.keyId}\r\n` : "";
	return (
		`${options.method ?? "POST"} ${options.path ?? "/pair"} HTTP/1.1\r\n` +
		"Host: peer.invalid\r\n" +
		`x-peer-label: ${options.label}\r\n` +
		"content-length: 0\r\n" +
		claim +
		(options.extraHeaders ?? "") +
		"\r\n"
	);
}

export function maskedFrame(opcode: number, payload: Buffer): Buffer {
	const mask = Buffer.from([1, 2, 3, 4]);
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
	} else if (payload.length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	const masked = Buffer.alloc(payload.length);
	for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
	return Buffer.concat([header, mask, masked]);
}

export function maskedTextFrame(text: string): Buffer {
	return maskedFrame(0x1, Buffer.from(text));
}

export function maskedBinaryFrame(payload: Buffer): Buffer {
	return maskedFrame(0x2, payload);
}

export function maskedPingFrame(payload: Buffer): Buffer {
	return maskedFrame(0x9, payload);
}

export interface RawWebSocketPeer {
	readonly socket: TLSSocket;
	readonly responseHead: string;
}

/** Owned raw WebSocket peer used to send malformed/large frames and withhold close replies. */
export async function openRawWebSocket(options: {
	readonly port: number;
	readonly identity: OwnedPeerIdentity;
	readonly timeoutMs?: number;
}): Promise<RawWebSocketPeer> {
	const timeoutMs = options.timeoutMs ?? 2000;
	const socket = tls.connect({
		host: "127.0.0.1",
		port: options.port,
		cert: options.identity.certificatePem,
		key: options.identity.privateKeyPem,
		rejectUnauthorized: false,
	});
	socket.on("error", () => {
		// The caller owns disposal after the handshake.
	});
	try {
		await withTimeout(
			new Promise<void>((resolve, reject) => {
				socket.once("secureConnect", resolve);
				socket.once("error", reject);
			}),
			timeoutMs,
			"raw WebSocket TLS handshake timed out",
		);
	} catch (error) {
		socket.destroy();
		throw error;
	}

	let buffer = Buffer.alloc(0);
	let responseHead: string;
	try {
		responseHead = await withTimeout(
			new Promise<string>((resolve, reject) => {
				const onData = (chunk: Buffer): void => {
					buffer = Buffer.concat([buffer, chunk]);
					const boundary = buffer.indexOf("\r\n\r\n");
					if (boundary < 0) {
						if (buffer.length > 8192) {
							cleanup();
							reject(new Error("raw WebSocket response head too large"));
						}
						return;
					}
					cleanup();
					const head = buffer.subarray(0, boundary + 4).toString("utf8");
					if (!head.startsWith("HTTP/1.1 101")) reject(new Error("raw WebSocket upgrade was refused"));
					else resolve(head);
				};
				const onError = (): void => {
					cleanup();
					reject(new Error("raw WebSocket upgrade failed"));
				};
				const cleanup = (): void => {
					socket.off("data", onData);
					socket.off("error", onError);
				};
				socket.on("data", onData);
				socket.once("error", onError);
				socket.write(upgradeRequestText());
			}),
			timeoutMs,
			"raw WebSocket upgrade timed out",
		);
	} catch (error) {
		socket.destroy();
		throw error;
	}
	return { socket, responseHead };
}

export async function assertRefused(port: number): Promise<void> {
	await assert.rejects(
		new Promise<void>((resolve, reject) => {
			const socket = net.connect({ host: "127.0.0.1", port }, () => {
				socket.destroy();
				resolve();
			});
			socket.on("error", reject);
		}),
		(error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED",
	);
}
