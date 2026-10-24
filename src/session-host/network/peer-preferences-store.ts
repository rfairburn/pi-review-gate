/**
 * Protected durable sidebar preferences for the paired peer transport (issue
 * #482).
 *
 * One bounded, versioned document in its own private directory holds everything
 * the network sidebar remembers that is NOT identity or trust:
 *
 * ```
 * <agentDir>/session-host/peer-preferences/preferences.json
 * ```
 *
 * It is deliberately a sibling of the key/trust directory
 * (`session-host/peers/state.json`) rather than part of it. Saving a display
 * preference such as the arrival bell must never create a peer identity, a
 * `peers` directory, or any key material, and an uninitialized trust store must
 * stay uninitialized while settings are saved.
 *
 * Saved content:
 *
 * - hosting: the operator's enabled flag plus the explicit bind host and port.
 *   Nothing here selects a wildcard or a fallback port.
 * - autoReconnect: remembered, off by default.
 * - bellEnabled: remembered, on by default.
 * - viewerNativeInputEnabled: THIS viewing host's remote native input/copy
 *   preference for the remote pane it displays. Optional in the document: an
 *   absent field (a new installation or an otherwise valid older document) is
 *   on, and only an explicit `false` is written and remembered. It never
 *   changes hosting, Auto, connections, grants, or this host's own children.
 * - remoteHistoryDeleteEnabled: THIS owner host's policy for exposing remote
 *   saved-history deletion to its paired viewers. Optional with the same rule:
 *   absent is enabled, and only an explicit `false` is written. It is an owner
 *   policy fact, never a viewer-side delete toggle, and it never gates this
 *   host's own local Saved deletion.
 * - destinations: opaque local ids with a bounded display alias, endpoint, a
 *   successful-connection history flag, and explicit reconnect suppression.
 *
 * Pins are NOT stored here. A remembered server key belongs to the trust store's
 * per-target slot and is never derived from, or authoritative because of, a
 * saved endpoint, alias, or history flag.
 *
 * Fail-closed boundaries:
 *
 * - A genuinely absent document means "no saved preferences": reads return
 *   `null` and create no file, directory, key, socket, or timer.
 * - An existing dedicated directory without a valid document, an unknown
 *   version, an unknown/missing required field, a present optional flag that is
 *   not a boolean, a duplicate id, an out-of-range endpoint, unsafe path, or
 *   unverified protection is refused untouched. It is never treated as empty or
 *   as the default-on flags, and never overwritten with defaults.
 * - Protection is established on the owned, still-empty temporary before any
 *   preference byte is written; a private containing directory is required by
 *   the injected platform policy (Windows ACLs included), not by mode bits here.
 * - A publication failure before the rename leaves the previous document intact
 *   and the handle usable; a failure at or after the rename attempt poisons the
 *   handle so it can never claim memory equals disk.
 * - One owning-host lifecycle uses one handle. There is no reset, repair,
 *   backup search, scan, or sweep.
 *
 * Fixed, display-safe errors only: no path, errno, content, or raw exception
 * text is ever part of an error.
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
import type { PeerStatePermissionPolicy } from "./peer-state-permission-policy";
import { ensureNetworkStateDirectory, type StorageReceipt } from "./peer-storage-base";
import {
	peerStorageDiagnostic,
	peerStorageRefusalDetail,
	withPeerStorageDiagnostic,
	type PeerStorageObject,
	type PeerStorageReason,
} from "./peer-storage-diagnostics";
import { isValidPeerLabel } from "./protocol";

/** Version of the persisted preferences document; unknown versions are refused. */
export const PEER_PREFERENCES_VERSION = 1;

/** Dedicated private sibling directory below the session-host state directory. */
export const PEER_PREFERENCES_DIRNAME = "peer-preferences";

/** Fixed persisted document name inside the dedicated directory. */
export const PEER_PREFERENCES_FILENAME = "preferences.json";

/** Bound for the whole published document. */
export const MAX_PEER_PREFERENCES_FILE_BYTES = 64 * 1024;

/** Bound for saved destinations; larger documents are refused. */
export const MAX_PEER_DESTINATIONS = 64;

/** Bound for an opaque LOCAL destination id. It never names a path component. */
export const MAX_PEER_DESTINATION_ID_CHARS = 128;

/** Bound for a saved bind/listen host string. */
export const MAX_PEER_ENDPOINT_HOST_CHARS = 255;

/** Fixed failure codes. Never a path, errno, content, or exception text. */
export type PeerPreferencesErrorCode =
	| "PEER_PREFERENCES_UNAVAILABLE"
	| "PEER_PREFERENCES_WRITE_FAILED";

const PREFERENCES_ERROR_MESSAGES: Readonly<Record<PeerPreferencesErrorCode, string>> = Object.freeze({
	PEER_PREFERENCES_UNAVAILABLE: "peer sidebar preferences are unavailable",
	PEER_PREFERENCES_WRITE_FAILED: "peer sidebar preferences could not be saved",
});

/** Sanitized preferences failure: fixed code and fixed message. */
export class PeerPreferencesError extends Error {
	readonly code: PeerPreferencesErrorCode;

	constructor(code: PeerPreferencesErrorCode) {
		super(PREFERENCES_ERROR_MESSAGES[code]);
		this.name = "PeerPreferencesError";
		this.code = code;
	}
}

export function isPeerPreferencesError(value: unknown): value is PeerPreferencesError {
	return value instanceof PeerPreferencesError;
}

/** Remembered hosting intent; the listener's actual state is never stored here. */
export interface PeerHostingPreferences {
	readonly enabled: boolean;
	/** Explicit bind address, or null when the operator never selected one. */
	readonly bindHost: string | null;
	/** Explicit bind port, or null when the operator never selected one. */
	readonly bindPort: number | null;
}

/** One saved local destination. None of these values is identity or authority. */
export interface PeerDestination {
	/** Opaque local handle. It is never an identity, endpoint, or path component. */
	readonly id: string;
	/** Bounded display alias; never identity. */
	readonly label: string;
	readonly host: string;
	readonly port: number;
	/** True only after an authenticated service connection actually opened. */
	readonly previouslyConnected: boolean;
	/** Explicit Disconnect intent, remembered across restarts until Connect. */
	readonly reconnectSuppressed: boolean;
}

export interface PeerPreferences {
	readonly hosting: PeerHostingPreferences;
	readonly autoReconnect: boolean;
	readonly bellEnabled: boolean;
	/**
	 * Effective viewer-side remote native input/copy preference for the remote
	 * pane THIS host displays. True when the document omits it; only an explicit
	 * `false` is persisted.
	 */
	readonly viewerNativeInputEnabled: boolean;
	/**
	 * Effective owner-side policy for exposing remote saved-history deletion to
	 * paired viewers. True when the document omits it; only an explicit `false`
	 * is persisted. It never gates local Saved deletion.
	 */
	readonly remoteHistoryDeleteEnabled: boolean;
	readonly destinations: readonly PeerDestination[];
}

/** In-memory defaults for a genuinely uninitialized agent directory. */
export const DEFAULT_PEER_PREFERENCES: PeerPreferences = Object.freeze({
	hosting: Object.freeze({ enabled: false, bindHost: null, bindPort: null }),
	autoReconnect: false,
	bellEnabled: true,
	viewerNativeInputEnabled: true,
	remoteHistoryDeleteEnabled: true,
	destinations: Object.freeze([]) as readonly PeerDestination[],
});

/** Optional top-level document fields; absence means the default-on value. */
const VIEWER_NATIVE_INPUT_FIELD = "viewerNativeInputEnabled";
const REMOTE_HISTORY_DELETE_FIELD = "remoteHistoryDeleteEnabled";

export interface OpenPeerPreferencesStoreOptions {
	/** Canonical Pi agent directory; must already exist as a real directory. */
	readonly agentDir: string;
	/** Injected, required protection seam. There is no permissive default. */
	readonly permissions: PeerStatePermissionPolicy;
}

/**
 * One explicitly opened preferences handle.
 *
 * `read()` returns `null` only while no preferences document exists; the caller
 * supplies {@link DEFAULT_PEER_PREFERENCES} in memory without creating anything.
 */
export interface PeerPreferencesStore {
	read(): PeerPreferences | null;
	write(next: PeerPreferences): void;
	close(): void;
}

/** Display-safe host admission: no whitespace, path, or URL punctuation. */
export function isValidPeerEndpointHost(value: unknown): value is string {
	return (
		typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_PEER_ENDPOINT_HOST_CHARS
		&& !/[\s/\\?#@]/.test(value)
	);
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

function isBoundedDestinationId(value: unknown): value is string {
	// An opaque local id is data only: it is never used as a path component or a
	// property key, so names such as `__proto__` are ordinary strings here.
	return (
		typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_PEER_DESTINATION_ID_CHARS
		&& !/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(value)
	);
}

function isSavedPort(value: unknown, allowZero: boolean): value is number {
	return (
		typeof value === "number"
		&& Number.isInteger(value)
		&& value >= (allowZero ? 0 : 1)
		&& value <= 65_535
	);
}

/**
 * One optional default-on flag. A genuinely absent key is `true`; a present key
 * must be a real boolean, and anything else (including a present `undefined`,
 * `null`, a string, or a number) is `undefined`, which refuses the document.
 */
function optionalEnabledFlag(record: Record<string, unknown>, key: string): boolean | undefined {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return true;
	const flag = record[key];
	return typeof flag === "boolean" ? flag : undefined;
}

/** Strict parse of one whole document; any deviation refuses the document. */
function parsePreferences(value: unknown): PeerPreferences | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (!hasOnlyKeys(value, [
		"version",
		"hosting",
		"autoReconnect",
		"bellEnabled",
		VIEWER_NATIVE_INPUT_FIELD,
		REMOTE_HISTORY_DELETE_FIELD,
		"destinations",
	])) return undefined;
	if (value.version !== PEER_PREFERENCES_VERSION) return undefined;
	if (typeof value.autoReconnect !== "boolean") return undefined;
	if (typeof value.bellEnabled !== "boolean") return undefined;
	const viewerNativeInputEnabled = optionalEnabledFlag(value, VIEWER_NATIVE_INPUT_FIELD);
	if (viewerNativeInputEnabled === undefined) return undefined;
	const remoteHistoryDeleteEnabled = optionalEnabledFlag(value, REMOTE_HISTORY_DELETE_FIELD);
	if (remoteHistoryDeleteEnabled === undefined) return undefined;

	const hosting = value.hosting;
	if (!isPlainRecord(hosting)) return undefined;
	if (!hasOnlyKeys(hosting, ["enabled", "bindHost", "bindPort"])) return undefined;
	if (typeof hosting.enabled !== "boolean") return undefined;
	let bindHost: string | null;
	if (hosting.bindHost === null) bindHost = null;
	else if (isValidPeerEndpointHost(hosting.bindHost)) bindHost = hosting.bindHost;
	else return undefined;
	let bindPort: number | null;
	if (hosting.bindPort === null) bindPort = null;
	else if (isSavedPort(hosting.bindPort, true)) bindPort = hosting.bindPort;
	else return undefined;
	// Enabled hosting always carries an explicit address and port: a saved
	// "enabled" without a chosen endpoint would force an implicit default.
	if (hosting.enabled && (bindHost === null || bindPort === null)) return undefined;

	if (!Array.isArray(value.destinations) || value.destinations.length > MAX_PEER_DESTINATIONS) return undefined;
	const destinations: PeerDestination[] = [];
	const seen = new Set<string>();
	for (const raw of value.destinations) {
		if (!isPlainRecord(raw)) return undefined;
		if (!hasOnlyKeys(raw, ["id", "label", "host", "port", "previouslyConnected", "reconnectSuppressed"])) {
			return undefined;
		}
		if (!isBoundedDestinationId(raw.id)) return undefined;
		if (seen.has(raw.id)) return undefined;
		seen.add(raw.id);
		if (!isValidPeerLabel(raw.label)) return undefined;
		if (!isValidPeerEndpointHost(raw.host)) return undefined;
		if (!isSavedPort(raw.port, false)) return undefined;
		if (typeof raw.previouslyConnected !== "boolean") return undefined;
		if (typeof raw.reconnectSuppressed !== "boolean") return undefined;
		destinations.push(Object.freeze({
			id: raw.id,
			label: raw.label,
			host: raw.host,
			port: raw.port,
			previouslyConnected: raw.previouslyConnected,
			reconnectSuppressed: raw.reconnectSuppressed,
		}));
	}

	return Object.freeze({
		hosting: Object.freeze({ enabled: hosting.enabled, bindHost, bindPort }),
		autoReconnect: value.autoReconnect,
		bellEnabled: value.bellEnabled,
		viewerNativeInputEnabled,
		remoteHistoryDeleteEnabled,
		destinations: Object.freeze(destinations),
	});
}

/**
 * Validate one caller-built preferences value and return an immutable, detached
 * copy. A malformed value is a programmer error, not a persisted-state problem.
 */
export function validatePeerPreferences(value: unknown): PeerPreferences {
	const parsed = parsePreferences(toDocument(value));
	if (parsed === undefined) throw new TypeError("peer sidebar preferences are invalid");
	return parsed;
}

function toDocument(value: unknown): unknown {
	if (!isPlainRecord(value)) return undefined;
	const hosting = value.hosting;
	const destinations = value.destinations;
	const document = {
		version: PEER_PREFERENCES_VERSION,
		hosting: isPlainRecord(hosting)
			? { enabled: hosting.enabled, bindHost: hosting.bindHost, bindPort: hosting.bindPort }
			: hosting,
		autoReconnect: value.autoReconnect,
		bellEnabled: value.bellEnabled,
		// A caller-built value always names both effective flags: these keys are
		// always present here, so a missing or non-boolean in-memory flag is refused
		// as a programmer error rather than silently becoming the default-on value.
		[VIEWER_NATIVE_INPUT_FIELD]: value[VIEWER_NATIVE_INPUT_FIELD],
		[REMOTE_HISTORY_DELETE_FIELD]: value[REMOTE_HISTORY_DELETE_FIELD],
		destinations: Array.isArray(destinations)
			? destinations.map((entry) => {
				if (!isPlainRecord(entry)) return entry;
				return {
					id: entry.id,
					label: entry.label,
					host: entry.host,
					port: entry.port,
					previouslyConnected: entry.previouslyConnected,
					reconnectSuppressed: entry.reconnectSuppressed,
				};
			})
			: destinations,
	};
	return document;
}

function copyPreferences(value: PeerPreferences): PeerPreferences {
	return Object.freeze({
		hosting: Object.freeze({
			enabled: value.hosting.enabled,
			bindHost: value.hosting.bindHost,
			bindPort: value.hosting.bindPort,
		}),
		autoReconnect: value.autoReconnect,
		bellEnabled: value.bellEnabled,
		viewerNativeInputEnabled: value.viewerNativeInputEnabled,
		remoteHistoryDeleteEnabled: value.remoteHistoryDeleteEnabled,
		destinations: Object.freeze(value.destinations.map((destination) => Object.freeze({
			id: destination.id,
			label: destination.label,
			host: destination.host,
			port: destination.port,
			previouslyConnected: destination.previouslyConnected,
			reconnectSuppressed: destination.reconnectSuppressed,
		}))),
	});
}

function serializePreferences(value: PeerPreferences): string {
	const document = {
		version: PEER_PREFERENCES_VERSION,
		hosting: {
			enabled: value.hosting.enabled,
			bindHost: value.hosting.bindHost,
			bindPort: value.hosting.bindPort,
		},
		autoReconnect: value.autoReconnect,
		bellEnabled: value.bellEnabled,
		// Sparse default-on flags: only an explicit Off is written, so a document
		// that never turned either flag off keeps the exact version-1 field set.
		...(value.viewerNativeInputEnabled ? {} : { [VIEWER_NATIVE_INPUT_FIELD]: false }),
		...(value.remoteHistoryDeleteEnabled ? {} : { [REMOTE_HISTORY_DELETE_FIELD]: false }),
		destinations: value.destinations.map((destination) => ({
			id: destination.id,
			label: destination.label,
			host: destination.host,
			port: destination.port,
			previouslyConnected: destination.previouslyConnected,
			reconnectSuppressed: destination.reconnectSuppressed,
		})),
	};
	const body = `${JSON.stringify(document)}\n`;
	if (Buffer.byteLength(body, "utf8") > MAX_PEER_PREFERENCES_FILE_BYTES) {
		throw new PeerPreferencesError("PEER_PREFERENCES_WRITE_FAILED");
	}
	return body;
}

interface FileReceipt {
	readonly dev: bigint;
	readonly ino: bigint;
}

function unavailable(): PeerPreferencesError {
	return new PeerPreferencesError("PEER_PREFERENCES_UNAVAILABLE");
}

function writeFailed(): PeerPreferencesError {
	return new PeerPreferencesError("PEER_PREFERENCES_WRITE_FAILED");
}

/** The fixed unavailable error carrying one fixed storage diagnostic. */
function unavailableBecause(reason: PeerStorageReason, object: PeerStorageObject): PeerPreferencesError {
	return withPeerStorageDiagnostic(unavailable(), reason, object);
}

/** The fixed write failure, keeping only the sanitized diagnostic of `cause`, if any. */
function writeFailedFrom(cause: unknown): PeerPreferencesError {
	const diagnostic = peerStorageDiagnostic(cause);
	return diagnostic === null ? writeFailed() : withPeerStorageDiagnostic(writeFailed(), diagnostic.reason, diagnostic.object);
}

function lstatBig(path: string, object?: PeerStorageObject): BigIntStats | undefined {
	try {
		return lstatSync(path, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw object === undefined ? unavailable() : unavailableBecause("unreadable", object);
	}
}

function sameReceipt(stats: BigIntStats, receipt: FileReceipt): boolean {
	return stats.dev === receipt.dev && stats.ino === receipt.ino;
}

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
		throw new TypeError("peer sidebar preferences require an absolute agent directory");
	}
	let stats: Stats;
	try {
		stats = lstatSync(agentDir);
	} catch {
		throw unavailable();
	}
	if (stats.isSymbolicLink() || !stats.isDirectory()) throw unavailable();
	try {
		return realpathSync(agentDir);
	} catch {
		throw unavailable();
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
	if (!isPlainRecord(value)) throw new TypeError("peer sidebar preferences require a permission policy");
	for (const method of PERMISSION_METHODS) {
		if (typeof value[method] !== "function") {
			throw new TypeError("peer sidebar preferences require a permission policy");
		}
	}
	return value as unknown as PeerStatePermissionPolicy;
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

class PreferencesManager implements PeerPreferencesStore {
	readonly #permissions: PeerStatePermissionPolicy;
	readonly #stateDir: string;
	readonly #directory: string;
	readonly #path: string;

	#model: PeerPreferences | null = null;
	#directoryReceipt: FileReceipt | undefined;
	#fileReceipt: FileReceipt | undefined;
	#closed = false;
	#poisoned = false;

	constructor(canonicalAgentDir: string, permissions: PeerStatePermissionPolicy) {
		this.#permissions = permissions;
		this.#stateDir = sessionHostStateDir(canonicalAgentDir);
		this.#directory = join(this.#stateDir, PEER_PREFERENCES_DIRNAME);
		this.#path = join(this.#directory, PEER_PREFERENCES_FILENAME);
	}

	read(): PeerPreferences | null {
		this.#assertUsable();
		return this.#model === null ? null : copyPreferences(this.#model);
	}

	write(next: PeerPreferences): void {
		this.#assertUsable();
		const value = validatePeerPreferences(next);
		this.#publish(value);
		this.#model = value;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#model = null;
	}

	/**
	 * Read the fixed existing document; absence of the dedicated directory is
	 * "no saved preferences" and creates nothing.
	 */
	load(): void {
		const stateDirStats = lstatBig(this.#stateDir, "session-host");
		if (stateDirStats === undefined) return;
		if (stateDirStats.isSymbolicLink() || !stateDirStats.isDirectory()) throw unavailableBecause("unsafe-object", "session-host");
		this.#protect(() => this.#permissions.assertOwnerControlledDirectory(this.#stateDir), "session-host");

		const directoryStats = lstatBig(this.#directory, "peer-preferences");
		if (directoryStats === undefined) return;
		if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
			throw unavailableBecause("unsafe-object", "peer-preferences");
		}
		this.#protect(() => this.#permissions.assertPrivateDirectory(this.#directory), "peer-preferences");

		const documentStats = lstatBig(this.#path, "preferences-document");
		// An existing dedicated directory without its document is unavailable: it
		// is never treated as fresh defaults and nothing is overwritten.
		if (documentStats === undefined) throw unavailableBecause("missing-initialized", "preferences-document");
		if (documentStats.isSymbolicLink() || !documentStats.isFile()) {
			throw unavailableBecause("unsafe-object", "preferences-document");
		}
		if (documentStats.size <= 0n || documentStats.size > BigInt(MAX_PEER_PREFERENCES_FILE_BYTES)) {
			throw unavailableBecause("malformed", "preferences-document");
		}
		this.#protect(() => this.#permissions.assertPrivateFile(this.#path), "preferences-document");

		const model = this.#readExistingDocument(documentStats);
		this.#model = model;
		this.#directoryReceipt = { dev: directoryStats.dev, ino: directoryStats.ino };
		this.#fileReceipt = { dev: documentStats.dev, ino: documentStats.ino };
	}

	#readExistingDocument(preStats: BigIntStats): PeerPreferences {
		let fd: number;
		try {
			fd = openSync(this.#path, fsConstants.O_RDONLY
				| (fsConstants.O_NONBLOCK ?? 0)
				| (fsConstants.O_NOFOLLOW ?? 0));
		} catch (error) {
			throw unavailableBecause(
				(error as NodeJS.ErrnoException)?.code === "ENOENT" ? "changed" : "unreadable",
				"preferences-document",
			);
		}
		try {
			let stats: BigIntStats;
			try {
				stats = fstatSync(fd, { bigint: true });
			} catch {
				throw unavailableBecause("unreadable", "preferences-document");
			}
			if (!stats.isFile() || !sameReceipt(stats, preStats)) throw unavailableBecause("changed", "preferences-document");
			if (stats.size <= 0n || stats.size > BigInt(MAX_PEER_PREFERENCES_FILE_BYTES)) {
				throw unavailableBecause("malformed", "preferences-document");
			}
			const bytes = readAll(fd, Number(stats.size));
			if (bytes === undefined) throw unavailableBecause("unreadable", "preferences-document");
			let parsed: unknown;
			try {
				parsed = JSON.parse(bytes.toString("utf8"));
			} catch {
				throw unavailableBecause("malformed", "preferences-document");
			}
			const model = parsePreferences(parsed);
			if (model === undefined) throw unavailableBecause("malformed", "preferences-document");
			return model;
		} finally {
			try {
				closeSync(fd);
			} catch {
				// A close failure must not replace the bounded read result.
			}
		}
	}

	/**
	 * One full-document publication: fence the owned destination, write and fsync
	 * an owned private temporary, then link it exclusively (first save) or rename
	 * it (later saves), verify the published inode and protection, and only then
	 * make the candidate usable.
	 */
	#publish(next: PeerPreferences): void {
		const body = serializePreferences(next);
		let stateDirReceipt: FileReceipt;
		try {
			stateDirReceipt = this.#ensureOwnerControlledStateDir();
		} catch (error) {
			throw writeFailedFrom(error);
		}
		const creating = this.#model === null;
		let directoryReceipt: FileReceipt;
		if (creating && this.#directoryReceipt === undefined) {
			try {
				mkdirSync(this.#directory, { mode: 0o700 });
			} catch (error) {
				// An existing directory is never adopted as a first-save destination.
				throw withPeerStorageDiagnostic(
					writeFailed(),
					(error as NodeJS.ErrnoException)?.code === "EEXIST" ? "changed" : "unreadable",
					"peer-preferences",
				);
			}
			try {
				this.#protect(() => this.#permissions.protectCreatedDirectory(this.#directory), "peer-preferences", "session-host");
			} catch (error) {
				throw writeFailedFrom(error);
			}
			const created = lstatBig(this.#directory);
			if (created === undefined || created.isSymbolicLink() || !created.isDirectory()) throw writeFailed();
			directoryReceipt = { dev: created.dev, ino: created.ino };
		} else {
			directoryReceipt = this.#assertOwnedDirectory();
		}
		if (!creating) this.#assertOwnedDestination();

		const temporaryPath = join(this.#directory, `${PEER_PREFERENCES_FILENAME}.tmp.${randomUUID()}`);
		let fd: number | undefined;
		let temporaryReceipt: FileReceipt | undefined;
		let commitAttempted = false;
		try {
			try {
				fd = openSync(temporaryPath, "wx", 0o600);
			} catch {
				throw writeFailed();
			}
			const opened = fstatSync(fd, { bigint: true });
			if (!opened.isFile()) throw writeFailed();
			temporaryReceipt = { dev: opened.dev, ino: opened.ino };
			this.#protect(() => this.#permissions.protectCreatedFile(temporaryPath), "preferences-document", "peer-preferences");
			this.#assertEmptyOwnedTemporary(temporaryPath, temporaryReceipt);

			writeFileSync(fd, body, "utf8");
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;

			this.#assertDirectoryReceipt(directoryReceipt);
			this.#assertStateDirectoryReceipt(stateDirReceipt);
			if (creating) {
				// Exclusive first publication: a winner that appeared meanwhile is
				// never overwritten.
				if (lstatBig(this.#path) !== undefined) throw writeFailed();
			} else {
				this.#assertOwnedDestination();
			}

			// Commit point.
			commitAttempted = true;
			if (creating) linkSync(temporaryPath, this.#path);
			else renameSync(temporaryPath, this.#path);

			const published = lstatBig(this.#path);
			if (published === undefined
				|| published.isSymbolicLink()
				|| !published.isFile()
				|| !sameReceipt(published, temporaryReceipt)
				|| published.size !== BigInt(Buffer.byteLength(body))) {
				throw writeFailed();
			}
			if (creating) {
				// First publication briefly has two names for the same protected
				// inode. Retire only our receipt-fenced temporary before enforcing
				// the policy's final single-link invariant.
				const retiring = lstatBig(temporaryPath);
				if (retiring === undefined
					|| retiring.isSymbolicLink()
					|| !retiring.isFile()
					|| !sameReceipt(retiring, temporaryReceipt)) {
					throw writeFailed();
				}
				unlinkSync(temporaryPath);
				temporaryReceipt = undefined;
			}
			this.#protect(() => this.#permissions.assertPrivateFile(this.#path), "preferences-document");
			syncDirectoryBestEffort(this.#directory);
				this.#directoryReceipt = directoryReceipt;
			this.#fileReceipt = { dev: published.dev, ino: published.ino };
		} catch (error) {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// Preserve the refusal.
				}
			}
			if (commitAttempted) {
				// The link/rename may or may not be visible: never claim memory
				// equals disk again for this handle.
				this.#poison();
			} else {
				removeOwnedTemporary(temporaryPath, temporaryReceipt);
			}
			throw writeFailedFrom(error);
		}
	}

	#ensureOwnerControlledStateDir(): StorageReceipt {
		return ensureNetworkStateDirectory({
			stateDir: this.#stateDir,
			permissions: this.#permissions,
			fail: (reason) => withPeerStorageDiagnostic(writeFailed(), reason, "session-host"),
			protect: (operation) => this.#protect(operation, "session-host"),
		});
	}

	#assertOwnedDirectory(): FileReceipt {
		const receipt = this.#directoryReceipt;
		if (receipt === undefined) throw writeFailed();
		const current = this.#lstatFenced(this.#directory);
		if (current === undefined || current.isSymbolicLink() || !current.isDirectory()) {
			this.#poison();
			throw writeFailed();
		}
		if (!sameReceipt(current, receipt)) {
			// A replaced directory invalidates this handle's authority.
			this.#poison();
			throw writeFailed();
		}
		try {
			this.#permissions.assertPrivateDirectory(this.#directory);
		} catch (error) {
			this.#poison();
			throw withPeerStorageDiagnostic(
				writeFailed(),
				peerStorageRefusalDetail(error)?.reason ?? "protection-unsupported",
				"peer-preferences",
			);
		}
		return receipt;
	}

	#assertDirectoryReceipt(receipt: FileReceipt): void {
		const current = this.#lstatFenced(this.#directory);
		if (current === undefined || current.isSymbolicLink() || !current.isDirectory() || !sameReceipt(current, receipt)) {
			throw writeFailed();
		}
	}

	#assertStateDirectoryReceipt(receipt: FileReceipt): void {
		const current = this.#lstatFenced(this.#stateDir);
		if (current === undefined || current.isSymbolicLink() || !current.isDirectory() || !sameReceipt(current, receipt)) {
			throw writeFailed();
		}
	}

	#assertOwnedDestination(): void {
		const receipt = this.#fileReceipt;
		if (receipt === undefined) throw writeFailed();
		const current = this.#lstatFenced(this.#path);
		if (current === undefined || current.isSymbolicLink() || !current.isFile() || !sameReceipt(current, receipt)) {
			// A missing or replaced destination is never overwritten.
			this.#poison();
			throw writeFailed();
		}
	}

	#assertEmptyOwnedTemporary(path: string, receipt: FileReceipt): void {
		const current = lstatBig(path);
		if (current === undefined
			|| current.isSymbolicLink()
			|| !current.isFile()
			|| !sameReceipt(current, receipt)
			|| current.size !== 0n) {
			throw writeFailed();
		}
	}

	#lstatFenced(path: string): BigIntStats | undefined {
		try {
			return lstatSync(path, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
			this.#poison();
			throw writeFailed();
		}
	}

	#assertUsable(): void {
		if (this.#closed || this.#poisoned) throw unavailable();
	}

	/**
	 * Run one permission-policy call; a refusal becomes the fixed unavailable
	 * error carrying the policy's fixed reason and the named storage object (the
	 * parent object when the policy refused on the containing directory first).
	 */
	#protect(operation: () => void, object: PeerStorageObject, parentObject: PeerStorageObject = object): void {
		try {
			operation();
		} catch (error) {
			const detail = peerStorageRefusalDetail(error);
			throw unavailableBecause(detail?.reason ?? "protection-unsupported", detail?.scope === "parent" ? parentObject : object);
		}
	}

	#poison(): void {
		this.#poisoned = true;
		this.#model = null;
	}
}

/**
 * Open the protected sidebar preferences for one canonical Pi agent directory.
 *
 * - No `session-host/peer-preferences` directory: no saved preferences; nothing
 *   is created, and `read()` returns `null`.
 * - Existing directory without a valid document: throws a fixed error and
 *   leaves everything untouched.
 * - Valid, protected, internally consistent document: loaded and usable.
 *
 * The injected protection policy is required; the safe product default belongs
 * to the caller that injects the real platform policy.
 */
export function openPeerPreferencesStoreWithPermissions(
	options: OpenPeerPreferencesStoreOptions,
): PeerPreferencesStore {
	if (!isPlainRecord(options)) throw new TypeError("peer sidebar preferences require options");
	const permissions = assertPermissionPolicy(options.permissions);
	const canonicalAgentDir = canonicalAgentDirectory(options.agentDir);
	const manager = new PreferencesManager(canonicalAgentDir, permissions);
	manager.load();
	return manager;
}
