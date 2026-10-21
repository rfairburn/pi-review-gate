/**
 * Bounded byte-channel contract shared by both ends of the inert peer
 * transport. A channel carries bytes only: no session permissions, capability
 * matrix, view-only policy, or controller lease exists here.
 */

import WebSocket from "ws";
import { peerError, type PeerDiagnosticCode, type PeerTransportBounds } from "./protocol";
import type { PeerKey } from "./identity";

export interface PeerChannelClose {
	readonly code: number;
	readonly reason: string;
}

export interface PeerByteChannel {
	/** Exact peer identity verified on this connection. */
	readonly peerKey: PeerKey;
	/** Bounded display label from the peer certificate, never identity. */
	readonly label: string | null;
	readonly bufferedAmount: number;
	readonly closed: Promise<PeerChannelClose>;
	/**
	 * Queue bytes for delivery. Resolution means the bytes were written to the
	 * socket, not that the remote peer read or acknowledged them. Message size
	 * and outbound queue bounds are enforced before queueing.
	 */
	send(bytes: Uint8Array): Promise<void>;
	close(): Promise<void>;
	onMessage(handler: (bytes: Buffer) => void): () => void;
}

/** Bound and strip control characters from a remote close reason. */
export function sanitizePeerCloseReason(reason: Buffer | string | undefined): string {
	if (reason === undefined) return "";
	const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : reason;
	return text.slice(0, 123).replace(/[\x00-\x1f\x7f]/g, "?");
}

export interface ByteChannelOptions {
	readonly ws: InstanceType<typeof WebSocket>;
	readonly peerKey: PeerKey;
	readonly label: string | null;
	readonly bounds: PeerTransportBounds;
	readonly isServer: boolean;
	readonly onFinalized: () => void;
	readonly diagnostic: (code: PeerDiagnosticCode) => void;
}

/** Conservative WebSocket control-frame overhead (header plus client mask). */
const CONTROL_FRAME_OVERHEAD = 32;

export function createPeerByteChannel(options: ByteChannelOptions): PeerByteChannel {
	const { ws, peerKey, label, bounds, onFinalized, diagnostic } = options;
	const handlers = new Set<(bytes: Buffer) => void>();
	let resolveClosed: (value: PeerChannelClose) => void = () => undefined;
	const closed = new Promise<PeerChannelClose>((resolve) => {
		resolveClosed = resolve;
	});
	let closePromise: Promise<void> | null = null;
	let finalized = false;
	let pendingControlBytes = 0;

	const finalize = (code: number, reason: Buffer | string | undefined): void => {
		if (finalized) return;
		finalized = true;
		pendingControlBytes = 0;
		const info = Object.freeze({ code, reason: sanitizePeerCloseReason(reason) });
		resolveClosed(info);
		onFinalized();
		diagnostic("app_channel_closed");
	};

	ws.on("error", () => {
		// The close event owns finalization; an error must never become unhandled.
	});
	ws.on("close", (code: number, reason: Buffer) => finalize(code, reason));
	ws.on("ping", (data: WebSocket.RawData) => {
		if (ws.readyState !== WebSocket.OPEN) return;
		const payload = Buffer.isBuffer(data)
			? data
			: Array.isArray(data)
				? Buffer.concat(data)
				: Buffer.from(data as ArrayBuffer);
		const controlBytes = payload.length + CONTROL_FRAME_OVERHEAD;
		if (ws.bufferedAmount + pendingControlBytes + controlBytes > bounds.maxOutboundQueueBytes) {
			try {
				ws.terminate();
			} catch {
				// Already gone.
			}
			finalize(1006, "control queue bound");
			return;
		}
		pendingControlBytes += controlBytes;
		const releaseControl = (): void => {
			pendingControlBytes = Math.max(0, pendingControlBytes - controlBytes);
		};
		try {
			ws.pong(payload, !options.isServer, (error?: Error) => {
				releaseControl();
				if (!error) return;
				try {
					ws.terminate();
				} catch {
					// Already gone.
				}
				finalize(1006, "control send failed");
			});
		} catch {
			releaseControl();
			try {
				ws.terminate();
			} catch {
				// Already gone.
			}
			finalize(1006, "control send failed");
		}
	});
	ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
		if (!isBinary) {
			try {
				ws.close(1003, "unsupported message");
			} catch {
				// Already closing.
			}
			return;
		}
		const bytes = Buffer.isBuffer(data)
			? data
			: Array.isArray(data)
				? Buffer.concat(data)
				: Buffer.from(data as ArrayBuffer);
		for (const handler of [...handlers]) {
			try {
				handler(bytes);
			} catch {
				try {
					ws.close(1011, "handler failed");
				} catch {
					// Already closing.
				}
				return;
			}
		}
	});

	const channel: PeerByteChannel = {
		peerKey,
		label,
		get bufferedAmount() {
			return ws.bufferedAmount + pendingControlBytes;
		},
		closed,
		send(bytes: Uint8Array): Promise<void> {
			if (finalized || ws.readyState !== WebSocket.OPEN) {
				return Promise.reject(peerError("CHANNEL_NOT_OPEN"));
			}
			if (!(bytes instanceof Uint8Array)) return Promise.reject(peerError("INVALID_ARGUMENT"));
			if (bytes.length > bounds.maxWebSocketMessageBytes) return Promise.reject(peerError("MESSAGE_TOO_LARGE"));
			if (ws.bufferedAmount + pendingControlBytes + bytes.length > bounds.maxOutboundQueueBytes) {
				return Promise.reject(peerError("OUTBOUND_QUEUE_FULL"));
			}
			return new Promise<void>((resolve, reject) => {
				try {
					ws.send(bytes, { binary: true }, (error?: Error) => {
						if (error) reject(peerError("SEND_FAILED"));
						else resolve();
					});
				} catch {
					reject(peerError("SEND_FAILED"));
				}
			});
		},
		close(): Promise<void> {
			if (closePromise) return closePromise;
			closePromise = (async () => {
				if (finalized || ws.readyState === WebSocket.CLOSED) {
					finalize(1000, "");
					return;
				}
				if (ws.readyState === WebSocket.OPEN) {
					try {
						ws.close(1000);
					} catch {
						try {
							ws.terminate();
						} catch {
							// Already gone.
						}
						finalize(1006, "terminated");
						return;
					}
					const closedInTime = await new Promise<boolean>((resolve) => {
						let done = false;
						const timer = setTimeout(() => {
							if (done) return;
							done = true;
							resolve(false);
						}, bounds.closeTimeoutMs);
						timer.unref?.();
						closed.then(() => {
							if (done) return;
							done = true;
							clearTimeout(timer);
							resolve(true);
						});
					});
					if (!closedInTime) {
						try {
							ws.terminate();
						} catch {
							// Already gone.
						}
						finalize(1006, "terminated");
					}
					return;
				}
				try {
					ws.terminate();
				} catch {
					// Already gone.
				}
				finalize(1006, "terminated");
			})();
			return closePromise;
		},
		onMessage(handler: (bytes: Buffer) => void): () => void {
			if (typeof handler !== "function") throw peerError("INVALID_ARGUMENT");
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
	};
	return channel;
}
