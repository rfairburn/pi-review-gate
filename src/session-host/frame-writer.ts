import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";
import { visibleWidth } from "pi-session-host-tui";
import type { ComposedHostFrame } from "./compositor";

const MAX_DIMENSION = 1000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_REDRAW_INTERVAL_MS = 1000 / 30;
const MAX_REDRAW_INTERVAL_MS = 1000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 250;
const MAX_CLEANUP_TIMEOUT_MS = 5000;
const MAX_SGR_BYTES = 256;
const OUTPUT_ERROR_MESSAGE = "Session host frame output failed";
const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[0m\x1b[?25l";
const LEAVE_ALT_SCREEN = "\x1b[0m\x1b[?25h\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const ERASE_ROW = "\x1b[2K";
const TEXT_CHUNK_CODE_UNITS = 4096;

/**
 * Options for the generated-frame-only outer terminal writer.
 *
 * `redrawIntervalMs` is a maximum redraw frequency (default ~30 fps; zero
 * disables rate limiting). `maxFrameBytes` caps the complete serialized frame
 * in UTF-8 bytes (default 8 MiB). `cleanupTimeoutMs` bounds the final cleanup
 * write/callback/drain wait (default 250 ms). None of these options configures
 * stdin, raw mode, terminal input protocols, child processes, or native TUI
 * internals.
 */
export interface SessionHostFrameWriterOptions {
	readonly redrawIntervalMs?: number;
	readonly maxFrameBytes?: number;
	readonly cleanupTimeoutMs?: number;
	/** Receives one generic, non-sensitive error at most; callback throws are ignored. */
	readonly onError?: (error: Error) => void;
}

/**
 * Small structural API for an output-only custom session-host surface.
 *
 * Call `start()` once before submitting. `submit()` consumes only a composed
 * frame and its outer geometry; it emits generated CUP/erase/reset/SGR/cursor
 * sequences and sanitized frame text. A false Writable `write()` result pauses
 * new frames until `drain`; while paused, only the newest bounded frame is
 * retained. Call `close()` to cancel pending redraws and attempt reset, cursor
 * show, and alternate-screen exit. Its boolean is true only if that final
 * cleanup write was accepted and its callback (and any required `drain`) was
 * observed before the deadline; it does not prove physical terminal state. If
 * the deadline expires while owned writes remain outstanding, only this
 * writer's error/close guards remain attached until their callbacks/error
 * delivery settle or the Writable closes; the close promise is not extended
 * and caller listeners are untouched.
 *
 * Construction is inert. `start()` is idempotent while active; start/submit
 * after closing or closing before start behave as documented by throwing for
 * start/submit and resolving close without output. Output errors are reported
 * through `onError` once and never include stream diagnostics or frame text.
 * The injected Writable is never ended or destroyed.
 */
export interface SessionHostFrameWriter {
	start(): void;
	submit(frame: ComposedHostFrame, cols: number, rows: number): void;
	close(): Promise<boolean>;
}

/** Create an inert frame writer; no output, timers, or listeners are created yet. */
export function createSessionHostFrameWriter(
	output: Writable,
	options: SessionHostFrameWriterOptions = {},
): SessionHostFrameWriter {
	const redrawIntervalMs = boundedOption(
		options.redrawIntervalMs,
		DEFAULT_REDRAW_INTERVAL_MS,
		0,
		MAX_REDRAW_INTERVAL_MS,
		"redrawIntervalMs",
	);
	const maxFrameBytes = boundedOption(
		options.maxFrameBytes,
		DEFAULT_MAX_FRAME_BYTES,
		1,
		MAX_FRAME_BYTES,
		"maxFrameBytes",
	);
	const cleanupTimeoutMs = boundedOption(
		options.cleanupTimeoutMs,
		DEFAULT_CLEANUP_TIMEOUT_MS,
		1,
		MAX_CLEANUP_TIMEOUT_MS,
		"cleanupTimeoutMs",
	);
	if (!Number.isSafeInteger(maxFrameBytes)) {
		throw new RangeError("Session host frame writer maxFrameBytes must be a safe integer");
	}

	let started = false;
	let closing = false;
	let closed = false;
	let failed = false;
	let errorReported = false;
	let blocked = false;
	let pending: Buffer | undefined;
	let redrawTimer: ReturnType<typeof setTimeout> | undefined;
	let lastFrameAt: number | undefined;
	let closePromise: Promise<boolean> | undefined;
	let finishClose: ((flushed: boolean) => void) | undefined;
	let cleanupAttempted = false;
	let cleanupAccepted = false;
	let cleanupNeedsDrain = false;
	let cleanupDrainObserved = false;
	let cleanupCallbackSucceeded = false;
	let cleanupFailed = false;
	let cleanupSettled = false;
	let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
	let outstandingOwnedWrites = 0;
	let pendingWriteErrorEvents = 0;
	let errorListenerAttached = false;
	let closeListenerAttached = false;
	let streamClosed = false;
	let streamErrorObserved = false;

	const onDrain = (): void => {
		if (closing) {
			cleanupDrainObserved = true;
			maybeFinishCleanup();
			return;
		}
		if (blocked) {
			blocked = false;
			schedulePump();
		}
	};
	const onError = (_error: Error): void => {
		// One Writable error may cover several failed buffered write callbacks,
		// including callbacks that Node delivers after this event.
		streamErrorObserved = true;
		pendingWriteErrorEvents = 0;
		recordOutputFailure();
		maybeDetachTerminalListeners();
	};
	const onClose = (): void => {
		streamClosed = true;
		recordOutputFailure();
		if (closing && !cleanupSettled) finishCleanup(false);
		else maybeDetachTerminalListeners();
	};

	function clearRedrawTimer(): void {
		if (redrawTimer !== undefined) {
			clearTimeout(redrawTimer);
			redrawTimer = undefined;
		}
	}

	function recordOutputFailure(): void {
		failed = true;
		pending = undefined;
		clearRedrawTimer();
		if (closing && cleanupAttempted) cleanupFailed = true;
		if (errorReported) return;
		errorReported = true;
		try {
			options.onError?.(new Error(OUTPUT_ERROR_MESSAGE));
		} catch {
			// Error reporting is deliberately isolated from stream lifecycle events.
		}
	}

	function attachListeners(): void {
		output.on("drain", onDrain);
		output.on("error", onError);
		output.on("close", onClose);
		errorListenerAttached = true;
		closeListenerAttached = true;
	}

	function detachListeners(): void {
		output.removeListener("drain", onDrain);
		maybeDetachTerminalListeners();
	}

	function maybeDetachTerminalListeners(): void {
		if (!closed) return;
		if (streamClosed || (outstandingOwnedWrites === 0 && pendingWriteErrorEvents === 0)) {
			if (errorListenerAttached) {
				output.removeListener("error", onError);
				errorListenerAttached = false;
			}
			if (closeListenerAttached) {
				output.removeListener("close", onClose);
				closeListenerAttached = false;
			}
		}
	}

	function beginOwnedWrite(onComplete?: (error?: Error | null) => void): {
		readonly callback: (error?: Error | null) => void;
		cancel(): void;
	} {
		outstandingOwnedWrites += 1;
		let callbackCalled = false;
		const cancel = (): void => {
			if (callbackCalled) return;
			callbackCalled = true;
			outstandingOwnedWrites -= 1;
			maybeDetachTerminalListeners();
		};
		const callback = (error?: Error | null): void => {
			if (callbackCalled) return;
			callbackCalled = true;
			if (error && !streamErrorObserved) pendingWriteErrorEvents += 1;
			outstandingOwnedWrites -= 1;
			if (error) recordOutputFailure();
			try {
				onComplete?.(error);
			} catch {
				// Writable callbacks must not leak errors back into Node's stream machinery.
				recordOutputFailure();
			}
			// A failed callback does not prove that Node has delivered the error:
			// asynchronous Writable._destroy may defer it. Keep the guard until an
			// actual error or close event settles the stream lifecycle.
			maybeDetachTerminalListeners();
		};
		return { callback, cancel };
	}

	function writeFrame(payload: Buffer): boolean | undefined {
		let accepted: boolean;
		const write = beginOwnedWrite();
		try {
			accepted = output.write(payload, write.callback);
		} catch {
			write.cancel();
			recordOutputFailure();
			return undefined;
		}
		if (!failed && !closing && !accepted) blocked = true;
		return accepted;
	}

	function pump(): void {
		if (!started || closing || closed || failed || blocked || pending === undefined) return;
		const payload = pending;
		pending = undefined;
		lastFrameAt = Date.now();
		writeFrame(payload);
	}

	function schedulePump(): void {
		if (!started || closing || closed || failed || blocked || pending === undefined || redrawTimer !== undefined) return;
		if (redrawIntervalMs === 0 || lastFrameAt === undefined) {
			pump();
			return;
		}
		const delay = Math.max(0, lastFrameAt + redrawIntervalMs - Date.now());
		if (delay === 0) {
			pump();
			return;
		}
		redrawTimer = setTimeout(() => {
			redrawTimer = undefined;
			pump();
		}, delay);
	}

	function maybeFinishCleanup(): void {
		if (cleanupSettled || !cleanupAttempted || !cleanupAccepted || !cleanupCallbackSucceeded) return;
		if (cleanupNeedsDrain && !cleanupDrainObserved) return;
		finishCleanup(!cleanupFailed);
	}

	function finishCleanup(flushed: boolean): void {
		if (cleanupSettled) return;
		cleanupSettled = true;
		closed = true;
		clearRedrawTimer();
		if (cleanupTimer !== undefined) {
			clearTimeout(cleanupTimer);
			cleanupTimer = undefined;
		}
		detachListeners();
		finishClose?.(flushed && !cleanupFailed);
		finishClose = undefined;
	}

	function writeCleanup(): void {
		cleanupAttempted = true;
		cleanupDrainObserved = false;
		let accepted: boolean;
		const write = beginOwnedWrite((error) => {
			if (error) {
				cleanupFailed = true;
			} else {
				cleanupCallbackSucceeded = true;
			}
			maybeFinishCleanup();
		});
		try {
			accepted = output.write(Buffer.from(LEAVE_ALT_SCREEN, "ascii"), write.callback);
		} catch {
			write.cancel();
			cleanupFailed = true;
			recordOutputFailure();
			finishCleanup(false);
			return;
		}
		cleanupAccepted = true;
		cleanupNeedsDrain = !accepted;
		if (!accepted) blocked = true;
		maybeFinishCleanup();
	}

	return {
		start(): void {
			if (closing || closed) throw new Error("Session host frame writer is closed");
			if (started) return;
			started = true;
			attachListeners();
			writeFrame(Buffer.from(ENTER_ALT_SCREEN, "ascii"));
		},

		submit(frame: ComposedHostFrame, cols: number, rows: number): void {
			if (!started) throw new Error("Session host frame writer has not started");
			if (closing || closed) throw new Error("Session host frame writer is closed");
			if (failed) throw new Error("Session host frame output is unavailable");
			validateGeometry(cols, rows);
			if (!frame || !Array.isArray(frame.lines)) {
				throw new TypeError("Composed host frame must contain a lines array");
			}
			const payload = serializeFrame(frame, cols, rows, maxFrameBytes);
			pending = payload;
			schedulePump();
		},

		close(): Promise<boolean> {
			if (closePromise) return closePromise;
			closing = true;
			clearRedrawTimer();
			pending = undefined;
			closePromise = new Promise<boolean>((resolve) => {
				finishClose = resolve;
			});
			if (!started) {
				finishCleanup(true);
				return closePromise;
			}
			cleanupTimer = setTimeout(() => finishCleanup(false), cleanupTimeoutMs);
			writeCleanup();
			return closePromise;
		},
	};
}

function boundedOption(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	label: string,
): number {
	const result = value ?? fallback;
	if (!Number.isFinite(result) || result < minimum || result > maximum) {
		throw new RangeError(`Session host frame writer ${label} must be between ${minimum} and ${maximum}`);
	}
	return result;
}

function validateGeometry(cols: number, rows: number): void {
	if (!Number.isSafeInteger(cols) || cols < 1 || cols > MAX_DIMENSION) {
		throw new RangeError(`Session host frame cols must be a safe integer from 1 to ${MAX_DIMENSION}`);
	}
	if (!Number.isSafeInteger(rows) || rows < 1 || rows > MAX_DIMENSION) {
		throw new RangeError(`Session host frame rows must be a safe integer from 1 to ${MAX_DIMENSION}`);
	}
}

class BoundedFrameBuilder {
	private readonly buffers: Buffer[] = [];
	private readonly textParts: string[] = [];
	private textCodeUnits = 0;
	private byteLength = 0;

	constructor(private readonly byteLimit: number) {}

	append(text: string): void {
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes > this.byteLimit - this.byteLength) {
			throw new RangeError("Serialized host frame exceeds its UTF-8 byte limit");
		}
		this.byteLength += bytes;
		if (text.length === 0) return;
		this.textParts.push(text);
		this.textCodeUnits += text.length;
		if (this.textCodeUnits >= TEXT_CHUNK_CODE_UNITS) this.flushText();
	}

	finish(): Buffer {
		this.flushText();
		return Buffer.concat(this.buffers, this.byteLength);
	}

	private flushText(): void {
		if (this.textCodeUnits === 0) return;
		this.buffers.push(Buffer.from(this.textParts.join(""), "utf8"));
		this.textParts.length = 0;
		this.textCodeUnits = 0;
	}
}

function serializeFrame(frame: ComposedHostFrame, cols: number, rows: number, maxFrameBytes: number): Buffer {
	const builder = new BoundedFrameBuilder(maxFrameBytes);
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const cursor = validCursor(frame.cursor, cols, rows);

	builder.append(HIDE_CURSOR);
	for (let row = 0; row < rows; row += 1) {
		builder.append(`\x1b[${row + 1};1H${RESET}${ERASE_ROW}`);
		const source = typeof frame.lines[row] === "string" ? frame.lines[row] : "";
		appendSafeClippedLine(builder, source, cols, segmenter);
		builder.append(RESET);
	}
	if (cursor) {
		builder.append(`${SHOW_CURSOR}\x1b[${cursor.row + 1};${cursor.column + 1}H`);
	} else {
		builder.append(HIDE_CURSOR);
	}
	return builder.finish();
}

function validCursor(
	cursor: ComposedHostFrame["cursor"] | undefined,
	cols: number,
	rows: number,
): { readonly column: number; readonly row: number } | undefined {
	if (!cursor || cursor.visible !== true) return undefined;
	if (!Number.isSafeInteger(cursor.column) || !Number.isSafeInteger(cursor.row)) return undefined;
	if (cursor.column < 0 || cursor.column >= cols || cursor.row < 0 || cursor.row >= rows) return undefined;
	return { column: cursor.column, row: cursor.row };
}

function appendSafeClippedLine(
	builder: BoundedFrameBuilder,
	source: string,
	cols: number,
	segmenter: Intl.Segmenter,
): void {
	const segments = segmenter.segment(source)[Symbol.iterator]();
	let segment = segments.next();
	let index = 0;
	let cells = 0;

	while (index < source.length && cells <= cols) {
		const code = source.codePointAt(index) ?? 0;
		const codeUnits = code > 0xffff ? 2 : 1;
		if (code === 0x1b) {
			const escaped = consumeEscape(source, index);
			if (escaped.sgr !== undefined && cells < cols) builder.append(escaped.sgr);
			index = escaped.end;
			while (!segment.done && segment.value.index < index) segment = segments.next();
			continue;
		}
		if (code === 0x9b) {
			index = consumeCsi(source, index + codeUnits);
			while (!segment.done && segment.value.index < index) segment = segments.next();
			continue;
		}
		if (isStringControl(code)) {
			index = consumeStringControl(source, index + codeUnits, code === 0x9d);
			while (!segment.done && segment.value.index < index) segment = segments.next();
			continue;
		}
		if (isControl(code) || code === 0x2028 || code === 0x2029 || isSurrogate(code)) {
			index += codeUnits;
			while (!segment.done && segment.value.index < index) segment = segments.next();
			continue;
		}

		while (!segment.done && segment.value.index < index) segment = segments.next();
		if (segment.done) break;
		if (segment.value.index > index) index = segment.value.index;
		const grapheme = segment.value.segment;
		const end = segment.value.index + grapheme.length;
		if (!isSafeGrapheme(grapheme)) {
			index = end;
			segment = segments.next();
			continue;
		}
		const width = visibleWidth(grapheme);
		if (!Number.isSafeInteger(width) || width < 0) {
			index = end;
			segment = segments.next();
			continue;
		}
		if (cells + width > cols) break;
		builder.append(grapheme);
		cells += width;
		index = end;
		segment = segments.next();
	}
}

function consumeEscape(source: string, index: number): { end: number; sgr?: string } {
	const next = source.charCodeAt(index + 1);
	if (next === 0x5b) {
		const parsed = consumeCsiWithSgr(source, index + 2, index);
		return parsed;
	}
	if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f || next === 0x58) {
		return { end: consumeStringControl(source, index + 2, next === 0x5d) };
	}
	return { end: index + 1 };
}

function consumeCsi(source: string, index: number): number {
	let cursor = index;
	while (cursor < source.length) {
		const code = source.codePointAt(cursor) ?? 0;
		cursor += code > 0xffff ? 2 : 1;
		if (code >= 0x40 && code <= 0x7e) return cursor;
	}
	return source.length;
}

function consumeCsiWithSgr(source: string, bodyStart: number, escapeStart: number): { end: number; sgr?: string } {
	let cursor = bodyStart;
	let allowedParams = true;
	while (cursor < source.length) {
		const code = source.codePointAt(cursor) ?? 0;
		if (code >= 0x40 && code <= 0x7e) {
			const end = cursor + (code > 0xffff ? 2 : 1);
			if (code === 0x6d && allowedParams && end - escapeStart <= MAX_SGR_BYTES) {
				return { end, sgr: source.slice(escapeStart, end) };
			}
			return { end };
		}
		if (!((code >= 0x30 && code <= 0x39) || code === 0x3b)) allowedParams = false;
		cursor += code > 0xffff ? 2 : 1;
	}
	return { end: source.length };
}

function consumeStringControl(source: string, start: number, bellTerminates: boolean): number {
	let cursor = start;
	while (cursor < source.length) {
		const code = source.codePointAt(cursor) ?? 0;
		if ((bellTerminates && code === 0x07) || code === 0x9c) return cursor + (code > 0xffff ? 2 : 1);
		if (code === 0x1b && source[cursor + 1] === "\\") return cursor + 2;
		cursor += code > 0xffff ? 2 : 1;
	}
	return source.length;
}

function isStringControl(code: number): boolean {
	return code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f;
}

function isControl(code: number): boolean {
	return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function isSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdfff;
}

function isSafeGrapheme(text: string): boolean {
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (isControl(code) || code === 0x2028 || code === 0x2029 || isSurrogate(code)) return false;
	}
	return true;
}
