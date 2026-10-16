/**
 * Bounded, privacy-preserving terminal-parser diagnostics for the optional
 * session host (#428).
 *
 * The pinned @xterm/headless 6 core reports through its log service, which
 * defaults to the host process `console` (`xterm.js: Parsing error: ...` via
 * `console.error`). In the session host that console is the real terminal's
 * stderr, so a malformed child control sequence could paint a diagnostic dump
 * outside the composed frame and outside the frame writer's diff baseline.
 *
 * This module supplies a per-surface `ILogger` instead. It never touches the
 * global console, never changes xterm's log level, and never accepts or
 * forwards child escape sequences. Every logger level is contained here:
 *
 * - Logger calls are classified against a fixed table of known xterm message
 *   prefixes. Message text and arbitrary logger arguments are never retained,
 *   because xterm's debug/trace messages embed raw terminal bytes.
 * - Only a parser error's state object is read structurally: the parser state
 *   number, the triggering code point, the chunk position, decoded
 *   intermediates, and the ACTIVE parameters (bounded by `params.length`; the
 *   parser's fixed `Int32Array` storage past that length is stale and never
 *   read).
 * - An xterm parser error is a state report, not an exception. The only stack
 *   recorded for it is the host call stack captured at the logger call site,
 *   explicitly labelled as such; no originating child stack or cause is ever
 *   fabricated. A genuine `Error` passed to the logger keeps its own stack
 *   frames under a separate label (never its message text).
 * - A per-surface token bucket bounds detailed records (and stack capture);
 *   calls beyond it are counted, never silently lost. Delivery happens in a
 *   microtask after the current parse step, never inside the parser callback,
 *   and nothing here can throw into xterm.
 *
 * Pure module: no filesystem, process, or terminal I/O. Persistence lives in
 * `terminal-diagnostics-log.ts`; host warning state is `TerminalDiagnosticsWarning`.
 */

import { homedir } from "node:os";

/** xterm logger levels (the pinned `ILogger` interface). */
export type TerminalDiagnosticLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Coarse category used for the host warning and the persisted record. */
export type TerminalDiagnosticCategory = "parser-error" | "xterm-warning" | "xterm-log";

/** Bounded parser state copied from an xterm parse-error report. */
export interface TerminalParserStateSnapshot {
	/** xterm's numeric parser state (pinned 6.0.0 ParserState enum). */
	readonly state: number;
	/** Symbolic name of `state`, or "unknown" for a value outside the pinned enum. */
	readonly stateName: string;
	/** The code point that the transition table rejected. */
	readonly code: number;
	/** Offset of that code point inside the parsed chunk (a number, never the chunk). */
	readonly position: number;
	/** Printable collected intermediate/prefix bytes (for example "?"). */
	readonly intermediates: string;
	/** Active parameter count reported by the parser (`params.length`). */
	readonly paramCount: number;
	/** Bounded copy of the ACTIVE parameters only; sub-parameters are nested arrays. */
	readonly params: readonly (number | readonly number[])[];
	/** True when `params` omits active entries beyond the record bound. */
	readonly paramsTruncated: boolean;
}

/** A bounded, labelled stack. Never a fabricated originating stack. */
export interface TerminalDiagnosticStack {
	/**
	 * `logger-call-site`: the host stack when xterm invoked the logger (useful
	 * for locating the xterm path; it is NOT the child's or the cause's stack).
	 * `logged-error`: frames of a genuine Error object xterm passed to the logger.
	 */
	readonly kind: "logger-call-site" | "logged-error";
	readonly frames: readonly string[];
	readonly truncated: boolean;
}

/** Surface context captured synchronously at the logger site. */
export interface TerminalDiagnosticContext {
	readonly cols: number;
	readonly rows: number;
	readonly buffer: "normal" | "alternate" | "unknown";
	readonly synchronizedFrameHeld: boolean;
}

/** One bounded diagnostic produced by a surface's xterm logger. */
export interface TerminalDiagnosticRecord {
	/** ISO-8601 capture time at the logger call site. */
	readonly time: string;
	readonly level: TerminalDiagnosticLevel;
	readonly category: TerminalDiagnosticCategory;
	/** Fixed identifier of the recognized xterm message, or "unrecognized". */
	readonly messageId: string;
	/** Logger calls on this surface counted but not detailed since the previous record. */
	readonly suppressedBefore: number;
	readonly context?: TerminalDiagnosticContext;
	readonly parser?: TerminalParserStateSnapshot;
	/** Bounded identifier-like name of a genuine Error passed to the logger. */
	readonly errorName?: string;
	readonly stack?: TerminalDiagnosticStack;
	/**
	 * Why no originating stack is present. Parser errors are state reports from
	 * xterm's transition table: there is no originating exception or child stack.
	 */
	readonly originatingStack: "not-applicable-parser-state-report" | "not-captured" | "logged-error-stack";
}

/** One post-parse delivery from a surface: detailed records plus counted overflow. */
export interface TerminalDiagnosticEvent {
	readonly records: readonly TerminalDiagnosticRecord[];
	/** Logger calls counted but not detailed in this delivery (bucket or queue overflow). */
	readonly suppressed: number;
	/** Warning-relevant (warn/error) logger calls represented by this delivery, detailed or not. */
	readonly warningCount: number;
}

/** Structural xterm `ILogger` (pinned 6.0.0 typings). */
export interface XtermLogger {
	trace(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string | Error, ...args: unknown[]): void;
}

export interface XtermDiagnosticCollectorOptions {
	/** Receives post-parse deliveries; exceptions are contained. */
	readonly deliver: (event: TerminalDiagnosticEvent) => void;
	/** Synchronous surface context getter; exceptions are contained. */
	readonly context?: () => TerminalDiagnosticContext;
	/** Injectable clock (ms since epoch). */
	readonly now?: () => number;
	/** Injectable scheduler for the post-parse delivery (default queueMicrotask). */
	readonly schedule?: (callback: () => void) => void;
	/** Detailed-record burst capacity (default 16). */
	readonly burst?: number;
	/** Milliseconds per refilled detailed-record token (default 2000). */
	readonly refillMs?: number;
}

/** Pinned xterm 6.0.0 ParserState names (EscapeSequenceParser). */
const PARSER_STATE_NAMES: readonly string[] = [
	"GROUND",
	"ESCAPE",
	"ESCAPE_INTERMEDIATE",
	"CSI_ENTRY",
	"CSI_PARAM",
	"CSI_INTERMEDIATE",
	"CSI_IGNORE",
	"SOS_PM_APC_STRING",
	"OSC_STRING",
	"DCS_ENTRY",
	"DCS_PARAM",
	"DCS_IGNORE",
	"DCS_INTERMEDIATE",
	"DCS_PASSTHROUGH",
];

/**
 * Known message prefixes of the pinned xterm 6.0.0 log service calls. Only
 * the identifier is retained; the message itself (which may embed raw child
 * bytes for debug/trace calls) never is.
 */
const KNOWN_MESSAGES: readonly { readonly prefix: string; readonly id: string }[] = [
	{ prefix: "Parsing error", id: "parser-error" },
	{ prefix: "writeSync is unreliable", id: "write-sync-unreliable" },
	{ prefix: "Unknown CSI code", id: "unknown-csi" },
	{ prefix: "Unknown ESC code", id: "unknown-esc" },
	{ prefix: "Unknown EXECUTE code", id: "unknown-execute" },
	{ prefix: "Unknown OSC code", id: "unknown-osc" },
	{ prefix: "Unknown DCS code", id: "unknown-dcs" },
	{ prefix: "Unknown SGR attribute", id: "unknown-sgr" },
	{ prefix: "parsing data", id: "parsing-data" },
	{ prefix: "sending data", id: "sending-data" },
	{ prefix: "sending binary", id: "sending-binary" },
	{ prefix: "DECSET 1005", id: "decset-1005-unsupported" },
	{ prefix: "DECRST 1005", id: "decrst-1005-unsupported" },
	{ prefix: "Serial port requested application keypad", id: "application-keypad" },
	{ prefix: "Switching back to normal keypad", id: "normal-keypad" },
];

const MAX_RECORDED_PARAMS = 16;
const MAX_RECORDED_SUBPARAMS = 8;
const MAX_PARSER_PARAMS = 32;
const MAX_STACK_FRAMES = 12;
const MAX_STACK_FRAME_CHARS = 240;
const MAX_ERROR_NAME_CHARS = 64;
const MAX_PENDING_RECORDS = 32;
const DEFAULT_BURST = 16;
const DEFAULT_REFILL_MS = 2000;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function classify(message: unknown): string {
	if (typeof message !== "string") return "unrecognized";
	for (const known of KNOWN_MESSAGES) {
		if (message.startsWith(known.prefix)) return known.id;
	}
	return "unrecognized";
}

function categoryFor(level: TerminalDiagnosticLevel, messageId: string): TerminalDiagnosticCategory {
	if (messageId === "parser-error") return "parser-error";
	return level === "warn" || level === "error" ? "xterm-warning" : "xterm-log";
}

function boundedInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(INT32_MAX, Math.max(INT32_MIN, Math.trunc(value)));
}

function decodeIntermediates(collect: unknown): string {
	const packed = boundedInt(collect);
	if (packed === undefined || packed <= 0) return "";
	// xterm packs each collected byte as (collect << 8) | byte, first byte highest.
	let value = packed >>> 0;
	const bytes: number[] = [];
	for (let index = 0; index < 4 && value > 0; index += 1) {
		bytes.unshift(value & 0xff);
		value >>>= 8;
	}
	// Intermediates (0x20-0x2f) and private prefixes (0x3c-0x3f) only.
	return bytes
		.filter((byte) => (byte >= 0x20 && byte <= 0x2f) || (byte >= 0x3c && byte <= 0x3f))
		.map((byte) => String.fromCharCode(byte))
		.join("");
}

/**
 * Copy only the ACTIVE parameters from an xterm `IParams`: `toArray()` is
 * bounded by `length`, so stale storage past the active length is never read.
 */
function activeParams(params: unknown): {
	readonly count: number;
	readonly values: (number | number[])[];
	readonly truncated: boolean;
} {
	const empty = { count: 0, values: [], truncated: false };
	if (typeof params !== "object" || params === null) return empty;
	const candidate = params as { length?: unknown; toArray?: unknown };
	const length = boundedInt(candidate.length);
	if (length === undefined || length <= 0) return empty;
	const count = Math.min(length, MAX_PARSER_PARAMS);
	if (typeof candidate.toArray !== "function") return { count, values: [], truncated: true };
	let raw: unknown;
	try {
		raw = (candidate.toArray as () => unknown).call(params);
	} catch {
		return { count, values: [], truncated: true };
	}
	if (!Array.isArray(raw)) return { count, values: [], truncated: true };
	const values: (number | number[])[] = [];
	let topLevel = 0;
	let truncated = false;
	for (const entry of raw) {
		if (Array.isArray(entry)) {
			// Sub-parameters belong to the preceding recorded top-level entry.
			if (topLevel === 0 || topLevel > MAX_RECORDED_PARAMS) continue;
			const sub = entry.slice(0, MAX_RECORDED_SUBPARAMS).map(boundedInt)
				.filter((item): item is number => item !== undefined);
			if (entry.length > MAX_RECORDED_SUBPARAMS) truncated = true;
			values.push(sub);
			continue;
		}
		topLevel += 1;
		if (topLevel > MAX_RECORDED_PARAMS) {
			truncated = true;
			continue;
		}
		const value = boundedInt(entry);
		if (value !== undefined) values.push(value);
	}
	if (topLevel < count) truncated = true;
	return { count, values, truncated };
}

/** Bounded structural copy of an xterm parse-error state report. */
export function snapshotParserState(state: unknown): TerminalParserStateSnapshot | undefined {
	if (typeof state !== "object" || state === null) return undefined;
	try {
		const source = state as {
			currentState?: unknown;
			code?: unknown;
			position?: unknown;
			collect?: unknown;
			params?: unknown;
		};
		const stateNumber = boundedInt(source.currentState) ?? -1;
		const params = activeParams(source.params);
		return {
			state: stateNumber,
			stateName: PARSER_STATE_NAMES[stateNumber] ?? "unknown",
			code: boundedInt(source.code) ?? -1,
			position: boundedInt(source.position) ?? -1,
			intermediates: decodeIntermediates(source.collect),
			paramCount: params.count,
			params: params.values,
			paramsTruncated: params.truncated,
		};
	} catch {
		return undefined;
	}
}

let cachedHome: string | undefined | null = null;

function homePrefix(): string | undefined {
	if (cachedHome === null) {
		try {
			const home = homedir();
			cachedHome = typeof home === "string" && home.length > 1 ? home : undefined;
		} catch {
			cachedHome = undefined;
		}
	}
	return cachedHome;
}

function sanitizeFrame(line: string): string {
	let frame = line.trim();
	const home = homePrefix();
	if (home !== undefined) frame = frame.split(home).join("~");
	frame = frame.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "");
	return frame.length > MAX_STACK_FRAME_CHARS ? `${frame.slice(0, MAX_STACK_FRAME_CHARS - 3)}...` : frame;
}

/** Keep only `at ...` frames: never the first line, which carries an error message. */
export function boundedStackFrames(stack: unknown, skipFrames = 0): { frames: string[]; truncated: boolean } {
	if (typeof stack !== "string") return { frames: [], truncated: false };
	const lines = stack.split("\n").filter((line) => /^\s*at\s/.test(line)).slice(skipFrames);
	return {
		frames: lines.slice(0, MAX_STACK_FRAMES).map(sanitizeFrame),
		truncated: lines.length > MAX_STACK_FRAMES,
	};
}

function boundedErrorName(error: Error): string | undefined {
	try {
		const name = typeof error.name === "string" ? error.name : "";
		const safe = name.replace(/[^A-Za-z0-9_.$-]/g, "").slice(0, MAX_ERROR_NAME_CHARS);
		return safe.length > 0 ? safe : undefined;
	} catch {
		return undefined;
	}
}

/**
 * One surface's xterm logger. `logger` is handed to the xterm Terminal
 * constructor; it never writes to the console and never throws.
 */
export class XtermDiagnosticCollector {
	readonly logger: XtermLogger;
	private readonly options: XtermDiagnosticCollectorOptions;
	private readonly now: () => number;
	private readonly schedule: (callback: () => void) => void;
	private readonly burst: number;
	private readonly refillMs: number;
	private tokens: number;
	private lastRefill: number;
	private pending: TerminalDiagnosticRecord[] = [];
	private pendingSuppressed = 0;
	private pendingWarnings = 0;
	/** Calls counted but not detailed since the previous detailed record. */
	private suppressedSinceRecord = 0;
	private scheduled = false;
	private disposed = false;

	constructor(options: XtermDiagnosticCollectorOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? queueMicrotask;
		this.burst = Math.max(1, Math.floor(options.burst ?? DEFAULT_BURST));
		this.refillMs = Math.max(1, Math.floor(options.refillMs ?? DEFAULT_REFILL_MS));
		this.tokens = this.burst;
		this.lastRefill = this.safeNow();
		const self = this;
		// Plain functions: xterm binds each method to this object before calling.
		this.logger = Object.freeze({
			trace(message: string, ...args: unknown[]): void { self.note("trace", message, args); },
			debug(message: string, ...args: unknown[]): void { self.note("debug", message, args); },
			info(message: string, ...args: unknown[]): void { self.note("info", message, args); },
			warn(message: string, ...args: unknown[]): void { self.note("warn", message, args); },
			error(message: string | Error, ...args: unknown[]): void { self.note("error", message, args); },
		});
	}

	/** Deliver anything pending synchronously (used immediately before disposal). */
	flushNow(): void {
		this.deliverPending();
	}

	/** Stop collecting; later logger calls are ignored and nothing is delivered. */
	dispose(): void {
		this.disposed = true;
		this.pending = [];
		this.pendingSuppressed = 0;
		this.pendingWarnings = 0;
	}

	private safeNow(): number {
		try {
			const value = this.now();
			return Number.isFinite(value) ? value : 0;
		} catch {
			return 0;
		}
	}

	private takeToken(now: number): boolean {
		if (now > this.lastRefill) {
			const refilled = Math.floor((now - this.lastRefill) / this.refillMs);
			if (refilled > 0) {
				this.tokens = Math.min(this.burst, this.tokens + refilled);
				this.lastRefill = this.tokens >= this.burst ? now : this.lastRefill + refilled * this.refillMs;
			}
		} else if (now < this.lastRefill) {
			// A clock step backwards must not freeze the bucket forever.
			this.lastRefill = now;
		}
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}

	private note(level: TerminalDiagnosticLevel, message: unknown, args: readonly unknown[]): void {
		// Everything here runs inside xterm's parser/log call: contain all failures.
		try {
			if (this.disposed) return;
			const messageId = message instanceof Error ? "logged-error" : classify(message);
			if (level === "warn" || level === "error") this.pendingWarnings += 1;
			const now = this.safeNow();
			if (this.pending.length >= MAX_PENDING_RECORDS || !this.takeToken(now)) {
				this.pendingSuppressed += 1;
				this.suppressedSinceRecord += 1;
				this.requestDelivery();
				return;
			}
			this.pending.push(this.buildRecord(level, messageId, message, args, now));
			this.suppressedSinceRecord = 0;
			this.requestDelivery();
		} catch {
			// A diagnostic failure must never escape into the parser callback.
		}
	}

	private buildRecord(
		level: TerminalDiagnosticLevel,
		messageId: string,
		message: unknown,
		args: readonly unknown[],
		now: number,
	): TerminalDiagnosticRecord {
		let context: TerminalDiagnosticContext | undefined;
		try {
			context = this.options.context?.();
		} catch {
			context = undefined;
		}
		const parser = messageId === "parser-error" ? snapshotParserState(args[0]) : undefined;
		let stack: TerminalDiagnosticStack | undefined;
		let errorName: string | undefined;
		let originatingStack: TerminalDiagnosticRecord["originatingStack"] = "not-captured";
		if (message instanceof Error) {
			errorName = boundedErrorName(message);
			let raw: unknown;
			try { raw = message.stack; } catch { raw = undefined; }
			const frames = boundedStackFrames(raw);
			stack = { kind: "logged-error", frames: frames.frames, truncated: frames.truncated };
			originatingStack = "logged-error-stack";
		} else if (level === "warn" || level === "error") {
			let raw: unknown;
			try { raw = new Error().stack; } catch { raw = undefined; }
			// Skip this collector's own frames (buildRecord, note, logger method).
			const frames = boundedStackFrames(raw, 3);
			stack = { kind: "logger-call-site", frames: frames.frames, truncated: frames.truncated };
			if (messageId === "parser-error") originatingStack = "not-applicable-parser-state-report";
		}
		let time: string;
		try { time = new Date(now).toISOString(); } catch { time = new Date(0).toISOString(); }
		return {
			time,
			level,
			category: categoryFor(level, messageId),
			messageId,
			suppressedBefore: this.suppressedSinceRecord,
			...(context === undefined ? {} : { context }),
			...(parser === undefined ? {} : { parser }),
			...(errorName === undefined ? {} : { errorName }),
			...(stack === undefined ? {} : { stack }),
			originatingStack,
		};
	}

	private requestDelivery(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		try {
			this.schedule(() => {
				this.scheduled = false;
				this.deliverPending();
			});
		} catch {
			this.scheduled = false;
		}
	}

	private deliverPending(): void {
		if (this.disposed) return;
		if (this.pending.length === 0 && this.pendingSuppressed === 0 && this.pendingWarnings === 0) return;
		const event: TerminalDiagnosticEvent = {
			records: this.pending,
			suppressed: this.pendingSuppressed,
			warningCount: this.pendingWarnings,
		};
		this.pending = [];
		this.pendingSuppressed = 0;
		this.pendingWarnings = 0;
		try {
			this.options.deliver(event);
		} catch {
			// The owner's sink is responsible for its own failures.
		}
	}
}

/** Persistence state shown with the host warning. */
export type TerminalDiagnosticsLogStatus = "ok" | "failed" | "unavailable";

/** Fixed, payload-free persistence failure reasons. */
export type TerminalDiagnosticsLogFailure =
	| "agent-dir-unavailable"
	| "unsafe-state-dir"
	| "unsafe-log-path"
	| "unrecognized-log-file"
	| "open-failed"
	| "write-failed"
	| "sync-failed"
	| "rotate-failed";

/** Sidebar/header view of the active warning. */
export interface TerminalDiagnosticsWarningView {
	/** Warning-relevant events since the last clear (may be 0 for a pure save failure). */
	readonly count: number;
	/** Cumulative warning events this warning view covers (the clear fence). */
	readonly throughCount: number;
	readonly logStatus: TerminalDiagnosticsLogStatus;
	readonly logFailure?: TerminalDiagnosticsLogFailure;
	/** True while an unacknowledged persistence failure is part of this warning. */
	readonly failureNotice: boolean;
}

/** Short fixed phrase for a persistence failure (never a path or payload). */
export function terminalDiagnosticsFailurePhrase(failure: TerminalDiagnosticsLogFailure | undefined): string {
	switch (failure) {
		case "agent-dir-unavailable": return "log unavailable";
		case "unsafe-state-dir": return "unsafe log directory";
		case "unsafe-log-path": return "unsafe log file";
		case "unrecognized-log-file": return "unknown file at log path";
		case "open-failed": return "log open failed";
		case "write-failed": return "log write failed";
		case "sync-failed": return "log sync failed";
		case "rotate-failed": return "log rotation failed";
		default: return "log not saved";
	}
}

/**
 * Host-owned clearable warning state. Clearing is fenced by the cumulative
 * count the user actually saw, so a newer error still re-warns; clearing never
 * touches the persisted log.
 */
export class TerminalDiagnosticsWarning {
	private total = 0;
	private cleared = 0;
	private logStatus: TerminalDiagnosticsLogStatus;
	private logFailure?: TerminalDiagnosticsLogFailure;
	private failureAcknowledged = true;

	constructor(initialLogStatus: TerminalDiagnosticsLogStatus = "ok", failure?: TerminalDiagnosticsLogFailure) {
		this.logStatus = initialLogStatus;
		this.logFailure = failure;
	}

	/** Record warning-relevant events; returns true when the visible view changed. */
	note(count: number): boolean {
		if (!Number.isSafeInteger(count) || count <= 0) return false;
		this.total = Math.min(Number.MAX_SAFE_INTEGER, this.total + count);
		return true;
	}

	/** Record a persistence transition; a new failure becomes part of the warning. */
	setLogStatus(status: TerminalDiagnosticsLogStatus, failure?: TerminalDiagnosticsLogFailure): boolean {
		if (status === this.logStatus && failure === this.logFailure) return false;
		this.logStatus = status;
		this.logFailure = status === "ok" ? undefined : failure;
		if (status === "failed") this.failureAcknowledged = false;
		return true;
	}

	/** Current warning, or undefined when nothing needs showing. */
	view(): TerminalDiagnosticsWarningView | undefined {
		const count = this.total - this.cleared;
		const failureNotice = this.logStatus === "failed" && !this.failureAcknowledged;
		if (count <= 0 && !failureNotice) return undefined;
		return {
			count,
			throughCount: this.total,
			logStatus: this.logStatus,
			...(this.logFailure === undefined ? {} : { logFailure: this.logFailure }),
			failureNotice,
		};
	}

	/**
	 * Clear what the user saw: events up to `throughCount`, and the persistence
	 * failure only when it was displayed. Returns true when the view changed.
	 */
	clear(throughCount: number, failureShown: boolean): boolean {
		const before = JSON.stringify(this.view() ?? null);
		if (Number.isSafeInteger(throughCount) && throughCount > this.cleared) {
			this.cleared = Math.min(throughCount, this.total);
		}
		if (failureShown && this.logStatus === "failed") this.failureAcknowledged = true;
		return JSON.stringify(this.view() ?? null) !== before;
	}
}

/** Fixed header notice text for an active warning. */
export function terminalDiagnosticsHeaderNotice(view: TerminalDiagnosticsWarningView | undefined): string | undefined {
	if (view === undefined) return undefined;
	const saved = view.logStatus === "ok" ? "" : `; ${terminalDiagnosticsFailurePhrase(view.logFailure)}`;
	const count = view.count > 0 ? `: ${view.count > 9999 ? "9999+" : view.count}` : "";
	return `! Terminal diagnostics${count}${saved} (clear in sidebar)`;
}
