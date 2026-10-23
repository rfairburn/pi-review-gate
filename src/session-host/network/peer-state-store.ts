/**
 * Protected durable peer state for the inert paired peer transport (issue #480).
 *
 * One bounded, versioned document in the canonical Pi agent directory holds the
 * receiving identity, the accepted peer identities, the receiving-side
 * directional grants and the per-target outgoing remembered keys:
 *
 * ```
 * <agentDir>/session-host/peers/state.json
 * ```
 *
 * The store is an explicitly constructed library. Importing this module and
 * opening an uninitialized agent directory create no key material, file,
 * directory, socket, timer, or process. `initializeIdentity` is the only
 * operation that generates an identity, and it does so only after the dedicated
 * `peers` directory and an empty temporary file have been established and
 * verified private by the injected `PeerStatePermissionPolicy`.
 *
 * Trust semantics:
 *
 * - Every record is bound to the exact SPKI of the receiving identity that
 *   approved it (`receiverKeyId`). A document whose records are bound to a
 *   different key, or whose certificate does not match its private key, is
 *   refused and left untouched.
 * - The receiving host calls `acceptedPeers.set` and `grants.set` separately.
 *   Each call durably publishes one complete candidate document before it is
 *   usable in memory, but the two calls are deliberately NOT one pairing
 *   transaction: the host's existing both-facts gate remains authoritative.
 * - Accepted identity and directional grant are independent facts. A document
 *   may legitimately hold either one alone: separate `set`/`delete` calls (and
 *   the host's existing revoke order) must stay representable, and restoring
 *   one fact never manufactures the other. This store rejects receiver-key,
 *   direction, capability, key, duplicate, or schema inconsistency — never the
 *   intentional absence of the other fact, and it never imposes a cross-record
 *   bijection such as "every grant needs an accepted row".
 * - Unknown versions, malformed/oversized/duplicate records, unsafe paths, and
 *   inconsistent receiver bindings never degrade to empty or first-use trust.
 *   An existing `peers` directory without a valid `state.json` is unavailable,
 *   never a fresh initialization. Only a genuinely absent path means
 *   uninitialized: a stat/IO/permission failure is unavailable storage, and the
 *   open fails closed instead of reporting empty trust.
 *
 * Fail-closed boundaries:
 *
 * - A mutation whose publication definitely failed before the rename leaves the
 *   previous committed document intact and the handle usable.
 * - A publication failure at or after the rename attempt, a detected
 *   destination/directory change, or an unverifiable published document poisons
 *   the handle: every later read/mutation throws a fixed error instead of
 *   claiming memory equals disk. Poisoning is permanent for that handle.
 * - One owning-host lifecycle uses one handle per canonical agent directory.
 *   This store is a single-writer component with fences against unexpected disk
 *   changes; it is not a CAS against arbitrary external writers and does not
 *   read live hand-edited files. There is no automatic reset, repair, recovery,
 *   sweep, backup search, or stale-lock takeover.
 * - File fsync plus best-effort directory fsync are scoped publication
 *   guarantees, not power-loss durability promises.
 *
 * Fixed, display-safe errors only: no PEM, key, record content, path, stack, or
 * raw exception text is ever part of an error.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	type BigIntStats,
	type Stats,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import { sessionHostStateDir } from "../roster-store";
import {
	generatePeerIdentity,
	isWellFormedPeerKey,
	loadOwnedPeerIdentity,
	type OwnedPeerIdentity,
	type PeerKey,
} from "./identity";
import {
	GRANT_CAPABILITY,
	GRANT_DIRECTION,
	isBoundedPeerKeyId,
	isValidPeerLabel,
	peerError,
	type PeerTransportError,
} from "./protocol";
import type { PeerStatePermissionPolicy } from "./peer-state-permission-policy";
import type {
	AcceptedPeerRecord,
	AcceptedPeerStore,
	DirectionalGrantRecord,
	DirectionalGrantStore,
	RememberedPeerKeyStore,
} from "./trust";

/** Version of the persisted peer-state document; unknown versions are refused. */
export const PEER_STATE_STORE_VERSION = 1;

/** Dedicated per-agent state directory holding only this document. */
export const PEER_STATE_DIRNAME = "peers";

/** Fixed persisted document name inside the dedicated directory. */
export const PEER_STATE_FILENAME = "state.json";

/** Bound for the whole published document. */
export const MAX_PEER_STATE_FILE_BYTES = 128 * 1024;

/** Bounds for remembered record counts; larger documents are refused. */
export const MAX_ACCEPTED_PEER_RECORDS = 64;
export const MAX_DIRECTIONAL_GRANT_RECORDS = 64;
export const MAX_REMEMBERED_PEER_SLOTS = 64;

/**
 * Bound for an opaque LOCAL remembered-key slot id. It names a local client
 * slot only; it is never an identity, endpoint, or path component.
 */
export const MAX_REMEMBERED_TARGET_ID_CHARS = 128;

export interface OpenPeerStateStoreOptions {
	/** Canonical Pi agent directory; must already exist as a real directory. */
	readonly agentDir: string;
	/** Injected, required protection seam. There is no permissive default. */
	readonly permissions: PeerStatePermissionPolicy;
}

/** Read-only owner-UI observations; never a substitute for current store authorization. */
export interface PeerStateTrustSnapshot {
	readonly receiverKey: PeerKey;
	readonly acceptedPeers: readonly AcceptedPeerRecord[];
	readonly grants: readonly DirectionalGrantRecord[];
	readonly remembered: readonly { readonly targetId: string; readonly key: PeerKey }[];
}

/**
 * One explicitly opened peer state handle.
 *
 * `identity` is `null` only while the store is uninitialized (no dedicated
 * `peers` directory exists). Reads of a closed, poisoned, or uninitialized
 * handle never fabricate records, and mutations without an established
 * identity refuse rather than create one.
 */
export interface PeerStateStore {
	readonly identity: OwnedPeerIdentity | null;
	/** Explicit, one-time generation of the receiving identity for this directory. */
	initializeIdentity(label: string): Promise<OwnedPeerIdentity>;
	readonly acceptedPeers: AcceptedPeerStore;
	readonly grants: DirectionalGrantStore;
	/** Fresh display-only projection, or null for a genuinely uninitialized store. */
	readTrustSnapshot(): PeerStateTrustSnapshot | null;
	/** Independent remembered outgoing key slot; `targetId` never affects a path. */
	rememberedFor(targetId: string): RememberedPeerKeyStore;
	close(): void;
}

interface FileReceipt {
	readonly dev: bigint;
	readonly ino: bigint;
}

interface PeerStateModel {
	readonly identity: OwnedPeerIdentity;
	readonly accepted: Map<string, AcceptedPeerRecord>;
	readonly grants: Map<string, DirectionalGrantRecord>;
	readonly remembered: Map<string, PeerKey>;
}

function trustError(): PeerTransportError {
	return peerError("TRUST_STORE_FAILED");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) return false;
	}
	return true;
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedTargetId(value: unknown): value is string {
	// A remembered target id is opaque local DATA only: it is held in a Map, never
	// used as a path component or property key, so names such as `__proto__` or
	// `constructor` are ordinary strings with no prototype or authority effect.
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_REMEMBERED_TARGET_ID_CHARS
		&& !/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(value);
}

function copyPeerKey(key: PeerKey): PeerKey {
	return Object.freeze({ keyId: key.keyId, fingerprint: key.fingerprint });
}

function copyAcceptedRecord(record: AcceptedPeerRecord): AcceptedPeerRecord {
	return Object.freeze({
		key: copyPeerKey(record.key),
		label: record.label,
		acceptedAt: record.acceptedAt,
		receiverKeyId: record.receiverKeyId,
	});
}

function copyGrantRecord(record: DirectionalGrantRecord): DirectionalGrantRecord {
	return Object.freeze({
		peerKeyId: record.peerKeyId,
		direction: record.direction,
		capability: record.capability,
		grantedAt: record.grantedAt,
		receiverKeyId: record.receiverKeyId,
	});
}

/** Fresh immutable projection; the mutable certificate buffer and dates are copied. */
function projectIdentity(identity: OwnedPeerIdentity): OwnedPeerIdentity {
	return Object.freeze({
		label: identity.label,
		certificatePem: identity.certificatePem,
		privateKeyPem: identity.privateKeyPem,
		key: copyPeerKey(identity.key),
		certificateDer: Buffer.from(identity.certificateDer),
		notBefore: new Date(identity.notBefore.getTime()),
		notAfter: new Date(identity.notAfter.getTime()),
		keyType: identity.keyType,
	});
}

/**
 * Bounded observation of one path. Only ENOENT means "absent"; every other
 * failure (permissions, IO, type resolution) is an unavailable store and is
 * reported as a fixed error instead of being mistaken for fresh state.
 */
function lstatBig(path: string): BigIntStats | undefined {
	try {
		return lstatSync(path, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw trustError();
	}
}

function sameReceipt(stats: BigIntStats, receipt: FileReceipt): boolean {
	return stats.dev === receipt.dev && stats.ino === receipt.ino;
}

/** Best-effort directory fsync; not every supported filesystem permits it. */
function syncDirectoryBestEffort(directory: string): void {
	try {
		const fd = openSync(directory, fsConstants.O_RDONLY);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Directory fsync is a best-effort publication aid, not a durability claim.
	}
}

function readAll(fd: number, size: number): Buffer | undefined {
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		let read: number;
		try {
			read = readSync(fd, buffer, offset, size - offset, offset);
		} catch {
			return undefined;
		}
		if (read <= 0) break;
		offset += read;
	}
	return offset === size ? buffer : undefined;
}

function canonicalAgentDirectory(agentDir: unknown): string {
	if (typeof agentDir !== "string" || agentDir === "" || !isAbsolute(agentDir)) {
		throw peerError("INVALID_ARGUMENT");
	}
	let stats: Stats;
	try {
		stats = lstatSync(agentDir);
	} catch {
		throw trustError();
	}
	if (stats.isSymbolicLink() || !stats.isDirectory()) throw trustError();
	try {
		return realpathSync(agentDir);
	} catch {
		throw trustError();
	}
}

const PERMISSION_METHODS = [
	"assertOwnerControlledDirectory",
	"assertPrivateDirectory",
	"protectCreatedDirectory",
	"assertPrivateFile",
	"protectCreatedFile",
] as const;

function assertPermissionPolicy(value: unknown): PeerStatePermissionPolicy {
	if (!isPlainRecord(value)) throw peerError("INVALID_ARGUMENT");
	for (const method of PERMISSION_METHODS) {
		if (typeof value[method] !== "function") throw peerError("INVALID_ARGUMENT");
	}
	return value as unknown as PeerStatePermissionPolicy;
}

/** Documents validated in this process; a second live authority is refused. */
const liveAuthorities = new Set<string>();

function readDocumentIdentity(value: unknown): OwnedPeerIdentity | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (!hasOnlyKeys(value, ["label", "certificatePem", "privateKeyPem"])) return undefined;
	const { label, certificatePem, privateKeyPem } = value;
	if (typeof label !== "string" || typeof certificatePem !== "string" || typeof privateKeyPem !== "string") {
		return undefined;
	}
	try {
		return loadOwnedPeerIdentity({ label, certificatePem, privateKeyPem });
	} catch {
		return undefined;
	}
}

function readAcceptedRecord(value: unknown, receiverKeyId: string): AcceptedPeerRecord | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (!hasOnlyKeys(value, ["key", "label", "acceptedAt", "receiverKeyId"])) return undefined;
	if (!isPlainRecord(value.key) || !hasOnlyKeys(value.key, ["keyId", "fingerprint"])) return undefined;
	if (!isWellFormedPeerKey(value.key)) return undefined;
	if (!isValidPeerLabel(value.label)) return undefined;
	if (!isTimestamp(value.acceptedAt)) return undefined;
	if (value.receiverKeyId !== receiverKeyId) return undefined;
	return Object.freeze({
		key: copyPeerKey(value.key),
		label: value.label,
		acceptedAt: value.acceptedAt,
		receiverKeyId,
	});
}

function readGrantRecord(value: unknown, receiverKeyId: string): DirectionalGrantRecord | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (!hasOnlyKeys(value, ["peerKeyId", "direction", "capability", "grantedAt", "receiverKeyId"])) return undefined;
	if (!isBoundedPeerKeyId(value.peerKeyId)) return undefined;
	if (value.direction !== GRANT_DIRECTION) return undefined;
	if (value.capability !== GRANT_CAPABILITY) return undefined;
	if (!isTimestamp(value.grantedAt)) return undefined;
	if (value.receiverKeyId !== receiverKeyId) return undefined;
	return Object.freeze({
		peerKeyId: value.peerKeyId,
		direction: GRANT_DIRECTION,
		capability: GRANT_CAPABILITY,
		grantedAt: value.grantedAt,
		receiverKeyId,
	});
}

function readRememberedRecord(value: unknown): { targetId: string; key: PeerKey } | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (!hasOnlyKeys(value, ["targetId", "key"])) return undefined;
	if (!isBoundedTargetId(value.targetId)) return undefined;
	if (!isPlainRecord(value.key) || !hasOnlyKeys(value.key, ["keyId", "fingerprint"])) return undefined;
	if (!isWellFormedPeerKey(value.key)) return undefined;
	return { targetId: value.targetId, key: copyPeerKey(value.key) };
}

/**
 * Validate one whole persisted document. Any unknown version, missing or extra
 * field, duplicate logical record, bound violation, or receiver-binding
 * inconsistency refuses the document; nothing is silently dropped, truncated,
 * or evicted.
 *
 * Validation uses standard bounded `JSON.parse` plus this strict schema. Records
 * are carried as arrays precisely so duplicate logical peer, grant, and slot
 * entries are observable and refused; no custom JSON duplicate-member lexer or
 * parser is invented here.
 */
function parsePeerStateDocument(value: unknown): PeerStateModel | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (!hasOnlyKeys(value, ["version", "receiverKeyId", "identity", "accepted", "grants", "remembered"])) {
		return undefined;
	}
	if (value.version !== PEER_STATE_STORE_VERSION) return undefined;
	if (!isBoundedPeerKeyId(value.receiverKeyId)) return undefined;

	const identity = readDocumentIdentity(value.identity);
	if (identity === undefined) return undefined;
	if (identity.key.keyId !== value.receiverKeyId) return undefined;

	if (!Array.isArray(value.accepted) || value.accepted.length > MAX_ACCEPTED_PEER_RECORDS) return undefined;
	const accepted = new Map<string, AcceptedPeerRecord>();
	for (const raw of value.accepted) {
		const record = readAcceptedRecord(raw, value.receiverKeyId);
		if (record === undefined) return undefined;
		if (accepted.has(record.key.keyId)) return undefined;
		accepted.set(record.key.keyId, record);
	}

	if (!Array.isArray(value.grants) || value.grants.length > MAX_DIRECTIONAL_GRANT_RECORDS) return undefined;
	const grants = new Map<string, DirectionalGrantRecord>();
	for (const raw of value.grants) {
		const record = readGrantRecord(raw, value.receiverKeyId);
		if (record === undefined) return undefined;
		if (grants.has(record.peerKeyId)) return undefined;
		grants.set(record.peerKeyId, record);
	}

	if (!Array.isArray(value.remembered) || value.remembered.length > MAX_REMEMBERED_PEER_SLOTS) return undefined;
	const remembered = new Map<string, PeerKey>();
	for (const raw of value.remembered) {
		const record = readRememberedRecord(raw);
		if (record === undefined) return undefined;
		if (remembered.has(record.targetId)) return undefined;
		remembered.set(record.targetId, record.key);
	}

	return { identity, accepted, grants, remembered };
}

function serializePeerState(model: PeerStateModel): string {
	const document = {
		version: PEER_STATE_STORE_VERSION,
		receiverKeyId: model.identity.key.keyId,
		identity: {
			label: model.identity.label,
			certificatePem: model.identity.certificatePem,
			privateKeyPem: model.identity.privateKeyPem,
		},
		accepted: Array.from(model.accepted.values(), (record) => ({
			key: { keyId: record.key.keyId, fingerprint: record.key.fingerprint },
			label: record.label,
			acceptedAt: record.acceptedAt,
			receiverKeyId: record.receiverKeyId,
		})),
		grants: Array.from(model.grants.values(), (record) => ({
			peerKeyId: record.peerKeyId,
			direction: record.direction,
			capability: record.capability,
			grantedAt: record.grantedAt,
			receiverKeyId: record.receiverKeyId,
		})),
		remembered: Array.from(model.remembered, ([targetId, key]) => ({
			targetId,
			key: { keyId: key.keyId, fingerprint: key.fingerprint },
		})),
	};
	const body = `${JSON.stringify(document)}\n`;
	if (Buffer.byteLength(body, "utf8") > MAX_PEER_STATE_FILE_BYTES) throw trustError();
	return body;
}

/** Remove only a temporary file whose exact receipt this call still owns. */
function removeOwnedTemporary(path: string, receipt: FileReceipt | undefined): void {
	if (receipt === undefined) return;
	try {
		const current = lstatSync(path, { bigint: true });
		if (!current.isFile() || current.isSymbolicLink() || !sameReceipt(current, receipt)) return;
		unlinkSync(path);
	} catch {
		// An unverified or already-gone temporary is never removed by name.
	}
}

class PeerStateManager implements PeerStateStore {
	private readonly permissions: PeerStatePermissionPolicy;
	private readonly stateDir: string;
	private readonly peersDir: string;
	private readonly statePath: string;

	private model: PeerStateModel | null = null;
	private stateDirReceipt: FileReceipt | undefined;
	private peersReceipt: FileReceipt | undefined;
	private stateReceipt: FileReceipt | undefined;
	private pendingInitialization: Promise<OwnedPeerIdentity> | null = null;
	private closed = false;
	private poisoned = false;
	private registered = false;

	private readonly acceptedStore: AcceptedPeerStore;
	private readonly grantStore: DirectionalGrantStore;
	private readonly rememberedStores = new Map<string, RememberedPeerKeyStore>();

	constructor(canonicalAgentDir: string, permissions: PeerStatePermissionPolicy) {
		this.permissions = permissions;
		this.stateDir = sessionHostStateDir(canonicalAgentDir);
		this.peersDir = join(this.stateDir, PEER_STATE_DIRNAME);
		this.statePath = join(this.peersDir, PEER_STATE_FILENAME);
		this.acceptedStore = Object.freeze({
			get: (keyId: string) => this.readAccepted(keyId),
			set: (record: AcceptedPeerRecord) => this.writeAccepted(record),
			delete: (keyId: string) => this.deleteAccepted(keyId),
		});
		this.grantStore = Object.freeze({
			get: (peerKeyId: string) => this.readGrant(peerKeyId),
			set: (record: DirectionalGrantRecord) => this.writeGrant(record),
			delete: (peerKeyId: string) => this.deleteGrant(peerKeyId),
		});
	}

	get identity(): OwnedPeerIdentity | null {
		this.assertUsable();
		return this.model === null ? null : projectIdentity(this.model.identity);
	}

	get acceptedPeers(): AcceptedPeerStore {
		return this.acceptedStore;
	}

	get grants(): DirectionalGrantStore {
		return this.grantStore;
	}

	readTrustSnapshot(): PeerStateTrustSnapshot | null {
		this.assertUsable();
		const model = this.model;
		if (model === null) return null;
		return Object.freeze({
			receiverKey: copyPeerKey(model.identity.key),
			acceptedPeers: Object.freeze(Array.from(model.accepted.values(), copyAcceptedRecord)),
			grants: Object.freeze(Array.from(model.grants.values(), copyGrantRecord)),
			remembered: Object.freeze(Array.from(model.remembered, ([targetId, key]) =>
				Object.freeze({ targetId, key: copyPeerKey(key) }))),
		});
	}

	initializeIdentity(label: string): Promise<OwnedPeerIdentity> {
		if (typeof label !== "string" || !isValidPeerLabel(label)) {
			return Promise.reject(peerError("INVALID_ARGUMENT"));
		}
		// A closed or poisoned handle has no authority; even a previously resolved
		// initialization outcome is not reported as usable again.
		if (this.closed || this.poisoned) return Promise.reject(trustError());
		if (this.pendingInitialization !== null) {
			return this.pendingInitialization.then((identity) => projectIdentity(identity));
		}
		if (this.model !== null) return Promise.reject(trustError());

		const pending = this.performInitialization(label);
		this.pendingInitialization = pending;
		pending.catch(() => {
			if (this.pendingInitialization === pending) this.pendingInitialization = null;
		});
		// Every caller receives its own fresh projection of the shared outcome.
		return pending.then((identity) => projectIdentity(identity));
	}

	rememberedFor(targetId: string): RememberedPeerKeyStore {
		if (!isBoundedTargetId(targetId)) throw peerError("INVALID_ARGUMENT");
		const existing = this.rememberedStores.get(targetId);
		if (existing !== undefined) return existing;
		const store: RememberedPeerKeyStore = Object.freeze({
			read: (): PeerKey | null => this.readRemembered(targetId),
			write: (key: PeerKey): void => this.writeRemembered(targetId, key),
			clear: (): void => this.clearRemembered(targetId),
		});
		this.rememberedStores.set(targetId, store);
		return store;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.model = null;
		this.pendingInitialization = null;
		this.dropAuthority();
	}

	/** Read the fixed existing document; absence of the dedicated directory is uninitialized. */
	load(): void {
		const stateDirStats = lstatBig(this.stateDir);
		if (stateDirStats === undefined) return;
		if (stateDirStats.isSymbolicLink() || !stateDirStats.isDirectory()) throw trustError();
		this.protect(() => this.permissions.assertOwnerControlledDirectory(this.stateDir));
		const stateDirReceipt = { dev: stateDirStats.dev, ino: stateDirStats.ino };

		const peersStats = lstatBig(this.peersDir);
		if (peersStats === undefined) return;
		if (peersStats.isSymbolicLink() || !peersStats.isDirectory()) throw trustError();
		this.protect(() => this.permissions.assertPrivateDirectory(this.peersDir));

		const documentStats = lstatBig(this.statePath);
		// An existing dedicated directory without state.json is unavailable: it is
		// never treated as a fresh identity and nothing is regenerated.
		if (documentStats === undefined) throw trustError();
		if (documentStats.isSymbolicLink() || !documentStats.isFile()) throw trustError();
		if (documentStats.size <= 0n || documentStats.size > BigInt(MAX_PEER_STATE_FILE_BYTES)) throw trustError();
		this.protect(() => this.permissions.assertPrivateFile(this.statePath));

		const model = this.readExistingDocument(documentStats);
		this.claimAuthority();
		this.model = model;
		this.stateDirReceipt = stateDirReceipt;
		this.peersReceipt = { dev: peersStats.dev, ino: peersStats.ino };
		this.stateReceipt = { dev: documentStats.dev, ino: documentStats.ino };
	}

	private readExistingDocument(preStats: BigIntStats): PeerStateModel {
		let fd: number;
		try {
			fd = openSync(this.statePath, fsConstants.O_RDONLY
				| (fsConstants.O_NONBLOCK ?? 0)
				| (fsConstants.O_NOFOLLOW ?? 0));
		} catch {
			throw trustError();
		}
		try {
			let stats: BigIntStats;
			try {
				stats = fstatSync(fd, { bigint: true });
			} catch {
				throw trustError();
			}
			if (!stats.isFile() || !sameReceipt(stats, preStats)) throw trustError();
			if (stats.size <= 0n || stats.size > BigInt(MAX_PEER_STATE_FILE_BYTES)) throw trustError();
			const bytes = readAll(fd, Number(stats.size));
			if (bytes === undefined) throw trustError();
			let parsed: unknown;
			try {
				parsed = JSON.parse(bytes.toString("utf8"));
			} catch {
				throw trustError();
			}
			const model = parsePeerStateDocument(parsed);
			if (model === undefined) throw trustError();
			return model;
		} finally {
			try {
				closeSync(fd);
			} catch {
				// A close failure must not replace the bounded read result.
			}
		}
	}

	private async performInitialization(label: string): Promise<OwnedPeerIdentity> {
		let temporaryReceipt: FileReceipt | undefined;
		let temporaryPath: string | undefined;
		let fd: number | undefined;
		try {
			const stateDirReceipt = this.ensureOwnerControlledStateDir();

			// The dedicated directory is created exclusively: an existing directory
			// (including one a concurrent initializer just created) is refused rather
			// than adopted, scanned, or repaired.
			try {
				mkdirSync(this.peersDir, { mode: 0o700 });
			} catch {
				throw trustError();
			}
			this.protect(() => this.permissions.protectCreatedDirectory(this.peersDir));
			const peersStats = lstatBig(this.peersDir);
			if (peersStats === undefined || peersStats.isSymbolicLink() || !peersStats.isDirectory()) {
				throw trustError();
			}

			// Protection is established on the owned, still-empty temporary BEFORE
			// any private-key byte exists on disk.
			const tempPath = join(this.peersDir, `${PEER_STATE_FILENAME}.tmp.${randomUUID()}`);
			temporaryPath = tempPath;
			try {
				fd = openSync(tempPath, "wx", 0o600);
			} catch {
				throw trustError();
			}
			const opened = fstatSync(fd, { bigint: true });
			if (!opened.isFile()) throw trustError();
			temporaryReceipt = { dev: opened.dev, ino: opened.ino };
			this.protect(() => this.permissions.protectCreatedFile(tempPath));
			this.assertEmptyOwnedTemporary(tempPath, temporaryReceipt);

			const identity = await generateIdentity(label);
			// The handle may have been closed while the identity was generated: an
			// in-flight initialization never publishes for a handle without authority.
			this.assertUsable();
			const model: PeerStateModel = {
				identity,
				accepted: new Map(),
				grants: new Map(),
				remembered: new Map(),
			};
			const body = serializePeerState(model);

			// Re-fence the owned empty temporary immediately before the secret write.
			this.assertEmptyOwnedTemporary(tempPath, temporaryReceipt);
			writeFileSync(fd, body, "utf8");
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;

			const currentPeers = lstatBig(this.peersDir);
			if (currentPeers === undefined || !sameReceipt(currentPeers, peersStats)) throw trustError();
			const currentStateDir = lstatBig(this.stateDir);
			if (currentStateDir === undefined
				|| currentStateDir.isSymbolicLink()
				|| !currentStateDir.isDirectory()
				|| !sameReceipt(currentStateDir, stateDirReceipt)) {
				throw trustError();
			}
			// A winner that appeared meanwhile is never overwritten.
			if (lstatBig(this.statePath) !== undefined) throw trustError();

			// Exclusive first publication: the fully written, fsynced temporary is
			// linked to the fixed name; the link fails instead of replacing a winner.
			linkSync(tempPath, this.statePath);
			const published = lstatBig(this.statePath);
			if (published === undefined
				|| published.isSymbolicLink()
				|| !published.isFile()
				|| !sameReceipt(published, temporaryReceipt)
				|| published.size !== BigInt(Buffer.byteLength(body))) {
				throw trustError();
			}
			// First publication briefly has two names for the same protected inode.
			// Retire only our receipt-fenced temporary before enforcing the platform
			// policy's final single-link invariant; no permission check is weakened.
			const retiring = lstatBig(tempPath);
			if (retiring === undefined || retiring.isSymbolicLink() || !retiring.isFile()
				|| !sameReceipt(retiring, temporaryReceipt)) throw trustError();
			unlinkSync(tempPath);
			temporaryReceipt = undefined;
			temporaryPath = undefined;
			this.protect(() => this.permissions.assertPrivateFile(this.statePath));
			syncDirectoryBestEffort(this.peersDir);

			this.claimAuthority();
			this.model = model;
			this.stateDirReceipt = stateDirReceipt;
			this.peersReceipt = { dev: peersStats.dev, ino: peersStats.ino };
			this.stateReceipt = { dev: published.dev, ino: published.ino };
			// The caller never receives the internal identity object: a projection
			// cannot mutate the authority the model retains.
			return projectIdentity(identity);
		} catch {
			// Any initialization failure leaves this handle without authority: the
			// caller must reopen instead of retrying on a half-established directory.
			this.poison();
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// Preserve the refusal.
				}
			}
			if (temporaryPath !== undefined) removeOwnedTemporary(temporaryPath, temporaryReceipt);
			throw trustError();
		}
	}

	private ensureOwnerControlledStateDir(): FileReceipt {
		const existing = lstatBig(this.stateDir);
		if (existing === undefined) {
			try {
				mkdirSync(this.stateDir, { mode: 0o700 });
			} catch {
				throw trustError();
			}
			this.protect(() => this.permissions.protectCreatedDirectory(this.stateDir));
			const created = lstatBig(this.stateDir);
			if (created === undefined || created.isSymbolicLink() || !created.isDirectory()) throw trustError();
			return { dev: created.dev, ino: created.ino };
		}
		if (existing.isSymbolicLink() || !existing.isDirectory()) throw trustError();
		this.protect(() => this.permissions.assertOwnerControlledDirectory(this.stateDir));
		return { dev: existing.dev, ino: existing.ino };
	}

	private assertEmptyOwnedTemporary(path: string, receipt: FileReceipt): void {
		const current = lstatBig(path);
		if (current === undefined
			|| current.isSymbolicLink()
			|| !current.isFile()
			|| !sameReceipt(current, receipt)
			|| current.size !== 0n) {
			throw trustError();
		}
	}

	private assertUsable(): void {
		if (this.closed || this.poisoned) throw trustError();
	}

	private requireModel(): PeerStateModel {
		this.assertUsable();
		if (this.model === null) throw trustError();
		return this.model;
	}

	/**
	 * One full-document publication: fence the owned destination, write and fsync
	 * an owned private temporary, rename it into place, verify the published
	 * inode and protection, and only then make the candidate usable.
	 */
	private publish(next: PeerStateModel): void {
		const body = serializePeerState(next);
		this.assertOwnedStateDirectory();
		this.assertOwnedPeersDirectory();
		this.assertOwnedDestination();

		const temporaryPath = join(this.peersDir, `${PEER_STATE_FILENAME}.tmp.${randomUUID()}`);
		let fd: number | undefined;
		let temporaryReceipt: FileReceipt | undefined;
		let commitAttempted = false;
		try {
			try {
				fd = openSync(temporaryPath, "wx", 0o600);
			} catch {
				throw trustError();
			}
			const opened = fstatSync(fd, { bigint: true });
			if (!opened.isFile()) throw trustError();
			temporaryReceipt = { dev: opened.dev, ino: opened.ino };
			this.protect(() => this.permissions.protectCreatedFile(temporaryPath));
			this.assertEmptyOwnedTemporary(temporaryPath, temporaryReceipt);

			writeFileSync(fd, body, "utf8");
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;

			this.assertOwnedPeersDirectory();
			this.assertOwnedDestination();

			// Commit point.
			commitAttempted = true;
			renameSync(temporaryPath, this.statePath);

			// From here on a failure is a genuine post-commit uncertainty.
			const published = lstatBig(this.statePath);
			if (published === undefined
				|| published.isSymbolicLink()
				|| !published.isFile()
				|| !sameReceipt(published, temporaryReceipt)
				|| published.size !== BigInt(Buffer.byteLength(body))) {
				throw trustError();
			}
			this.protect(() => this.permissions.assertPrivateFile(this.statePath));
			syncDirectoryBestEffort(this.peersDir);
			this.stateReceipt = { dev: published.dev, ino: published.ino };
		} catch {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// Preserve the refusal.
				}
			}
			if (commitAttempted) {
				// The rename may or may not be visible: never claim memory equals disk.
				this.poison();
			} else {
				removeOwnedTemporary(temporaryPath, temporaryReceipt);
			}
			throw trustError();
		}
	}

	private assertOwnedStateDirectory(): void {
		const receipt = this.stateDirReceipt;
		if (receipt === undefined) throw trustError();
		const current = this.lstatFenced(this.stateDir);
		if (current === undefined
			|| current.isSymbolicLink()
			|| !current.isDirectory()
			|| !sameReceipt(current, receipt)) {
			// A replaced parent invalidates this handle's authority.
			this.poison();
			throw trustError();
		}
	}

	private assertOwnedPeersDirectory(): void {
		const receipt = this.peersReceipt;
		if (receipt === undefined) throw trustError();
		const current = this.lstatFenced(this.peersDir);
		if (current === undefined || current.isSymbolicLink() || !current.isDirectory()) {
			this.poison();
			throw trustError();
		}
		if (!sameReceipt(current, receipt)) {
			// A replaced directory invalidates this handle's authority.
			this.poison();
			throw trustError();
		}
		try {
			this.permissions.assertPrivateDirectory(this.peersDir);
		} catch {
			this.poison();
			throw trustError();
		}
	}

	private assertOwnedDestination(): void {
		const receipt = this.stateReceipt;
		if (receipt === undefined) throw trustError();
		const current = this.lstatFenced(this.statePath);
		if (current === undefined || current.isSymbolicLink() || !current.isFile() || !sameReceipt(current, receipt)) {
			// A missing, replaced, or non-regular destination is never overwritten.
			this.poison();
			throw trustError();
		}
	}

	/**
	 * Observation used by publication fences: only ENOENT is absence, and an
	 * unverifiable fence permanently closes this handle's authority.
	 */
	private lstatFenced(path: string): BigIntStats | undefined {
		try {
			return lstatSync(path, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
			this.poison();
			throw trustError();
		}
	}

	private commit(next: PeerStateModel): void {
		this.publish(next);
		this.model = next;
	}

	private readAccepted(keyId: string): AcceptedPeerRecord | undefined {
		this.assertUsable();
		if (this.model === null) return undefined;
		if (!isBoundedPeerKeyId(keyId)) return undefined;
		const record = this.model.accepted.get(keyId);
		return record === undefined ? undefined : copyAcceptedRecord(record);
	}

	private writeAccepted(record: AcceptedPeerRecord): void {
		const model = this.requireModel();
		if (!isPlainRecord(record)) throw peerError("INVALID_ARGUMENT");
		const receiverKeyId = model.identity.key.keyId;
		if (!isWellFormedPeerKey(record.key)) throw peerError("INVALID_ARGUMENT");
		if (!isValidPeerLabel(record.label)) throw peerError("INVALID_ARGUMENT");
		if (!isTimestamp(record.acceptedAt)) throw peerError("INVALID_ARGUMENT");
		if (record.receiverKeyId !== receiverKeyId) throw peerError("INVALID_ARGUMENT");

		const next: PeerStateModel = {
			identity: model.identity,
			accepted: new Map(model.accepted),
			grants: model.grants,
			remembered: model.remembered,
		};
		next.accepted.set(record.key.keyId, copyAcceptedRecord({
			key: record.key,
			label: record.label,
			acceptedAt: record.acceptedAt,
			receiverKeyId,
		}));
		if (next.accepted.size > MAX_ACCEPTED_PEER_RECORDS) throw trustError();
		this.commit(next);
	}

	private deleteAccepted(keyId: string): boolean {
		this.assertUsable();
		// An uninitialized handle owns no accepted record: nothing is deleted and
		// nothing is trusted, so `false` is the truthful answer.
		if (this.model === null) return false;
		const model = this.model;
		if (!isBoundedPeerKeyId(keyId) || !model.accepted.has(keyId)) return false;
		const next: PeerStateModel = {
			identity: model.identity,
			accepted: new Map(model.accepted),
			grants: model.grants,
			remembered: model.remembered,
		};
		next.accepted.delete(keyId);
		this.commit(next);
		return true;
	}

	private readGrant(peerKeyId: string): DirectionalGrantRecord | undefined {
		this.assertUsable();
		if (this.model === null) return undefined;
		if (!isBoundedPeerKeyId(peerKeyId)) return undefined;
		const record = this.model.grants.get(peerKeyId);
		return record === undefined ? undefined : copyGrantRecord(record);
	}

	private writeGrant(record: DirectionalGrantRecord): void {
		const model = this.requireModel();
		if (!isPlainRecord(record)) throw peerError("INVALID_ARGUMENT");
		const receiverKeyId = model.identity.key.keyId;
		if (!isBoundedPeerKeyId(record.peerKeyId)) throw peerError("INVALID_ARGUMENT");
		if (record.direction !== GRANT_DIRECTION || record.capability !== GRANT_CAPABILITY) {
			throw peerError("INVALID_ARGUMENT");
		}
		if (!isTimestamp(record.grantedAt)) throw peerError("INVALID_ARGUMENT");
		if (record.receiverKeyId !== receiverKeyId) throw peerError("INVALID_ARGUMENT");

		const next: PeerStateModel = {
			identity: model.identity,
			accepted: model.accepted,
			grants: new Map(model.grants),
			remembered: model.remembered,
		};
		next.grants.set(record.peerKeyId, copyGrantRecord({
			peerKeyId: record.peerKeyId,
			direction: GRANT_DIRECTION,
			capability: GRANT_CAPABILITY,
			grantedAt: record.grantedAt,
			receiverKeyId,
		}));
		if (next.grants.size > MAX_DIRECTIONAL_GRANT_RECORDS) throw trustError();
		this.commit(next);
	}

	private deleteGrant(peerKeyId: string): boolean {
		this.assertUsable();
		if (this.model === null) return false;
		const model = this.model;
		if (!isBoundedPeerKeyId(peerKeyId) || !model.grants.has(peerKeyId)) return false;
		const next: PeerStateModel = {
			identity: model.identity,
			accepted: model.accepted,
			grants: new Map(model.grants),
			remembered: model.remembered,
		};
		next.grants.delete(peerKeyId);
		this.commit(next);
		return true;
	}

	private readRemembered(targetId: string): PeerKey | null {
		this.assertUsable();
		if (this.model === null) return null;
		const key = this.model.remembered.get(targetId);
		return key === undefined ? null : copyPeerKey(key);
	}

	private writeRemembered(targetId: string, key: PeerKey): void {
		const model = this.requireModel();
		if (!isWellFormedPeerKey(key)) throw peerError("INVALID_ARGUMENT");
		if (!model.remembered.has(targetId) && model.remembered.size >= MAX_REMEMBERED_PEER_SLOTS) throw trustError();
		const next: PeerStateModel = {
			identity: model.identity,
			accepted: model.accepted,
			grants: model.grants,
			remembered: new Map(model.remembered),
		};
		next.remembered.set(targetId, copyPeerKey(key));
		this.commit(next);
	}

	private clearRemembered(targetId: string): void {
		this.assertUsable();
		if (this.model === null) return;
		const model = this.model;
		if (!model.remembered.has(targetId)) return;
		const next: PeerStateModel = {
			identity: model.identity,
			accepted: model.accepted,
			grants: model.grants,
			remembered: new Map(model.remembered),
		};
		next.remembered.delete(targetId);
		this.commit(next);
	}

	private protect(operation: () => void): void {
		try {
			operation();
		} catch {
			throw trustError();
		}
	}

	private claimAuthority(): void {
		if (liveAuthorities.has(this.statePath)) throw trustError();
		liveAuthorities.add(this.statePath);
		this.registered = true;
	}

	private dropAuthority(): void {
		if (this.registered) {
			liveAuthorities.delete(this.statePath);
			this.registered = false;
		}
	}

	/** Permanently close this handle's authority; getters fail closed afterwards. */
	private poison(): void {
		this.poisoned = true;
		this.model = null;
		this.dropAuthority();
	}
}

/**
 * Generate one receiving identity for a truly uninitialized agent directory.
 * This is the only place the identity generator is used, and it is reached only
 * after safe storage and an empty protected temporary are established.
 */
async function generateIdentity(label: string): Promise<OwnedPeerIdentity> {
	try {
		return await generatePeerIdentity(label);
	} catch {
		throw trustError();
	}
}

/**
 * Open the protected peer state for one canonical Pi agent directory.
 *
 * - No `session-host/peers` directory: the store is uninitialized and nothing is
 *   created or generated.
 * - Existing `peers` directory without a valid `state.json`: throws a fixed
 *   error; past identity is never regenerated.
 * - Valid, protected, internally consistent document: loaded and bound to its
 *   exact receiving key.
 *
 * The injected protection policy is required and there is deliberately no
 * permissive default here: the safe product default belongs to the caller that
 * injects the real platform policy.
 */
export function openPeerStateStoreWithPermissions(options: OpenPeerStateStoreOptions): PeerStateStore {
	if (!isPlainRecord(options)) throw peerError("INVALID_ARGUMENT");
	const permissions = assertPermissionPolicy(options.permissions);
	const canonicalAgentDir = canonicalAgentDirectory(options.agentDir);
	const manager = new PeerStateManager(canonicalAgentDir, permissions);
	manager.load();
	return manager;
}
