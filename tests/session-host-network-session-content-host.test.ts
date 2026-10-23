/**
 * Focused contract tests for the owner side of the native viewport content
 * endpoint (#389).
 *
 * Everything here is pure and in-memory: a synthetic loopback content-lane
 * channel stands in for the transport, and a thin fake of the owning-host
 * service stands in for the manager's read-only content watch, its inventory
 * snapshot, and its own per-session viewer registration. No socket, listener,
 * process, filesystem path, or product state is touched, no real session is
 * ever started, stopped, written, or resized, and the only timers are the
 * endpoint's own finite guards plus the test's own bounded observation windows.
 *
 * The assertions are about observable safety: nothing is attached or written
 * off the content lane, nothing is sent before a negotiated hello and an
 * accepted subscription, the requested owner run and row are fenced before any
 * viewer exists, only this endpoint's own viewer is ever changed, only canonical
 * geometry and unchanged native content are published, one serialized transfer
 * is in flight with one newest-wins pending snapshot, authorization is
 * re-checked before every frame, and a stalled write or a lost source retires
 * local resources truthfully instead of claiming settled cleanup.
 *
 * The native input and text-copy extension (#481 path) is asserted the same way:
 * it is inert unless an explicit opt-in, a real provider seam, and a peer offer
 * all line up; an echoed source is re-proved against the CURRENT owner facts so a
 * stale or incomplete input hands over zero bytes and poisons nothing after it;
 * every packet is translated once by the owner's own translator; one text paste of
 * up to exactly 1 MiB is atomic; and a native copy reaches only the viewer whose
 * own input caused it, whole, on the one serialized writer, never as a PTY write.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";
import type {
	NativeInstanceView,
	SessionGeometry,
	SessionViewerState,
	SessionViewerUpdate,
	SessionViewerUpdateResult,
} from "../src/session-host/instances";
import { isNativeViewerStartupInputSource } from "../src/session-host/instances";
import { translateInput } from "../src/session-host/input";
import type { NativeClipboardEvent } from "../src/session-host/native-clipboard";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import type {
	NativeViewerClipboardReceipt,
	NativeViewerClipboardSink,
	NativeViewerInputRequest,
	NativeViewerInputResult,
	NativeViewerInputSource,
	OwningHostInventorySnapshot,
	OwningHostSessionContentListener,
	OwningHostSessionContentSnapshot,
	OwningHostSessionContentWatch,
	OwningHostViewerOptions,
} from "../src/session-host/owning-host-service";
import type { PeerKey } from "../src/session-host/network/identity";
import type { PeerAppLane } from "../src/session-host/network/protocol";
import type { PeerByteChannel, PeerChannelClose } from "../src/session-host/network/channel";
import {
	SESSION_CONTENT_HOST_CLOSE_ERROR_CODE,
	SESSION_CONTENT_HOST_CLOSE_ERROR_MESSAGE,
	SessionContentHostCloseError,
	createSessionContentHost,
	type SessionContentChannelBinding,
	type SessionContentHost,
	type SessionContentHostDiagnostic,
	type SessionContentHostDiagnosticCode,
	type SessionContentSource,
} from "../src/session-host/network/session-content-host";
import {
	DEFAULT_SESSION_CONTENT_BOUNDS,
	NATIVE_COPY_MAX_ENCODED_CHARS,
	NATIVE_TEXT_PASTE_MAX_BYTES,
	SESSION_CONTENT_MAJOR,
	SESSION_CONTENT_MINOR,
	SESSION_CONTENT_NATIVE_IO_CAPABILITY,
	SESSION_CONTENT_REQUIRED_CAPABILITY,
	SESSION_CONTENT_SERVICE,
	buildNativeInputInline,
	buildNativeInputPaste,
	createNativeCopyAssembler,
	createSessionContentTransferAssembler,
	decodeSessionContentFrame,
	encodeSessionContentFrame,
	isNativeIoStartupSource,
	isSessionContentProtocolError,
	nativeIoSourceEquals,
	type NativeIoBuiltTransfer,
	type NativeIoCompletedCopy,
	type NativeIoInputKind,
	type NativeIoSource,
	type SessionContentBounds,
	type SessionContentFrame,
	type SessionContentHelloFrame,
	type SessionContentResizeFrame,
	type SessionContentSnapshot,
	type SessionContentSubscribeFrame,
} from "../src/session-host/network/session-content-protocol";
import { DEFAULT_ROSTER_BRIDGE_BOUNDS } from "../src/session-host/network/roster-bridge-protocol";
import type { TerminalFrame, TerminalInputModes, TerminalLineStyles } from "../src/session-host/terminal-surface";

/* ------------------------------------------------------------------------- *
 * Native viewport fixtures
 * ------------------------------------------------------------------------- */

function crc32(input: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of input) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([typeBytes, data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function pngBase64(width = 4, height = 4): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return Buffer.concat([
		signature,
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(Buffer.alloc(height * (width * 4 + 1)))),
		pngChunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

const INPUT_MODES: TerminalInputModes = Object.freeze({
	kittyFlags: 7,
	applicationCursorKeys: true,
	applicationKeypad: false,
	bracketedPaste: true,
	mouseTracking: "any",
	modifyOtherKeys: 2,
	mouseEncoding: "sgr-pixels",
});

const ZERO_CLIP = Object.freeze({ leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 });
const UNICODE_TEXT = "\u4e16\u754c\u6587\u5b57 e\u0301";

/**
 * One canonical native viewport at exactly `cols` x `rows`: generated SGR,
 * structured style runs with colors and attributes, a cursor, and a typed Kitty
 * PNG image with its placement and payload-free fallback. Filler text keeps a
 * normal pane large enough that a small chunk budget needs several messages,
 * without any artificial ceiling on the content itself.
 */
function styledViewport(cols: number, rows: number): TerminalFrame {
	const filler = "x".repeat(Math.max(0, cols - 2));
	const lines: string[] = [`\x1b[0m\x1b[1;38;5;196m${UNICODE_TEXT}\x1b[0m\x1b[0m`];
	for (let row = 1; row < rows; row += 1) lines.push(`\x1b[0m${filler}\x1b[0m`);
	const styles: TerminalLineStyles[] = [{
		line: 0,
		runs: [{ startColumn: 0, text: UNICODE_TEXT, bold: true, fg: { mode: "palette", value: 196 } }],
	}];
	if (rows > 1) {
		styles.push({
			line: 1,
			runs: [{ startColumn: 0, text: filler, underline: true, fg: { mode: "rgb", value: 0x10_20_30 } }],
		});
	}
	const image = { id: "kitty-1", mimeType: "image/png" as const, widthPx: 4, heightPx: 4, base64: pngBase64() };
	return {
		cols,
		rows,
		lines,
		cursor: { column: Math.min(1, cols - 1), row: 0, visible: true },
		styles,
		graphics: {
			images: [image],
			placements: [{
				id: "placement-1",
				imageId: image.id,
				column: 0,
				row: 0,
				columns: 2,
				rows: 1,
				crop: { x: 0, y: 0, width: 4, height: 4 },
				clip: ZERO_CLIP,
			}],
			fallbacks: [{
				id: "placement-1",
				mimeType: "image/png",
				widthPx: 4,
				heightPx: 4,
				column: 0,
				row: 0,
				columns: 2,
				rows: 1,
				clip: ZERO_CLIP,
			}],
		},
	};
}

/* ------------------------------------------------------------------------- *
 * Loopback content lane
 * ------------------------------------------------------------------------- */

/**
 * One in-memory content-lane channel. `send` preserves message boundaries and
 * records every write, delivery is explicit, and a test can hold, fail, or stall
 * one write to observe the endpoint's own bookkeeping.
 */
class ContentChannel implements PeerByteChannel {
	readonly lane: PeerAppLane;
	readonly peerKey = { keyId: "viewer-key", fingerprint: "synthetic-viewer-fingerprint" } as const;
	readonly label: string | null = "content viewer";
	readonly sent: Buffer[] = [];
	/** Shared ordered log with the fake source, for retirement-ordering assertions. */
	events: string[] = [];
	closeCalls = 0;
	handlerCount = 0;
	/** Hold every following write: bytes are recorded, the promise stays pending. */
	hold = false;
	/** Hold exactly the next write. */
	holdNextSend = false;
	/** Reject exactly the next write. */
	failNextSend = false;
	/** Leave exactly the next write's promise pending forever. */
	stallNextSend = false;
	/** Reject every close, as a transport that cannot confirm its own teardown. */
	refuseClose = false;
	/** Never settle a close, as a transport whose teardown hangs. */
	stallClose = false;
	/** Fail the disposer returned by `onMessage`. */
	throwOnDetach = false;
	#handlers = new Set<(bytes: Buffer) => void>();
	#pending: Array<() => void> = [];
	#closed: Promise<PeerChannelClose>;
	#resolveClosed!: (value: PeerChannelClose) => void;
	#settled = false;

	constructor(lane: PeerAppLane = "content") {
		this.lane = lane;
		this.#closed = new Promise<PeerChannelClose>((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	get closed(): Promise<PeerChannelClose> {
		return this.#closed;
	}

	get bufferedAmount(): number {
		return 0;
	}

	frames(): SessionContentFrame[] {
		return this.sent.map((bytes) => decodeSessionContentFrame(bytes));
	}

	types(): string[] {
		return this.frames().map((frame) => frame.type);
	}

	/** Writes whose send promise is still outstanding. */
	get heldWrites(): number {
		return this.#pending.length;
	}

	send(bytes: Uint8Array): Promise<void> {
		if (this.#settled) return Promise.reject(new Error("channel closed"));
		if (this.failNextSend) {
			this.failNextSend = false;
			return Promise.reject(new Error("synthetic send failure"));
		}
		const copy = Buffer.from(bytes);
		this.sent.push(copy);
		this.events.push(`send:${decodeSessionContentFrame(copy).type}`);
		if (this.stallNextSend) {
			this.stallNextSend = false;
			return new Promise<void>(() => undefined);
		}
		if (this.holdNextSend) {
			this.holdNextSend = false;
			return new Promise<void>((resolve) => {
				this.#pending.push(resolve);
			});
		}
		if (this.hold) {
			return new Promise<void>((resolve) => {
				this.#pending.push(resolve);
			});
		}
		return Promise.resolve();
	}

	/** Settle every held write, as a socket that finally drains. */
	release(): void {
		const pending = this.#pending;
		this.#pending = [];
		for (const settle of pending) settle();
	}

	close(): Promise<void> {
		this.closeCalls += 1;
		if (this.stallClose) return new Promise<void>(() => undefined);
		if (this.refuseClose) return Promise.reject(new Error("synthetic close failure"));
		this.#finish(1000, "");
		return Promise.resolve();
	}

	onMessage(handler: (bytes: Buffer) => void): () => void {
		this.#handlers.add(handler);
		this.handlerCount = this.#handlers.size;
		return () => {
			if (this.throwOnDetach) throw new Error("synthetic detach failure");
			this.#handlers.delete(handler);
			this.handlerCount = this.#handlers.size;
		};
	}

	deliver(frame: SessionContentFrame): void {
		this.deliverBytes(encodeSessionContentFrame(frame));
	}

	deliverBytes(bytes: Buffer): void {
		if (this.#settled) return;
		for (const handler of [...this.#handlers]) handler(bytes);
	}

	/** Transport loss, as the socket reports it. */
	lose(code = 1006): void {
		this.#finish(code, "lost");
	}

	#finish(code: number, reason: string): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#resolveClosed(Object.freeze({ code, reason }));
	}
}

/* ------------------------------------------------------------------------- *
 * Fake owning-host service
 * ------------------------------------------------------------------------- */

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN = "22222222-2222-4222-8222-222222222222";

interface FakeRow {
	readonly id: string;
	cols: number;
	rows: number;
	revision: number;
	nativeSession: SessionHostNativeSession;
}

interface FakeViewer {
	readonly viewerId: string;
	sessionId: string | undefined;
	cols: number | undefined;
	rows: number | undefined;
	revision: number;
}

interface FakeWatch {
	readonly rowId: string;
	readonly snapshot: OwningHostSessionContentSnapshot;
	readonly listener: OwningHostSessionContentListener;
	unsubscribed: number;
}

function ownerRow(row: FakeRow): NativeInstanceView {
	return {
		id: row.id,
		label: `Row ${row.id}`,
		workspace: `/srv/owner/work-${row.id}`,
		agentDir: "/srv/owner/.pi/agent",
		lifecycle: "alive",
		busy: null,
		pendingInput: null,
		inputSurface: false,
		nativeSession: row.nativeSession,
		backgroundTasks: null,
		backgroundShells: null,
		activeTasks: null,
		activeShells: null,
		hasLiveProcess: true,
		activity: [],
	};
}

/**
 * A thin fake of the one owning-host service capabilities the endpoint uses.
 *
 * It is deliberately not an authority: it owns no transport, no UI, and no
 * session lifecycle. Its viewer registry models the manager's own rule that a
 * row's canonical geometry is the independent minimum of the viewers that
 * display it, that closing a viewer recomputes from the remaining ones, and
 * that a row with no viewer keeps its last canonical geometry.
 */
class FakeContentSource implements SessionContentSource {
	readonly runId: string;
	readonly rows = new Map<string, FakeRow>();
	readonly watches: FakeWatch[] = [];
	readonly viewers = new Map<string, FakeViewer>();
	readonly installedRowIds: string[] = [];
	readonly updateCalls: Array<{ readonly viewerId: string; readonly update: SessionViewerUpdate }> = [];
	readonly closedViewerIds: string[] = [];
	/** The copy sink each surface registered with, as the manager keeps it. */
	readonly viewerSinks = new Map<string, NativeViewerClipboardSink>();
	/** Every `openViewer` argument, in order, to prove the default stays option-free. */
	readonly openViewerOptions: Array<OwningHostViewerOptions | undefined> = [];
	/**
	 * Every handoff this source was asked for, in order. This is the strictest
	 * observable: an endpoint that invoked the seam with stale facts is itself
	 * wrong, whether or not the fake's own fence then refused it.
	 */
	readonly inputWrites: Array<{ readonly viewerId: string; readonly data: string | Buffer }> = [];
	readonly #sourceTokens = new Map<string, string>();
	/** Every release this source was asked for, in order, successful or not. */
	readonly closeViewerAttempts: string[] = [];
	readonly builtSnapshots: OwningHostSessionContentSnapshot[] = [];
	events: string[] = [];
	inventoryReads = 0;
	readViewerCalls = 0;
	inventoryUnavailable = false;
	watchUnavailable = false;
	viewerUnavailable = false;
	refuseUpdate = false;
	refuseViewerClose = false;
	/** Refuse only these viewer ids, as a manager that lost one surface only. */
	readonly refuseViewerCloseIds = new Set<string>();
	throwOnCloseViewer = false;
	/** Fail the unsubscribe the source hands back with its watch. */
	throwOnUnsubscribe = false;
	/**
	 * Faithful manager notification: a viewer change notifies a content change only for
	 * a row whose canonical geometry actually MOVED. The real manager takes a row's
	 * size as the minimum over the viewers that display it, so a sibling holding a
	 * smaller size leaves the row exactly as it is and its watch stays silent even
	 * though the changed viewer's own revision moved. Off by default, so every
	 * pre-existing test keeps exactly the emissions it was written against.
	 */
	emitOnlyOnCanonicalChange = false;
	/** Runs after a viewer is allocated, before it is handed back to the endpoint. */
	openViewerHook: (() => void) | undefined;
	/** Publish the install snapshot under a different owner run. */
	watchRunOverride: string | undefined;
	/** Runs after a viewer change was applied and its ordinary snapshot emitted. */
	updateHook: ((rowId: string) => void) | undefined;
	/** Runs before `watchSessionContent` returns, as a retained source change would. */
	installHook: ((rowId: string) => void) | undefined;
	/** The input modes every capture reports; a test changes them to model the child. */
	inputModes: TerminalInputModes = INPUT_MODES;
	/** Report that no surface can take input right now, as teardown or no seam would. */
	inputUnavailable = false;
	/** Force every handoff outcome, as a manager that refuses or loses track would. */
	inputWriteOutcome: NativeViewerInputResult | undefined;
	inputReads = 0;
	#nextViewerId = 1;
	#sequence = 0;
	#inventoryRevision = 0;
	#nextToken = 1;

	constructor(runId = RUN_ID) {
		this.runId = runId;
	}

	addRow(id: string, cols: number, rows: number): void {
		this.rows.set(id, {
			id,
			cols,
			rows,
			revision: 0,
			nativeSession: { sessionId: `conversation-${id}`, epoch: 3, name: `Conversation ${id}` },
		});
	}

	get lastSequence(): number {
		return this.#sequence;
	}

	get liveWatches(): readonly FakeWatch[] {
		return this.watches.filter((watch) => watch.unsubscribed === 0);
	}

	geometryOf(rowId: string): SessionGeometry {
		const row = this.#row(rowId);
		return Object.freeze({ cols: row.cols, rows: row.rows, revision: row.revision });
	}

	/** The exact frame the most recent snapshot for `rowId` carried. */
	snapshotFrame(rowId: string): TerminalFrame {
		for (let index = this.builtSnapshots.length - 1; index >= 0; index -= 1) {
			const snapshot = this.builtSnapshots[index];
			if (snapshot !== undefined && snapshot.sessionId === rowId) return snapshot.frame;
		}
		throw new Error("no snapshot was captured for this row");
	}

	readInventorySnapshot(): OwningHostInventorySnapshot | undefined {
		this.inventoryReads += 1;
		this.events.push("readInventorySnapshot");
		if (this.inventoryUnavailable) return undefined;
		this.#inventoryRevision += 1;
		return Object.freeze({
			hostRunId: this.runId,
			revision: this.#inventoryRevision,
			rows: Object.freeze([...this.rows.values()].map((row) => ownerRow(row))),
		});
	}

	watchSessionContent(
		rowId: string,
		listener: OwningHostSessionContentListener,
	): OwningHostSessionContentWatch | undefined {
		this.installedRowIds.push(rowId);
		this.events.push(`watch:${rowId}`);
		if (this.watchUnavailable) return undefined;
		if (!this.rows.has(rowId)) return undefined;
		const snapshot = this.#capture(rowId, this.watchRunOverride ?? this.runId);
		const watch: FakeWatch = {
			rowId,
			snapshot,
			listener,
			unsubscribed: 0,
		};
		const unsubscribe = (): void => {
			if (this.throwOnUnsubscribe) throw new Error("synthetic unsubscribe failure");
			watch.unsubscribed += 1;
			this.events.push(`unwatch:${rowId}`);
		};
		this.watches.push(watch);
		const hook = this.installHook;
		if (hook !== undefined) {
			this.installHook = undefined;
			hook(rowId);
		}
		return Object.freeze({ snapshot, unsubscribe });
	}

	openViewer(options?: OwningHostViewerOptions): SessionViewerState | undefined {
		this.events.push("openViewer");
		this.openViewerOptions.push(options);
		if (this.viewerUnavailable) return undefined;
		const viewer: FakeViewer = {
			viewerId: `viewer-${this.#nextViewerId++}`,
			sessionId: undefined,
			cols: undefined,
			rows: undefined,
			revision: 0,
		};
		this.viewers.set(viewer.viewerId, viewer);
		// Exactly like the manager: the sink stays in the viewer's own record, and a
		// surface registered without one can never become an input source.
		if (options?.nativeClipboardSink !== undefined) {
			this.viewerSinks.set(viewer.viewerId, options.nativeClipboardSink);
			this.#sourceTokens.set(viewer.viewerId, `token-${this.#nextToken++}`);
		}
		const hook = this.openViewerHook;
		if (hook !== undefined) {
			this.openViewerHook = undefined;
			hook();
		}
		return this.#state(viewer);
	}

	readViewer(viewerId: string): SessionViewerState | undefined {
		this.readViewerCalls += 1;
		const viewer = this.viewers.get(viewerId);
		return viewer === undefined ? undefined : this.#state(viewer);
	}

	updateViewer(viewerId: string, update: SessionViewerUpdate = {}): SessionViewerUpdateResult {
		this.updateCalls.push({ viewerId, update });
		const viewer = this.viewers.get(viewerId);
		if (viewer === undefined) return { applied: false, reason: "unknown-viewer" };
		if (this.refuseUpdate) return { applied: false, reason: "invalid-geometry" };
		if (update.expectedRevision !== undefined && update.expectedRevision !== viewer.revision) {
			return { applied: false, reason: "stale" };
		}
		const previousSession = viewer.sessionId;
		if (update.sessionId !== undefined) viewer.sessionId = update.sessionId === null ? undefined : update.sessionId;
		if (update.cols !== undefined) viewer.cols = update.cols;
		if (update.rows !== undefined) viewer.rows = update.rows;
		viewer.revision += 1;
		this.events.push(`updateViewer:${viewerId}`);
		const moved: string[] = [];
		for (const rowId of this.#affectedRows(previousSession, viewer.sessionId)) {
			if (this.#recompute(rowId)) moved.push(rowId);
		}
		for (const rowId of this.#affectedRows(previousSession, viewer.sessionId)) {
			// The real manager notifies only a row whose canonical geometry moved; the
			// default emits as this fake always has, so existing tests are untouched.
			if (moved.includes(rowId) || !this.emitOnlyOnCanonicalChange) this.emit(rowId);
		}
		const hook = this.updateHook;
		if (hook !== undefined) {
			this.updateHook = undefined;
			if (viewer.sessionId !== undefined) hook(viewer.sessionId);
		}
		return { applied: true, state: this.#state(viewer) };
	}

	closeViewer(viewerId: string): boolean {
		this.events.push(`closeViewer:${viewerId}`);
		this.closeViewerAttempts.push(viewerId);
		if (this.throwOnCloseViewer) throw new Error("viewer close failed");
		if (this.refuseViewerClose || this.refuseViewerCloseIds.has(viewerId)) return false;
		const viewer = this.viewers.get(viewerId);
		if (viewer === undefined) return false;
		this.viewers.delete(viewerId);
		this.viewerSinks.delete(viewerId);
		this.#sourceTokens.delete(viewerId);
		this.closedViewerIds.push(viewerId);
		if (viewer.sessionId !== undefined) {
			const moved = this.#recompute(viewer.sessionId);
			if (moved || !this.emitOnlyOnCanonicalChange) this.emit(viewer.sessionId);
		}
		return true;
	}

	/* --------------------------------------------------------------------- *
	 * Strict viewer input seam (#481 path), modeled the way the manager fences it
	 * --------------------------------------------------------------------- */

	/** The CURRENT owner-private input scope of one surface, or undefined. */
	readViewerInputSource(viewerId: string): NativeViewerInputSource | undefined {
		this.inputReads += 1;
		if (this.inputUnavailable) return undefined;
		const viewer = this.viewers.get(viewerId);
		if (viewer === undefined || viewer.sessionId === undefined) return undefined;
		// A surface with no copy sink of its own is never an input source.
		if (!this.viewerSinks.has(viewerId)) return undefined;
		const row = this.rows.get(viewer.sessionId);
		if (row === undefined) return undefined;
		return Object.freeze({
			hostRunId: this.runId,
			viewerId,
			viewerRevision: viewer.revision,
			rowId: row.id,
			nativeSession: Object.freeze({ sessionId: row.nativeSession.sessionId, epoch: row.nativeSession.epoch }),
			geometry: Object.freeze({ cols: row.cols, rows: row.rows, revision: row.revision }),
			registrationIdentity: `registration-${viewerId}`,
			registrationGeneration: `generation-${viewerId}`,
			sourceToken: this.#sourceTokens.get(viewerId) ?? `token-rotated-${viewerId}`,
		});
	}

	/** The one handoff: every current fact is re-checked before it is "submitted". */
	writeViewerInput(viewerId: string, request: NativeViewerInputRequest): NativeViewerInputResult {
		this.inputWrites.push({ viewerId, data: request.data });
		if (this.inputWriteOutcome !== undefined) return this.inputWriteOutcome;
		const current = this.readViewerInputSource(viewerId);
		if (current === undefined) return { status: "refused", reason: "no-input-source" };
		// This fake models only conversation scopes, so a startup expectation is stale.
		const expected = request.expectedSource;
		if (isNativeViewerStartupInputSource(expected)) return { status: "refused", reason: "stale-source" };
		if (!sameScopeFacts(current, expected)) return { status: "refused", reason: "stale-source" };
		if (!sameModesFacts(this.inputModes, request.expectedInputModes)) {
			return { status: "refused", reason: "stale-input-modes" };
		}
		if (request.data.length === 0) return { status: "refused", reason: "invalid-input" };
		return { status: "submitted" };
	}

	/** Deliver a native copy on one surface's own bound sink, as the manager would. */
	emitCopy(viewerId: string, event: NativeClipboardEvent, dispatchId: number): void {
		const source = this.readViewerInputSource(viewerId);
		assert.ok(source !== undefined, "the viewer must have a current input scope");
		const receipt: NativeViewerClipboardReceipt = Object.freeze({ source, event, dispatchId });
		this.sinkFor(viewerId)(receipt);
	}

	/** Deliver an arbitrary receipt to one surface's sink, as a hostile caller could. */
	sinkFor(viewerId: string): NativeViewerClipboardSink {
		const sink = this.viewerSinks.get(viewerId);
		assert.ok(sink !== undefined, "the endpoint must have registered this viewer's own sink");
		return sink;
	}

	/** Replace a surface's host-minted token, as a re-registration would. */
	rotateSourceToken(viewerId: string): void {
		this.#sourceTokens.set(viewerId, `token-${this.#nextToken++}`);
	}

	/** Start a new native conversation on one row, changing every tuple fact. */
	rotateNativeSession(rowId: string): void {
		const row = this.rows.get(rowId);
		assert.ok(row !== undefined);
		row.nativeSession = {
			sessionId: `conversation-${rowId}-next`,
			epoch: row.nativeSession.epoch + 1,
			name: `Conversation ${rowId} next`,
		};
	}

	/** Bump only a surface's revision, as an unrelated viewer change would. */
	bumpViewerRevision(viewerId: string): void {
		const viewer = this.viewers.get(viewerId);
		assert.ok(viewer !== undefined);
		viewer.revision += 1;
	}

	/** One live change to every watch of `rowId`, as the manager's hook would. */
	emit(rowId: string): OwningHostSessionContentSnapshot {
		const snapshot = this.#capture(rowId);
		this.#deliver(rowId, snapshot);
		return snapshot;
	}

	/** Publish a snapshot that claims another owner run. */
	emitRun(rowId: string, runId: string): OwningHostSessionContentSnapshot {
		const snapshot = this.#capture(rowId, runId);
		this.#deliver(rowId, snapshot);
		return snapshot;
	}

	/** Publish a snapshot for a different row id. */
	emitReplacedRow(rowId: string, otherRowId: string): OwningHostSessionContentSnapshot {
		this.addRowIfMissing(otherRowId);
		const snapshot = this.#capture(otherRowId);
		this.#deliver(rowId, snapshot);
		return snapshot;
	}

	emitUnavailable(rowId: string): void {
		this.#deliver(rowId, undefined);
	}

	addRowIfMissing(id: string): void {
		if (!this.rows.has(id)) this.addRow(id, 40, 12);
	}

	#row(rowId: string): FakeRow {
		const row = this.rows.get(rowId);
		if (row === undefined) throw new Error("unknown row");
		return row;
	}

	#state(viewer: FakeViewer): SessionViewerState {
		return Object.freeze({
			viewerId: viewer.viewerId,
			sessionId: viewer.sessionId,
			cols: viewer.cols,
			rows: viewer.rows,
			revision: viewer.revision,
		});
	}

	#affectedRows(...ids: ReadonlyArray<string | undefined>): string[] {
		const affected = new Set<string>();
		for (const id of ids) if (id !== undefined) affected.add(id);
		return [...affected];
	}

	#capture(rowId: string, runId = this.runId): OwningHostSessionContentSnapshot {
		const row = this.#row(rowId);
		this.#sequence += 1;
		const snapshot: OwningHostSessionContentSnapshot = Object.freeze({
			hostRunId: runId,
			sessionId: rowId,
			nativeSession: Object.freeze({ sessionId: row.nativeSession.sessionId, epoch: row.nativeSession.epoch }),
			sequence: this.#sequence,
			geometry: Object.freeze({ cols: row.cols, rows: row.rows, revision: row.revision }),
			frame: Object.freeze(styledViewport(row.cols, row.rows)),
			inputModes: this.inputModes,
		});
		this.builtSnapshots.push(snapshot);
		return snapshot;
	}

	#deliver(rowId: string, snapshot: OwningHostSessionContentSnapshot | undefined): void {
		for (const watch of this.liveWatches) {
			if (watch.rowId !== rowId) continue;
			try {
				watch.listener(snapshot);
			} catch {
				// The real service contains listener failures; the fake does too.
			}
		}
	}

	/**
	 * Recompute one row's canonical geometry from the viewers that display it.
	 * With no such viewer the row keeps its last canonical geometry: zero viewers
	 * is not a size, and the endpoint's own arrival must never touch a sibling.
	 */
	#recompute(rowId: string): boolean {
		const row = this.rows.get(rowId);
		if (row === undefined) return false;
		const contributions = [...this.viewers.values()]
			.filter((viewer) => viewer.sessionId === rowId && viewer.cols !== undefined && viewer.rows !== undefined);
		if (contributions.length === 0) return false;
		const cols = Math.min(...contributions.map((viewer) => viewer.cols as number));
		const rows = Math.min(...contributions.map((viewer) => viewer.rows as number));
		if (cols === row.cols && rows === row.rows) return false;
		row.cols = cols;
		row.rows = rows;
		row.revision += 1;
		return true;
	}
}

/* ------------------------------------------------------------------------- *
 * Harness
 * ------------------------------------------------------------------------- */

interface Harness {
	readonly channel: ContentChannel;
	readonly source: FakeContentSource;
	readonly host: SessionContentHost;
	readonly binding: SessionContentChannelBinding;
	readonly diagnostics: SessionContentHostDiagnosticCode[];
	readonly allow: { value: boolean };
}

const FAST_TIMEOUTS = { helloTimeoutMs: 400, transferIdleTimeoutMs: 400, stopAckTimeoutMs: 400 } as const;

function createHarness(options: {
	readonly source?: FakeContentSource;
	readonly bounds?: Partial<SessionContentBounds>;
	readonly timeouts?: {
		readonly helloTimeoutMs?: number;
		readonly transferIdleTimeoutMs?: number;
		readonly stopAckTimeoutMs?: number;
	};
	readonly authorizePeer?: (peerKey: PeerKey) => boolean;
	readonly nativeIo?: boolean;
} = {}): Harness {
	const source = options.source ?? new FakeContentSource();
	const channel = new ContentChannel();
	source.events = channel.events;
	const diagnostics: SessionContentHostDiagnosticCode[] = [];
	const allow = { value: true };
	const host = createSessionContentHost({
		source,
		nativeIo: options.nativeIo,
		authorizePeer: options.authorizePeer ?? (() => allow.value),
		bounds: options.bounds,
		timeouts: { ...FAST_TIMEOUTS, ...options.timeouts },
		onDiagnostic: (event) => {
			diagnostics.push(event.code);
		},
	});
	const binding = host.attach(channel);
	return { channel, source, host, binding, diagnostics, allow };
}

function helloFrame(overrides: Partial<SessionContentHelloFrame> = {}): SessionContentHelloFrame {
	return {
		type: "hello",
		service: SESSION_CONTENT_SERVICE,
		major: SESSION_CONTENT_MAJOR,
		minor: SESSION_CONTENT_MINOR,
		capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY],
		...overrides,
	};
}

function subscribeFrame(
	source: FakeContentSource,
	overrides: Partial<SessionContentSubscribeFrame> = {},
): SessionContentSubscribeFrame {
	return {
		type: "subscribe",
		subscriptionId: "sub-1",
		hostRunId: source.runId,
		sessionId: "row-a",
		cols: 80,
		rows: 24,
		...overrides,
	};
}

function resizeFrame(overrides: Partial<SessionContentResizeFrame> = {}): SessionContentResizeFrame {
	return { type: "resize", subscriptionId: "sub-1", cols: 60, rows: 20, ...overrides };
}

function framesOfType<T extends SessionContentFrame["type"]>(
	frames: readonly SessionContentFrame[],
	type: T,
): Array<Extract<SessionContentFrame, { type: T }>> {
	return frames.filter((frame): frame is Extract<SessionContentFrame, { type: T }> => frame.type === type);
}

function onlyFrameOfType<T extends SessionContentFrame["type"]>(
	frames: readonly SessionContentFrame[],
	type: T,
): Extract<SessionContentFrame, { type: T }> {
	const matching = framesOfType(frames, type);
	assert.equal(matching.length, 1, `expected exactly one ${type} frame, got ${matching.length}`);
	return matching[0] as Extract<SessionContentFrame, { type: T }>;
}

/** Reassemble every complete transfer this channel wrote, in order. */
function assembleTransfers(
	frames: readonly SessionContentFrame[],
	bounds: Partial<SessionContentBounds> = {},
): SessionContentSnapshot[] {
	const assembler = createSessionContentTransferAssembler({ ...DEFAULT_SESSION_CONTENT_BOUNDS, ...bounds });
	const snapshots: SessionContentSnapshot[] = [];
	for (const frame of frames) {
		if (frame.type !== "content_begin" && frame.type !== "content_chunk" && frame.type !== "content_end") continue;
		const snapshot = assembler.accept(frame);
		if (snapshot !== undefined) snapshots.push(snapshot);
	}
	return snapshots;
}

async function settle(times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Bounded observation window; resolves as soon as the condition holds. */
async function waitFor(check: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(message);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * The one fixed retirement failure: a constant code and message, and no wrapped
 * source, transport, or channel error of any kind.
 */
function isCloseFailure(error: unknown): boolean {
	if (!(error instanceof SessionContentHostCloseError)) return false;
	assert.equal(error.code, SESSION_CONTENT_HOST_CLOSE_ERROR_CODE);
	assert.equal(error.message, SESSION_CONTENT_HOST_CLOSE_ERROR_MESSAGE);
	assert.equal(error.name, "SessionContentHostCloseError");
	assert.equal("cause" in error, false, "the fixed failure never wraps a raw error");
	assert.equal(JSON.stringify(error.message).includes("synthetic"), false);
	return true;
}

/** Drive a valid hello and assert the acknowledgement is content-free. */
async function openHello(harness: Harness, overrides: Partial<SessionContentHelloFrame> = {}): Promise<void> {
	harness.channel.deliver(helloFrame(overrides));
	await settle();
	assert.equal(harness.binding.subscribed, false);
}

/* ------------------------------------------------------------------------- *
 * Native IO helpers (#481 path) — every frame here is built by the protocol's
 * own builders, so the tests exercise the real wire shape.
 * ------------------------------------------------------------------------- */

const NATIVE_IO_CAPABILITIES = [SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY] as const;

const SGR_MOUSE_MODES: TerminalInputModes = Object.freeze({
	...INPUT_MODES,
	mouseEncoding: "sgr",
	mouseTracking: "any",
});
const X10_MOUSE_MODES: TerminalInputModes = Object.freeze({
	...INPUT_MODES,
	mouseEncoding: "default",
	mouseTracking: "any",
});
/** A child with no kitty protocol, no bracketed paste, and no application cursor keys. */
const PLAIN_TEXT_MODES: TerminalInputModes = Object.freeze({
	...INPUT_MODES,
	kittyFlags: 0,
	modifyOtherKeys: 0,
	bracketedPaste: false,
	applicationCursorKeys: false,
});

function sameScopeFacts(left: NativeViewerInputSource, right: NativeViewerInputSource): boolean {
	return left.hostRunId === right.hostRunId
		&& left.viewerId === right.viewerId
		&& left.viewerRevision === right.viewerRevision
		&& left.rowId === right.rowId
		&& left.nativeSession.sessionId === right.nativeSession.sessionId
		&& left.nativeSession.epoch === right.nativeSession.epoch
		&& left.geometry.cols === right.geometry.cols
		&& left.geometry.rows === right.geometry.rows
		&& left.geometry.revision === right.geometry.revision
		&& left.registrationIdentity === right.registrationIdentity
		&& left.registrationGeneration === right.registrationGeneration
		&& left.sourceToken === right.sourceToken;
}

function sameModesFacts(left: TerminalInputModes, right: TerminalInputModes): boolean {
	return left.kittyFlags === right.kittyFlags
		&& left.modifyOtherKeys === right.modifyOtherKeys
		&& left.bracketedPaste === right.bracketedPaste
		&& left.applicationCursorKeys === right.applicationCursorKeys
		&& left.mouseEncoding === right.mouseEncoding
		&& left.mouseTracking === right.mouseTracking;
}

/** A source view that provides none of the native IO primitives. */
function displayOnlySource(source: FakeContentSource): SessionContentSource {
	return {
		watchSessionContent: (rowId, listener) => source.watchSessionContent(rowId, listener),
		readInventorySnapshot: () => source.readInventorySnapshot(),
		openViewer: () => source.openViewer(),
		readViewer: (viewerId) => source.readViewer(viewerId),
		updateViewer: (viewerId, update) => source.updateViewer(viewerId, update),
		closeViewer: (viewerId) => source.closeViewer(viewerId),
	};
}

/** A hello from a peer that offered the optional extension. */
function nativeIoHello(overrides: Partial<SessionContentHelloFrame> = {}): Partial<SessionContentHelloFrame> {
	return { capabilities: [...NATIVE_IO_CAPABILITIES], ...overrides };
}

/** Hello on a negotiated channel, asserting the acknowledgement carried the offer. */
async function openNativeHello(harness: Harness): Promise<void> {
	harness.channel.deliver(helloFrame(nativeIoHello()));
	await settle();
	assert.deepEqual(
		onlyFrameOfType(harness.channel.frames(), "hello_ack").capabilities,
		NATIVE_IO_CAPABILITIES,
		"an explicit opt-in with a real provider acknowledges the peer's own offer",
	);
}

/** The input source carried by the last published viewport, if any. */
function publishedSource(channel: ContentChannel): NativeIoSource | null | undefined {
	const begin = framesOfType(channel.frames(), "content_begin").at(-1);
	assert.ok(begin !== undefined, "a viewport must have been published");
	const stated = begin.inputSource;
	// This fake publishes tuple-carrying viewports only; a startup source here is a defect.
	if (stated !== undefined && stated !== null && isNativeIoStartupSource(stated)) {
		throw new Error("a tuple-carrying publish never states a startup source");
	}
	return stated;
}

/** Subscribe a negotiated binding and return the source this endpoint published. */
async function subscribeNative(harness: Harness, overrides: Partial<SessionContentSubscribeFrame> = {}): Promise<NativeIoSource> {
	harness.channel.deliver(subscribeFrame(harness.source, overrides));
	await settle();
	assert.equal(harness.binding.subscribed, true, "the native IO subscription must be live");
	const published = publishedSource(harness.channel);
	assert.ok(published !== null && published !== undefined, "a negotiated publish carries the input source");
	return published;
}

/** The CURRENT wire source of one surface, exactly as its owner sees it. */
function wireSourceOf(source: FakeContentSource, viewerId: string): NativeIoSource {
	const scope = source.readViewerInputSource(viewerId);
	assert.ok(scope !== undefined, "the surface must have a current input scope");
	return {
		hostRunId: scope.hostRunId,
		sessionId: scope.rowId,
		nativeSession: { sessionId: scope.nativeSession.sessionId, epoch: scope.nativeSession.epoch },
		geometry: { cols: scope.geometry.cols, rows: scope.geometry.rows, revision: scope.geometry.revision },
		viewerRevision: scope.viewerRevision,
		sourceToken: scope.sourceToken,
	};
}

/** A syntactically valid source for a surface that never existed here. */
function foreignWireSource(overrides: Partial<NativeIoSource> = {}): NativeIoSource {
	return {
		hostRunId: OTHER_RUN,
		sessionId: "row-z",
		nativeSession: { sessionId: "conversation-row-z", epoch: 1 },
		geometry: { cols: 80, rows: 24, revision: 0 },
		viewerRevision: 1,
		sourceToken: "token-foreign",
		...overrides,
	};
}

function deliverBuilt(channel: ContentChannel, built: NativeIoBuiltTransfer): void {
	for (const frame of built.frames) channel.deliverBytes(frame);
}

/** Send one complete inline input through the protocol's own builder. */
function sendNativeInput(channel: ContentChannel, send: {
	readonly source: NativeIoSource;
	readonly kind: NativeIoInputKind;
	readonly data: string;
	readonly ordinal: number;
	readonly subscriptionId?: string;
	readonly inputModes?: TerminalInputModes;
	readonly inputId?: string;
}): void {
	deliverBuilt(channel, buildNativeInputInline({
		subscriptionId: send.subscriptionId ?? "sub-1",
		inputId: send.inputId ?? randomUUID(),
		ordinal: send.ordinal,
		source: send.source,
		inputModes: send.inputModes ?? INPUT_MODES,
		kind: send.kind,
		data: send.data,
		bounds: DEFAULT_SESSION_CONTENT_BOUNDS,
	}));
}

/** Build one atomic paged paste; the caller decides which pages to deliver. */
function buildPaste(send: {
	readonly source: NativeIoSource;
	readonly ordinal: number;
	readonly text: string;
	readonly subscriptionId?: string;
	readonly inputModes?: TerminalInputModes;
	readonly bounds?: SessionContentBounds;
}): NativeIoBuiltTransfer {
	return buildNativeInputPaste({
		subscriptionId: send.subscriptionId ?? "sub-1",
		inputId: randomUUID(),
		ordinal: send.ordinal,
		source: send.source,
		inputModes: send.inputModes ?? INPUT_MODES,
		text: send.text,
		bounds: send.bounds ?? DEFAULT_SESSION_CONTENT_BOUNDS,
	});
}

/** Reassemble every native copy emission a peer actually received. */
function assembledCopies(frames: readonly SessionContentFrame[]): NativeIoCompletedCopy[] {
	const assembler = createNativeCopyAssembler(DEFAULT_SESSION_CONTENT_BOUNDS);
	const copies: NativeIoCompletedCopy[] = [];
	for (const frame of frames) {
		if (frame.type !== "copy" && frame.type !== "copy_begin" && frame.type !== "copy_chunk"
			&& frame.type !== "copy_end") continue;
		const copy = assembler.accept(frame);
		if (copy !== undefined) copies.push(copy);
	}
	return copies;
}

/** Copies received since `mark` frames were written, so sequences stay fresh. */
function copiesSince(channel: ContentChannel, mark: number): NativeIoCompletedCopy[] {
	return assembledCopies(channel.frames().slice(mark));
}

function copyEventOf(text: string, rowId = "row-a"): NativeClipboardEvent {
	return {
		kind: "copy",
		encoded: Buffer.from(text, "utf8").toString("base64"),
		sessionId: `conversation-${rowId}`,
		sessionEpoch: 3,
	};
}

function decodedCopy(copy: NativeIoCompletedCopy): string {
	assert.equal(copy.event.kind, "copy");
	if (copy.event.kind !== "copy") return "";
	return Buffer.from(copy.event.encoded, "base64").toString("utf8");
}

/** The bytes this endpoint handed to the child, as text. */
function handedText(source: FakeContentSource, index = 0): string {
	const write = source.inputWrites[index];
	assert.ok(write !== undefined, "a handoff must have happened");
	return typeof write.data === "string" ? write.data : Buffer.from(write.data).toString("utf8");
}

/**
 * A live native IO subscription whose child reports `modes`, with the source this
 * endpoint published. The caller owns the returned harness and must stop it.
 */
async function openInputCase(
	modes: TerminalInputModes,
	geometry: { readonly cols?: number; readonly rows?: number } = {},
): Promise<{
	readonly source: FakeContentSource;
	readonly harness: Harness;
	readonly published: NativeIoSource;
}> {
	const source = new FakeContentSource();
	const cols = geometry.cols ?? 80;
	const rows = geometry.rows ?? 24;
	source.addRow("row-a", cols, rows);
	source.inputModes = modes;
	const harness = createHarness({ source, nativeIo: true });
	await openNativeHello(harness);
	const published = await subscribeNative(harness, { cols, rows });
	return { source, harness, published };
}

/* ------------------------------------------------------------------------- *
 * Lane and handshake
 * ------------------------------------------------------------------------- */

test("only a content lane channel is attached; an app lane channel is left completely untouched", () => {
	const source = new FakeContentSource();
	const appChannel = new ContentChannel("app");
	const host = createSessionContentHost({ source, authorizePeer: () => true });
	assert.throws(() => host.attach(appChannel), (error: unknown) => error instanceof TypeError);
	assert.equal(appChannel.handlerCount, 0, "no receiver is installed on the application lane");
	assert.equal(appChannel.sent.length, 0, "nothing is written to the application lane");
	assert.equal(appChannel.closeCalls, 0, "the application lane is never closed here");
	assert.equal(host.activeBindingCount, 0);
	assert.equal(source.inventoryReads, 0);
	assert.equal(source.watches.length, 0);
	assert.equal(source.viewers.size, 0);
});

test("the receiver is installed synchronously and nothing crosses before a valid hello", async () => {
	const harness = createHarness();
	const { channel, source, binding, host } = harness;
	try {
		assert.equal(channel.handlerCount, 1, "the message receiver is installed before attach returns");
		assert.equal(binding.subscribed, false);
		await settle();
		assert.equal(channel.sent.length, 0, "the owner is never eager");

		// A subscribe before any hello is a violation and mutates no source.
		channel.deliver(subscribeFrame(source));
		await settle();
		const refusal = onlyFrameOfType(channel.frames(), "error");
		assert.equal(refusal.code, "bad_frame");
		assert.equal(source.inventoryReads, 0);
		assert.equal(source.watches.length, 0);
		assert.equal(source.viewers.size, 0);
	} finally {
		await host.stopAll();
	}
});

test("hello negotiation is exact and never eager: no content before hello and subscribe", async () => {
	// A foreign service, a different major, and a missing required capability are
	// refused rather than adapted.
	const cases: Array<{
		readonly overrides: Partial<SessionContentHelloFrame>;
		readonly expected: "unsupported_version" | "missing_capability";
	}> = [
		{ overrides: { service: "pi-peer-roster-v1" }, expected: "unsupported_version" },
		{ overrides: { major: SESSION_CONTENT_MAJOR + 1 }, expected: "unsupported_version" },
		{ overrides: { capabilities: [] }, expected: "missing_capability" },
	];
	for (const { overrides, expected } of cases) {
		const harness = createHarness();
		try {
			await openHello(harness, overrides);
			const refusal = onlyFrameOfType(harness.channel.frames(), "error");
			assert.equal(refusal.code, expected);
			assert.equal(framesOfType(harness.channel.frames(), "hello_ack").length, 0);
			assert.equal(harness.source.watches.length, 0);
			assert.equal(harness.source.viewers.size, 0);
		} finally {
			await harness.host.stopAll();
		}
	}

	const harness = createHarness();
	try {
		// An unimplemented optional capability is never echoed back as if it existed.
		await openHello(harness, { capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, "not-implemented-v9"] });
		const ack = onlyFrameOfType(harness.channel.frames(), "hello_ack");
		assert.equal(ack.service, SESSION_CONTENT_SERVICE);
		assert.equal(ack.major, SESSION_CONTENT_MAJOR);
		assert.equal(ack.minor, SESSION_CONTENT_MINOR);
		assert.deepEqual(ack.capabilities, [SESSION_CONTENT_REQUIRED_CAPABILITY]);
		assert.equal(harness.channel.sent.length, 1, "the acknowledgement carries no viewport content");
		assert.equal(harness.source.watches.length, 0, "no watch exists before a subscription");
		assert.equal(harness.source.viewers.size, 0, "no viewer exists before a subscription");
		assert.equal(harness.host.activeSubscriptionCount, 0);
		assert.equal(harness.binding.subscriptionId, null);
		assert.equal(harness.binding.viewerId, null);
	} finally {
		await harness.host.stopAll();
	}
});

test("the owner hello deadline is finite, from the roster defaults, and only positive overrides are accepted", async () => {
	assert.equal(DEFAULT_ROSTER_BRIDGE_BOUNDS.helloTimeoutMs, 10_000);
	for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(
			() => createSessionContentHost({
				source: new FakeContentSource(),
				authorizePeer: () => true,
				timeouts: { helloTimeoutMs: value },
			}),
			(error: unknown) => error instanceof TypeError,
		);
	}
	assert.throws(
		() => createSessionContentHost({
			source: new FakeContentSource(),
			authorizePeer: () => true,
			timeouts: { unknownTimeoutMs: 5 } as unknown as { readonly helloTimeoutMs?: number },
		}),
		(error: unknown) => error instanceof TypeError,
	);
	const harness = createHarness({ timeouts: { helloTimeoutMs: 20 } });
	try {
		await waitFor(() => harness.channel.sent.length > 0, "the hello deadline must be finite");
		const refusal = onlyFrameOfType(harness.channel.frames(), "error");
		assert.equal(refusal.code, "protocol_violation");
		await harness.binding.closed;
		assert.equal(harness.channel.handlerCount, 0, "a timed-out endpoint detaches");
		assert.equal(harness.source.watches.length, 0);
		assert.equal(harness.source.viewers.size, 0);
		assert.equal(harness.channel.closeCalls, 0, "a hello timeout fences the endpoint; the transport owns the socket");
	} finally {
		await harness.host.stopAll();
	}
});

/* ------------------------------------------------------------------------- *
 * Run and row fencing before any mutation
 * ------------------------------------------------------------------------- */

test("a stale owner run, unknown row, or unavailable inventory is refused before a viewer exists", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, binding, host } = harness;
	try {
		await openHello(harness);
		const refused = (): void => {
			const errors = framesOfType(channel.frames(), "error");
			assert.ok(errors.length >= 1, "the request is answered with one fixed refusal");
			assert.equal(errors[errors.length - 1]?.code, "unavailable");
			assert.equal(source.inventoryReads >= 1, true);
			assert.equal(source.installedRowIds.length, 0, "nothing is watched for a stale request");
			assert.equal(source.viewers.size, 0, "no viewer is registered for a stale request");
			assert.equal(binding.subscribed, false);
			assert.equal(host.activeSubscriptionCount, 0);
		};

		channel.deliver(subscribeFrame(source, { hostRunId: OTHER_RUN }));
		await settle();
		refused();
		assert.ok(harness.diagnostics.includes("run_changed"));

		channel.deliver(subscribeFrame(source, { sessionId: "row-missing" }));
		await settle();
		refused();

		source.inventoryUnavailable = true;
		channel.deliver(subscribeFrame(source));
		await settle();
		refused();

		// The same endpoint still accepts a correct request afterwards.
		source.inventoryUnavailable = false;
		channel.deliver(subscribeFrame(source));
		await settle();
		onlyFrameOfType(channel.frames(), "subscribed");
		assert.equal(source.liveWatches.length, 1);
		assert.equal(source.viewers.size, 1);
		assert.equal(binding.subscribed, true);
	} finally {
		await host.stopAll();
	}
});

test("a watch installed for another owner run is refused before the viewer mutation", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	source.watchRunOverride = OTHER_RUN;
	const harness = createHarness({ source });
	const { channel, host } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle();
		const refusal = framesOfType(channel.frames(), "error").at(-1);
		assert.ok(refusal !== undefined && refusal.type === "error" && refusal.code === "unavailable");
		assert.equal(source.viewers.size, 0, "the install-run check happens before any viewer is opened");
		assert.equal(source.updateCalls.length, 0);
		assert.equal(source.liveWatches.length, 0, "the mismatched watch is retired, not adopted");
		assert.equal(source.watches[0]?.unsubscribed, 1);
		assert.equal(harness.binding.subscriptionId, null);
		assert.equal(harness.binding.viewerId, null);
	} finally {
		await host.stopAll();
	}
});

test("only the selected row is watched and a change to another row publishes nothing", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	source.addRow("row-b", 100, 30);
	const harness = createHarness({ source });
	const { channel, binding, host } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle();
		assert.deepEqual(source.installedRowIds, ["row-a"]);
		assert.equal(source.watches.length, 1);
		assert.equal(binding.subscriptionId, "sub-1");

		const contentBefore = channel.frames().filter((frame) => frame.type.startsWith("content")).length;
		source.emit("row-b");
		await settle();
		const contentAfter = channel.frames().filter((frame) => frame.type.startsWith("content")).length;
		assert.equal(contentAfter, contentBefore, "a change to another row never captures this row");
		assert.equal(source.installedRowIds.length, 1);
	} finally {
		await host.stopAll();
	}
});

/* ------------------------------------------------------------------------- *
 * One independent viewer and canonical geometry
 * ------------------------------------------------------------------------- */

test("one independent viewer is registered and only canonical geometry is published", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 90, 30);
	const sibling = source.openViewer();
	assert.ok(sibling !== undefined);
	const siblingApplied = source.updateViewer(sibling.viewerId, { sessionId: "row-a", cols: 100, rows: 30 });
	assert.equal(siblingApplied.applied, true);
	const siblingFacts = source.readViewer(sibling.viewerId);

	const harness = createHarness({ source });
	const { channel, binding, host } = harness;
	try {
		await openHello(harness);
		// A larger request than the sibling must not enlarge the row: the manager's
		// canonical geometry is the independent minimum of its viewers.
		channel.deliver(subscribeFrame(source, { cols: 200, rows: 50 }));
		await settle();
		assert.equal(source.viewers.size, 2, "exactly one new viewer is registered for this endpoint");
		const ownViewer = binding.viewerId;
		assert.ok(ownViewer !== null);
		assert.notEqual(ownViewer, sibling.viewerId);
		assert.equal(source.updateCalls.filter((call) => call.viewerId === sibling.viewerId).length, 1,
			"the sibling viewer is never changed by this endpoint");
		const firstBegin = onlyFrameOfType(channel.frames(), "content_begin");
		assert.deepEqual({ cols: firstBegin.geometry.cols, rows: firstBegin.geometry.rows }, { cols: 100, rows: 30 },
			"the published geometry is canonical, never the requested size");

		// A smaller request does contribute: the minimum moves down.
		channel.deliver(resizeFrame({ cols: 60, rows: 20 }));
		await settle();
		const begins = framesOfType(channel.frames(), "content_begin");
		assert.ok(begins.length >= 2);
		assert.deepEqual(
			{ cols: begins[begins.length - 1]?.geometry.cols, rows: begins[begins.length - 1]?.geometry.rows },
			{ cols: 60, rows: 20 },
		);
		assert.deepEqual(source.readViewer(sibling.viewerId), siblingFacts, "a resize never touches a sibling viewer");
		assert.deepEqual(
			source.updateCalls.filter((call) => call.viewerId === sibling.viewerId).map((call) => call.update),
			[{ sessionId: "row-a", cols: 100, rows: 30 }],
		);

		// Unsubscribing releases only this endpoint's viewer and restores the
		// sibling's canonical contribution.
		channel.deliver({ type: "unsubscribe", subscriptionId: "sub-1" });
		await settle();
		onlyFrameOfType(channel.frames(), "unsubscribed");
		assert.equal(binding.viewerId, null, "a confirmed release clears the recorded viewer");
		assert.deepEqual(source.closedViewerIds, [ownViewer], "only this endpoint's own viewer is released");
		assert.equal(source.viewers.size, 1);
		assert.equal(source.viewers.has(sibling.viewerId), true);
		const restored = source.geometryOf("row-a");
		assert.deepEqual({ cols: restored.cols, rows: restored.rows }, { cols: 100, rows: 30 });
		assert.equal(framesOfType(channel.frames(), "error").length, 0, "a clean retirement writes no error");

		// With no viewer at all the row keeps its last canonical geometry.
		source.closeViewer(sibling.viewerId);
		assert.deepEqual(source.geometryOf("row-a"), restored, "zero viewers keeps the last canonical geometry");
	} finally {
		await host.stopAll();
	}
});

/* ------------------------------------------------------------------------- *
 * Newest-wins delivery
 * ------------------------------------------------------------------------- */

test("a reentrant post-resize observation wins over the install sample", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	// The source publishes a newer observation while the subscription is still
	// being installed (the manager's own resize recompute would do this).
	source.updateHook = (rowId) => {
		source.emit(rowId);
	};
	const harness = createHarness({ source });
	const { channel, host } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle();
		const watch = source.watches[0];
		assert.ok(watch !== undefined);
		const firstBegin = onlyFrameOfType(channel.frames(), "content_begin");
		assert.notEqual(firstBegin.sequence, watch.snapshot.sequence,
			"the older install sample is never published over a newer one");
		assert.equal(firstBegin.sequence, source.lastSequence, "the newest retained observation is published first");
		assert.ok(
			channel.types().indexOf("subscribed") < channel.types().indexOf("content_begin"),
			"subscribed is written before any content",
		);
	} finally {
		await host.stopAll();
	}
});

test("one in-flight transfer plus one newest-wins pending snapshot, never a queue of stale ones", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, bounds: { maxChunkPayloadBytes: 300 } });
	const { channel, host, diagnostics } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle();
		const settledBegins = framesOfType(channel.frames(), "content_begin");
		assert.equal(settledBegins.length, 1);
		const firstSequence = settledBegins[0]?.sequence;

		// Park the next transfer's first write, then publish several newer snapshots.
		channel.holdNextSend = true;
		const inFlight = source.emit("row-a");
		await settle();
		assert.equal(channel.heldWrites, 1, "the in-flight transfer is holding the single send slot");
		const newer = [
			source.emit("row-a"),
			source.emit("row-a"),
			source.emit("row-a"),
		];
		await settle();
		assert.equal(channel.heldWrites, 1, "no second write is started while the slot is held");
		channel.release();
		await settle(20);

		const begins = framesOfType(channel.frames(), "content_begin").map((frame) => frame.sequence);
		assert.deepEqual(begins, [firstSequence, inFlight.sequence, newer[2]?.sequence],
			"only the newest retained snapshot follows the in-flight transfer");
		for (const skipped of newer.slice(0, 2)) {
			assert.equal(begins.includes(skipped.sequence), false, "a superseded snapshot is never published");
		}
		assert.ok(diagnostics.filter((code) => code === "viewport_pending_replaced").length >= 2);

		// Every published transfer is complete and decodes to one coherent viewport.
		const snapshots = assembleTransfers(channel.frames(), { maxChunkPayloadBytes: 300 });
		assert.deepEqual(snapshots.map((snapshot) => snapshot.meta.sequence), begins);
		for (const snapshot of snapshots) {
			assert.deepEqual(snapshot.meta.geometry, source.geometryOf("row-a"));
			assert.equal(snapshot.frame.cols, snapshot.meta.geometry.cols);
			assert.equal(snapshot.frame.rows, snapshot.meta.geometry.rows);
		}
	} finally {
		await host.stopAll();
	}
});

/* ------------------------------------------------------------------------- *
 * Authorization
 * ------------------------------------------------------------------------- */

test("authorization revoked between frames stops further content and retires local resources", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, bounds: { maxChunkPayloadBytes: 300 } });
	const { channel, host, allow, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle(20);
		assert.equal(framesOfType(channel.frames(), "content_end").length, 1);
		const endsBefore = 1;
		const beginsBefore = framesOfType(channel.frames(), "content_begin").length;
		const chunksBefore = framesOfType(channel.frames(), "content_chunk").length;

		channel.holdNextSend = true;
		source.emit("row-a");
		await settle();
		assert.equal(channel.heldWrites, 1, "the next transfer is mid-flight");
		allow.value = false;
		channel.release();
		await settle(20);

		const frames = channel.frames();
		const refusals = framesOfType(frames, "error");
		assert.equal(refusals.length, 1, "exactly one fixed refusal is written");
		assert.equal(refusals[0]?.code, "not_authorized");
		assert.equal(framesOfType(frames, "content_begin").length, beginsBefore + 1,
			"the interrupted transfer declared itself and then stopped");
		assert.equal(framesOfType(frames, "content_chunk").length, chunksBefore,
			"no content payload is written after the revocation");
		assert.equal(framesOfType(frames, "content_end").length, endsBefore,
			"no later frame of the interrupted transfer is written");
		assert.equal(binding.subscribed, false);
		assert.equal(binding.subscriptionId, null);
		assert.equal(binding.viewerId, null, "the endpoint's own viewer is released on revocation");
		assert.equal(source.liveWatches.length, 0, "the source watch is retired on revocation");
		assert.equal(source.viewers.size, 0);
		assert.equal(channel.closeCalls, 1, "the content channel is closed through its bounded close");
		assert.ok(diagnostics.includes("authorization_refused"));
	} finally {
		await host.stopAll();
	}
});

test("a throwing authorizer is a refusal, never an implicit allow", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	let allow = true;
	const harness = createHarness({
		source,
		authorizePeer: () => {
			if (!allow) throw new Error("authorizer unavailable");
			return true;
		},
	});
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		allow = false;
		channel.deliver(subscribeFrame(source));
		await settle();
		const refusals = framesOfType(channel.frames(), "error");
		assert.equal(refusals.at(-1)?.code, "not_authorized");
		assert.equal(source.watches.length, 0, "a refused request installs nothing");
		assert.equal(source.viewers.size, 0);
		assert.equal(binding.subscribed, false);
		assert.equal(channel.closeCalls, 1);
	} finally {
		await host.stopAll();
	}
});

test("a revoked peer cannot keep its viewer by repeating duplicate or unrelated requests", async () => {
	// (a) An idle duplicate subscribe after a revocation retires the endpoint
	// instead of being answered as an ordinary duplicate.
	const sourceA = new FakeContentSource();
	sourceA.addRow("row-a", 80, 24);
	const harnessA = createHarness({ source: sourceA });
	try {
		await openHello(harnessA);
		harnessA.channel.deliver(subscribeFrame(sourceA));
		await settle(10);
		assert.equal(sourceA.viewers.size, 1);
		assert.equal(harnessA.binding.subscribed, true);

		harnessA.allow.value = false;
		const errorsBefore = framesOfType(harnessA.channel.frames(), "error").length;
		harnessA.channel.deliver(subscribeFrame(sourceA, { subscriptionId: "sub-dup" }));
		await settle(20);
		const errors = framesOfType(harnessA.channel.frames(), "error");
		assert.equal(errors.length, errorsBefore + 1);
		assert.equal(errors.at(-1)?.code, "not_authorized", "a revoked duplicate is never answered as a duplicate");
		assert.equal(framesOfType(harnessA.channel.frames(), "subscribed").length, 1);
		assert.equal(sourceA.liveWatches.length, 0, "the revoked subscription is retired");
		assert.equal(sourceA.viewers.size, 0, "the revoked subscription releases its own viewer");
		assert.equal(harnessA.binding.subscribed, false);
		assert.equal(harnessA.binding.viewerId, null);
		assert.equal(harnessA.binding.subscriptionId, null);
		assert.equal(harnessA.channel.closeCalls, 1);
	} finally {
		await harnessA.host.stopAll();
	}

	// (b) An unrelated unsubscribe after a revocation is a protected request too.
	const sourceB = new FakeContentSource();
	sourceB.addRow("row-a", 80, 24);
	const harnessB = createHarness({ source: sourceB });
	try {
		await openHello(harnessB);
		harnessB.channel.deliver(subscribeFrame(sourceB));
		await settle(10);

		harnessB.allow.value = false;
		harnessB.channel.deliver({ type: "unsubscribe", subscriptionId: "sub-not-mine" });
		await settle(20);
		assert.equal(framesOfType(harnessB.channel.frames(), "error").at(-1)?.code, "not_authorized");
		assert.equal(framesOfType(harnessB.channel.frames(), "unsubscribed").length, 0,
			"a revoked peer is never acknowledged as if it had retired cleanly");
		assert.equal(sourceB.liveWatches.length, 0);
		assert.equal(sourceB.viewers.size, 0);
		assert.equal(harnessB.binding.subscribed, false);
		assert.equal(harnessB.channel.closeCalls, 1);
	} finally {
		await harnessB.host.stopAll();
	}
});

test("a refused initial hello authorization writes no viewport and closes this content channel only", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, authorizePeer: () => false });
	const { channel, host, binding } = harness;
	try {
		channel.deliver(helloFrame());
		await settle();
		const refusal = onlyFrameOfType(channel.frames(), "error");
		assert.equal(refusal.code, "not_authorized");
		assert.equal(source.inventoryReads, 0);
		assert.equal(source.watches.length, 0);
		assert.equal(source.viewers.size, 0);
		assert.equal(binding.subscribed, false);
		await binding.closed;
		assert.equal(channel.handlerCount, 0);
	} finally {
		await host.stopAll();
	}
});

/* ------------------------------------------------------------------------- *
 * Subscription lifecycle
 * ------------------------------------------------------------------------- */

test("one subscription per channel: duplicates and floods are refused, and an explicit replacement works", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, host, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle();
		const firstViewer = binding.viewerId;
		assert.ok(firstViewer !== null);
		assert.equal(source.liveWatches.length, 1);

		// A second subscription is refused; the first is untouched.
		channel.deliver(subscribeFrame(source, { subscriptionId: "sub-2" }));
		await settle();
		let refusals = framesOfType(channel.frames(), "error");
		assert.equal(refusals.at(-1)?.code, "too_many_subscriptions");
		assert.equal(framesOfType(channel.frames(), "subscribed").length, 1);
		assert.equal(binding.subscriptionId, "sub-1");
		assert.equal(source.liveWatches.length, 1);
		assert.equal(source.viewers.size, 1);

		// A flood of duplicate attempts accumulates nothing at all: identical pending
		// refusals coalesce, so the bounded writer is never grown by repetition.
		for (let index = 0; index < 20; index += 1) {
			channel.deliver(subscribeFrame(source, { subscriptionId: `sub-flood-${index}` }));
		}
		await settle();
		refusals = framesOfType(channel.frames(), "error");
		assert.ok(refusals.length >= 1 && refusals.length <= 3, `bounded refusals, got ${refusals.length}`);
		assert.equal(refusals.every((frame) => frame.code === "too_many_subscriptions"), true);
		assert.equal(source.watches.length, 1);
		assert.equal(source.viewers.size, 1);
		assert.equal(source.liveWatches.length, 1);
		assert.equal(channel.heldWrites, 0, "a flood never leaves outstanding writes behind");
		assert.equal(binding.subscribed, true, "a duplicate flood is refused without ending the subscription");
		assert.ok(diagnostics.filter((code) => code === "protocol_violation").length >= 1);

		// A replacement is an explicit unsubscribe followed by a fresh subscribe.
		channel.deliver({ type: "unsubscribe", subscriptionId: "sub-1" });
		await settle();
		onlyFrameOfType(channel.frames(), "unsubscribed");
		assert.equal(source.liveWatches.length, 0);
		assert.equal(binding.viewerId, null);
		assert.equal(binding.subscriptionId, null);

		channel.deliver(subscribeFrame(source, { subscriptionId: "sub-2" }));
		await settle();
		assert.equal(framesOfType(channel.frames(), "subscribed").length, 2);
		assert.equal(binding.subscriptionId, "sub-2");
		assert.notEqual(binding.viewerId, firstViewer);
		assert.equal(source.liveWatches.length, 1);
		assert.equal(source.viewers.size, 1);
		assert.equal(source.viewers.has(firstViewer), false);
	} finally {
		await host.stopAll();
	}
});

test("a failed install never loses or duplicates its own viewer", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	source.refuseUpdate = true;
	source.refuseViewerClose = true;
	const harness = createHarness({ source });
	const { channel, host, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle(10);
		assert.equal(binding.subscribed, false);
		const ownedViewer = binding.viewerId;
		assert.ok(ownedViewer !== null, "the viewer is owned from the moment the source returns it");
		assert.equal(source.viewers.size, 1);
		assert.equal(source.liveWatches.length, 0, "the failed attempt retires the watch it acquired");
		assert.ok(diagnostics.includes("viewer_release_uncertain"));

		// Repeated attempts must neither register another viewer nor install a watch
		// on top of an unproven release.
		for (let index = 0; index < 3; index += 1) {
			channel.deliver(subscribeFrame(source, { subscriptionId: `sub-retry-${index}` }));
		}
		await settle(10);
		assert.equal(source.viewers.size, 1, "no replacement viewer is registered over an unproven release");
		assert.equal(source.installedRowIds.length, 1, "refused retries install no further watch");
		assert.equal(binding.viewerId, ownedViewer);
		assert.equal(framesOfType(channel.frames(), "error").every((frame) => frame.code === "unavailable"), true);

		// The failure is latched at the operation that failed, so a source that could
		// confirm a later release never turns it into settled cleanup.
		source.refuseViewerClose = false;
		await assert.rejects(host.stopAll(), isCloseFailure);
		await assert.rejects(binding.closed, isCloseFailure);
		assert.equal(binding.viewerId, ownedViewer, "the retained viewer is never retried into success");
		assert.equal(source.viewers.size, 1);
		assert.equal(source.closedViewerIds.length, 0);
		assert.equal(host.activeBindingCount, 1);
	} finally {
		source.refuseViewerClose = false;
		await host.stopAll().catch(() => undefined);
	}

	// A throwing release is uncertainty too, never silent cleanup.
	const throwingSource = new FakeContentSource();
	throwingSource.addRow("row-a", 80, 24);
	throwingSource.refuseUpdate = true;
	throwingSource.throwOnCloseViewer = true;
	const throwingHarness = createHarness({ source: throwingSource });
	try {
		await openHello(throwingHarness);
		throwingHarness.channel.deliver(subscribeFrame(throwingSource));
		await settle(10);
		assert.ok(throwingHarness.binding.viewerId !== null);
		assert.equal(throwingSource.viewers.size, 1);
		assert.ok(throwingHarness.diagnostics.includes("viewer_release_uncertain"));
		throwingSource.throwOnCloseViewer = false;
		await assert.rejects(throwingHarness.host.stopAll(), isCloseFailure);
		assert.ok(throwingHarness.binding.viewerId !== null, "a throwing release is latched too");
		assert.equal(throwingSource.viewers.size, 1);
	} finally {
		throwingSource.throwOnCloseViewer = false;
		await throwingHarness.host.stopAll().catch(() => undefined);
	}
});

test("a reentrant stop during installation leaves nothing behind and announces nothing", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		let stoppedDuringInstall = false;
		source.updateHook = () => {
			stoppedDuringInstall = true;
			void binding.stop();
		};
		channel.deliver(subscribeFrame(source));
		await settle(20);
		await binding.closed;
		assert.equal(stoppedDuringInstall, true, "the stop happened while the subscription was installing");
		assert.equal(framesOfType(channel.frames(), "subscribed").length, 0, "a cancelled install announces nothing");
		assert.equal(framesOfType(channel.frames(), "content_begin").length, 0);
		assert.equal(binding.subscribed, false);
		assert.equal(binding.subscriptionId, null);
		assert.equal(binding.viewerId, null, "the viewer acquired during installation was released");
		assert.equal(source.liveWatches.length, 0, "the watch acquired during installation was retired");
		assert.equal(source.viewers.size, 0);
		assert.equal(source.closedViewerIds.length, 1);
		assert.equal(channel.closeCalls, 1);
	} finally {
		await host.stopAll();
	}
});

test("a viewer allocated by a reentrantly stopping source is still retired", async () => {
	// (a) The source stops the binding from inside openViewer and then hands back a
	// freshly allocated viewer. Nothing is announced and that viewer is released.
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	try {
		await openHello(harness);
		source.openViewerHook = () => {
			void harness.binding.stop();
		};
		harness.channel.deliver(subscribeFrame(source));
		await settle(20);
		await harness.binding.closed;
		assert.equal(framesOfType(harness.channel.frames(), "subscribed").length, 0, "nothing is announced");
		assert.equal(framesOfType(harness.channel.frames(), "content_begin").length, 0);
		assert.equal(harness.binding.subscribed, false);
		assert.equal(harness.binding.subscriptionId, null);
		assert.equal(harness.binding.viewerId, null, "the viewer allocated during the cancel is released");
		assert.equal(source.liveWatches.length, 0);
		assert.equal(source.viewers.size, 0);
		assert.equal(source.closedViewerIds.length, 1);
		assert.equal(harness.channel.closeCalls, 1);
	} finally {
		await harness.host.stopAll();
	}

	// (b) When that release cannot be confirmed, the acquired viewer stays visible,
	// the binding and the host both settle as the one fixed failure, and no later
	// call turns that uncertainty into claimed cleanup.
	const refusedSource = new FakeContentSource();
	refusedSource.addRow("row-a", 80, 24);
	refusedSource.refuseViewerClose = true;
	const refusedHarness = createHarness({ source: refusedSource });
	try {
		await openHello(refusedHarness);
		refusedSource.openViewerHook = () => {
			void refusedHarness.binding.stop();
		};
		refusedHarness.channel.deliver(subscribeFrame(refusedSource));
		await settle(20);
		await assert.rejects(refusedHarness.binding.closed, isCloseFailure);
		assert.equal(framesOfType(refusedHarness.channel.frames(), "subscribed").length, 0);
		const refusedViewer = refusedHarness.binding.viewerId;
		assert.ok(refusedViewer !== null, "an unproven release keeps the acquired viewer visible");
		assert.equal(refusedSource.viewers.size, 1);
		assert.ok(refusedHarness.diagnostics.includes("viewer_release_uncertain"));
		assert.equal(refusedHarness.host.activeBindingCount, 1, "the unconfirmed binding stays owned");
		assert.equal(refusedHarness.host.activeSubscriptionCount, 1,
			"an unconfirmed owner viewer participant stays counted");

		refusedSource.refuseViewerClose = false;
		await assert.rejects(refusedHarness.binding.stop(), isCloseFailure);
		await assert.rejects(refusedHarness.host.stopAll(), isCloseFailure);
		assert.equal(refusedHarness.binding.viewerId, refusedViewer,
			"a source that recovers later never turns the settled failure into success");
		assert.equal(refusedSource.viewers.size, 1);
	} finally {
		refusedSource.refuseViewerClose = false;
		await refusedHarness.binding.stop().catch(() => undefined);
		await refusedHarness.host.stopAll().catch(() => undefined);
	}
});

test("unsubscribe retires local resources before it acknowledges, and cancels queued content", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, bounds: { maxChunkPayloadBytes: 300 } });
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle();
		const publishedBefore = framesOfType(channel.frames(), "content_end").length;

		// Park a transfer mid-flight, then unsubscribe.
		channel.holdNextSend = true;
		source.emit("row-a");
		await settle();
		assert.equal(channel.heldWrites, 1);
		const viewer = binding.viewerId;
		assert.ok(viewer !== null);
		channel.deliver({ type: "unsubscribe", subscriptionId: "sub-1" });
		await settle();

		const unwatchAt = channel.events.indexOf("unwatch:row-a");
		const closeAt = channel.events.indexOf(`closeViewer:${viewer}`);
		assert.ok(unwatchAt >= 0 && closeAt >= 0);
		assert.equal(channel.events.indexOf("send:unsubscribed"), -1,
			"the acknowledgement waits for the single send slot");
		assert.equal(binding.subscriptionId, null);
		assert.equal(binding.viewerId, null);

		channel.release();
		await settle(20);
		const ackAt = channel.events.indexOf("send:unsubscribed");
		assert.ok(ackAt >= 0, "the acknowledgement is admitted once the slot is free");
		assert.ok(unwatchAt < ackAt, "the source watch is retired before the acknowledgement");
		assert.ok(closeAt < ackAt, "the endpoint's own viewer is released before the acknowledgement");
		assert.equal(framesOfType(channel.frames(), "content_end").length, publishedBefore,
			"a write admitted before the unsubscribe is never resumed into a new transfer");
		assert.equal(source.liveWatches.length, 0);
		assert.equal(source.viewers.size, 0);
		assert.equal(framesOfType(channel.frames(), "error").length, 0);
	} finally {
		await host.stopAll();
	}
});

/* ------------------------------------------------------------------------- *
 * Unavailable source, transport loss, stop
 * ------------------------------------------------------------------------- */

test("source unavailability, transport loss, and stop retire local resources without touching a session", async () => {
	// (a) The row's content becomes unobservable.
	const sourceA = new FakeContentSource();
	sourceA.addRow("row-a", 80, 24);
	const harnessA = createHarness({ source: sourceA });
	try {
		await openHello(harnessA);
		harnessA.channel.deliver(subscribeFrame(sourceA));
		await settle();
		sourceA.emitUnavailable("row-a");
		await settle();
		const refusal = framesOfType(harnessA.channel.frames(), "error").at(-1);
		assert.ok(refusal !== undefined && refusal.code === "unavailable");
		assert.equal(harnessA.binding.subscribed, false);
		assert.equal(harnessA.binding.viewerId, null);
		assert.equal(sourceA.liveWatches.length, 0);
		assert.equal(sourceA.viewers.size, 0);
		assert.ok(harnessA.diagnostics.includes("source_unavailable"));
	} finally {
		await harnessA.host.stopAll();
	}

	// (b) A snapshot from another owner run can never continue this viewport.
	const sourceB = new FakeContentSource();
	sourceB.addRow("row-a", 80, 24);
	const harnessB = createHarness({ source: sourceB });
	try {
		await openHello(harnessB);
		harnessB.channel.deliver(subscribeFrame(sourceB));
		await settle();
		sourceB.emitRun("row-a", OTHER_RUN);
		await settle();
		const refusal = framesOfType(harnessB.channel.frames(), "error").at(-1);
		assert.ok(refusal !== undefined && refusal.code === "unavailable");
		assert.equal(harnessB.binding.subscribed, false);
		assert.equal(sourceB.liveWatches.length, 0);
		assert.equal(sourceB.viewers.size, 0);
		assert.ok(harnessB.diagnostics.includes("run_changed"));
	} finally {
		await harnessB.host.stopAll();
	}

	// (c) A snapshot for a replaced row is never published to this subscription.
	const sourceC = new FakeContentSource();
	sourceC.addRow("row-a", 80, 24);
	const harnessC = createHarness({ source: sourceC });
	try {
		await openHello(harnessC);
		harnessC.channel.deliver(subscribeFrame(sourceC));
		await settle();
		const endsBefore = framesOfType(harnessC.channel.frames(), "content_end").length;
		sourceC.emitReplacedRow("row-a", "row-b");
		await settle();
		assert.equal(framesOfType(harnessC.channel.frames(), "content_end").length, endsBefore,
			"a replaced row is never published");
		const refusal = framesOfType(harnessC.channel.frames(), "error").at(-1);
		assert.ok(refusal !== undefined && refusal.code === "unavailable");
		assert.equal(sourceC.liveWatches.length, 0);
		assert.equal(sourceC.viewers.size, 0);
	} finally {
		await harnessC.host.stopAll();
	}

	// (d) Transport loss retires local resources and never re-closes the socket.
	const sourceD = new FakeContentSource();
	sourceD.addRow("row-a", 80, 24);
	const harnessD = createHarness({ source: sourceD });
	try {
		await openHello(harnessD);
		harnessD.channel.deliver(subscribeFrame(sourceD));
		await settle();
		harnessD.channel.lose();
		await harnessD.binding.closed;
		assert.equal(sourceD.liveWatches.length, 0);
		assert.equal(sourceD.viewers.size, 0);
		assert.equal(harnessD.binding.subscribed, false);
		assert.equal(harnessD.channel.closeCalls, 0, "a lost channel is not closed again");
		assert.ok(harnessD.diagnostics.includes("channel_closed"));
	} finally {
		await harnessD.host.stopAll();
	}

	// (e) An explicit stop ends the exact subscription after local retirement.
	const sourceE = new FakeContentSource();
	sourceE.addRow("row-a", 80, 24);
	const harnessE = createHarness({ source: sourceE });
	try {
		await openHello(harnessE);
		harnessE.channel.deliver(subscribeFrame(sourceE));
		await settle();
		await harnessE.host.stopAll();
		const end = onlyFrameOfType(harnessE.channel.frames(), "end");
		assert.equal(end.subscriptionId, "sub-1");
		assert.equal(end.code, "stopped");
		assert.equal(sourceE.liveWatches.length, 0);
		assert.equal(sourceE.viewers.size, 0);
		assert.equal(harnessE.channel.closeCalls, 1, "stop closes the content channel through its bounded close");
		assert.equal(harnessE.host.activeBindingCount, 0);
		assert.equal(harnessE.host.activeSubscriptionCount, 0);
		assert.equal(harnessE.binding.subscribed, false);
		await harnessE.binding.closed;
	} finally {
		await harnessE.host.stopAll();
	}
});

/* ------------------------------------------------------------------------- *
 * Write failures and the stalled-write deadline
 * ------------------------------------------------------------------------- */

test("a rejected content write is owned: the subscription retires and the channel closes", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, bounds: { maxChunkPayloadBytes: 300 } });
	const { channel, host, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle(20);
		const endsBefore = framesOfType(channel.frames(), "content_end").length;

		channel.failNextSend = true;
		source.emit("row-a");
		await settle(20);

		const refusal = framesOfType(channel.frames(), "error").at(-1);
		assert.ok(refusal !== undefined && refusal.code === "send_failed");
		assert.equal(framesOfType(channel.frames(), "content_end").length, endsBefore);
		assert.equal(binding.subscribed, false);
		assert.equal(binding.viewerId, null);
		assert.equal(source.liveWatches.length, 0);
		assert.equal(source.viewers.size, 0);
		assert.equal(channel.closeCalls, 1);
		assert.ok(diagnostics.includes("send_failed"));
	} finally {
		await host.stopAll();
	}
});

test("a failed refusal write after an incompatible hello still closes the channel once", async () => {
	// (a) The refusal write itself is rejected.
	const rejected = createHarness();
	try {
		rejected.channel.failNextSend = true;
		rejected.channel.deliver(helloFrame({ major: SESSION_CONTENT_MAJOR + 1 }));
		await settle(20);
		await rejected.binding.closed;
		assert.equal(rejected.channel.closeCalls, 1, "a rejected refusal write closes the channel");
		assert.equal(framesOfType(rejected.channel.frames(), "hello_ack").length, 0);
		assert.ok(rejected.diagnostics.includes("send_failed"));
	} finally {
		await rejected.host.stopAll();
	}

	// (b) The refusal write stalls past the transfer deadline.
	const stalled = createHarness({ timeouts: { transferIdleTimeoutMs: 25 } });
	try {
		stalled.channel.stallNextSend = true;
		stalled.channel.deliver(helloFrame({ service: "pi-peer-other-content-v1" }));
		await waitFor(() => stalled.channel.closeCalls === 1, "a stalled refusal write must close the channel");
		await settle(20);
		assert.equal(stalled.channel.closeCalls, 1, "the bounded close happens exactly once");
		assert.equal(stalled.binding.subscribed, false);
		assert.equal(stalled.channel.handlerCount, 0);
		assert.ok(stalled.diagnostics.includes("send_timeout"));
	} finally {
		await stalled.host.stopAll();
	}
});

test("failed refusal writes retain ownership until their close is confirmed", async () => {
	// A non-closing fence (an incompatible hello) writes its refusal and then
	// settles. If that write is rejected or stalls, the close it triggers must
	// still belong to the settlement instead of being abandoned after a
	// successful-looking one.
	for (const stalledWrite of [false, true]) {
		for (const stalledClose of [false, true]) {
			const harness = createHarness({
				timeouts: { transferIdleTimeoutMs: 1_000, stopAckTimeoutMs: 25 },
			});
			try {
				harness.channel.failNextSend = !stalledWrite;
				harness.channel.stallNextSend = stalledWrite;
				harness.channel.refuseClose = !stalledClose;
				harness.channel.stallClose = stalledClose;
				harness.channel.deliver(helloFrame({ major: SESSION_CONTENT_MAJOR + 1 }));
				await waitFor(
					() => harness.diagnostics.includes("channel_close_uncertain"),
					"the refusal's close must have a bounded outcome",
				);
				await assert.rejects(harness.binding.closed, isCloseFailure);
				await assert.rejects(harness.binding.stop(), isCloseFailure);
				await assert.rejects(harness.host.stopAll(), isCloseFailure);
				await assert.rejects(harness.host.stopAll(), isCloseFailure);
				assert.equal(harness.host.activeBindingCount, 1);
				assert.equal(harness.channel.closeCalls, 1);
				const replacement = new ContentChannel();
				assert.throws(() => harness.host.attach(replacement), isCloseFailure);
				assert.equal(replacement.handlerCount, 0);
			} finally {
				await harness.host.stopAll().catch(() => undefined);
			}
		}
	}
});

test("a held write plus a control burst never accumulates outstanding writes", async () => {
	// (a) A duplicate flood behind a held write coalesces into one bounded refusal.
	const duplicateSource = new FakeContentSource();
	duplicateSource.addRow("row-a", 80, 24);
	const duplicateHarness = createHarness({ source: duplicateSource, timeouts: { transferIdleTimeoutMs: 2_000 } });
	try {
		const { channel, binding } = duplicateHarness;
		await openHello(duplicateHarness);
		channel.holdNextSend = true;
		channel.deliver(subscribeFrame(duplicateSource));
		await settle();
		assert.equal(channel.heldWrites, 1, "the acknowledgement holds the single write slot");

		for (let index = 0; index < 20; index += 1) {
			channel.deliver(subscribeFrame(duplicateSource, { subscriptionId: `sub-flood-${index}` }));
		}
		await settle();
		// Never more than one outstanding write, whatever the peer sends.
		assert.equal(channel.heldWrites, 1);
		channel.release();
		await settle(30);
		assert.equal(channel.heldWrites, 0);
		assert.equal(binding.subscribed, true, "a duplicate burst is refused without ending the subscription");
		assert.equal(duplicateSource.liveWatches.length, 1);
		assert.equal(duplicateSource.viewers.size, 1);
		assert.equal(framesOfType(channel.frames(), "content_begin").length, 1);
		assert.equal(framesOfType(channel.frames(), "error").every((frame) => frame.code === "too_many_subscriptions"),
			true);
	} finally {
		await duplicateHarness.host.stopAll();
	}

	// (b) Distinct control frames behind a held write are bounded: the backlog
	// refuses overflow and closes instead of accumulating requests.
	const distinctSource = new FakeContentSource();
	distinctSource.addRow("row-a", 80, 24);
	const distinctHarness = createHarness({ source: distinctSource, timeouts: { transferIdleTimeoutMs: 2_000 } });
	try {
		const { channel, binding, diagnostics } = distinctHarness;
		await openHello(distinctHarness);
		// Establish the subscription and let its initial viewport finish, so the
		// write that is parked below really is a content write.
		channel.deliver(subscribeFrame(distinctSource));
		await settle(20);
		channel.holdNextSend = true;
		distinctSource.emit("row-a");
		await settle();
		assert.equal(channel.heldWrites, 1, "the content write holds the single slot");

		for (let index = 0; index < 20; index += 1) {
			// Each distinct unknown subscription id produces a distinct refusal frame.
			channel.deliver({ type: "resize", subscriptionId: `sub-unknown-${index}`, cols: 40, rows: 12 });
		}
		await settle();
		assert.equal(channel.heldWrites, 1, "one outstanding write, never a pile of control promises");
		assert.ok(diagnostics.includes("protocol_violation"), "control overflow is refused, not queued forever");

		channel.release();
		await settle(30);
		await binding.closed;
		assert.equal(channel.closeCalls, 1);
		assert.equal(distinctSource.liveWatches.length, 0);
		assert.equal(distinctSource.viewers.size, 0);
		assert.equal(binding.subscribed, false);
		assert.ok(framesOfType(channel.frames(), "error").length <= 9, "only the bounded backlog was admitted");
	} finally {
		await distinctHarness.host.stopAll();
	}
});

test("a stalled hello acknowledgement is bounded by the transfer deadline", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, timeouts: { transferIdleTimeoutMs: 25 } });
	const { channel, host, binding, diagnostics } = harness;
	try {
		channel.stallNextSend = true;
		channel.deliver(helloFrame());
		await waitFor(() => diagnostics.includes("send_timeout"), "a stalled hello_ack must be bounded");
		await settle(20);
		await binding.closed;
		assert.equal(channel.closeCalls, 1);
		assert.equal(source.inventoryReads, 0);
		assert.equal(source.watches.length, 0);
		assert.equal(source.viewers.size, 0);
		assert.equal(framesOfType(channel.frames(), "content_begin").length, 0);
		assert.equal(binding.subscribed, false);
		assert.equal(channel.handlerCount, 0);
	} finally {
		await host.stopAll();
	}
});

test("a stalled subscribed acknowledgement never lets content overtake it", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({
		source,
		bounds: { maxChunkPayloadBytes: 300 },
		timeouts: { transferIdleTimeoutMs: 25 },
	});
	const { channel, host, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		channel.stallNextSend = true;
		channel.deliver(subscribeFrame(source));
		await settle();
		// The one writer is holding the acknowledgement: no content frame exists yet.
		assert.equal(framesOfType(channel.frames(), "content_begin").length, 0);
		assert.equal(framesOfType(channel.frames(), "content_chunk").length, 0);
		await waitFor(() => diagnostics.includes("send_timeout"), "a stalled acknowledgement must be bounded");
		await settle(20);
		await binding.closed;
		assert.equal(channel.closeCalls, 1);
		assert.equal(source.liveWatches.length, 0);
		assert.equal(source.viewers.size, 0);
		assert.equal(framesOfType(channel.frames(), "content_begin").length, 0);
		assert.equal(binding.subscribed, false);
	} finally {
		await host.stopAll();
	}
});

test("an unchanged idle viewport never expires, but an actually stalled write is bounded and closed", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({
		source,
		bounds: { maxChunkPayloadBytes: 300 },
		timeouts: { transferIdleTimeoutMs: 40 },
	});
	const { channel, host, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle(20);
		const writtenWhileIdle = channel.sent.length;
		// Far longer than the transfer deadline: an idle viewport is not a stall.
		await new Promise<void>((resolve) => setTimeout(resolve, 120));
		assert.equal(binding.subscribed, true, "an idle viewport keeps its subscription");
		assert.equal(channel.sent.length, writtenWhileIdle, "idle silence writes and expires nothing");
		assert.equal(source.liveWatches.length, 1);
		assert.equal(diagnostics.includes("send_timeout"), false);

		// A write that never settles is a stalled transport and is bounded.
		channel.stallNextSend = true;
		source.emit("row-a");
		await waitFor(() => diagnostics.includes("send_timeout"), "the stalled write must be bounded");
		await settle(20);
		assert.equal(framesOfType(channel.frames(), "error").length, 0,
			"a timed-out writer closes without attempting another write on the stalled transport");
		assert.equal(binding.subscribed, false);
		assert.equal(binding.viewerId, null);
		assert.equal(source.liveWatches.length, 0);
		assert.equal(source.viewers.size, 0);
		assert.equal(channel.closeCalls, 1);

		// Nothing retained or late may resurrect the retired subscription.
		const afterTimeout = channel.sent.length;
		source.emit("row-a");
		await settle(20);
		assert.equal(channel.sent.length, afterTimeout, "late source changes publish nothing");
		assert.equal(source.watches.length, 1, "no new watch is installed after retirement");
		assert.equal(source.viewers.size, 0);
	} finally {
		await host.stopAll();
	}
});

test("a viewer release the source cannot confirm is reported as uncertainty, not proven cleanup", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, host, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle();
		const viewer = binding.viewerId;
		assert.ok(viewer !== null);
		source.refuseViewerClose = true;
		channel.deliver({ type: "unsubscribe", subscriptionId: "sub-1" });
		await settle();
		onlyFrameOfType(channel.frames(), "unsubscribed");
		assert.ok(diagnostics.includes("viewer_release_uncertain"));
		assert.equal(binding.viewerId, viewer, "an unproven release keeps the id visible");
		assert.equal(binding.subscriptionId, null);

		// A further subscription is refused instead of accumulating a second viewer.
		channel.deliver(subscribeFrame(source, { subscriptionId: "sub-2" }));
		await settle();
		const refusal = framesOfType(channel.frames(), "error").at(-1);
		assert.ok(refusal !== undefined && refusal.code === "unavailable");
		assert.equal(source.viewers.size, 1, "no second viewer is ever registered");
		assert.equal(source.watches.length, 1);

		// The unsubscribe failure is latched for the binding's lifetime: a source that
		// could confirm a later release never turns it into settled cleanup.
		source.refuseViewerClose = false;
		await assert.rejects(host.stopAll(), isCloseFailure);
		assert.equal(binding.viewerId, viewer);
		assert.equal(source.viewers.size, 1);
		assert.equal(source.closedViewerIds.length, 0);
		assert.equal(host.activeBindingCount, 1);
	} finally {
		source.refuseViewerClose = false;
		await host.stopAll().catch(() => undefined);
	}
});

/* ------------------------------------------------------------------------- *
 * Protocol violations
 * ------------------------------------------------------------------------- */

test("viewer-only and unknown frames are refused with a fixed code and no source mutation", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source));
		await settle();
		assert.ok(binding.viewerId !== null, "the endpoint owns one viewer before the violation");

		// The owner never receives a transfer frame or its own acknowledgement.
		channel.deliver({
			type: "content_begin",
			subscriptionId: "sub-1",
			transferId: "transfer-x",
			hostRunId: source.runId,
			sessionId: "row-a",
			nativeSession: null,
			sequence: 1,
			geometry: { cols: 80, rows: 24, revision: 0 },
			inputModes: INPUT_MODES,
			byteLength: 2,
			chunkCount: 1,
		});
		await settle();
		const refusal = framesOfType(channel.frames(), "error").at(-1);
		assert.ok(refusal !== undefined && refusal.code === "bad_frame");
		assert.equal(binding.subscribed, false);
		assert.equal(binding.viewerId, null);
		assert.equal(source.liveWatches.length, 0);
		assert.equal(source.viewers.size, 0);
		assert.equal(channel.closeCalls, 1);
		// An unknown frame type is refused by the codec before it reaches any state.
		const fresh = createHarness({ source: new FakeContentSource() });
		try {
			fresh.channel.deliverBytes(Buffer.from(JSON.stringify({ type: "content_delta", subscriptionId: "sub-1" })));
			await settle();
			assert.equal(framesOfType(fresh.channel.frames(), "error").at(-1)?.code, "bad_frame");
			assert.equal(fresh.source.watches.length, 0);
			assert.equal(fresh.source.viewers.size, 0);
		} finally {
			await fresh.host.stopAll();
		}
	} finally {
		await host.stopAll();
	}
});

test("diagnostics are fixed codes only: never a label, key, frame, path, or exception text", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const channel = new ContentChannel();
	source.events = channel.events;
	const events: SessionContentHostDiagnostic[] = [];
	const host = createSessionContentHost({
		source,
		authorizePeer: () => true,
		bounds: { maxChunkPayloadBytes: 300 },
		timeouts: { ...FAST_TIMEOUTS },
		onDiagnostic: (event) => {
			events.push(event);
		},
	});
	const binding = host.attach(channel);
	try {
		channel.deliver(helloFrame());
		await settle();
		onlyFrameOfType(channel.frames(), "hello_ack");
		channel.deliver(subscribeFrame(source));
		await settle(20);
		channel.failNextSend = true;
		source.emit("row-a");
		await settle(20);
		assert.ok(events.some((event) => event.code === "viewport_published"));
		assert.ok(events.some((event) => event.code === "send_failed"));
		for (const event of events) {
			assert.equal(event.role, "owner");
			for (const key of Object.keys(event)) {
				assert.ok(["code", "role", "sequence", "chunks"].includes(key), `unexpected diagnostic field ${key}`);
			}
			const serialized = JSON.stringify(event);
			for (const secret of [channel.label, channel.peerKey.keyId, channel.peerKey.fingerprint]
				.filter((value): value is string => typeof value === "string")) {
				assert.equal(serialized.includes(secret), false, "a diagnostic carries no peer identity or label");
			}
		}
		assert.equal(binding.subscribed, false);
	} finally {
		await host.stopAll();
	}

	// A thrown authorization failure is reported by code only, never by its text.
	const throwingSource = new FakeContentSource();
	throwingSource.addRow("row-a", 80, 24);
	const throwingChannel = new ContentChannel();
	const throwingEvents: SessionContentHostDiagnostic[] = [];
	const throwingHost = createSessionContentHost({
		source: throwingSource,
		authorizePeer: () => {
			throw new Error("/srv/owner/secret-file.ts could not be read");
		},
		onDiagnostic: (event) => {
			throwingEvents.push(event);
		},
	});
	throwingHost.attach(throwingChannel);
	try {
		throwingChannel.deliver(helloFrame());
		await settle();
		// The refusal and the legitimate closure it causes are the only events; a
		// thrown authorizer never becomes text, a label, or a peer identity.
		assert.deepEqual(throwingEvents.map((event) => event.code), ["authorization_refused", "channel_closed"]);
		assert.equal(JSON.stringify(throwingEvents).includes("/srv/owner"), false);
		assert.equal(JSON.stringify(throwingEvents).includes("secret-file"), false);
	} finally {
		await throwingHost.stopAll();
	}
});

/* ------------------------------------------------------------------------- *
 * Native content fidelity
 * ------------------------------------------------------------------------- */

test("geometry revision 0 is valid and styled, Unicode, and image content crosses unchanged", async () => {
	const source = new FakeContentSource();
	// A fresh row's canonical geometry revision is 0.
	source.addRow("row-a", 12, 3);
	const harness = createHarness({ source });
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		// Requesting the row's own canonical size changes no geometry at all.
		channel.deliver(subscribeFrame(source, { cols: 12, rows: 3 }));
		await settle(10);
		assert.deepEqual(source.geometryOf("row-a"), { cols: 12, rows: 3, revision: 0 });

		const snapshots = assembleTransfers(channel.frames(), { maxChunkPayloadBytes: 32 * 1024 });
		assert.ok(snapshots.length >= 1);
		const published = snapshots[snapshots.length - 1];
		assert.ok(published !== undefined);
		assert.deepEqual(published.meta.geometry, { cols: 12, rows: 3, revision: 0 });
		assert.deepEqual(published.meta.inputModes, INPUT_MODES);
		assert.equal(published.meta.hostRunId, RUN_ID);
		assert.equal(published.meta.sessionId, "row-a");
		assert.deepEqual(published.meta.nativeSession, { sessionId: "conversation-row-a", epoch: 3 });
		assert.equal(published.meta.subscriptionId, "sub-1");
		// The complete typed native viewport — generated SGR, structured styles,
		// cursor, Unicode text, and the validated PNG payload — is forwarded exactly.
		assert.deepEqual(published.frame, source.snapshotFrame("row-a"));
		const image = published.frame.graphics?.images[0];
		assert.ok(image !== undefined);
		assert.equal(image.base64, pngBase64());
		assert.equal(image.mimeType, "image/png");
		assert.equal(binding.subscriptionId, "sub-1");
	} finally {
		await host.stopAll();
	}
});

test("each published transfer is framed by the canonical geometry it carries", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 40, 12);
	const harness = createHarness({ source, bounds: { maxChunkPayloadBytes: 200 } });
	const { channel, host } = harness;
	try {
		await openHello(harness);
		channel.deliver(subscribeFrame(source, { cols: 30, rows: 8 }));
		await settle(20);
		channel.deliver(resizeFrame({ cols: 20, rows: 6 }));
		await settle(20);
		const snapshots = assembleTransfers(channel.frames(), { maxChunkPayloadBytes: 200 });
		assert.ok(snapshots.length >= 2);
		for (const snapshot of snapshots) {
			// The frame the codec rebuilt always agrees with the canonical geometry
			// that framed it; a mismatched pair is never emitted.
			assert.equal(snapshot.frame.cols, snapshot.meta.geometry.cols);
			assert.equal(snapshot.frame.rows, snapshot.meta.geometry.rows);
			assert.equal(snapshot.meta.hostRunId, RUN_ID);
			assert.equal(snapshot.meta.sessionId, "row-a");
			assert.equal(snapshot.meta.nativeSession?.sessionId, "conversation-row-a");
		}
		const last = snapshots[snapshots.length - 1];
		assert.deepEqual({ cols: last?.meta.geometry.cols, rows: last?.meta.geometry.rows }, { cols: 20, rows: 6 });
	} finally {
		await host.stopAll();
	}
});

/* ------------------------------------------------------------------------- *
 * Evidenced retirement and fail-closed host settlement
 * ------------------------------------------------------------------------- */

/** Drive one accepted subscription and return this endpoint's own viewer id. */
async function subscribeRow(harness: Harness, source: FakeContentSource): Promise<string> {
	harness.channel.deliver(subscribeFrame(source));
	await settle(20);
	assert.equal(harness.binding.subscribed, true, "the subscription is accepted before it is retired");
	const viewerId = harness.binding.viewerId;
	assert.ok(viewerId !== null);
	return viewerId;
}

test("an unconfirmed viewer release is retained and settles as the fixed failure at binding and host", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, host, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		const viewer = await subscribeRow(harness, source);

		source.refuseViewerClose = true;
		const readsBefore = source.readViewerCalls;
		await assert.rejects(binding.stop(), isCloseFailure);
		await assert.rejects(binding.closed, isCloseFailure);
		assert.equal(binding.viewerId, viewer, "an unconfirmed release keeps the id as owned evidence");
		assert.equal(source.viewers.has(viewer), true, "the source still holds that participant");
		assert.equal(source.readViewerCalls, readsBefore,
			"an ambiguous read is never substituted for a positively confirmed release");
		assert.ok(diagnostics.includes("viewer_release_uncertain"));
		assert.equal(source.liveWatches.length, 0, "the confirmed part of retirement really happened");
		assert.equal(channel.closeCalls, 1, "the bounded close was attempted exactly once");

		// The aggregate host boundary reports the same uncertainty: the binding stays
		// owned and counted instead of being dropped by a successful-looking sweep.
		assert.equal(host.activeBindingCount, 1, "an unconfirmed binding is still owned");
		assert.equal(host.activeSubscriptionCount, 1, "an unconfirmed owner viewer participant stays counted");
		await assert.rejects(host.stopAll(), isCloseFailure);
		assert.equal(host.activeBindingCount, 1);

		// A source that can confirm release later never converts the settled failure
		// into claimed success: no retry-to-green and no silent bookkeeping clear.
		source.refuseViewerClose = false;
		await assert.rejects(host.stopAll(), isCloseFailure);
		await assert.rejects(binding.stop(), isCloseFailure);
		assert.equal(binding.viewerId, viewer, "the retained handle is never cleared by a caught failure");
		assert.deepEqual(source.closeViewerAttempts, [viewer],
			"an uncertain release is latched at the failed operation and never retried");
		assert.equal(host.activeBindingCount, 1);
	} finally {
		source.refuseViewerClose = false;
		await host.stopAll().catch(() => undefined);
	}
});

test("a throwing viewer release is the same fixed failure, never the raw error", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { host, binding } = harness;
	try {
		await openHello(harness);
		const viewer = await subscribeRow(harness, source);
		source.throwOnCloseViewer = true;
		await assert.rejects(binding.stop(), isCloseFailure);
		assert.equal(binding.viewerId, viewer);
		assert.equal(source.viewers.size, 1);
		assert.equal(host.activeBindingCount, 1);
		assert.equal(host.activeSubscriptionCount, 1);
		await assert.rejects(host.stopAll(), isCloseFailure);
	} finally {
		source.throwOnCloseViewer = false;
		await host.stopAll().catch(() => undefined);
	}
});

test("a failed watch unsubscribe is retained evidence, not best-effort cleanup", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { host, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		const viewer = await subscribeRow(harness, source);
		source.throwOnUnsubscribe = true;
		await assert.rejects(binding.stop(), isCloseFailure);
		assert.ok(diagnostics.includes("watch_release_uncertain"));
		assert.equal(source.watches[0]?.unsubscribed, 0, "the failed unsubscribe stays visible");
		assert.equal(source.liveWatches.length, 1, "the unretired source capture is still retained");
		assert.equal(binding.viewerId, null, "the viewer release that did succeed is recorded as released");
		assert.equal(host.activeSubscriptionCount, 1, "a retained watch keeps its subscription counted");
		assert.equal(host.activeBindingCount, 1);

		// The retained watch is never dropped, and never retired by a later call that
		// would have cleared the evidence.
		source.throwOnUnsubscribe = false;
		await assert.rejects(host.stopAll(), isCloseFailure);
		assert.equal(source.watches[0]?.unsubscribed, 0);
		assert.equal(source.liveWatches.length, 1);
		assert.equal(binding.viewerId, null);
		assert.deepEqual(source.closedViewerIds, [viewer], "the viewer retirement that did succeed stays recorded");
	} finally {
		source.throwOnUnsubscribe = false;
		await host.stopAll().catch(() => undefined);
	}
});

test("a failed handler detach is retained evidence and settles as the fixed failure", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, host, binding, diagnostics } = harness;
	try {
		await openHello(harness);
		await subscribeRow(harness, source);
		channel.throwOnDetach = true;
		await assert.rejects(binding.stop(), isCloseFailure);
		assert.ok(diagnostics.includes("handler_release_uncertain"));
		assert.equal(channel.handlerCount, 1, "a handler that could not be detached stays visible");
		assert.equal(source.liveWatches.length, 0);
		assert.equal(source.viewers.size, 0);
		assert.equal(host.activeBindingCount, 1);
		assert.equal(host.activeSubscriptionCount, 0,
			"no owner-side subscription participant is retained, so this count is truthful");
		await assert.rejects(host.stopAll(), isCloseFailure);
		assert.equal(channel.handlerCount, 1);
		assert.equal(host.activeBindingCount, 1);
	} finally {
		channel.throwOnDetach = false;
		await host.stopAll().catch(() => undefined);
	}
});

/**
 * A synthetic stalled channel owns no real socket. Keep its observation alive
 * on Node22 with a REFERENCED guard at the existing 2s assertion bound; the
 * production deadline stays unref'ed and unchanged.
 */
function withReferencedClose(promise: Promise<void>, message: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), 2_000);
		promise.then(() => {
			clearTimeout(timer);
			resolve();
		}, (error: unknown) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

test("a content channel close that rejects or hangs is bounded and never settles green", async () => {
	// The owner uses the existing finite stop-acknowledgement budget, which is
	// shorter than the transfer deadline a stalled writer would otherwise keep.
	assert.equal(DEFAULT_ROSTER_BRIDGE_BOUNDS.stopAckTimeoutMs, 2_000);
	assert.ok(DEFAULT_ROSTER_BRIDGE_BOUNDS.stopAckTimeoutMs < DEFAULT_ROSTER_BRIDGE_BOUNDS.transferIdleTimeoutMs);

	// (a) A close the transport rejects is unconfirmed, not completed.
	const rejectedSource = new FakeContentSource();
	rejectedSource.addRow("row-a", 80, 24);
	const rejected = createHarness({ source: rejectedSource });
	try {
		await openHello(rejected);
		await subscribeRow(rejected, rejectedSource);
		rejected.channel.refuseClose = true;
		await assert.rejects(rejected.binding.stop(), isCloseFailure);
		assert.ok(rejected.diagnostics.includes("channel_close_uncertain"));
		assert.equal(rejected.channel.closeCalls, 1, "the bounded close is attempted exactly once");
		assert.equal(rejectedSource.viewers.size, 0, "local retirement was confirmed before the close failed");
		assert.equal(rejectedSource.liveWatches.length, 0);
		assert.equal(rejected.host.activeBindingCount, 1, "an unconfirmed close keeps the binding owned");
		await assert.rejects(rejected.host.stopAll(), isCloseFailure);
		assert.equal(rejected.channel.closeCalls, 1, "a repeated stop starts no second close");
	} finally {
		await rejected.host.stopAll().catch(() => undefined);
	}

	// (b) A close that never settles is bounded by the same finite deadline.
	const stalledSource = new FakeContentSource();
	stalledSource.addRow("row-a", 80, 24);
	const stalled = createHarness({ source: stalledSource, timeouts: { stopAckTimeoutMs: 600 } });
	try {
		await openHello(stalled);
		await subscribeRow(stalled, stalledSource);
		stalled.channel.stallClose = true;
		let settled = false;
		const closed = stalled.binding.closed.then(() => {
			settled = true;
		}, () => {
			settled = true;
		});
		const started = Date.now();
		const stopping = stalled.binding.stop();
		await settle();
		assert.equal(settled, false, "neither stop nor closed settles before the bounded close does");
		// The product's deadline is intentionally unref'ed. Keep this synthetic
		// observation alive on Node22 without changing that deadline or its bound.
		await assert.rejects(withReferencedClose(stopping, "the stalled close never settled"), isCloseFailure);
		await closed;
		assert.equal(settled, true);
		assert.ok(Date.now() - started < 2_000, "the stalled close is bounded, not awaited forever");
		assert.ok(stalled.diagnostics.includes("channel_close_uncertain"));
		assert.equal(stalled.channel.closeCalls, 1);
		assert.equal(stalled.host.activeBindingCount, 1);
	} finally {
		await stalled.host.stopAll().catch(() => undefined);
	}
});

test("a second caller joins the one in-flight close instead of observing early completion", async () => {
	// (a) Two stop callers plus the closed promise, while one close is in flight.
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, timeouts: { stopAckTimeoutMs: 600 } });
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		await subscribeRow(harness, source);
		channel.stallClose = true;
		let settledEarly = false;
		const watch = (pending: Promise<void>): void => {
			void pending.then(() => {
				settledEarly = true;
			}, () => {
				settledEarly = true;
			});
		};
		const first = binding.stop();
		const second = binding.stop();
		const closed = binding.closed;
		watch(first);
		watch(second);
		watch(closed);
		await settle();
		assert.equal(channel.closeCalls, 1, "both callers share exactly one close attempt");
		assert.equal(settledEarly, false, "no caller settles before the one close does");
		await assert.rejects(withReferencedClose(first, "the shared close never settled"), isCloseFailure);
		await assert.rejects(second, isCloseFailure);
		await assert.rejects(closed, isCloseFailure);
		assert.equal(channel.closeCalls, 1, "the joined close is never attempted twice");
		assert.equal(host.activeBindingCount, 1);
		await assert.rejects(host.stopAll(), isCloseFailure);
		assert.equal(channel.closeCalls, 1, "a later stop starts no second close");
	} finally {
		await host.stopAll().catch(() => undefined);
	}

	// (b) A failed control write requests the close twice — once from the writer
	// failure and once from the settlement — and both join that one close.
	const writerHarness = createHarness({ timeouts: { stopAckTimeoutMs: 600 } });
	try {
		writerHarness.channel.stallClose = true;
		writerHarness.channel.failNextSend = true;
		writerHarness.channel.deliver(helloFrame({ major: SESSION_CONTENT_MAJOR + 1 }));
		await settle();
		assert.equal(writerHarness.channel.closeCalls, 1, "the refusal's close is already in flight");
		let settledEarly = false;
		const joined = writerHarness.binding.stop();
		void joined.then(() => {
			settledEarly = true;
		}, () => {
			settledEarly = true;
		});
		await settle();
		assert.equal(settledEarly, false, "a second caller never observes completion before the close does");
		await assert.rejects(withReferencedClose(joined, "the writer's shared close never settled"), isCloseFailure);
		await assert.rejects(writerHarness.binding.closed, isCloseFailure);
		assert.equal(writerHarness.channel.closeCalls, 1, "the double close request is joined, not repeated");
		assert.equal(writerHarness.host.activeBindingCount, 1);
	} finally {
		await writerHarness.host.stopAll().catch(() => undefined);
	}
});

test("a channel close event never deletes an owned binding whose retirement is unconfirmed", async () => {
	// (a) The transport is lost outright: the binding still settles locally, and its
	// unconfirmed viewer keeps it owned even though the channel reports closure.
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		const viewer = await subscribeRow(harness, source);
		source.refuseViewerClose = true;
		channel.lose();
		await assert.rejects(binding.closed, isCloseFailure);
		assert.equal(binding.viewerId, viewer);
		assert.equal(source.viewers.size, 1);
		assert.equal(host.activeBindingCount, 1, "a closed channel never deletes an unconfirmed binding");
		assert.equal(host.activeSubscriptionCount, 1);
		assert.equal(channel.closeCalls, 0, "a lost channel is never closed again");
		await assert.rejects(host.stopAll(), isCloseFailure);
		assert.equal(host.activeBindingCount, 1);
	} finally {
		source.refuseViewerClose = false;
		await host.stopAll().catch(() => undefined);
	}

	// (b) The channel reports closure while a stop is still settling behind a held
	// write: ownership is not dropped before that settlement decides.
	const sourceB = new FakeContentSource();
	sourceB.addRow("row-a", 80, 24);
	const harnessB = createHarness({ source: sourceB, timeouts: { stopAckTimeoutMs: 25 } });
	try {
		await openHello(harnessB);
		const viewerB = await subscribeRow(harnessB, sourceB);
		sourceB.refuseViewerClose = true;
		harnessB.channel.hold = true;
		sourceB.emit("row-a");
		await settle();
		assert.equal(harnessB.channel.heldWrites, 1);

		const stopping = harnessB.binding.stop();
		harnessB.channel.lose();
		assert.equal(harnessB.host.activeBindingCount, 1, "a channel close event is not a settled retirement");
		await assert.rejects(withReferencedClose(stopping, "the lost channel's held writer never settled"), isCloseFailure);
		assert.equal(harnessB.host.activeBindingCount, 1);
		assert.equal(harnessB.host.activeSubscriptionCount, 1);
		assert.equal(harnessB.binding.viewerId, viewerB);
	} finally {
		sourceB.refuseViewerClose = false;
		await harnessB.host.stopAll().catch(() => undefined);
	}
});

test("the fixed failure refuses further content bindings before any handler or participant exists", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { host, binding } = harness;
	try {
		await openHello(harness);
		await subscribeRow(harness, source);
		source.refuseViewerClose = true;
		await assert.rejects(binding.stop(), isCloseFailure);
		const watchesBefore = source.watches.length;
		const viewersBefore = source.viewers.size;

		const replacement = new ContentChannel();
		assert.throws(() => host.attach(replacement), isCloseFailure);
		assert.equal(replacement.handlerCount, 0, "no receiver is installed on a refused channel");
		assert.equal(replacement.sent.length, 0, "nothing is written to a refused channel");
		assert.equal(replacement.closeCalls, 0);
		assert.equal(source.watches.length, watchesBefore, "no further watch is installed");
		assert.equal(source.viewers.size, viewersBefore, "no further viewer participant accumulates");
		assert.equal(host.activeBindingCount, 1, "the failed binding is the only one owned");

		// The refusal is fail-closed resource admission only: the content source's own
		// inventory reads are not even reached, and nothing about a row is mutated.
		const inventoryBefore = source.inventoryReads;
		assert.throws(() => host.attach(new ContentChannel()), isCloseFailure);
		assert.equal(source.inventoryReads, inventoryBefore);
		assert.equal(source.rows.size, 1);
	} finally {
		source.refuseViewerClose = false;
		await host.stopAll().catch(() => undefined);
	}
});

test("a confirmed stop retires the registry, own watch, and own viewer exactly once and never touches a row", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	source.addRow("row-b", 70, 20);
	const sibling = source.openViewer();
	assert.ok(sibling !== undefined);
	assert.equal(source.updateViewer(sibling.viewerId, { sessionId: "row-b", cols: 70, rows: 20 }).applied, true);
	const geometryA = source.geometryOf("row-a");
	const geometryB = source.geometryOf("row-b");
	const harness = createHarness({ source });
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		const viewer = await subscribeRow(harness, source);

		await binding.stop();
		await binding.stop();
		await host.stopAll();
		await host.stopAll();

		assert.equal(host.activeBindingCount, 0, "a confirmed settlement removes its binding");
		assert.equal(host.activeSubscriptionCount, 0);
		assert.equal(source.watches.length, 1);
		assert.equal(source.watches[0]?.unsubscribed, 1, "the watch is retired exactly once");
		assert.deepEqual(source.closedViewerIds, [viewer], "only this endpoint's own viewer is released");
		assert.equal(source.viewers.has(sibling.viewerId), true, "a sibling viewer is never released here");
		assert.equal(source.installedRowIds.length, 1, "no further row is ever watched");
		assert.equal(source.rows.size, 2, "no row is removed, stopped, or replaced");
		assert.deepEqual(source.geometryOf("row-a"), geometryA, "the row keeps the geometry it had");
		assert.deepEqual(source.geometryOf("row-b"), geometryB);
		assert.equal(channel.closeCalls, 1, "the content channel is closed exactly once");
		assert.equal(framesOfType(channel.frames(), "end").length, 1, "exactly one end frame is written");
		assert.equal(binding.viewerId, null);
		assert.equal(framesOfType(channel.frames(), "error").length, 0);
	} finally {
		await host.stopAll();
	}
});

test("cleanup uncertainty is latched at the failed operation, not cleared by a later settlement", async () => {
	// (a) The failure happens during an unsubscribe, long before any settlement.
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		const viewer = await subscribeRow(harness, source);
		source.refuseViewerClose = true;
		channel.deliver({ type: "unsubscribe", subscriptionId: "sub-1" });
		await settle(20);
		onlyFrameOfType(channel.frames(), "unsubscribed");
		assert.equal(binding.viewerId, viewer);
		assert.equal(binding.subscribed, false);
		assert.equal(host.activeBindingCount, 1);
		assert.equal(host.activeSubscriptionCount, 1, "the retained owner viewer keeps its subscription counted");

		// A source that recovers cannot clear the latched failure.
		source.refuseViewerClose = false;
		await assert.rejects(binding.stop(), isCloseFailure);
		await assert.rejects(binding.closed, isCloseFailure);
		await assert.rejects(host.stopAll(), isCloseFailure);
		assert.equal(binding.viewerId, viewer);
		assert.equal(source.viewers.size, 1);
		assert.deepEqual(source.closeViewerAttempts, [viewer], "the uncertain release is never retried");
		assert.equal(host.activeBindingCount, 1);
	} finally {
		source.refuseViewerClose = false;
		await host.stopAll().catch(() => undefined);
	}

	// (b) The failure happens during a source-driven retirement, which does not
	// settle the binding, so only a latched record can keep it uncertain.
	const sourceB = new FakeContentSource();
	sourceB.addRow("row-a", 80, 24);
	const harnessB = createHarness({ source: sourceB });
	try {
		await openHello(harnessB);
		const viewerB = await subscribeRow(harnessB, sourceB);
		sourceB.refuseViewerClose = true;
		sourceB.emitUnavailable("row-a");
		await settle(20);
		const refusal = framesOfType(harnessB.channel.frames(), "error").at(-1);
		assert.ok(refusal !== undefined && refusal.code === "unavailable");
		assert.equal(harnessB.binding.subscribed, false);
		assert.equal(harnessB.binding.viewerId, viewerB);

		sourceB.refuseViewerClose = false;
		await assert.rejects(harnessB.binding.stop(), isCloseFailure);
		await assert.rejects(harnessB.host.stopAll(), isCloseFailure);
		assert.equal(harnessB.binding.viewerId, viewerB);
		assert.deepEqual(sourceB.closeViewerAttempts, [viewerB], "the source-driven failure is latched too");
		assert.equal(harnessB.host.activeBindingCount, 1);
	} finally {
		sourceB.refuseViewerClose = false;
		await harnessB.host.stopAll().catch(() => undefined);
	}
});

test("an unconfirmed release fences new content admission before any settlement", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	const { channel, host, binding } = harness;
	try {
		await openHello(harness);
		const viewer = await subscribeRow(harness, source);
		source.refuseViewerClose = true;
		// Keep the bounded final flush and close pending, so no settlement can have
		// finished by the time admission is checked.
		channel.hold = true;
		source.emit("row-a");
		await settle();
		assert.equal(channel.heldWrites, 1, "the writer is still holding the send slot");

		const stopping = binding.stop();
		// Deliberately not awaited: the release already failed synchronously inside
		// stop, so admission must be fenced now, with no settlement in between.
		const replacement = new ContentChannel();
		assert.throws(() => host.attach(replacement), isCloseFailure);
		assert.equal(replacement.handlerCount, 0, "no handler is installed once cleanup is uncertain");
		assert.equal(replacement.sent.length, 0);
		assert.equal(replacement.closeCalls, 0);
		assert.equal(source.watches.length, 1, "no watch is installed for the refused channel");
		assert.equal(source.viewers.size, 1, "no viewer participant accumulates for the refused channel");
		assert.equal(host.activeBindingCount, 1);

		await assert.rejects(withReferencedClose(stopping, "the failed release's held writer never settled"), isCloseFailure);
		assert.equal(binding.viewerId, viewer);
		await assert.rejects(host.stopAll(), isCloseFailure);
	} finally {
		source.refuseViewerClose = false;
		await host.stopAll().catch(() => undefined);
	}
});

test("stopAll retires a healthy sibling even while a failed binding keeps the host sticky", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	source.addRow("row-b", 60, 20);
	const host = createSessionContentHost({
		source,
		authorizePeer: () => true,
		timeouts: { ...FAST_TIMEOUTS },
	});
	const channelA = new ContentChannel();
	const channelB = new ContentChannel();
	const bindingA = host.attach(channelA);
	const bindingB = host.attach(channelB);
	try {
		channelA.deliver(helloFrame());
		channelB.deliver(helloFrame());
		await settle();
		channelA.deliver(subscribeFrame(source, { subscriptionId: "sub-a", sessionId: "row-a" }));
		channelB.deliver(subscribeFrame(source, { subscriptionId: "sub-b", sessionId: "row-b" }));
		await settle(20);
		assert.equal(bindingA.subscribed, true);
		assert.equal(bindingB.subscribed, true);
		const viewerA = bindingA.viewerId;
		const viewerB = bindingB.viewerId;
		assert.ok(viewerA !== null);
		assert.ok(viewerB !== null);
		assert.equal(source.liveWatches.length, 2);
		assert.equal(host.activeBindingCount, 2);

		// Exactly one participant's release fails.
		source.refuseViewerCloseIds.add(viewerA);
		await assert.rejects(bindingA.stop(), isCloseFailure);
		assert.equal(host.activeBindingCount, 2, "the healthy sibling is still owned");
		assert.equal(bindingB.subscribed, true);

		// A full sweep still retires the healthy sibling before reporting the failure.
		await assert.rejects(host.stopAll(), isCloseFailure);
		assert.equal(bindingB.subscribed, false);
		assert.equal(bindingB.viewerId, null);
		assert.equal(source.viewers.has(viewerB), false, "the healthy sibling's own viewer is released");
		assert.equal(source.viewers.has(viewerA), true, "only the unconfirmed viewer remains");
		assert.equal(source.liveWatches.length, 0, "both watches are retired");
		assert.deepEqual(source.watches.map((watch) => watch.unsubscribed), [1, 1],
			"each owned watch is retired exactly once");
		assert.equal(channelB.closeCalls, 1);
		assert.equal(host.activeBindingCount, 1, "the failed binding is the only one still owned");

		// A repeated sweep keeps the original fixed failure and retires nothing twice.
		await assert.rejects(host.stopAll(), isCloseFailure);
		assert.deepEqual(source.watches.map((watch) => watch.unsubscribed), [1, 1]);
		assert.equal(channelB.closeCalls, 1);
		assert.equal(host.activeBindingCount, 1);
	} finally {
		source.refuseViewerCloseIds.clear();
		await host.stopAll().catch(() => undefined);
	}
});

test("stopAll reports uncertainty latched by a binding it never swept", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	source.addRow("row-b", 60, 20);
	const host = createSessionContentHost({
		source,
		authorizePeer: () => true,
		timeouts: { ...FAST_TIMEOUTS, stopAckTimeoutMs: 1_000 },
	});
	const channelA = new ContentChannel();
	const bindingA = host.attach(channelA);
	const channelB = new ContentChannel();
	try {
		channelA.deliver(helloFrame());
		await settle();
		channelA.deliver(subscribeFrame(source, { subscriptionId: "sub-a", sessionId: "row-a" }));
		await settle(20);
		assert.equal(bindingA.subscribed, true);
		const viewerA = bindingA.viewerId;
		assert.ok(viewerA !== null);

		// Keep A's retirement pending behind its held writer, then start the sweep.
		channelA.hold = true;
		source.emit("row-a");
		await settle();
		assert.equal(channelA.heldWrites, 1, "the swept binding is still flushing");
		const sweep = host.stopAll();

		// An attachment admitted while the sweep is pending is not in its snapshot:
		// only its own cleanup failure can tell the host.
		const bindingB = host.attach(channelB);
		channelB.deliver(helloFrame());
		await settle();
		channelB.deliver(subscribeFrame(source, { subscriptionId: "sub-b", sessionId: "row-b" }));
		await settle(20);
		assert.equal(bindingB.subscribed, true);
		const viewerB = bindingB.viewerId;
		assert.ok(viewerB !== null);
		source.refuseViewerCloseIds.add(viewerB);
		await assert.rejects(bindingB.stop(), isCloseFailure);
		assert.equal(host.activeBindingCount, 2, "the concurrent unconfirmed binding is still owned");

		// The swept binding retires cleanly; the aggregate must still not claim success.
		channelA.release();
		await assert.rejects(withReferencedClose(sweep, "the held writer's aggregate sweep never settled"), isCloseFailure);
		assert.equal(bindingA.viewerId, null, "the swept binding retired as confirmed");
		assert.equal(source.viewers.has(viewerA), false, "the swept binding's own viewer was released");
		assert.equal(bindingB.viewerId, viewerB, "the unconfirmed binding keeps its evidence");
		assert.equal(source.viewers.has(viewerB), true);
		assert.equal(host.activeBindingCount, 1, "only the unconfirmed binding remains owned");
		assert.equal(host.activeSubscriptionCount, 1);

		const replacement = new ContentChannel();
		assert.throws(() => host.attach(replacement), isCloseFailure);
		assert.equal(replacement.handlerCount, 0);
		assert.equal(replacement.sent.length, 0);
	} finally {
		source.refuseViewerCloseIds.clear();
		await host.stopAll().catch(() => undefined);
	}
});

/* ------------------------------------------------------------------------- *
 * Native input and native copy (#481 path)
 * ------------------------------------------------------------------------- */

test("native input and copy are inert without an explicit opt-in, however a peer greets it", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source });
	try {
		await openHello(harness, nativeIoHello());
		assert.deepEqual(
			onlyFrameOfType(harness.channel.frames(), "hello_ack").capabilities,
			[SESSION_CONTENT_REQUIRED_CAPABILITY],
			"a peer's offer alone never activates this endpoint",
		);
		harness.channel.deliver(subscribeFrame(source));
		await settle();
		assert.ok(harness.binding.viewerId !== null);
		assert.equal(source.openViewerOptions.length, 1);
		assert.equal(source.openViewerOptions[0], undefined, "a display-only viewer is registered with no options at all");
		assert.equal(source.viewerSinks.size, 0, "no copy sink is registered");
		assert.equal(source.inputReads, 0, "the input seam is never consulted");
		assert.equal(
			"inputSource" in onlyFrameOfType(harness.channel.frames(), "content_begin"),
			false,
			"a legacy publish keeps its exact key set",
		);
		sendNativeInput(harness.channel, { source: foreignWireSource(), kind: "keyboard", data: "a", ordinal: 1 });
		await settle();
		assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "bad_frame");
		assert.equal(harness.channel.closeCalls, 1, "an unnegotiated extension frame retires this content lane only");
		assert.equal(source.inputWrites.length, 0);
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}

	// An opt-in whose injected source provides none of the primitives is no offer:
	// this peer never sees a capability, a source, or a sink.
	const plainChannel = new ContentChannel();
	source.events = plainChannel.events;
	const plainHost = createSessionContentHost({
		source: displayOnlySource(source),
		nativeIo: true,
		authorizePeer: () => true,
		timeouts: FAST_TIMEOUTS,
	});
	try {
		plainHost.attach(plainChannel);
		plainChannel.deliver(helloFrame(nativeIoHello()));
		await settle();
		assert.deepEqual(
			onlyFrameOfType(plainChannel.frames(), "hello_ack").capabilities,
			[SESSION_CONTENT_REQUIRED_CAPABILITY],
			"an opt-in with no provider behind it is no offer",
		);
		plainChannel.deliver(subscribeFrame(source, { subscriptionId: "sub-plain" }));
		await settle();
		assert.equal(source.viewerSinks.size, 0);
		assert.equal(source.inputReads, 0);
		assert.equal("inputSource" in onlyFrameOfType(plainChannel.frames(), "content_begin"), false);
		assert.equal(source.inputWrites.length, 0);
	} finally {
		await plainHost.stopAll().catch(() => undefined);
	}

	// The opt-in itself is validated before any channel exists.
	assert.throws(
		() => createSessionContentHost({ source, authorizePeer: () => true, nativeIo: "yes" as unknown as boolean }),
		(error: unknown) => error instanceof TypeError,
	);
});

test("an explicit opt-in acknowledges only an offering peer, on one viewer with its own sink", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	// This host opted in, but a peer that never offered the extension keeps the
	// exact display-only channel it always had.
	const legacy = createHarness({ source, nativeIo: true });
	try {
		await openHello(legacy);
		assert.deepEqual(
			onlyFrameOfType(legacy.channel.frames(), "hello_ack").capabilities,
			[SESSION_CONTENT_REQUIRED_CAPABILITY],
		);
		legacy.channel.deliver(subscribeFrame(source, { subscriptionId: "sub-legacy" }));
		await settle();
		assert.equal(source.viewerSinks.size, 0, "a legacy subscription registers no copy sink");
		assert.equal(source.inputReads, 0, "a legacy subscription never consults the input seam");
		assert.equal("inputSource" in onlyFrameOfType(legacy.channel.frames(), "content_begin"), false);
		sendNativeInput(legacy.channel, {
			source: foreignWireSource(),
			subscriptionId: "sub-legacy",
			kind: "keyboard",
			data: "a",
			ordinal: 1,
		});
		await settle();
		assert.equal(framesOfType(legacy.channel.frames(), "error").at(-1)?.code, "bad_frame");
		assert.equal(legacy.channel.closeCalls, 1);
		assert.equal(source.inputWrites.length, 0);
	} finally {
		await legacy.host.stopAll().catch(() => undefined);
	}

	// The same host and source, with a peer that did offer it.
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		const published = await subscribeNative(harness);
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		assert.equal(source.viewers.size, 1, "exactly one viewer for this binding");
		assert.deepEqual([...source.viewerSinks.keys()], [viewerId], "the sink is bound to this endpoint's own viewer");
		assert.ok(source.openViewerOptions.at(-1)?.nativeClipboardSink !== undefined);
		const scope = source.readViewerInputSource(viewerId);
		assert.ok(scope !== undefined);
		assert.equal(published.hostRunId, scope.hostRunId);
		assert.equal(published.sessionId, scope.rowId);
		assert.equal(published.nativeSession.sessionId, scope.nativeSession.sessionId);
		assert.equal(published.nativeSession.epoch, scope.nativeSession.epoch);
		assert.deepEqual(published.geometry, {
			cols: scope.geometry.cols,
			rows: scope.geometry.rows,
			revision: scope.geometry.revision,
		});
		assert.equal(published.viewerRevision, scope.viewerRevision);
		assert.equal(published.sourceToken, scope.sourceToken);
		// Owner-private facts never cross the wire.
		const wire = JSON.stringify(published);
		assert.equal(wire.includes("registration-"), false, "registration identity never crosses the wire");
		assert.equal(wire.includes("generation-"), false, "registration generation never crosses the wire");
		assert.equal(wire.includes(viewerId), false, "the owner's viewer id never crosses the wire");
		assert.equal(Object.hasOwn(published, "viewerId"), false);
		assert.equal(Object.hasOwn(published, "registrationIdentity"), false);
		assert.equal(Object.hasOwn(published, "registrationGeneration"), false);
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("input admission re-proves every echoed source fact against the CURRENT owner facts", async () => {
	const mutations: Array<{ readonly name: string; readonly mutate: (published: NativeIoSource) => NativeIoSource }> = [
		{ name: "another host run", mutate: (published) => ({ ...published, hostRunId: OTHER_RUN }) },
		{ name: "another owner row", mutate: (published) => ({ ...published, sessionId: "row-b" }) },
		{
			name: "another native conversation",
			mutate: (published) => ({ ...published, nativeSession: { ...published.nativeSession, sessionId: "conversation-row-b" } }),
		},
		{
			name: "a retired conversation epoch",
			mutate: (published) => ({ ...published, nativeSession: { ...published.nativeSession, epoch: published.nativeSession.epoch + 1 } }),
		},
		{
			name: "a stale geometry revision",
			mutate: (published) => ({ ...published, geometry: { ...published.geometry, revision: published.geometry.revision + 1 } }),
		},
		{
			name: "dimensions that were never published",
			mutate: (published) => ({ ...published, geometry: { ...published.geometry, cols: published.geometry.cols - 1 } }),
		},
		{ name: "a stale viewer revision", mutate: (published) => ({ ...published, viewerRevision: published.viewerRevision + 1 }) },
		{ name: "a rotated source token", mutate: (published) => ({ ...published, sourceToken: "token-rotated" }) },
		{ name: "a wholly foreign scope", mutate: () => foreignWireSource() },
	];
	for (const mutation of mutations) {
		const source = new FakeContentSource();
		source.addRow("row-a", 80, 24);
		source.addRow("row-b", 90, 30);
		const harness = createHarness({ source, nativeIo: true });
		try {
			await openNativeHello(harness);
			const published = await subscribeNative(harness);
			sendNativeInput(harness.channel, {
				source: mutation.mutate(published),
				kind: "keyboard",
				data: "a",
				ordinal: 1,
			});
			await settle();
			assert.equal(source.inputWrites.length, 0, `${mutation.name}: no byte reaches a child`);
			assert.ok(harness.diagnostics.includes("input_refused"), `${mutation.name}: the refusal is diagnosed`);
			assert.equal(
				framesOfType(harness.channel.frames(), "error").length,
				0,
				`${mutation.name}: ordinary staleness is never a protocol failure`,
			);
			assert.equal(harness.binding.subscribed, true, `${mutation.name}: the refusal leaves the subscription usable`);
			assert.equal(harness.channel.closeCalls, 0);
			// The refusal never poisons the valid input that follows it.
			const viewerId = harness.binding.viewerId;
			assert.ok(viewerId !== null);
			sendNativeInput(harness.channel, { source: wireSourceOf(source, viewerId), kind: "keyboard", data: "b", ordinal: 2 });
			await settle();
			assert.equal(source.inputWrites.length, 1, `${mutation.name}: the CURRENT scope is still admitted`);
			assert.equal(source.inputWrites[0]?.viewerId, viewerId, `${mutation.name}: only this endpoint's own surface`);
			assert.equal(handedText(harness.source), "b");
		} finally {
			await harness.host.stopAll().catch(() => undefined);
		}
	}
});

test("an old viewport, conversation, mode set, or surface revision never retargets input", async () => {
	interface LifecycleCase {
		readonly name: string;
		readonly change: (harness: Harness) => void | Promise<void>;
		readonly staleModes?: TerminalInputModes;
		readonly currentModes?: TerminalInputModes;
		/** Whether this change moves the owner scope itself, or only the mode set. */
		readonly sourceChanges?: boolean;
	}
	const modesWithoutPaste: TerminalInputModes = Object.freeze({ ...INPUT_MODES, bracketedPaste: false });
	const cases: LifecycleCase[] = [
		{
			name: "a resize to a new viewport",
			change: (harness) => {
				harness.channel.deliver(resizeFrame({ cols: 60, rows: 20 }));
			},
		},
		{
			// Equal dimensions alone never identify a viewport: an A -> B -> A change
			// differs by geometry revision and viewer revision, so old A is refused.
			name: "an A -> B -> A resize back to the original dimensions",
			change: async (harness) => {
				harness.channel.deliver(resizeFrame({ cols: 60, rows: 20 }));
				await settle();
				harness.channel.deliver(resizeFrame({ cols: 80, rows: 24 }));
			},
		},
		{
			name: "a replaced native conversation",
			change: (harness) => {
				harness.source.rotateNativeSession("row-a");
				harness.source.emit("row-a");
			},
		},
		{
			// The scope is identical; only the modes the child actually has differ, and
			// that alone is enough to refuse a packet made for another mode set.
			name: "input modes the packet was not made for",
			change: (harness) => {
				harness.source.inputModes = modesWithoutPaste;
				harness.source.emit("row-a");
			},
			staleModes: INPUT_MODES,
			currentModes: modesWithoutPaste,
			sourceChanges: false,
		},
		{
			name: "a surface re-registered under a new revision",
			change: (harness) => {
				const viewerId = harness.binding.viewerId;
				assert.ok(viewerId !== null);
				harness.source.bumpViewerRevision(viewerId);
			},
		},
		{
			name: "a rotated host-minted token",
			change: (harness) => {
				const viewerId = harness.binding.viewerId;
				assert.ok(viewerId !== null);
				harness.source.rotateSourceToken(viewerId);
				harness.source.emit("row-a");
			},
		},
	];
	for (const lifecycleCase of cases) {
		const source = new FakeContentSource();
		source.addRow("row-a", 80, 24);
		const harness = createHarness({ source, nativeIo: true });
		try {
			await openNativeHello(harness);
			const stale = await subscribeNative(harness);
			await settle();
			await lifecycleCase.change(harness);
			await settle();
			const viewerId = harness.binding.viewerId;
			assert.ok(viewerId !== null);
			const current = wireSourceOf(source, viewerId);
			if (lifecycleCase.sourceChanges === false) {
				assert.equal(
					JSON.stringify(current),
					JSON.stringify(stale),
					`${lifecycleCase.name}: the refusal below cannot rest on a scope change`,
				);
			} else {
				assert.notEqual(
					JSON.stringify(current),
					JSON.stringify(stale),
					`${lifecycleCase.name}: the scope really changed`,
				);
			}
			sendNativeInput(harness.channel, {
				source: stale,
				kind: "keyboard",
				data: "a",
				ordinal: 1,
				inputModes: lifecycleCase.staleModes ?? INPUT_MODES,
			});
			await settle();
			assert.equal(source.inputWrites.length, 0, `${lifecycleCase.name}: zero PTY bytes`);
			assert.ok(harness.diagnostics.includes("input_refused"), `${lifecycleCase.name}: diagnosed as a refusal`);
			assert.equal(
				framesOfType(harness.channel.frames(), "error").length,
				0,
				`${lifecycleCase.name}: staleness is never a protocol failure and never disconnects`,
			);
			assert.equal(harness.binding.subscribed, true);
			sendNativeInput(harness.channel, {
				source: current,
				kind: "keyboard",
				data: "b",
				ordinal: 2,
				inputModes: lifecycleCase.currentModes ?? INPUT_MODES,
			});
			await settle();
			assert.equal(source.inputWrites.length, 1, `${lifecycleCase.name}: the CURRENT scope is admitted`);
			assert.equal(handedText(source), "b");
		} finally {
			source.inputModes = INPUT_MODES;
			await harness.host.stopAll().catch(() => undefined);
		}
	}
});

test("a source that cannot provide an input scope admits nothing and changes nothing", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		const published = await subscribeNative(harness);
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		source.inputUnavailable = true;
		sendNativeInput(harness.channel, { source: published, kind: "keyboard", data: "a", ordinal: 1 });
		await settle();
		assert.equal(source.inputWrites.length, 0, "no seam means no handoff, never a guess");
		assert.ok(harness.diagnostics.includes("input_refused"));
		assert.equal(harness.binding.subscribed, true, "a refusal never retires the subscription");
		assert.equal(framesOfType(harness.channel.frames(), "error").length, 0);
		source.inputUnavailable = false;
		// A handoff whose outcome is genuinely uncertain is reported as uncertain and
		// never retried.
		source.inputWriteOutcome = { status: "unknown" };
		sendNativeInput(harness.channel, { source: wireSourceOf(source, viewerId), kind: "keyboard", data: "b", ordinal: 2 });
		await settle();
		assert.equal(source.inputWrites.length, 1, "an uncertain handoff is never retried");
		assert.ok(harness.diagnostics.includes("input_uncertain"));
		assert.equal(harness.binding.subscribed, true);
		source.inputWriteOutcome = { status: "refused", reason: "input-unready" };
		sendNativeInput(harness.channel, { source: wireSourceOf(source, viewerId), kind: "keyboard", data: "c", ordinal: 3 });
		await settle();
		assert.equal(source.inputWrites.length, 2, "a lower refusal is not retried either");
		assert.equal(harness.binding.subscribed, true, "a lower refusal never stops an owner view or a session");
		assert.equal(framesOfType(harness.channel.frames(), "error").length, 0);
	} finally {
		source.inputWriteOutcome = undefined;
		source.inputUnavailable = false;
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("native packets are translated exactly once by the owner's existing translator", async () => {
	const viewport = { column: 0, row: 0, cols: 80, rows: 24 };
	{
		const { source, harness, published } = await openInputCase(INPUT_MODES);
		try {
			sendNativeInput(harness.channel, { source: published, kind: "keyboard", data: "hello there", ordinal: 1 });
			await settle();
			assert.equal(source.inputWrites.length, 1, "exactly one handoff per packet");
			// The handoff is addressed by this binding's OWN viewer id, never by anything
			// the peer echoed: that id is the only address the lower fence accepts.
			assert.equal(source.inputWrites[0]?.viewerId, harness.binding.viewerId);
			assert.equal(handedText(source), "hello there", "joined text is not a protocol packet");
			// A legacy cursor packet is re-encoded for the child's own modes, not copied.
			const cursor = "\u001b[A";
			sendNativeInput(harness.channel, { source: published, kind: "keyboard", data: cursor, ordinal: 2 });
			await settle();
			assert.equal(source.inputWrites.length, 2);
			assert.equal(handedText(source, 1), translateInput(cursor, INPUT_MODES, viewport));
			// Bracketed paste: the child's own mode decides whether the markers appear.
			sendNativeInput(harness.channel, { source: published, kind: "paste", data: "line1\nline2", ordinal: 3 });
			await settle();
			assert.equal(handedText(source, 2), `\u001b[200~line1\nline2\u001b[201~`);
		} finally {
			await harness.host.stopAll().catch(() => undefined);
		}
	}
	{
		const { source, harness, published } = await openInputCase(PLAIN_TEXT_MODES);
		try {
			const cursor = "\u001b[A";
			sendNativeInput(harness.channel, {
				source: published, kind: "keyboard", data: cursor, ordinal: 1, inputModes: PLAIN_TEXT_MODES,
			});
			await settle();
			assert.equal(handedText(source), translateInput(cursor, PLAIN_TEXT_MODES, viewport));
			assert.notEqual(handedText(source), "\u001bOA", "the child's modes, not the source's, shape the bytes");
			sendNativeInput(harness.channel, {
				source: published, kind: "paste", data: "line1\nline2", ordinal: 2, inputModes: PLAIN_TEXT_MODES,
			});
			await settle();
			assert.equal(handedText(source, 1), "line1\nline2", "a child without bracketed paste gets the text alone");
		} finally {
			await harness.host.stopAll().catch(() => undefined);
		}
	}
	{
		// A child reporting SGR mouse coordinates receives the canonical report.
		const { source, harness, published } = await openInputCase(SGR_MOUSE_MODES);
		try {
			sendNativeInput(harness.channel, {
				source: published, kind: "mouse", data: "\u001b[<0;5;3M", ordinal: 1, inputModes: SGR_MOUSE_MODES,
			});
			await settle();
			assert.equal(source.inputWrites.length, 1);
			assert.equal(handedText(source), "\u001b[<0;5;3M");
			// A report outside the published viewport is refused quietly, and the next
			// valid packet still works: a refusal is never a disconnect.
			sendNativeInput(harness.channel, {
				source: published, kind: "mouse", data: "\u001b[<0;500;3M", ordinal: 2, inputModes: SGR_MOUSE_MODES,
			});
			await settle();
			assert.equal(source.inputWrites.length, 1, "nothing the child cannot use is written");
			assert.ok(harness.diagnostics.includes("input_refused"));
			assert.equal(framesOfType(harness.channel.frames(), "error").length, 0);
			sendNativeInput(harness.channel, {
				source: published, kind: "keyboard", data: "b", ordinal: 3, inputModes: SGR_MOUSE_MODES,
			});
			await settle();
			assert.equal(source.inputWrites.length, 2);
			assert.equal(handedText(source, 1), "b");
		} finally {
			await harness.host.stopAll().catch(() => undefined);
		}
	}
	{
		// A legacy X10 child: the translator's raw bytes cross unchanged, so a
		// coordinate above 127 is never UTF-8 recoded.
		const { source, harness, published } = await openInputCase(X10_MOUSE_MODES, { cols: 240, rows: 60 });
		try {
			sendNativeInput(harness.channel, {
				source: published, kind: "mouse", data: "\u001b[<0;200;3M", ordinal: 1, inputModes: X10_MOUSE_MODES,
			});
			await settle();
			assert.equal(source.inputWrites.length, 1);
			const write = source.inputWrites[0];
			assert.ok(write !== undefined);
			assert.ok(Buffer.isBuffer(write.data), "a legacy report crosses as raw bytes, never as a JS string");
			assert.deepEqual(write.data, Buffer.from([0x1b, 0x5b, 0x4d, 32, 232, 35]));
			assert.equal(Buffer.isBuffer(write.data) ? write.data[4] : 0, 232, "a coordinate above 127 is never UTF-8 recoded");
		} finally {
			await harness.host.stopAll().catch(() => undefined);
		}
	}
	// A mouse packet must already be one canonical SGR report: this is refused by the
	// wire itself, so a legacy report or a key can never be relabeled as mouse input.
	assert.throws(
		() => buildNativeInputInline({
			subscriptionId: "sub-1",
			inputId: randomUUID(),
			ordinal: 1,
			source: foreignWireSource(),
			inputModes: X10_MOUSE_MODES,
			kind: "mouse",
			data: "\u001b[M ghe",
			bounds: DEFAULT_SESSION_CONTENT_BOUNDS,
		}),
		(error: unknown) => isSessionContentProtocolError(error) && error.code === "invalid_frame",
	);
});

test("a paste body is preserved exactly, whatever control characters it contains", async () => {
	// A paste is never reinterpreted as a keyboard packet. An embedded Escape, a
	// literal bracketed-paste marker inside the text, a trailing escape, and control
	// characters all survive translation byte for byte; the only thing the endpoint
	// decides is the outer wrapper, and that follows the CHILD's own mode.
	const bodies: readonly string[] = [
		"plain text",
		"esc\u001b[Ainside",
		"marker \u001b[200~inside\u001b[201~ tail",
		"trailing escape\u001b",
		"tab\t, bell \u0007, nul \u0000, and \u00e9moji",
	];
	for (const modes of [INPUT_MODES, PLAIN_TEXT_MODES]) {
		const { source, harness, published } = await openInputCase(modes);
		try {
			for (const [index, body] of bodies.entries()) {
				sendNativeInput(harness.channel, {
					source: published, kind: "paste", data: body, ordinal: index + 1, inputModes: modes,
				});
				await settle();
				assert.equal(
					source.inputWrites.length,
					index + 1,
					`${JSON.stringify(body)}: a paste is never refused as an unknown key`,
				);
				const expected = modes.bracketedPaste ? `\u001b[200~${body}\u001b[201~` : body;
				assert.equal(
					handedText(source, index),
					expected,
					`${JSON.stringify(body)}: body preserved with bracketedPaste=${String(modes.bracketedPaste)}`,
				);
			}
			assert.equal(framesOfType(harness.channel.frames(), "error").length, 0);
		} finally {
			await harness.host.stopAll().catch(() => undefined);
		}
	}
});

test("one atomic native paste crosses whole at exactly 1 MiB and never partially", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		const published = await subscribeNative(harness);
		// Exactly 1 MiB of decoded UTF-8 text, in multi-byte characters.
		const whole = "\u4e16".repeat(349_525) + "a";
		assert.equal(Buffer.byteLength(whole, "utf8"), NATIVE_TEXT_PASTE_MAX_BYTES);
		const built = buildPaste({ source: published, ordinal: 1, text: whole });
		assert.ok(built.frames.length > 3, "the paste really crosses as bounded pages");
		deliverBuilt(harness.channel, built);
		await settle(20);
		assert.equal(source.inputWrites.length, 1, "the whole paste is handed over exactly once");
		assert.equal(handedText(source), `\u001b[200~${whole}\u001b[201~`, "no character is truncated");
		assert.equal(harness.binding.subscribed, true);
		// One byte more is not expressible on this wire at all, so no partial paste can
		// ever be built, sent, or half-written.
		assert.throws(
			() => buildPaste({ source: published, ordinal: 2, text: `${whole}x` }),
			(error: unknown) => isSessionContentProtocolError(error) && error.code === "transfer_too_large",
		);
		assert.equal(source.inputWrites.length, 1, "an over-cap paste writes nothing at all");
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}

	// A missing page is refused whole: the partial text is never handed over.
	const truncated = new FakeContentSource();
	truncated.addRow("row-a", 80, 24);
	const partial = createHarness({ source: truncated, nativeIo: true });
	try {
		await openNativeHello(partial);
		const published = await subscribeNative(partial);
		const built = buildPaste({ source: published, ordinal: 1, text: "x".repeat(40_000) });
		assert.ok(built.frames.length >= 4);
		partial.channel.deliverBytes(built.frames[0] ?? Buffer.alloc(0));
		partial.channel.deliverBytes(built.frames[1] ?? Buffer.alloc(0));
		partial.channel.deliverBytes(built.frames[built.frames.length - 1] ?? Buffer.alloc(0));
		await settle();
		assert.equal(truncated.inputWrites.length, 0, "a missing page never produces a partial paste");
		assert.equal(framesOfType(partial.channel.frames(), "error").at(-1)?.code, "bad_frame");
		assert.equal(partial.channel.closeCalls, 1, "a broken input assembly fails this content lane closed");
		assert.equal(truncated.viewers.size, 0, "and retires this endpoint's own resources");
	} finally {
		await partial.host.stopAll().catch(() => undefined);
	}

	// A reordered page is refused whole as well.
	const reordered = new FakeContentSource();
	reordered.addRow("row-a", 80, 24);
	const outOfOrder = createHarness({ source: reordered, nativeIo: true });
	try {
		await openNativeHello(outOfOrder);
		const published = await subscribeNative(outOfOrder);
		const built = buildPaste({ source: published, ordinal: 1, text: "y".repeat(40_000) });
		outOfOrder.channel.deliverBytes(built.frames[0] ?? Buffer.alloc(0));
		for (const frame of built.frames.slice(2)) outOfOrder.channel.deliverBytes(frame);
		outOfOrder.channel.deliverBytes(built.frames[1] ?? Buffer.alloc(0));
		await settle();
		assert.equal(reordered.inputWrites.length, 0, "pages are never reassembled out of order");
		assert.equal(framesOfType(outOfOrder.channel.frames(), "error").at(-1)?.code, "bad_frame");
	} finally {
		await outOfOrder.host.stopAll().catch(() => undefined);
	}
});

test("a partial paste dies with the viewport it was made for and never blocks the next input", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		const stale = await subscribeNative(harness);
		const built = buildPaste({ source: stale, ordinal: 1, text: "y".repeat(40_000) });
		assert.ok(built.frames.length >= 4);
		harness.channel.deliverBytes(built.frames[0] ?? Buffer.alloc(0));
		harness.channel.deliverBytes(built.frames[1] ?? Buffer.alloc(0));
		await settle();
		assert.equal(source.inputWrites.length, 0, "an incomplete paste is never handed over");
		// The viewport changes underneath it.
		harness.channel.deliver(resizeFrame({ cols: 60, rows: 20 }));
		await settle();
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		// The remaining pages of the abandoned input are consumed and dropped quietly.
		for (const frame of built.frames.slice(2)) harness.channel.deliverBytes(frame);
		await settle();
		assert.equal(source.inputWrites.length, 0, "an abandoned paste is never resumed or completed");
		assert.equal(
			framesOfType(harness.channel.frames(), "error").length,
			0,
			"an ordinary staleness refusal never becomes a protocol failure",
		);
		assert.equal(harness.binding.subscribed, true);
		assert.equal(harness.channel.closeCalls, 0);
		// The new viewport takes input immediately.
		sendNativeInput(harness.channel, { source: wireSourceOf(source, viewerId), kind: "keyboard", data: "b", ordinal: 2 });
		await settle();
		assert.equal(source.inputWrites.length, 1, "a stale refusal never poisons the valid input that follows");
		assert.equal(handedText(source), "b");
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a paste begun for a scope that is already stale never opens", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		const stale = await subscribeNative(harness);
		// The owner viewport changes first, so this paste is stale before its first page.
		harness.channel.deliver(resizeFrame({ cols: 60, rows: 20 }));
		await settle();
		const built = buildPaste({ source: stale, ordinal: 1, text: "y".repeat(40_000) });
		for (const frame of built.frames) harness.channel.deliverBytes(frame);
		await settle();
		assert.equal(source.inputWrites.length, 0, "a stale paste is refused whole, before any assembly opens");
		assert.ok(harness.diagnostics.includes("input_refused"));
		assert.equal(
			framesOfType(harness.channel.frames(), "error").length,
			0,
			"staleness is never a protocol failure and never disconnects",
		);
		assert.equal(harness.binding.subscribed, true);
		assert.equal(harness.channel.closeCalls, 0);
		// The valid packet that follows has no open partial assembly to step over.
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		sendNativeInput(harness.channel, {
			source: wireSourceOf(source, viewerId), kind: "keyboard", data: "b", ordinal: 2,
		});
		await settle();
		assert.equal(source.inputWrites.length, 1, "an old paste cannot block a current packet");
		assert.equal(handedText(source), "b");
		assert.equal(harness.channel.closeCalls, 0, "nothing on either side became a protocol violation");
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a paste cannot survive an input-mode change, even back to the modes it began with", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	const modesWithoutPaste: TerminalInputModes = Object.freeze({ ...INPUT_MODES, bracketedPaste: false });
	try {
		await openNativeHello(harness);
		const published = await subscribeNative(harness);
		const built = buildPaste({ source: published, ordinal: 1, text: "y".repeat(40_000) });
		harness.channel.deliverBytes(built.frames[0] ?? Buffer.alloc(0));
		harness.channel.deliverBytes(built.frames[1] ?? Buffer.alloc(0));
		await settle();
		assert.equal(source.inputWrites.length, 0, "an incomplete paste is never handed over");
		// Only the child's modes move, and then move back. The paste was made for the
		// modes it began with, but its assembly was freed the moment they changed, so it
		// cannot finish against a mode set that was observed and then restored.
		source.inputModes = modesWithoutPaste;
		source.emit("row-a");
		await settle();
		source.inputModes = INPUT_MODES;
		source.emit("row-a");
		await settle();
		for (const frame of built.frames.slice(2)) harness.channel.deliverBytes(frame);
		await settle();
		assert.equal(source.inputWrites.length, 0, "a paste whose modes moved is never completed");
		assert.ok(harness.diagnostics.includes("input_incomplete"), "the freed paste is diagnosed");
		assert.equal(framesOfType(harness.channel.frames(), "error").length, 0);
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		sendNativeInput(harness.channel, {
			source: wireSourceOf(source, viewerId), kind: "keyboard", data: "b", ordinal: 2, inputModes: INPUT_MODES,
		});
		await settle();
		assert.equal(source.inputWrites.length, 1, "the current packet after the change is admitted");
		assert.equal(handedText(source), "b");
	} finally {
		source.inputModes = INPUT_MODES;
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("an open paste is bounded by the existing transfer deadline and leaves nothing behind", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true, timeouts: { transferIdleTimeoutMs: 60 } });
	try {
		await openNativeHello(harness);
		const published = await subscribeNative(harness);
		const built = buildPaste({ source: published, ordinal: 1, text: "z".repeat(40_000) });
		harness.channel.deliverBytes(built.frames[0] ?? Buffer.alloc(0));
		harness.channel.deliverBytes(built.frames[1] ?? Buffer.alloc(0));
		await waitFor(() => harness.diagnostics.includes("input_incomplete"), "the partial paste deadline never fired");
		assert.equal(source.inputWrites.length, 0, "an expired partial paste is never handed over");
		assert.equal(harness.binding.subscribed, false, "the subscription retired");
		assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "transfer_failed");
		assert.equal(source.liveWatches.length, 0, "the watch was released");
		assert.equal(source.viewers.size, 0, "the viewer was released");
		assert.equal(harness.channel.closeCalls, 0, "an expired partial retires the subscription, not the channel");
		// The deadline is gone with the subscription: nothing is left to fire later.
		const frames = harness.channel.sent.length;
		await new Promise<void>((resolve) => setTimeout(resolve, 120));
		assert.equal(harness.channel.sent.length, frames, "no timer keeps writing after retirement");
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("input for another or a retired subscription is refused without touching any viewer", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		sendNativeInput(harness.channel, {
			source: foreignWireSource(), kind: "keyboard", data: "a", ordinal: 1, subscriptionId: "sub-none",
		});
		await settle();
		assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "protocol_violation");
		assert.equal(source.viewers.size, 0, "no viewer exists yet, and none was created");
		assert.equal(source.inputWrites.length, 0);
		await subscribeNative(harness);
		// Another subscription id on this channel is never retargeted onto this one.
		sendNativeInput(harness.channel, {
			source: foreignWireSource(), kind: "keyboard", data: "a", ordinal: 1, subscriptionId: "sub-other",
		});
		await settle();
		assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "protocol_violation");
		assert.equal(source.inputWrites.length, 0);
		assert.equal(harness.binding.subscribed, true);
		// Once retired, its input frames change nothing either.
		harness.channel.deliver({ type: "unsubscribe", subscriptionId: "sub-1" });
		await settle();
		sendNativeInput(harness.channel, { source: foreignWireSource(), kind: "keyboard", data: "a", ordinal: 1 });
		await settle();
		assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "protocol_violation");
		assert.equal(source.inputWrites.length, 0);
		assert.equal(harness.channel.closeCalls, 0);
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a revoked grant stops input before any handoff and still retires its own resources", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		const published = await subscribeNative(harness);
		harness.allow.value = false;
		sendNativeInput(harness.channel, { source: published, kind: "keyboard", data: "a", ordinal: 1 });
		await settle();
		assert.equal(source.inputWrites.length, 0, "a revoked peer writes nothing");
		assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "not_authorized");
		assert.equal(harness.binding.subscribed, false);
		assert.equal(source.viewers.size, 0, "refusal still retires this endpoint's own resources");
		assert.equal(source.inputWrites.length, 0);
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a native copy crosses only its own initiating viewer, whole, and never to the child", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	source.addRow("row-b", 100, 30);
	const diagnostics: SessionContentHostDiagnosticCode[] = [];
	const host = createSessionContentHost({
		source,
		nativeIo: true,
		authorizePeer: () => true,
		timeouts: FAST_TIMEOUTS,
		onDiagnostic: (event) => {
			diagnostics.push(event.code);
		},
	});
	const channelA = new ContentChannel();
	const channelB = new ContentChannel();
	source.events = channelA.events;
	const bindingA = host.attach(channelA);
	const bindingB = host.attach(channelB);
	try {
		channelA.deliver(helloFrame(nativeIoHello()));
		channelB.deliver(helloFrame(nativeIoHello()));
		await settle();
		channelA.deliver(subscribeFrame(source, { subscriptionId: "sub-a" }));
		channelB.deliver(subscribeFrame(source, { subscriptionId: "sub-b", sessionId: "row-b" }));
		await settle(20);
		assert.equal(bindingA.subscribed, true);
		assert.equal(bindingB.subscribed, true);
		const viewerA = bindingA.viewerId;
		const viewerB = bindingB.viewerId;
		assert.ok(viewerA !== null && viewerB !== null);
		assert.notEqual(viewerA, viewerB, "each binding owns its own viewer and only its own sink");
		assert.equal(source.viewerSinks.size, 2);

		// Three emissions on A's own sink, deliberately out of native dispatch order,
		// including one that needs pages. If two assemblies interleaved on the single
		// writer, the real assembler below would refuse them.
		const markA = channelA.sent.length;
		const markB = channelB.sent.length;
		source.emitCopy(viewerA, copyEventOf("first A", "row-a"), 9);
		source.emitCopy(viewerA, {
			kind: "copy",
			encoded: Buffer.alloc(75_000, 0x41).toString("base64"),
			sessionId: "conversation-row-a",
			sessionEpoch: 3,
		}, 2);
		source.emitCopy(viewerA, copyEventOf("third A", "row-a"), 5);
		await settle(20);
		const copiesA = copiesSince(channelA, markA);
		assert.equal(copiesSince(channelB, markB).length, 0, "a copy never crosses to another viewer's channel");
		assert.equal(copiesA.length, 3, "every emission is carried whole, pages and all");
		assert.deepEqual(copiesA.map((copy) => copy.sequence), [1, 2, 3], "one emission at a time, in this endpoint's order");
		assert.deepEqual(copiesA.map((copy) => copy.dispatchId), [9, 2, 5], "an out-of-order native dispatch is carried, not reordered");
		assert.deepEqual(copiesA.map((copy) => decodedCopy(copy)).slice(0, 1), ["first A"]);
		const paged = copiesA[1];
		const third = copiesA[2];
		assert.ok(paged !== undefined && third !== undefined);
		assert.equal(decodedCopy(paged), "A".repeat(75_000), "the whole 100,000-character bound crossed");
		assert.equal(decodedCopy(third), "third A");
		assert.deepEqual(copiesA.map((copy) => copy.subscriptionId), ["sub-a", "sub-a", "sub-a"]);
		const publishedA = publishedSource(channelA);
		assert.ok(publishedA !== null && publishedA !== undefined);
		assert.ok(copiesA.every((copy) => nativeIoSourceEquals(copy.source, publishedA)), "each copy names this surface's own scope");

		// B receives only its own copy.
		const markB2 = channelB.sent.length;
		const markA2 = channelA.sent.length;
		source.emitCopy(viewerB, copyEventOf("only B", "row-b"), 1);
		await settle();
		const copiesB = copiesSince(channelB, markB2);
		assert.equal(copiesB.length, 1);
		const ownB = copiesB[0];
		assert.ok(ownB !== undefined);
		assert.equal(decodedCopy(ownB), "only B");
		assert.equal(copiesSince(channelA, markA2).length, 0, "B's copy never appears on A");

		// A receipt naming another surface's scope is dropped on the floor.
		const markA3 = channelA.sent.length;
		const scopeB = source.readViewerInputSource(viewerB);
		assert.ok(scopeB !== undefined);
		source.sinkFor(viewerA)(Object.freeze({ source: scopeB, event: copyEventOf("not yours", "row-a"), dispatchId: 11 }));
		await settle();
		assert.equal(copiesSince(channelA, markA3).length, 0, "a receipt for another surface's scope crosses nothing");
		assert.ok(diagnostics.includes("copy_dropped"));

		// A copy event whose native tuple disagrees with this surface's own is dropped.
		const markA4 = channelA.sent.length;
		source.emitCopy(viewerA, copyEventOf("stale tuple", "row-b"), 12);
		await settle();
		assert.equal(copiesSince(channelA, markA4).length, 0, "a copy from another conversation crosses nothing");

		assert.equal(source.inputWrites.length, 0, "a copy never falls back to the child's input");
	} finally {
		await host.stopAll().catch(() => undefined);
	}
});

test("one native copy carries the whole producer bound, and an unavailable copy keeps its reason", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		await subscribeNative(harness);
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		// The unchanged native producer bound, in encoded characters, crosses whole.
		const encoded = Buffer.alloc(75_000, 0x41).toString("base64");
		assert.equal(encoded.length, NATIVE_COPY_MAX_ENCODED_CHARS);
		const mark = harness.channel.sent.length;
		source.emitCopy(viewerId, { kind: "copy", encoded, sessionId: "conversation-row-a", sessionEpoch: 3 }, 1);
		await settle(20);
		const copies = copiesSince(harness.channel, mark);
		assert.equal(copies.length, 1, "one emission, one whole copy");
		const event = copies[0]?.event;
		assert.equal(event?.kind, "copy");
		if (event !== undefined && event.kind === "copy") assert.equal(event.encoded, encoded, "nothing is trimmed to a message size");
		assert.equal(framesOfType(harness.channel.frames(), "copy_begin").length, 1);
		assert.ok(framesOfType(harness.channel.frames(), "copy_chunk").length > 1, "the copy really crosses as pages");
		assert.equal(framesOfType(harness.channel.frames(), "copy_end").length, 1);
		// One character more is refused whole, never truncated.
		const markTooLong = harness.channel.sent.length;
		source.emitCopy(viewerId, { kind: "copy", encoded: `${encoded}A`, sessionId: "conversation-row-a", sessionEpoch: 3 }, 2);
		await settle();
		assert.equal(copiesSince(harness.channel, markTooLong).length, 0, "a copy over the producer bound is refused whole");
		assert.ok(harness.diagnostics.includes("copy_dropped"));
		assert.equal(harness.binding.subscribed, true, "a refused copy never retires the subscription");
		assert.equal(framesOfType(harness.channel.frames(), "error").length, 0);
		// An unavailable copy crosses as its fixed reason with the same authenticated tuple.
		const markUnavailable = harness.channel.sent.length;
		source.emitCopy(viewerId, {
			kind: "unavailable",
			reason: "unsupported-runtime",
			sessionId: "conversation-row-a",
			sessionEpoch: 3,
		}, 3);
		await settle();
		const unavailable = copiesSince(harness.channel, markUnavailable);
		assert.equal(unavailable.length, 1);
		assert.deepEqual(unavailable[0]?.event, {
			kind: "unavailable",
			reason: "unsupported-runtime",
			sessionId: "conversation-row-a",
			sessionEpoch: 3,
		});
		assert.equal(source.inputWrites.length, 0);
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a copy is fenced before every part, and a retired surface emits nothing at all", async () => {
	// (1) The scope changes while later pages are still queued, after the begin crossed.
	{
		const source = new FakeContentSource();
		source.addRow("row-a", 80, 24);
		const harness = createHarness({ source, nativeIo: true });
		// The viewer's own assembler, fed only what actually arrived on the wire.
		const assembler = createNativeCopyAssembler(DEFAULT_SESSION_CONTENT_BOUNDS);
		const viewer: { fed: number; completed: NativeIoCompletedCopy | undefined } = { fed: 0, completed: undefined };
		const feedViewer = (): void => {
			const all = harness.channel.frames();
			for (; viewer.fed < all.length; viewer.fed += 1) {
				const frame = all[viewer.fed];
				if (frame === undefined) continue;
				if (frame.type !== "copy" && frame.type !== "copy_begin" && frame.type !== "copy_chunk"
					&& frame.type !== "copy_end") continue;
				viewer.completed = assembler.accept(frame) ?? viewer.completed;
			}
		};
		try {
			await openNativeHello(harness);
			await subscribeNative(harness);
			const viewerId = harness.binding.viewerId;
			assert.ok(viewerId !== null);
			harness.channel.hold = true;
			source.emitCopy(viewerId, {
				kind: "copy",
				encoded: Buffer.alloc(75_000, 0x41).toString("base64"),
				sessionId: "conversation-row-a",
				sessionEpoch: 3,
			}, 1);
			await settle();
			assert.equal(harness.channel.heldWrites, 1, "the one writer holds exactly one outstanding copy frame");
			// The surface is re-registered under a new token while pages are queued.
			source.rotateSourceToken(viewerId);
			harness.channel.hold = false;
			harness.channel.release();
			await settle(20);
			feedViewer();
			assert.equal(framesOfType(harness.channel.frames(), "copy_begin").length, 1);
			assert.equal(
				framesOfType(harness.channel.frames(), "copy_end").length,
				0,
				"no part of a stale emission is written after its scope changed",
			);
			assert.ok(harness.diagnostics.includes("copy_dropped"));
			assert.equal(viewer.completed, undefined, "the viewer is never told a truncated copy is its clipboard");
			assert.equal(source.inputWrites.length, 0, "a dropped copy is never re-routed to the child");
			// An interrupted emission whose begin the viewer already holds cannot simply be
			// forgotten: its pages can never arrive, so the subscription retires instead of
			// leaving the peer holding an assembly that poisons every later copy.
			assert.equal(
				framesOfType(harness.channel.frames(), "error").at(-1)?.code,
				"transfer_failed",
				"the unusable stream ends through the existing transfer-failure path",
			);
			assert.equal(harness.binding.subscribed, false, "the interrupted copy retires its subscription");
			assert.equal(source.liveWatches.length, 0);
			assert.equal(source.viewers.size, 0, "retirement releases this binding's own viewer");
			assert.equal(harness.channel.closeCalls, 0, "only the subscription ends; the lane stays usable");
			// A fresh subscription starts clean: its own copy assembles whole on the wire
			// this time, which an interrupted earlier stream could never have allowed.
			await subscribeNative(harness, { subscriptionId: "sub-2" });
			const nextViewerId = harness.binding.viewerId;
			assert.ok(nextViewerId !== null);
			const firstFreshFrame = harness.channel.frames().length;
			source.emitCopy(nextViewerId, copyEventOf("the next copy", "row-a"), 1);
			await settle();
			const fresh = createNativeCopyAssembler(DEFAULT_SESSION_CONTENT_BOUNDS);
			let completed: NativeIoCompletedCopy | undefined;
			for (const frame of harness.channel.frames().slice(firstFreshFrame)) {
				if (frame.type !== "copy") continue;
				completed = fresh.accept(frame);
			}
			assert.ok(completed !== undefined, "a later copy on the fresh subscription completes whole");
			assert.equal(decodedCopy(completed), "the next copy");
		} finally {
			await harness.host.stopAll().catch(() => undefined);
		}
	}
	// (2) Authority is revoked in the middle of an emission.
	{
		const source = new FakeContentSource();
		source.addRow("row-a", 80, 24);
		const harness = createHarness({ source, nativeIo: true });
		try {
			await openNativeHello(harness);
			await subscribeNative(harness);
			const viewerId = harness.binding.viewerId;
			assert.ok(viewerId !== null);
			harness.channel.hold = true;
			source.emitCopy(viewerId, copyEventOf("half an emission", "row-a"), 1);
			source.emitCopy(viewerId, {
				kind: "copy",
				encoded: Buffer.alloc(75_000, 0x41).toString("base64"),
				sessionId: "conversation-row-a",
				sessionEpoch: 3,
			}, 2);
			await settle();
			harness.allow.value = false;
			harness.channel.hold = false;
			harness.channel.release();
			await settle(20);
			assert.equal(
				framesOfType(harness.channel.frames(), "copy_end").length,
				0,
				"a revoked grant writes no further copy frame, chunk, or end",
			);
			assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "not_authorized");
			assert.equal(source.viewers.size, 0, "refusal still retires this endpoint's own resources");
			assert.equal(source.inputWrites.length, 0);
		} finally {
			await harness.host.stopAll().catch(() => undefined);
		}
	}
	// (3) A surface whose release the source could not confirm still emits nothing.
	{
		const source = new FakeContentSource();
		source.addRow("row-a", 80, 24);
		const harness = createHarness({ source, nativeIo: true });
		try {
			await openNativeHello(harness);
			await subscribeNative(harness);
			const viewerId = harness.binding.viewerId;
			assert.ok(viewerId !== null);
			source.refuseViewerClose = true;
			await harness.binding.stop().catch(() => undefined);
			source.refuseViewerClose = false;
			assert.equal(harness.binding.subscribed, false);
			const mark = harness.channel.sent.length;
			source.emitCopy(viewerId, copyEventOf("a late copy", "row-a"), 1);
			await settle();
			assert.equal(harness.channel.sent.length, mark, "a retired binding writes nothing at all");
			assert.equal(source.inputWrites.length, 0, "a retired surface never falls back to the child");
		} finally {
			await harness.host.stopAll().catch(() => undefined);
		}
	}
});

test("native copies share the one bounded writer and fail closed rather than drop silently", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		await subscribeNative(harness);
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		harness.channel.hold = true;
		// The backlog is deeper than the one bounded writer can represent. Emission
		// stops the moment the endpoint has failed closed: its own viewer is already
		// released, and a released surface has nothing to copy.
		for (let index = 1; index <= 12 && harness.binding.subscribed && !harness.diagnostics.includes("send_failed"); index += 1) {
			source.emitCopy(viewerId, copyEventOf(`copy ${index}`, "row-a"), index);
		}
		await settle();
		assert.ok(
			harness.diagnostics.includes("send_failed"),
			"an unrepresentable backlog fails closed instead of dropping a copy silently",
		);
		assert.equal(harness.binding.subscribed, false);
		assert.equal(source.inputWrites.length, 0, "a failed copy backlog never becomes input");
		harness.channel.release();
		await waitFor(() => harness.channel.closeCalls === 1, "the fenced content channel never closed");
		assert.equal(source.liveWatches.length, 0);
		assert.equal(source.viewers.size, 0, "retirement still releases this binding's own viewer");
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a copy never interleaves with a viewport transfer and the viewport still completes", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true, bounds: { maxChunkPayloadBytes: 512 } });
	try {
		await openNativeHello(harness);
		await subscribeNative(harness);
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		harness.channel.hold = true;
		harness.channel.deliver(resizeFrame({ cols: 60, rows: 20 }));
		await settle();
		source.emitCopy(viewerId, copyEventOf("a copy between frames", "row-a"), 1);
		harness.channel.hold = false;
		harness.channel.release();
		await settle(30);
		const copies = assembledCopies(harness.channel.frames());
		assert.equal(copies.length, 1, "the copy arrived whole among the viewport frames");
		const interleaved = copies[0];
		assert.ok(interleaved !== undefined);
		assert.equal(decodedCopy(interleaved), "a copy between frames");
		// The interrupted viewport still finishes: one writer, one assembly at a time.
		assert.ok(
			framesOfType(harness.channel.frames(), "content_end").length >= 2,
			"both viewport transfers completed",
		);
		const begin = framesOfType(harness.channel.frames(), "content_begin").at(-1);
		assert.ok(begin !== undefined);
		assert.equal(begin.geometry.cols, 60, "the resized viewport published completely");
		assert.equal(harness.binding.subscribed, true);
		assert.equal(harness.channel.heldWrites, 0, "nothing is left outstanding");
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a copy frame from a viewer is a frame this side never receives", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		await subscribeNative(harness);
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		// A copy is owner-to-viewer only: a peer cannot push clipboard content, an
		// owner-terminal write, or a relay request onto this lane.
		harness.channel.deliver({
			type: "copy",
			subscriptionId: "sub-1",
			copyId: randomUUID(),
			sequence: 1,
			source: wireSourceOf(source, viewerId),
			dispatchId: 1,
			event: {
				kind: "copy",
				encoded: Buffer.from("claimed by the viewer").toString("base64"),
				sessionId: "conversation-row-a",
				sessionEpoch: 3,
			},
		});
		await settle();
		assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "bad_frame");
		assert.equal(harness.channel.closeCalls, 1, "this content lane fails closed and nothing else changes");
		assert.equal(source.inputWrites.length, 0, "a claimed copy never reaches a child or a clipboard");
		// The lane fails closed, and failing closed still means retiring this endpoint's
		// own resources: the viewer and the copy sink it registered are released.
		assert.equal(harness.binding.viewerId, null);
		assert.equal(source.viewers.size, 0);
		assert.equal(source.viewerSinks.size, 0, "a closed lane keeps no sink behind");
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a completed input ordinal cannot reach the child twice because a refusal freed a buffer", async () => {
	const { source, harness, published } = await openInputCase(INPUT_MODES);
	try {
		sendNativeInput(harness.channel, { source: published, kind: "keyboard", data: "a", ordinal: 1 });
		await settle();
		assert.equal(source.inputWrites.length, 1, "the first packet was handed over exactly once");
		// An ordinary stale paste begin is a quiet refusal that frees its partial buffer.
		// Freeing bytes is not a new session: the ordinals already completed stay fence.
		const staleBegin = buildPaste({
			source: { ...published, sourceToken: "token-another-surface" },
			ordinal: 2,
			text: "y".repeat(40_000),
		});
		harness.channel.deliverBytes(staleBegin.frames[0] ?? Buffer.alloc(0));
		await settle();
		assert.equal(source.inputWrites.length, 1);
		assert.ok(harness.diagnostics.includes("input_refused"), "the stale begin is refused quietly");
		assert.equal(
			framesOfType(harness.channel.frames(), "error").length,
			0,
			"staleness is not a protocol failure and never disconnects",
		);
		// The completed packet replayed at its own ordinal can never execute again.
		sendNativeInput(harness.channel, { source: published, kind: "keyboard", data: "a", ordinal: 1 });
		await settle();
		assert.equal(source.inputWrites.length, 1, "a replayed ordinal never produces a second PTY handoff");
		assert.equal(
			framesOfType(harness.channel.frames(), "error").at(-1)?.code,
			"bad_frame",
			"a replay is a protocol failure under the existing wire policy",
		);
		assert.equal(harness.channel.closeCalls, 1, "this content lane fails closed and nothing else");
		assert.equal(source.viewers.size, 0, "failing closed still retires this endpoint's own resources");
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a modes-only abandonment cannot unlock the completed ordinal fence", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	const harness = createHarness({ source, nativeIo: true });
	const modesWithoutPaste: TerminalInputModes = Object.freeze({ ...INPUT_MODES, bracketedPaste: false });
	try {
		await openNativeHello(harness);
		const published = await subscribeNative(harness);
		sendNativeInput(harness.channel, { source: published, kind: "keyboard", data: "a", ordinal: 1 });
		await settle();
		assert.equal(source.inputWrites.length, 1);
		const built = buildPaste({ source: published, ordinal: 2, text: "y".repeat(40_000) });
		harness.channel.deliverBytes(built.frames[0] ?? Buffer.alloc(0));
		harness.channel.deliverBytes(built.frames[1] ?? Buffer.alloc(0));
		await settle();
		source.inputModes = modesWithoutPaste;
		source.emit("row-a");
		await settle();
		source.inputModes = INPUT_MODES;
		source.emit("row-a");
		await settle();
		assert.ok(harness.diagnostics.includes("input_incomplete"), "the modes move freed the open paste");
		sendNativeInput(harness.channel, { source: published, kind: "keyboard", data: "a", ordinal: 1 });
		await settle();
		assert.equal(source.inputWrites.length, 1, "a freed paste cannot re-admit a completed ordinal");
		assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "bad_frame");
		assert.equal(harness.channel.closeCalls, 1);
	} finally {
		source.inputModes = INPUT_MODES;
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a viewer revision change with no geometry notification still refreshes the published source", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	// Exactly like the manager: a row's size is the minimum over the viewers that
	// display it, so a sibling at 80x24 keeps the canonical geometry while this
	// endpoint's own surface grows — and no content change is ever delivered.
	source.emitOnlyOnCanonicalChange = true;
	const sibling = source.openViewer();
	assert.ok(sibling !== undefined);
	assert.equal(sibling.sessionId, undefined, "a fresh surface shows no row until it is placed");
	assert.equal(
		source.updateViewer(sibling.viewerId, { sessionId: "row-a", cols: 80, rows: 24 }).applied,
		true,
	);
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		const before = await subscribeNative(harness);
		await settle();
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		const capturesBefore = source.builtSnapshots.length;
		const watchesBefore = source.installedRowIds.length;
		harness.channel.deliver(resizeFrame({ cols: 100, rows: 30 }));
		await settle();
		assert.equal(source.geometryOf("row-a").cols, 80, "the sibling still decides the canonical width");
		assert.equal(source.readViewer(viewerId)?.cols, 100, "this surface really did change");
		assert.equal(
			source.builtSnapshots.length,
			capturesBefore + 1,
			"the owner's facts were re-read exactly once, and only an observed snapshot is published",
		);
		assert.equal(source.installedRowIds.length, watchesBefore + 1, "the watch was replaced, never stacked");
		assert.equal(source.watches[0]?.unsubscribed, 1, "the old watch was retired before its replacement");
		assert.equal(source.liveWatches.length, 1, "this binding holds exactly one watch");
		const after = publishedSource(harness.channel);
		assert.ok(after !== null && after !== undefined, "the refresh published this viewer's viewport");
		assert.notEqual(JSON.stringify(after), JSON.stringify(before), "the new surface revision reached the wire");
		assert.deepEqual(after, wireSourceOf(source, viewerId), "what is stated is the CURRENT owner scope");
		sendNativeInput(harness.channel, { source: before, kind: "keyboard", data: "x", ordinal: 1 });
		await settle();
		assert.equal(source.inputWrites.length, 0, "the superseded source is still refused");
		sendNativeInput(harness.channel, { source: after, kind: "keyboard", data: "a", ordinal: 2 });
		await settle();
		assert.equal(source.inputWrites.length, 1, "input works on an idle terminal, without waiting for output");
		assert.equal(handedText(source), "a");
		assert.equal(framesOfType(harness.channel.frames(), "error").length, 0);
		assert.equal(harness.binding.subscribed, true);
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a resize that frees an open paste leaves no deadline to retire the subscription later", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	source.emitOnlyOnCanonicalChange = true;
	const sibling = source.openViewer();
	assert.ok(sibling !== undefined);
	source.updateViewer(sibling.viewerId, { sessionId: "row-a", cols: 80, rows: 24 });
	const harness = createHarness({ source, nativeIo: true, timeouts: { transferIdleTimeoutMs: 60 } });
	try {
		await openNativeHello(harness);
		const published = await subscribeNative(harness);
		const built = buildPaste({ source: published, ordinal: 1, text: "y".repeat(40_000) });
		harness.channel.deliverBytes(built.frames[0] ?? Buffer.alloc(0));
		harness.channel.deliverBytes(built.frames[1] ?? Buffer.alloc(0));
		await settle();
		assert.equal(source.inputWrites.length, 0, "an incomplete paste is never handed over");
		harness.channel.deliver(resizeFrame({ cols: 100, rows: 30 }));
		await settle();
		assert.ok(harness.diagnostics.includes("input_incomplete"), "the pane change freed the paste immediately");
		// A real wait past the 60ms idle deadline the abandoned paste had armed. Without
		// an immediate release, this is where the subscription would quietly end.
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		await settle();
		assert.equal(harness.binding.subscribed, true, "a freed paste leaves no deadline to end the subscription");
		assert.equal(framesOfType(harness.channel.frames(), "error").length, 0);
		assert.equal(harness.channel.closeCalls, 0);
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		sendNativeInput(harness.channel, {
			source: wireSourceOf(source, viewerId), kind: "keyboard", data: "a", ordinal: 2,
		});
		await settle();
		assert.equal(source.inputWrites.length, 1, "input continues on the refreshed source");
		assert.equal(handedText(source), "a");
	} finally {
		await harness.host.stopAll().catch(() => undefined);
	}
});

test("a resize whose watch replacement cannot be retired ends the subscription as retained evidence", async () => {
	const source = new FakeContentSource();
	source.addRow("row-a", 80, 24);
	source.emitOnlyOnCanonicalChange = true;
	const sibling = source.openViewer();
	assert.ok(sibling !== undefined);
	source.updateViewer(sibling.viewerId, { sessionId: "row-a", cols: 80, rows: 24 });
	const harness = createHarness({ source, nativeIo: true });
	try {
		await openNativeHello(harness);
		await subscribeNative(harness);
		const viewerId = harness.binding.viewerId;
		assert.ok(viewerId !== null);
		source.throwOnUnsubscribe = true;
		harness.channel.deliver(resizeFrame({ cols: 100, rows: 30 }));
		await settle();
		assert.ok(
			harness.diagnostics.includes("watch_release_uncertain"),
			"a release that cannot be proven is evidence, not best-effort cleanup",
		);
		assert.equal(source.installedRowIds.length, 1, "no replacement watch is installed beside an unretired one");
		assert.equal(source.watches[0]?.unsubscribed, 0, "the failed release stays visible");
		assert.equal(source.liveWatches.length, 1, "the unretired watch stays retained by this binding");
		assert.equal(harness.binding.subscribed, false, "the subscription cannot continue on an unretirable handle");
		assert.equal(framesOfType(harness.channel.frames(), "error").at(-1)?.code, "unavailable");
		assert.equal(source.viewers.has(viewerId), false, "the viewer this endpoint did release is released");
		assert.equal(source.viewers.has(sibling.viewerId), true, "the separately owned sibling viewer is preserved");
		assert.equal(source.viewers.size, 1, "only the sibling remains; no endpoint viewer leaked");
		assert.equal(source.inputWrites.length, 0, "a refresh never writes to a child");
		await assert.rejects(harness.binding.stop(), isCloseFailure, "unproven cleanup never settles green");
	} finally {
		source.throwOnUnsubscribe = false;
		await harness.host.stopAll().catch(() => undefined);
	}
});
