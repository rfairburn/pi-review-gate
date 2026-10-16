/**
 * Private, bounded, rotated persistence for session-host terminal diagnostics
 * (#428).
 *
 * Location: `<agentDir>/session-host/terminal-diagnostics.jsonl`, under the
 * canonical native Pi agent directory (`PI_CODING_AGENT_DIR`, otherwise
 * `~/.pi/agent`) — the same private state directory as the sidebar roster.
 * Retention is exactly three files: the active file plus `.1` and `.2`, each
 * at most 5 MiB (15 MiB total). Before a line would push the active file past
 * its bound, `.2` is removed, `.1` becomes `.2`, and the active file becomes
 * `.1`.
 *
 * Fail-closed ownership rules:
 *
 * - Nothing is created until the first diagnostic of a run is recorded.
 * - The state directory must be a real directory (never a symlink) and, on
 *   POSIX, owned by the current user without group/other write access.
 * - Every log file must be a regular, single-link file owned by the current
 *   user and opened without following symlinks; the opened descriptor is
 *   rechecked against the inspected identity. New files are created
 *   exclusively with mode 0600. On POSIX an existing active or rotation file
 *   with any group/other permission bit is refused (`unsafe-log-path`) and
 *   left untouched: its mode is never changed, so new private records are
 *   never added to an overly accessible file. Windows relies on the OS ACLs
 *   of the agent directory; no custom ACL is applied.
 * - A rotation slot (`.1`/`.2`) or an existing active file is only moved,
 *   removed, or appended to when its first line carries this log's schema
 *   marker. Anything else, including a pre-existing empty file, is an unknown
 *   file: it is left untouched and persistence stops with a visible,
 *   payload-free failure. Nothing is ever truncated.
 * - Writes are serialized through one bounded in-memory queue; overflow is
 *   counted and recorded as a `dropped` line rather than growing memory.
 *   `close()` drains, syncs, and closes within a bounded wait and reports
 *   whether owned IO actually settled.
 *
 * Records never contain raw terminal bytes, conversation or tool text,
 * credentials, environment values, or arbitrary logger arguments: only the
 * bounded structures produced by `terminal-diagnostics.ts` plus run identity.
 * No data is transmitted anywhere; there is no polling, daemon, or setting.
 */

import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ensureHostStateDir } from "./roster-store";
import type {
	TerminalDiagnosticRecord,
	TerminalDiagnosticsLogFailure,
	TerminalDiagnosticsLogStatus,
} from "./terminal-diagnostics";

/** File name of the active log inside `<agentDir>/session-host/`. */
export const TERMINAL_DIAGNOSTICS_FILENAME = "terminal-diagnostics.jsonl";
/** Schema marker that must lead every line (and so every file's first line). */
export const TERMINAL_DIAGNOSTICS_SCHEMA = "pi-review-gate.session-host.terminal-diagnostics.v1";
/** Per-file bound: 5 MiB. */
export const TERMINAL_DIAGNOSTICS_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Active file plus `.1` and `.2`. */
export const TERMINAL_DIAGNOSTICS_RETAINED_FILES = 3;

const DEFAULT_MAX_LINE_BYTES = 16 * 1024;
const DEFAULT_MAX_QUEUED_LINES = 256;
const DEFAULT_MAX_QUEUED_BYTES = 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 2000;
const HEAD_BYTES = 128;
/** Minimum room per file for record lines beyond the identity record. */
const MIN_RECORD_ROOM_BYTES = 512;
const MAX_IDENTITY_FIELD_CHARS = 64;
const MAX_INSTANCE_ID_CHARS = 128;
const RECORD_PREFIX = `{"schema":${JSON.stringify(TERMINAL_DIAGNOSTICS_SCHEMA)}`;

/** Build/runtime/dependency identity, each field present only when actually known. */
export interface TerminalDiagnosticsIdentity {
	readonly packageName?: string;
	readonly packageVersion?: string;
	readonly node?: string;
	readonly platform?: string;
	readonly arch?: string;
	readonly piVersion?: string;
	readonly xtermHeadless?: string;
	readonly xtermAddonUnicode11?: string;
	readonly piTui?: string;
}

export interface TerminalDiagnosticsLogOptions {
	/** Canonical native Pi agent directory. */
	readonly agentDir: string;
	readonly identity?: TerminalDiagnosticsIdentity;
	/** Persistence transitions (`failed` is permanent for this run). */
	readonly onStatus?: (status: TerminalDiagnosticsLogStatus, failure?: TerminalDiagnosticsLogFailure) => void;
	/** Test seams: per-file bound and queue/line limits. */
	readonly maxFileBytes?: number;
	readonly maxLineBytes?: number;
	readonly maxQueuedLines?: number;
	readonly maxQueuedBytes?: number;
	readonly closeTimeoutMs?: number;
	readonly now?: () => number;
	/** Test seam for the final data synchronization (default `handle.datasync()`). */
	readonly syncFile?: (handle: FileHandle) => Promise<void>;
}

/** Truthful settlement outcome of `close()`. */
export interface TerminalDiagnosticsLogCloseResult {
	/** Owned IO drained and the descriptor closed within the bounded wait. */
	readonly settled: boolean;
	/**
	 * False when any persistence failure is observed after close was requested:
	 * a write, open, or rotation still pending at close, the final data
	 * synchronization, or the descriptor close (trivially true when nothing
	 * remained to flush). Such a failure can no longer be shown in the host UI,
	 * so it is a cleanup failure and never reported as success. A failure seen
	 * before close was already shown as the visible warning.
	 */
	readonly flushed: boolean;
	/** Final persistence state for this run. */
	readonly status: TerminalDiagnosticsLogStatus;
	readonly failure?: TerminalDiagnosticsLogFailure;
}

/** Minimal surface Main depends on (injectable for focused tests). */
export interface TerminalDiagnosticsLogLike {
	readonly status: TerminalDiagnosticsLogStatus;
	readonly failure?: TerminalDiagnosticsLogFailure;
	appendDiagnostic(instanceId: string, record: TerminalDiagnosticRecord): void;
	noteSuppressed(count: number): void;
	close(): Promise<TerminalDiagnosticsLogCloseResult>;
}

class LogFailure extends Error {
	constructor(readonly reason: TerminalDiagnosticsLogFailure) {
		super(reason);
	}
}

function boundedField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const safe = value.replace(/[^\x20-\x7e]/g, "").slice(0, MAX_IDENTITY_FIELD_CHARS);
	return safe.length > 0 ? safe : undefined;
}

function readPackageField(path: string, field: "name" | "version"): string | undefined {
	try {
		const text = readFileSync(path, { encoding: "utf8" });
		if (text.length > 256 * 1024) return undefined;
		const parsed = JSON.parse(text) as Record<string, unknown>;
		return boundedField(parsed[field]);
	} catch {
		return undefined;
	}
}

function dependencyVersion(name: string): string | undefined {
	try {
		return readPackageField(require.resolve(`${name}/package.json`), "version");
	} catch {
		return undefined;
	}
}

/**
 * Collect only identities that are actually available: this package's
 * manifest, Node/platform, the resolved Pi version, and the pinned terminal
 * dependency manifests. Missing values are omitted, never guessed.
 */
export function collectTerminalDiagnosticsIdentity(options: {
	readonly packageRoot?: string;
	readonly piVersion?: string;
}): TerminalDiagnosticsIdentity {
	const manifest = typeof options.packageRoot === "string" ? join(options.packageRoot, "package.json") : undefined;
	const entries: [keyof TerminalDiagnosticsIdentity, string | undefined][] = [
		["packageName", manifest === undefined ? undefined : readPackageField(manifest, "name")],
		["packageVersion", manifest === undefined ? undefined : readPackageField(manifest, "version")],
		["node", boundedField(process.versions?.node)],
		["platform", boundedField(process.platform)],
		["arch", boundedField(process.arch)],
		["piVersion", boundedField(options.piVersion)],
		["xtermHeadless", dependencyVersion("@xterm/headless")],
		["xtermAddonUnicode11", dependencyVersion("@xterm/addon-unicode11")],
		["piTui", dependencyVersion("pi-session-host-tui")],
	];
	const identity: Record<string, string> = {};
	for (const [key, value] of entries) if (value !== undefined) identity[key] = value;
	return identity as TerminalDiagnosticsIdentity;
}

function currentUid(): number | undefined {
	try {
		return typeof process.getuid === "function" ? process.getuid() : undefined;
	} catch {
		return undefined;
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

/** Regular, single-link, current-user file (POSIX ownership checks only where meaningful). */
function safeFileStats(stats: BigIntStats): boolean {
	if (stats.isSymbolicLink() || !stats.isFile()) return false;
	if (process.platform === "win32") return true;
	const uid = currentUid();
	if (uid !== undefined && stats.uid !== BigInt(uid)) return false;
	return stats.nlink === 1n;
}

/** POSIX: no group/other permission bits. Windows: governed by the OS ACL boundary. */
function privateFileMode(stats: BigIntStats): boolean {
	if (process.platform === "win32") return true;
	return (stats.mode & 0o077n) === 0n;
}

export class TerminalDiagnosticsLog implements TerminalDiagnosticsLogLike {
	private readonly options: TerminalDiagnosticsLogOptions;
	private readonly maxFileBytes: number;
	private readonly maxLineBytes: number;
	private readonly maxQueuedLines: number;
	private readonly maxQueuedBytes: number;
	private readonly closeTimeoutMs: number;
	private readonly now: () => number;
	private readonly run = randomUUID();
	private readonly queue: string[] = [];
	private queuedBytes = 0;
	private droppedPending = 0;
	private droppedTotal = 0;
	private suppressedTotal = 0;
	private recordsTotal = 0;
	private seq = 0;
	private handle?: FileHandle;
	private activePath?: string;
	private activeIdentity?: FileIdentity;
	private activeSize = 0;
	/** Whether the current active file already carries this run's identity record. */
	private headerInFile = false;
	/** 1-based count of files this run has written (identity record `segment`). */
	private segment = 0;
	private openedThisRun = false;
	/** A persistence failure occurred after close was requested. */
	private failedWhileClosing = false;
	private running?: Promise<void>;
	private closing = false;
	private closePromise?: Promise<TerminalDiagnosticsLogCloseResult>;
	private status_: TerminalDiagnosticsLogStatus = "ok";
	private failure_?: TerminalDiagnosticsLogFailure;

	constructor(options: TerminalDiagnosticsLogOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		// Every file this run writes starts with its bounded identity record, so
		// the per-file bound reserves room for it plus one maximal line.
		const headerBound = Buffer.byteLength(this.headerLine(Number.MAX_SAFE_INTEGER), "utf8");
		this.maxFileBytes = Math.max(
			positive(options.maxFileBytes, TERMINAL_DIAGNOSTICS_MAX_FILE_BYTES),
			headerBound + MIN_RECORD_ROOM_BYTES,
		);
		this.maxLineBytes = Math.min(positive(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES), this.maxFileBytes - headerBound);
		this.maxQueuedLines = positive(options.maxQueuedLines, DEFAULT_MAX_QUEUED_LINES);
		this.maxQueuedBytes = positive(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES);
		this.closeTimeoutMs = positive(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
	}

	get status(): TerminalDiagnosticsLogStatus {
		return this.status_;
	}

	get failure(): TerminalDiagnosticsLogFailure | undefined {
		return this.failure_;
	}

	/** Lexical active log path for one agent directory (diagnostics/tests). */
	static pathFor(agentDir: string): string {
		return join(agentDir, "session-host", TERMINAL_DIAGNOSTICS_FILENAME);
	}

	appendDiagnostic(instanceId: string, record: TerminalDiagnosticRecord): void {
		if (this.closing || this.status_ !== "ok") return;
		this.recordsTotal += 1;
		this.enqueue({
			kind: "diagnostic",
			instance: typeof instanceId === "string"
				? instanceId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, MAX_INSTANCE_ID_CHARS)
				: "unknown",
			...record,
		}, record);
	}

	noteSuppressed(count: number): void {
		if (Number.isSafeInteger(count) && count > 0) {
			this.suppressedTotal = Math.min(Number.MAX_SAFE_INTEGER, this.suppressedTotal + count);
		}
	}

	close(): Promise<TerminalDiagnosticsLogCloseResult> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		// Any accepted record means this run owns (or is about to open) the log,
		// even when the lazy open has not completed yet.
		if (this.recordsTotal > 0 && this.status_ === "ok") {
			this.enqueue({
				kind: "host-run-end",
				totals: {
					records: this.recordsTotal,
					suppressed: this.suppressedTotal,
					dropped: this.droppedTotal + this.droppedPending,
				},
			}, undefined, true);
		}
		this.kick();
		this.closePromise = this.settle();
		return this.closePromise;
	}

	private async settle(): Promise<TerminalDiagnosticsLogCloseResult> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), this.closeTimeoutMs);
			timer.unref?.();
		});
		const drained = this.idle().then(async () => {
			const handle = this.handle;
			this.handle = undefined;
			if (handle !== undefined) {
				// Delayed write errors can surface only at synchronization: a
				// rejected sync is a persistence failure. The descriptor is still
				// closed, and the failure is reported payload-free.
				let syncFailed = false;
				try {
					await (this.options.syncFile ?? ((owned: FileHandle) => owned.datasync()))(handle);
				} catch {
					syncFailed = true;
				}
				let closeFailed = false;
				try {
					await handle.close();
				} catch {
					closeFailed = true;
				}
				if (syncFailed) await this.fail("sync-failed");
				else if (closeFailed) await this.fail("write-failed");
			}
			return true as const;
		}).catch(() => false as const);
		const settled = await Promise.race([drained, timedOut]);
		if (timer !== undefined) clearTimeout(timer);
		return {
			settled,
			flushed: settled && !this.failedWhileClosing,
			status: this.status_,
			...(this.failure_ === undefined ? {} : { failure: this.failure_ }),
		};
	}

	private async idle(): Promise<void> {
		while (this.running !== undefined) {
			await this.running;
		}
	}

	private time(): string {
		try {
			return new Date(this.now()).toISOString();
		} catch {
			return new Date(0).toISOString();
		}
	}

	/** This run's bounded identity record, repeated at the start of every file it writes. */
	private headerLine(segment: number): string {
		return this.serialize({ kind: "host-run", segment, identity: this.options.identity ?? {} });
	}

	private serialize(body: Record<string, unknown>): string {
		return `${JSON.stringify({ schema: TERMINAL_DIAGNOSTICS_SCHEMA, time: this.time(), run: this.run, ...body })}\n`;
	}

	private enqueue(body: Record<string, unknown>, record?: TerminalDiagnosticRecord, force = false): void {
		let line: string;
		try {
			const sequenced = body.kind === "diagnostic" ? { ...body, seq: ++this.seq } : body;
			line = this.serialize(sequenced);
			if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
				line = this.serialize({
					kind: "diagnostic-omitted",
					reason: "record-too-large",
					...(record === undefined ? {} : { level: record.level, messageId: record.messageId }),
				});
			}
		} catch {
			return;
		}
		const bytes = Buffer.byteLength(line, "utf8");
		if (!force && (this.queue.length >= this.maxQueuedLines || this.queuedBytes + bytes > this.maxQueuedBytes)) {
			this.droppedPending += 1;
			return;
		}
		this.queue.push(line);
		this.queuedBytes += bytes;
		this.kick();
	}

	private kick(): void {
		if (this.running !== undefined || this.queue.length === 0 || this.status_ !== "ok") return;
		const task = this.drain().finally(() => {
			if (this.running === task) this.running = undefined;
			this.kick();
		});
		this.running = task;
	}

	private async drain(): Promise<void> {
		try {
			while (this.queue.length > 0 && this.status_ === "ok") {
				await this.ensureOpen();
				if (this.droppedPending > 0) {
					const count = this.droppedPending;
					this.droppedPending = 0;
					this.droppedTotal += count;
					await this.writeRecord(this.serialize({ kind: "dropped", count, reason: "writer-backlog" }));
				}
				const line = this.queue.shift() as string;
				this.queuedBytes -= Buffer.byteLength(line, "utf8");
				await this.writeRecord(line);
			}
		} catch (error) {
			await this.fail(error instanceof LogFailure ? error.reason : "write-failed");
		}
	}

	private async fail(reason: TerminalDiagnosticsLogFailure): Promise<void> {
		if (this.status_ === "failed") return;
		this.status_ = "failed";
		this.failure_ = reason;
		if (this.closing) this.failedWhileClosing = true;
		this.queue.length = 0;
		this.queuedBytes = 0;
		const handle = this.handle;
		this.handle = undefined;
		if (handle !== undefined) {
			try { await handle.close(); } catch { /* the failure is already recorded */ }
		}
		try {
			this.options.onStatus?.("failed", reason);
		} catch {
			// Status consumers are responsible for their own failures.
		}
	}

	/**
	 * Write one record line, preceded by this run's identity record when the
	 * active file does not carry it yet. Rotation happens first when the pair
	 * would exceed the per-file bound, so every retained file holding this run's
	 * records also holds its identities.
	 */
	private async writeRecord(line: string): Promise<void> {
		const bytes = Buffer.byteLength(line, "utf8");
		let header = this.headerInFile ? undefined : this.headerLine(this.segment);
		const needed = (): number => bytes + (header === undefined ? 0 : Buffer.byteLength(header, "utf8"));
		if (this.activeSize > 0 && this.activeSize + needed() > this.maxFileBytes) {
			await this.rotate();
			header = this.headerLine(this.segment);
		}
		if (header !== undefined) {
			await this.writeRaw(header);
			this.headerInFile = true;
		}
		await this.writeRaw(line);
	}

	private async writeRaw(line: string): Promise<void> {
		const buffer = Buffer.from(line, "utf8");
		const handle = this.handle;
		if (handle === undefined) throw new LogFailure("write-failed");
		let offset = 0;
		try {
			while (offset < buffer.length) {
				const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
				if (bytesWritten <= 0) throw new Error("no progress");
				offset += bytesWritten;
			}
		} catch {
			throw new LogFailure("write-failed");
		}
		this.activeSize += buffer.length;
	}

	private stateDir(): string {
		let dir: string;
		try {
			dir = ensureHostStateDir(this.options.agentDir);
		} catch {
			throw new LogFailure("unsafe-state-dir");
		}
		return dir;
	}

	private async assertPrivateDir(dir: string): Promise<void> {
		if (process.platform === "win32") return;
		let stats: BigIntStats;
		try {
			stats = await lstat(dir, { bigint: true });
		} catch {
			throw new LogFailure("unsafe-state-dir");
		}
		const uid = currentUid();
		if (stats.isSymbolicLink() || !stats.isDirectory()
			|| (uid !== undefined && stats.uid !== BigInt(uid))
			|| (stats.mode & 0o022n) !== 0n) {
			throw new LogFailure("unsafe-state-dir");
		}
	}

	private async ensureOpen(): Promise<void> {
		if (this.handle !== undefined) return;
		if (this.openedThisRun) throw new LogFailure("write-failed");
		const dir = this.stateDir();
		await this.assertPrivateDir(dir);
		const path = join(dir, TERMINAL_DIAGNOSTICS_FILENAME);
		let existing: BigIntStats | undefined;
		try {
			existing = await lstat(path, { bigint: true });
		} catch (error) {
			if (!isMissing(error)) throw new LogFailure("open-failed");
		}
		if (existing === undefined) {
			await this.createActive(path);
		} else {
			if (!safeFileStats(existing) || !privateFileMode(existing)) throw new LogFailure("unsafe-log-path");
			let handle: FileHandle;
			try {
				handle = await open(path, fsConstants.O_RDWR | fsConstants.O_APPEND
					| (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
			} catch {
				throw new LogFailure("open-failed");
			}
			try {
				const stats = await handle.stat({ bigint: true });
				if (!stats.isFile() || stats.dev !== existing.dev || stats.ino !== existing.ino
					|| !safeFileStats(stats) || !privateFileMode(stats)) {
					throw new LogFailure("unsafe-log-path");
				}
				// A pre-existing empty file carries no marker, so it is no evidence
				// that this log owns it; only a file this run created exclusively is
				// written without one.
				if (stats.size === 0n || !(await this.recognizedHead(handle))) {
					throw new LogFailure("unrecognized-log-file");
				}
				this.handle = handle;
				this.activeIdentity = { dev: stats.dev, ino: stats.ino };
				this.activeSize = Number(stats.size);
			} catch (error) {
				try { await handle.close(); } catch { /* preserve the refusal */ }
				throw error instanceof LogFailure ? error : new LogFailure("open-failed");
			}
		}
		this.activePath = path;
		this.openedThisRun = true;
		this.headerInFile = false;
		this.segment = 1;
	}

	private async createActive(path: string): Promise<void> {
		let handle: FileHandle;
		try {
			handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
				| fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
		} catch {
			throw new LogFailure("open-failed");
		}
		try {
			const stats = await handle.stat({ bigint: true });
			this.handle = handle;
			this.activeIdentity = { dev: stats.dev, ino: stats.ino };
			this.activeSize = 0;
		} catch {
			try { await handle.close(); } catch { /* preserve the failure */ }
			throw new LogFailure("open-failed");
		}
	}

	private async recognizedHead(handle: FileHandle): Promise<boolean> {
		const buffer = Buffer.alloc(HEAD_BYTES);
		try {
			const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
			return buffer.subarray(0, bytesRead).toString("utf8").startsWith(RECORD_PREFIX);
		} catch {
			return false;
		}
	}

	/** True when `path` is absent; throws unless it is a recognized log file of ours. */
	private async verifyRotationSlot(path: string): Promise<boolean> {
		let stats: BigIntStats;
		try {
			stats = await lstat(path, { bigint: true });
		} catch (error) {
			if (isMissing(error)) return true;
			throw new LogFailure("rotate-failed");
		}
		if (!safeFileStats(stats) || stats.size === 0n) throw new LogFailure("unrecognized-log-file");
		if (!privateFileMode(stats)) throw new LogFailure("unsafe-log-path");
		let handle: FileHandle;
		try {
			handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
		} catch {
			throw new LogFailure("rotate-failed");
		}
		try {
			const opened = await handle.stat({ bigint: true });
			if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino
				|| !(await this.recognizedHead(handle))) {
				throw new LogFailure("unrecognized-log-file");
			}
			if (!privateFileMode(opened)) throw new LogFailure("unsafe-log-path");
		} finally {
			try { await handle.close(); } catch { /* inspection only */ }
		}
		return false;
	}

	private async rotate(): Promise<void> {
		const path = this.activePath;
		const identity = this.activeIdentity;
		const handle = this.handle;
		if (path === undefined || identity === undefined || handle === undefined) throw new LogFailure("rotate-failed");
		this.handle = undefined;
		// The outgoing file becomes `.1`: synchronize it before its descriptor
		// closes, so a delayed write error is detected before any path changes.
		// The descriptor is closed even when synchronization rejects.
		let syncFailed = false;
		try {
			await (this.options.syncFile ?? ((owned: FileHandle) => owned.datasync()))(handle);
		} catch {
			syncFailed = true;
		}
		let closeFailed = false;
		try {
			await handle.close();
		} catch {
			closeFailed = true;
		}
		if (syncFailed) throw new LogFailure("sync-failed");
		if (closeFailed) throw new LogFailure("rotate-failed");
		const first = `${path}.1`;
		const second = `${path}.2`;
		// Check every slot before mutating any of them, so an unknown file stops
		// rotation without having removed or moved anything.
		const secondAbsent = await this.verifyRotationSlot(second);
		const firstAbsent = await this.verifyRotationSlot(first);
		let active: BigIntStats;
		try {
			active = await lstat(path, { bigint: true });
		} catch {
			throw new LogFailure("unsafe-log-path");
		}
		if (!safeFileStats(active) || !privateFileMode(active) || active.dev !== identity.dev || active.ino !== identity.ino) {
			throw new LogFailure("unsafe-log-path");
		}
		try {
			if (!secondAbsent) await unlink(second);
			if (!firstAbsent) await rename(first, second);
			await rename(path, first);
		} catch {
			throw new LogFailure("rotate-failed");
		}
		await this.createActive(path);
		this.headerInFile = false;
		this.segment += 1;
	}
}

function positive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
