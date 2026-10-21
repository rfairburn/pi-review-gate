/**
 * Injected trust and authorization seams for the inert paired peer transport.
 *
 * Two independent facts are stored:
 *
 * - An accepted peer identity: the exact key a receiving human approved.
 * - A current directional grant: permission for that peer to open inbound
 *   application channels to the receiving identity. A grant is always
 *   `peer->host`; it never implies the reverse direction.
 *
 * Records are bound to the stable canonical key of the receiving identity, not
 * to an ephemeral listener or process instance. Recreating a listener with the
 * same receiving key and the same injected stores therefore preserves
 * remembered access, while a different receiving key cannot inherit it.
 *
 * Revoking either fact refuses subsequent connections. The adapter does not
 * decide active-channel or session lifecycle beyond its explicit close API.
 * No filesystem, ambient configuration, or process-global trust is consulted.
 */

import type { PeerKey } from "./identity";

export interface AcceptedPeerRecord {
	readonly key: PeerKey;
	/** Friendly display label only; never identity. */
	readonly label: string;
	readonly acceptedAt: number;
	/** Stable canonical key id of the receiving identity that approved this peer. */
	readonly receiverKeyId: string;
}

export interface AcceptedPeerStore {
	get(keyId: string): AcceptedPeerRecord | undefined;
	set(record: AcceptedPeerRecord): void;
	delete(keyId: string): boolean;
}

export interface DirectionalGrantRecord {
	readonly peerKeyId: string;
	readonly direction: "peer->host";
	readonly capability: "app";
	readonly grantedAt: number;
	/** Stable canonical key id of the receiving identity that granted this access. */
	readonly receiverKeyId: string;
}

export interface DirectionalGrantStore {
	get(peerKeyId: string): DirectionalGrantRecord | undefined;
	set(record: DirectionalGrantRecord): void;
	delete(peerKeyId: string): boolean;
}

/**
 * Client-side remembered server identity. Only the exact canonical key is
 * remembered: no name, address, certificate id, or separate derived id.
 */
export interface RememberedPeerKeyStore {
	read(): PeerKey | null;
	write(key: PeerKey): void;
	clear(): void;
}

function copyRecord<T extends { readonly key: PeerKey }>(record: T): T {
	return Object.freeze({
		...record,
		key: Object.freeze({ ...record.key }),
	});
}

/** Process-local store; callers may inject a different implementation. */
export function createInMemoryAcceptedPeerStore(): AcceptedPeerStore & { readonly size: number } {
	const records = new Map<string, AcceptedPeerRecord>();
	return {
		get size() {
			return records.size;
		},
		get(keyId) {
			return records.get(keyId);
		},
		set(record) {
			records.set(record.key.keyId, copyRecord(record));
		},
		delete(keyId) {
			return records.delete(keyId);
		},
	};
}

/** Process-local store; callers may inject a different implementation. */
export function createInMemoryDirectionalGrantStore(): DirectionalGrantStore & { readonly size: number } {
	const records = new Map<string, DirectionalGrantRecord>();
	return {
		get size() {
			return records.size;
		},
		get(peerKeyId) {
			return records.get(peerKeyId);
		},
		set(record) {
			records.set(record.peerKeyId, Object.freeze({ ...record }));
		},
		delete(peerKeyId) {
			return records.delete(peerKeyId);
		},
	};
}

/** Process-local remembered-key store; callers may inject a different implementation. */
export function createInMemoryRememberedPeerKeyStore(initial: PeerKey | null = null): RememberedPeerKeyStore & {
	readonly current: PeerKey | null;
} {
	let remembered = initial === null ? null : Object.freeze({ ...initial });
	return {
		get current() {
			return remembered;
		},
		read() {
			return remembered;
		},
		write(key) {
			remembered = Object.freeze({ ...key });
		},
		clear() {
			remembered = null;
		},
	};
}
