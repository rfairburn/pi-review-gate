import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import { visibleWidth } from "pi-session-host-tui";
import type { ComposedHostFrame, HostPaneRect } from "./compositor";
import { fallbackHostGraphics, type HostGraphicsLayer } from "./graphics-output";
import type { TerminalGraphicsImage, TerminalGraphicsPlacement } from "./kitty-graphics";

const MAX_DIMENSION = 1000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_REDRAW_INTERVAL_MS = 16;
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
 * `redrawIntervalMs` is the minimum redraw interval (default 16 ms, about
 * 60 fps, matching Pi's native minimum redraw cadence; zero disables rate
 * limiting). `maxFrameBytes` caps the complete serialized frame
 * in UTF-8 bytes (default 8 MiB). `cleanupTimeoutMs` bounds the final cleanup
 * write/callback/drain wait (default 250 ms). None of these options configures
 * stdin, raw mode, terminal input protocols, child processes, or native TUI
 * internals.
 */
export interface SessionHostFrameWriterOptions {
	readonly redrawIntervalMs?: number;
	readonly maxFrameBytes?: number;
	readonly cleanupTimeoutMs?: number;
	/** True only for Main's positively identified direct Ghostty output path. */
	readonly graphicsEnabled?: boolean;
	/** Receives one generic, non-sensitive error at most; callback throws are ignored. */
	readonly onError?: (error: Error) => void;
}

/** Result of settling one submitted frame against the Writable output. */
export type SessionHostFrameDisposition = "written" | "unchanged";

/**
 * Small structural API for an output-only custom session-host surface.
 *
 * Call `start()` once before submitting. `submit()` consumes only a composed
 * frame and its outer geometry; it synchronously sanitizes and clips every row
 * and validates the complete serialized frame against the byte bound (an
 * oversized frame throws even when its delta would be small), then retains an
 * immutable snapshot of the row bytes, cursor, and geometry — never a caller
 * reference. At the next allowed redraw only rows that changed since the last
 * frame actually written to the Writable are emitted as generated
 * CUP/erase/reset/SGR sequences plus full sanitized row text: the first frame
 * after start, any geometry change, and any explicit `invalidate()` emit a
 * full redraw, cursor-only changes emit only the cursor sequence, and
 * unchanged rows/cursor skip output entirely. Every nonempty diff masks the
 * cursor before drawing. The written-frame baseline advances when a
 * nonthrowing `write()` invocation accepts a payload (a false return is queued
 * until drain, not a failure), but only one frame write may be in flight: it
 * is considered written only after its callback succeeds and, when `write()`
 * returned false, after `drain` is observed. While a frame is in flight or the
 * sink is backpressured, only the newest bounded candidate is retained.
 * Memory holds at most one pending candidate plus one written snapshot, each
 * bounded by `maxFrameBytes`.
 * `invalidate()` discards the known baseline so the next emitted frame is a
 * complete redraw: it keeps the newest pending candidate, allocates no queue,
 * and a blocked sink still repaints fully once its queued write drains. An
 * optional submit callback settles when that exact candidate completes
 * (successful write callback and, when required, `drain`; or when it is
 * confirmed unchanged). Callback and drain may arrive in either order. This is
 * a Writable completion boundary, not proof of physical terminal display. Call
 * `close()` to cancel pending redraws and attempt reset, cursor show, and
 * alternate-screen exit. Its boolean is true only if that final
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
	submit(
		frame: ComposedHostFrame,
		cols: number,
		rows: number,
		onSettled?: (disposition: SessionHostFrameDisposition) => void,
	): void;
	/**
	 * Discard the written-frame baseline so the next emitted frame is a
	 * complete redraw. Bounded and explicit: the newest pending candidate is
	 * preserved, no queue is allocated, and a blocked sink still repaints
	 * fully once it drains. Used when the outer terminal may have reflowed
	 * physically (for example an actual resize notification) even though the
	 * submitted content and geometry are unchanged.
	 */
	invalidate(): void;
	close(): Promise<boolean>;
}

/** One retained frame: immutable sanitized row content plus validated cursor/geometry. */
interface FrameCandidate {
	readonly cols: number;
	readonly rows: number;
	readonly rowTexts: readonly string[];
	/** Display-cell width of each sanitized row (cursor resting position). */
	readonly rowWidths: readonly number[];
	readonly cursor: { readonly column: number; readonly row: number } | undefined;
	readonly graphics?: ValidatedGraphicsPlan;
}

interface ValidatedGraphicsImage {
	readonly generationKey: string;
	readonly sourceId: string;
	readonly base64: string;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface ValidatedGraphicsPlacement {
	readonly generationKey: string;
	readonly sourceId: string;
	readonly imageGenerationKey: string;
	readonly column: number;
	readonly row: number;
	readonly columns: number;
	readonly rows: number;
	readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

interface ValidatedGraphicsPlan {
	readonly ownerId: string;
	readonly pane: HostPaneRect;
	readonly signature: string;
	readonly images: readonly ValidatedGraphicsImage[];
	readonly placements: readonly ValidatedGraphicsPlacement[];
}

interface OwnedGraphicsPlan extends ValidatedGraphicsPlan {
	readonly images: readonly (ValidatedGraphicsImage & { readonly outputId: number })[];
	readonly placements: readonly (ValidatedGraphicsPlacement & { readonly outputId: number })[];
}

interface PendingFrame {
	readonly candidate: FrameCandidate;
	readonly onSettled?: (disposition: SessionHostFrameDisposition) => void;
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
	const graphicsEnabled = options.graphicsEnabled === true;
	if (!Number.isSafeInteger(maxFrameBytes)) {
		throw new RangeError("Session host frame writer maxFrameBytes must be a safe integer");
	}

	let started = false;
	let closing = false;
	let closed = false;
	let failed = false;
	let errorReported = false;
	let blocked = false;
	let frameInFlight = false;
	let pending: PendingFrame | undefined;
	let blockedSettlement: (() => void) | undefined;
	let baseline: FrameCandidate | undefined;
	// Kept independently from the text baseline: invalidate() must preserve
	// sent image ownership until a targeted delete has actually been queued.
	let activeGraphics: OwnedGraphicsPlan | undefined;
	// Include both sides of an in-flight replacement until its callback/drain
	// proves success, so a concurrent close can target every possibly-sent ID.
	let possiblyOwnedImageIds = new Set<number>();
	let forceGraphicsRepaint = false;
	let nextGraphicsImageId = 1;
	let nextGraphicsPlacementId = 1;
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
	let drainSequence = 0;

	const onDrain = (): void => {
		drainSequence += 1;
		if (closing) {
			cleanupDrainObserved = true;
			maybeFinishCleanup();
			return;
		}
		if (blocked) {
			blocked = false;
			const settle = blockedSettlement;
			blockedSettlement = undefined;
			settle?.();
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
		frameInFlight = false;
		pending = undefined;
		blockedSettlement = undefined;
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

	function writeFrame(
		payload: Buffer,
		onComplete?: (error?: Error | null) => void,
	): boolean | undefined {
		let accepted: boolean;
		const write = beginOwnedWrite(onComplete);
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

	function notifySettled(
		submission: PendingFrame,
		disposition: SessionHostFrameDisposition,
	): void {
		try {
			submission.onSettled?.(disposition);
		} catch {
			// Presentation bookkeeping is isolated from output and stream lifecycle.
		}
	}

	function pump(): void {
		if (!started || closing || closed || failed || blocked || frameInFlight || pending === undefined) return;
		const submission = pending;
		pending = undefined;
		const candidate = submission.candidate;
		const textPayload = baseline === undefined
			|| baseline.cols !== candidate.cols
			|| baseline.rows !== candidate.rows
			? buildFullFramePayload(candidate, maxFrameBytes)
			: buildDiffPayload(baseline, candidate, maxFrameBytes);
		const graphicsChanged = forceGraphicsRepaint
			|| activeGraphics?.signature !== candidate.graphics?.signature;
		let nextGraphics = activeGraphics;
		let graphicsBefore: Buffer = Buffer.alloc(0);
		let graphicsAfter: Buffer = Buffer.alloc(0);
		if (graphicsChanged) {
			graphicsBefore = buildGraphicsDeletes(activeGraphics);
			const owned = ownGraphicsPlan(candidate.graphics, activeGraphics, nextGraphicsImageId, nextGraphicsPlacementId);
			nextGraphics = owned.plan;
			nextGraphicsImageId = owned.nextImageId;
			nextGraphicsPlacementId = owned.nextPlacementId;
			graphicsAfter = buildGraphicsRender(nextGraphics, candidate.cursor);
		}
		const payload = combinePayload([graphicsBefore, textPayload ?? Buffer.alloc(0), graphicsAfter], maxFrameBytes);
		if (!payload) {
			// A targeted delete is independently bounded. If the text diff plus
			// that small cleanup envelope alone exceeds the configured frame cap,
			// delete first and retry the newest text candidate after its existing
			// callback/drain fence rather than rejecting valid text.
			if (graphicsChanged && activeGraphics !== undefined && candidate.graphics === undefined
				&& graphicsBefore.length > 0) {
				frameInFlight = true;
				let accepted: boolean | undefined;
				let callbackSucceeded = false;
				let drainObserved = false;
				let settled = false;
				const drainSequenceBeforeWrite = drainSequence;
				const settleDelete = (): void => {
					if (settled || failed || closing || closed || accepted === undefined || !callbackSucceeded
						|| (!accepted && !drainObserved)) return;
					settled = true;
					activeGraphics = undefined;
					possiblyOwnedImageIds = new Set();
					forceGraphicsRepaint = false;
					frameInFlight = false;
					if (pending === undefined) pending = submission;
					schedulePump();
				};
				accepted = writeFrame(graphicsBefore, (error) => {
					if (!error) callbackSucceeded = true;
					settleDelete();
				});
				if (accepted !== undefined && !failed && !closing && !closed) {
					if (!accepted) {
						if (drainSequence !== drainSequenceBeforeWrite) {
							drainObserved = true;
							blocked = false;
							blockedSettlement = undefined;
						}
						if (!drainObserved) {
							blockedSettlement = () => {
								drainObserved = true;
								settleDelete();
							};
						}
					}
				} else {
					frameInFlight = false;
					return;
				}
				settleDelete();
				return;
			}
			// submit() budgets a conservative full redraw plus graphics payload;
			// an unexpected renderer-sizing mismatch must not emit an unbounded
			// buffer or silently continue with a partial image protocol command.
			recordOutputFailure();
			notifySettled(submission, "unchanged");
			return;
		}
		if (payload.length === 0) {
			if (graphicsChanged) {
				activeGraphics = nextGraphics;
				possiblyOwnedImageIds = graphicsImageIds(nextGraphics);
				forceGraphicsRepaint = false;
			}
			notifySettled(submission, "unchanged");
			return; // rows, cursor, and visible graphics are unchanged
		}
		lastFrameAt = Date.now();
		frameInFlight = true;
		let accepted: boolean | undefined;
		let callbackSucceeded = false;
		let drainObserved = false;
		let settled = false;
		const drainSequenceBeforeWrite = drainSequence;
		const settleWritten = (): void => {
			if (settled || failed || closing || closed || accepted === undefined || !callbackSucceeded
				|| (!accepted && !drainObserved)) return;
			settled = true;
			if (graphicsChanged) possiblyOwnedImageIds = graphicsImageIds(nextGraphics);
			frameInFlight = false;
			notifySettled(submission, "written");
			schedulePump();
		};
		if (graphicsChanged && nextGraphics) {
			for (const image of nextGraphics.images) possiblyOwnedImageIds.add(image.outputId);
		}
		accepted = writeFrame(payload, (error) => {
			if (!error) callbackSucceeded = true;
			settleWritten();
		});
		// The baseline and image ownership advance only when write() accepted the
		// complete bounded payload. Callback and drain still fence every newer
		// candidate, so cleanup can never overtake an in-flight image transfer.
		if (accepted !== undefined && !failed && !closing && !closed) {
			baseline = candidate;
			if (graphicsChanged) {
				activeGraphics = nextGraphics;
				forceGraphicsRepaint = false;
			}
			if (!accepted) {
				if (drainSequence !== drainSequenceBeforeWrite) {
					drainObserved = true;
					blocked = false;
					blockedSettlement = undefined;
				}
				if (!drainObserved) {
					blockedSettlement = () => {
						drainObserved = true;
						settleWritten();
					};
				}
			}
		} else {
			frameInFlight = false;
			return;
		}
		// Covers successful synchronous callbacks after the accepted result is known.
		settleWritten();
	}

	function schedulePump(): void {
		if (!started || closing || closed || failed || blocked || frameInFlight
			|| pending === undefined || redrawTimer !== undefined) return;
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
		baseline = undefined;
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
			const graphicsCleanup = buildGraphicsDeletesForIds(possiblyOwnedImageIds);
			const cleanupPayload = Buffer.concat([
				graphicsCleanup,
				Buffer.from(LEAVE_ALT_SCREEN, "ascii"),
			]);
			accepted = output.write(cleanupPayload, write.callback);
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
			baseline = undefined; // alternate-screen entry: prior screen state unknown
			attachListeners();
			frameInFlight = true;
			let accepted: boolean | undefined;
			let callbackSucceeded = false;
			let drainObserved = false;
			let settled = false;
			const drainSequenceBeforeWrite = drainSequence;
			const settleStart = (): void => {
				if (settled || failed || closing || closed || accepted === undefined || !callbackSucceeded
					|| (!accepted && !drainObserved)) return;
				settled = true;
				frameInFlight = false;
				schedulePump();
			};
			accepted = writeFrame(Buffer.from(ENTER_ALT_SCREEN, "ascii"), (error) => {
				if (!error) callbackSucceeded = true;
				settleStart();
			});
			if (accepted !== undefined && !failed && !closing && !closed) {
				if (!accepted) {
					if (drainSequence !== drainSequenceBeforeWrite) {
						drainObserved = true;
						blocked = false;
						blockedSettlement = undefined;
					}
					if (!drainObserved) {
						blockedSettlement = () => {
							drainObserved = true;
							settleStart();
						};
					}
				}
			} else {
				frameInFlight = false;
				return;
			}
			settleStart();
		},

		submit(
			frame: ComposedHostFrame,
			cols: number,
			rows: number,
			onSettled?: (disposition: SessionHostFrameDisposition) => void,
		): void {
			if (!started) throw new Error("Session host frame writer has not started");
			if (closing || closed) throw new Error("Session host frame writer is closed");
			if (failed) throw new Error("Session host frame output is unavailable");
			validateGeometry(cols, rows);
			if (!frame || !Array.isArray(frame.lines)) {
				throw new TypeError("Composed host frame must contain a lines array");
			}
			const cursor = validCursor(frame.cursor, cols, rows);
			let graphics = graphicsEnabled && frame.graphics
				? prepareGraphicsPlan(frame.graphics, cols, rows)
				: undefined;
			let effectiveFrame = frame;
			if (frame.graphics) {
				effectiveFrame = graphics
					? fallbackHostGraphics(frame, cols, rows, {
						excludePlacementIds: new Set(graphics.placements.map((placement) => placement.sourceId)),
						preserveGraphics: true,
					})
					: fallbackHostGraphics(frame, cols, rows);
			}
			let candidate: FrameCandidate;
			try {
				candidate = serializeCandidate(effectiveFrame, cols, rows, cursor, graphics, maxFrameBytes);
			} catch (error) {
				if (!frame.graphics) throw error;
				graphics = undefined;
				try {
					candidate = serializeCandidate(fallbackHostGraphics(frame, cols, rows), cols, rows, cursor, undefined, maxFrameBytes);
				} catch {
					// Fallback text must not make an otherwise valid text frame fail.
					const { graphics: _graphics, ...plainFrame } = frame;
					void _graphics;
					candidate = serializeCandidate(plainFrame, cols, rows, cursor, undefined, maxFrameBytes);
				}
			}
			if (graphics && graphicsWouldExceedBudget(
				candidate,
				graphics,
				activeGraphics,
				nextGraphicsImageId,
				nextGraphicsPlacementId,
				maxFrameBytes,
			)) {
				graphics = undefined;
				try {
					candidate = serializeCandidate(fallbackHostGraphics(frame, cols, rows), cols, rows, cursor, undefined, maxFrameBytes);
				} catch {
					// Fallback text must not make an otherwise valid text frame fail.
					const { graphics: _graphics, ...plainFrame } = frame;
					void _graphics;
					candidate = serializeCandidate(plainFrame, cols, rows, cursor, undefined, maxFrameBytes);
				}
			}
			pending = { candidate, onSettled };
			schedulePump();
		},

		invalidate(): void {
			if (!started || closing || closed || failed) return;
			// Drop the known baseline immediately so the next pump emits a
			// complete frame. A retained pending candidate stays pending; a
			// blocked sink repaints fully when its queued write drains.
			baseline = undefined;
			forceGraphicsRepaint = true;
			schedulePump();
		},

		close(): Promise<boolean> {
			if (closePromise) return closePromise;
			closing = true;
			clearRedrawTimer();
			pending = undefined;
			blockedSettlement = undefined;
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

/** Sanitize and clip one row's content (the bytes between erase-row and reset). */
function serializeRowContent(
	source: string,
	cols: number,
	segmenter: Intl.Segmenter,
	byteLimit: number,
): { readonly text: string; readonly width: number } {
	const builder = new BoundedFrameBuilder(byteLimit);
	const width = appendSafeClippedLine(builder, source, cols, segmenter);
	return { text: builder.finish().toString("utf8"), width };
}

function rowEnvelopePrefix(row: number): string {
	return `\x1b[${row + 1};1H${RESET}${ERASE_ROW}`;
}

function cursorSuffix(cursor: FrameCandidate["cursor"]): string {
	if (cursor) return `${SHOW_CURSOR}\x1b[${cursor.row + 1};${cursor.column + 1}H`;
	return HIDE_CURSOR;
}

function sameCursor(a: FrameCandidate["cursor"], b: FrameCandidate["cursor"]): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.column === b.column && a.row === b.row;
}

function buildFullFramePayload(candidate: FrameCandidate, byteLimit: number): Buffer {
	const builder = new BoundedFrameBuilder(byteLimit);
	builder.append(HIDE_CURSOR);
	for (let row = 0; row < candidate.rows; row += 1) {
		builder.append(rowEnvelopePrefix(row));
		builder.append(candidate.rowTexts[row]);
		builder.append(RESET);
	}
	builder.append(cursorSuffix(candidate.cursor));
	return builder.finish();
}

/**
 * Row-differential payload: a leading cursor-hide, the changed rows, and the
 * cursor suffix. Returns undefined when rows and cursor are unchanged (skip
 * output entirely). The diff is always no larger than the complete frame
 * validated at submit time.
 */
function buildDiffPayload(
	baseline: FrameCandidate,
	candidate: FrameCandidate,
	byteLimit: number,
): Buffer | undefined {
	const builder = new BoundedFrameBuilder(byteLimit);
	// Mask the cursor before drawing exactly like a full frame, so a transient
	// hide/show or reposition during the diff is never visible. The hide prefix
	// is already part of the reserved complete-frame budget.
	builder.append(HIDE_CURSOR);
	let changedRows = 0;
	let lastRowChanged = false;
	for (let row = 0; row < candidate.rows; row += 1) {
		if (baseline.rowTexts[row] === candidate.rowTexts[row]) continue;
		builder.append(rowEnvelopePrefix(row));
		builder.append(candidate.rowTexts[row]);
		builder.append(RESET);
		changedRows += 1;
		if (row === candidate.rows - 1) lastRowChanged = true;
	}
	if (changedRows === 0 && sameCursor(baseline.cursor, candidate.cursor)) return undefined;
	// A full frame leaves the hardware cursor at the end of the last row's
	// content; restore that resting position whenever this payload does not end
	// there already — rows changed without rewriting the last row, or a
	// cursor-only change whose suffix may move nothing (hiding the cursor). The
	// resting column is clamped to the frame width so generated CUP coordinates
	// stay inside the supplied geometry even when the last row is full-width.
	if (!lastRowChanged) {
		builder.append(`\x1b[${candidate.rows};${Math.min(candidate.rowWidths[candidate.rows - 1] + 1, candidate.cols)}H`);
	}
	builder.append(cursorSuffix(candidate.cursor));
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

function serializeCandidate(
	frame: ComposedHostFrame,
	cols: number,
	rows: number,
	cursor: FrameCandidate["cursor"],
	graphics: ValidatedGraphicsPlan | undefined,
	maxFrameBytes: number,
): FrameCandidate {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	// Reserve the fixed envelope (hide prefix, per-row CUP/erase/reset,
	// cursor suffix) before retaining row content.
	let contentBudget = maxFrameBytes
		- Buffer.byteLength(HIDE_CURSOR, "utf8")
		- Buffer.byteLength(cursorSuffix(cursor), "utf8");
	for (let row = 0; row < rows; row += 1) {
		contentBudget -= Buffer.byteLength(rowEnvelopePrefix(row), "utf8") + Buffer.byteLength(RESET, "utf8");
	}
	if (contentBudget < 0) throw new RangeError("Serialized host frame exceeds its UTF-8 byte limit");
	const rowTexts: string[] = [];
	const rowWidths: number[] = [];
	for (let row = 0; row < rows; row += 1) {
		const source = typeof frame.lines[row] === "string" ? frame.lines[row] : "";
		const serialized = serializeRowContent(source, cols, segmenter, contentBudget);
		rowTexts.push(serialized.text);
		rowWidths.push(serialized.width);
		contentBudget -= Buffer.byteLength(serialized.text, "utf8");
	}
	return { cols, rows, rowTexts, rowWidths, cursor, ...(graphics ? { graphics } : {}) };
}

function graphicsWouldExceedBudget(
	candidate: FrameCandidate,
	graphics: ValidatedGraphicsPlan,
	active: OwnedGraphicsPlan | undefined,
	nextImageId: number,
	nextPlacementId: number,
	maxFrameBytes: number,
): boolean {
	// A retained candidate may be force-redrawn by invalidate() after it is
	// submitted. Always budget the complete redraw, including a scoped delete
	// and the exact generated upload/chunk/placement envelope, even when the
	// current graphics signature happens to match the written baseline.
	const owned = ownGraphicsPlan(graphics, active, nextImageId, nextPlacementId).plan;
	const cleanupBytes = buildGraphicsDeletes(active).length;
	const renderBytes = graphicsRenderByteLength(owned, candidate.cursor);
	return fullFrameByteLength(candidate) + cleanupBytes + renderBytes > maxFrameBytes;
}

function fullFrameByteLength(candidate: FrameCandidate): number {
	let bytes = Buffer.byteLength(HIDE_CURSOR, "utf8") + Buffer.byteLength(cursorSuffix(candidate.cursor), "utf8");
	for (let row = 0; row < candidate.rows; row += 1) {
		bytes += Buffer.byteLength(rowEnvelopePrefix(row), "utf8")
			+ Buffer.byteLength(candidate.rowTexts[row] ?? "", "utf8")
			+ Buffer.byteLength(RESET, "utf8");
	}
	return bytes;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_GRAPHICS_BASE64_BYTES = 4 * 1024 * 1024;
const MAX_KITTY_PAYLOAD_CHUNK_BYTES = 4096;
const MAX_GRAPHICS_TOTAL_ENCODED_BYTES = 16 * 1024 * 1024;
const MAX_GRAPHICS_TOTAL_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_GRAPHICS_TOTAL_PIXELS = 16 * 1024 * 1024;
const MAX_GRAPHICS_IMAGES = 64;
const MAX_GRAPHICS_PLACEMENTS = 256;
const MAX_GRAPHICS_DIMENSION = 8192;
const MAX_GRAPHICS_IMAGE_PIXELS = 8 * 1024 * 1024;
const MAX_KITTY_ID = 0xffffffff;

function prepareGraphicsPlan(layer: HostGraphicsLayer, cols: number, rows: number): ValidatedGraphicsPlan | undefined {
	try {
		if (!validOwner(layer.ownerId) || !validPane(layer.pane, cols, rows)
			|| !Array.isArray(layer.frame?.images) || layer.frame.images.length > MAX_GRAPHICS_IMAGES
			|| !Array.isArray(layer.frame?.placements) || layer.frame.placements.length > MAX_GRAPHICS_PLACEMENTS) return undefined;
		const images = new Map<string, ValidatedGraphicsImage>();
		let encodedBytes = 0;
		let decodedBytes = 0;
		let pixels = 0;
		for (const source of layer.frame.images) {
			const image = validateGraphicsImage(source);
			if (!image || images.has(image.sourceId)) return undefined;
			encodedBytes += image.base64.length;
			decodedBytes += Math.floor(image.base64.length * 3 / 4);
			pixels += image.widthPx * image.heightPx;
			if (encodedBytes > MAX_GRAPHICS_TOTAL_ENCODED_BYTES
				|| decodedBytes > MAX_GRAPHICS_TOTAL_DECODED_BYTES
				|| pixels > MAX_GRAPHICS_TOTAL_PIXELS) return undefined;
			const generationKey = graphicsHash(layer.ownerId, "image", image.sourceId, image.widthPx, image.heightPx, image.base64);
			images.set(image.sourceId, { ...image, generationKey });
		}
		const visibleImages = new Map<string, ValidatedGraphicsImage>();
		const placements: ValidatedGraphicsPlacement[] = [];
		const placementKeys = new Set<string>();
		for (const source of layer.frame.placements) {
			const clipped = clipGraphicsPlacement(source, layer.pane, cols, rows, images);
			if (!clipped || placementKeys.has(clipped.generationKey)) return undefined;
			placementKeys.add(clipped.generationKey);
			placements.push(clipped);
			const image = [...images.values()].find((value) => value.generationKey === clipped.imageGenerationKey);
			if (!image) return undefined;
			visibleImages.set(image.sourceId, image);
		}
		if (placements.length === 0) return undefined;
		const imageList = [...visibleImages.values()];
		const signature = JSON.stringify([
			layer.ownerId,
			layer.pane.column, layer.pane.row, layer.pane.cols, layer.pane.rows,
			imageList.map((image) => image.generationKey),
			placements.map((placement) => [
				placement.generationKey,
				placement.imageGenerationKey,
				placement.column, placement.row, placement.columns, placement.rows,
				placement.crop.x, placement.crop.y, placement.crop.width, placement.crop.height,
			]),
		]);
		return { ownerId: layer.ownerId, pane: { ...layer.pane }, signature, images: imageList, placements };
	} catch {
		return undefined;
	}
}

function validateGraphicsImage(value: TerminalGraphicsImage): Omit<ValidatedGraphicsImage, "generationKey"> | undefined {
	if (typeof value !== "object" || value === null || value.mimeType !== "image/png"
		|| !validChildGraphicsId(value.id) || typeof value.base64 !== "string"
		|| value.base64.length < 60 || value.base64.length > MAX_GRAPHICS_BASE64_BYTES
		|| value.base64.length % 4 !== 0
		|| !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)
		|| !validImageDimension(value.widthPx) || !validImageDimension(value.heightPx)
		|| value.widthPx * value.heightPx > MAX_GRAPHICS_IMAGE_PIXELS) return undefined;
	const data = Buffer.from(value.base64, "base64");
	if (data.length < 45 || data.length > 3 * 1024 * 1024
		|| data.toString("base64") !== value.base64
		|| !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
		|| data.toString("ascii", 12, 16) !== "IHDR"
		|| data.readUInt32BE(16) !== value.widthPx || data.readUInt32BE(20) !== value.heightPx) return undefined;
	return {
		sourceId: value.id,
		base64: value.base64,
		widthPx: value.widthPx,
		heightPx: value.heightPx,
	};
}

function clipGraphicsPlacement(
	value: TerminalGraphicsPlacement,
	pane: HostPaneRect,
	cols: number,
	rows: number,
	images: ReadonlyMap<string, ValidatedGraphicsImage>,
): ValidatedGraphicsPlacement | undefined {
	if (typeof value !== "object" || value === null
		|| !validChildGraphicsId(value.id) || !validChildGraphicsId(value.imageId)
		|| !Number.isSafeInteger(value.column) || Math.abs(value.column) > MAX_DIMENSION
		|| !Number.isSafeInteger(value.row) || Math.abs(value.row) > MAX_DIMENSION
		|| !validCellDimension(value.columns) || !validCellDimension(value.rows)) return undefined;
	const image = images.get(value.imageId);
	if (!image || !validCrop(value.crop, image.widthPx, image.heightPx) || !validPlacementClip(value.clip, value.columns, value.rows)) return undefined;
	let left = value.clip.leftColumns;
	let right = value.clip.rightColumns;
	let top = value.clip.topRows;
	let bottom = value.clip.bottomRows;
	left += Math.max(0, -(value.column + left));
	top += Math.max(0, -(value.row + top));
	right += Math.max(0, value.column + value.columns - right - pane.cols);
	bottom += Math.max(0, value.row + value.rows - bottom - pane.rows);
	const columns = value.columns - left - right;
	const rowsVisible = value.rows - top - bottom;
	if (columns < 1 || rowsVisible < 1) return undefined;
	const column = pane.column + value.column + left;
	const row = pane.row + value.row + top;
	if (column < pane.column || row < pane.row || column + columns > pane.column + pane.cols
		|| row + rowsVisible > pane.row + pane.rows || column < 0 || row < 0
		|| column + columns > cols || row + rowsVisible > rows) return undefined;
	const crop = {
		x: value.crop.x + Math.floor(value.crop.width * left / value.columns),
		y: value.crop.y + Math.floor(value.crop.height * top / value.rows),
		width: Math.ceil(value.crop.width * (value.columns - right) / value.columns)
			- Math.floor(value.crop.width * left / value.columns),
		height: Math.ceil(value.crop.height * (value.rows - bottom) / value.rows)
			- Math.floor(value.crop.height * top / value.rows),
	};
	if (!validCrop(crop, image.widthPx, image.heightPx)) return undefined;
	const generationKey = graphicsHash(
		image.generationKey,
		"placement",
		value.id,
		column, row, columns, rowsVisible,
		crop.x, crop.y, crop.width, crop.height,
	);
	return {
		generationKey,
		sourceId: value.id,
		imageGenerationKey: image.generationKey,
		column,
		row,
		columns,
		rows: rowsVisible,
		crop,
	};
}

function validOwner(value: string): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= 256
		&& !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function validPane(value: HostPaneRect, cols: number, rows: number): boolean {
	return typeof value === "object" && value !== null
		&& Number.isSafeInteger(value.column) && value.column >= 0
		&& Number.isSafeInteger(value.row) && value.row >= 0
		&& Number.isSafeInteger(value.cols) && value.cols > 0 && value.cols <= MAX_DIMENSION
		&& Number.isSafeInteger(value.rows) && value.rows > 0 && value.rows <= MAX_DIMENSION
		&& value.column + value.cols <= cols && value.row + value.rows <= rows;
}

function validChildGraphicsId(value: string): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= 128
		&& !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function validImageDimension(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0 && value <= MAX_GRAPHICS_DIMENSION;
}

function validCellDimension(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0 && value <= MAX_DIMENSION;
}

function validPlacementClip(
	value: TerminalGraphicsPlacement["clip"],
	columns: number,
	rows: number,
): boolean {
	return typeof value === "object" && value !== null
		&& [value.leftColumns, value.rightColumns].every((part) => Number.isSafeInteger(part) && part >= 0)
		&& [value.topRows, value.bottomRows].every((part) => Number.isSafeInteger(part) && part >= 0)
		&& value.leftColumns + value.rightColumns < columns
		&& value.topRows + value.bottomRows < rows;
}

function validCrop(
	value: TerminalGraphicsPlacement["crop"],
	width: number,
	height: number,
): boolean {
	return typeof value === "object" && value !== null
		&& Number.isSafeInteger(value.x) && value.x >= 0
		&& Number.isSafeInteger(value.y) && value.y >= 0
		&& Number.isSafeInteger(value.width) && value.width > 0
		&& Number.isSafeInteger(value.height) && value.height > 0
		&& value.x + value.width <= width && value.y + value.height <= height;
}

function graphicsHash(...parts: readonly (string | number)[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(String(part)).update("\0");
	return hash.digest("hex");
}

function ownGraphicsPlan(
	plan: ValidatedGraphicsPlan | undefined,
	previous: OwnedGraphicsPlan | undefined,
	nextImageId: number,
	nextPlacementId: number,
): { readonly plan: OwnedGraphicsPlan | undefined; readonly nextImageId: number; readonly nextPlacementId: number } {
	if (!plan) return { plan: undefined, nextImageId, nextPlacementId };
	const previousImages = new Map(previous?.images.map((image) => [image.generationKey, image.outputId]));
	const previousPlacements = new Map(previous?.placements.map((placement) => [placement.generationKey, placement.outputId]));
	const usedImageIds = new Set<number>(previous?.images.map((image) => image.outputId));
	const usedPlacementIds = new Set<number>(previous?.placements.map((placement) => placement.outputId));
	const images = plan.images.map((image) => {
		const reusable = previousImages.get(image.generationKey);
		const outputId = reusable ?? allocateKittyId(nextImageId, usedImageIds);
		usedImageIds.add(outputId);
		if (reusable === undefined) nextImageId = followingKittyId(outputId);
		return { ...image, outputId };
	});
	const placements = plan.placements.map((placement) => {
		const reusable = previousPlacements.get(placement.generationKey);
		const outputId = reusable ?? allocateKittyId(nextPlacementId, usedPlacementIds);
		usedPlacementIds.add(outputId);
		if (reusable === undefined) nextPlacementId = followingKittyId(outputId);
		return { ...placement, outputId };
	});
	return { plan: { ...plan, images, placements }, nextImageId, nextPlacementId };
}

function allocateKittyId(start: number, used: ReadonlySet<number>): number {
	let candidate = start;
	for (let attempts = 0; attempts <= used.size; attempts += 1) {
		if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_KITTY_ID) candidate = 1;
		if (!used.has(candidate)) return candidate;
		candidate = followingKittyId(candidate);
	}
	return 1;
}

function followingKittyId(value: number): number {
	return value >= MAX_KITTY_ID ? 1 : value + 1;
}

function buildGraphicsDeletes(plan: OwnedGraphicsPlan | undefined): Buffer {
	return buildGraphicsDeletesForIds(graphicsImageIds(plan));
}

function graphicsImageIds(plan: OwnedGraphicsPlan | undefined): Set<number> {
	return new Set(plan?.images.map((image) => image.outputId) ?? []);
}

function buildGraphicsDeletesForIds(ids: ReadonlySet<number>): Buffer {
	if (ids.size === 0) return Buffer.alloc(0);
	return Buffer.from([...ids].map((imageId) => `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`).join(""), "ascii");
}

function* kittyImageUploadCommands(image: ValidatedGraphicsImage & { readonly outputId: number }): IterableIterator<string> {
	const base64 = image.base64;
	if (base64.length <= MAX_KITTY_PAYLOAD_CHUNK_BYTES) {
		yield `\x1b_Ga=t,f=100,q=2,i=${image.outputId};${base64}\x1b\\`;
		return;
	}
	for (let offset = 0; offset < base64.length; offset += MAX_KITTY_PAYLOAD_CHUNK_BYTES) {
		const chunk = base64.slice(offset, offset + MAX_KITTY_PAYLOAD_CHUNK_BYTES);
		const first = offset === 0;
		const last = offset + chunk.length >= base64.length;
		const header = first
			? `a=t,f=100,q=2,i=${image.outputId},m=1`
			: `m=${last ? 0 : 1}`;
		yield `\x1b_G${header};${chunk}\x1b\\`;
	}
}

function graphicsPlacementCommand(
	placement: OwnedGraphicsPlan["placements"][number],
	imageId: number,
): string {
	return `\x1b[${placement.row + 1};${placement.column + 1}H`
		+ `\x1b_Ga=p,q=2,C=1,i=${imageId},p=${placement.outputId},c=${placement.columns},r=${placement.rows}`
		+ `,x=${placement.crop.x},y=${placement.crop.y},w=${placement.crop.width},h=${placement.crop.height}\x1b\\`;
}

function graphicsRenderByteLength(plan: OwnedGraphicsPlan | undefined, cursor: FrameCandidate["cursor"]): number {
	if (!plan || plan.images.length === 0 || plan.placements.length === 0) return 0;
	const imageIds = new Map(plan.images.map((image) => [image.generationKey, image.outputId]));
	let bytes = HIDE_CURSOR.length + cursorSuffix(cursor).length;
	for (const image of plan.images) {
		for (const command of kittyImageUploadCommands(image)) bytes += command.length;
	}
	for (const placement of plan.placements) {
		const imageId = imageIds.get(placement.imageGenerationKey);
		if (imageId !== undefined) bytes += graphicsPlacementCommand(placement, imageId).length;
	}
	return bytes;
}

function buildGraphicsRender(plan: OwnedGraphicsPlan | undefined, cursor: FrameCandidate["cursor"]): Buffer {
	if (!plan || plan.images.length === 0 || plan.placements.length === 0) return Buffer.alloc(0);
	const images = new Map(plan.images.map((image) => [image.generationKey, image.outputId]));
	let output = "";
	for (const image of plan.images) {
		for (const command of kittyImageUploadCommands(image)) output += command;
	}
	output += HIDE_CURSOR;
	for (const placement of plan.placements) {
		const imageId = images.get(placement.imageGenerationKey);
		if (imageId !== undefined) output += graphicsPlacementCommand(placement, imageId);
	}
	output += cursorSuffix(cursor);
	return Buffer.from(output, "ascii");
}

function combinePayload(parts: readonly Buffer[], byteLimit: number): Buffer | undefined {
	let total = 0;
	for (const part of parts) {
		total += part.length;
		if (total > byteLimit) return undefined;
	}
	return Buffer.concat(parts, total);
}

/** Append one sanitized, clipped row; returns its display-cell width. */
function appendSafeClippedLine(
	builder: BoundedFrameBuilder,
	source: string,
	cols: number,
	segmenter: Intl.Segmenter,
): number {
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
	return cells;
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
