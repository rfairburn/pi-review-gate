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
 */

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import type {
	NativeInstanceView,
	SessionGeometry,
	SessionViewerState,
	SessionViewerUpdate,
	SessionViewerUpdateResult,
} from "../src/session-host/instances";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import type {
	OwningHostInventorySnapshot,
	OwningHostSessionContentListener,
	OwningHostSessionContentSnapshot,
	OwningHostSessionContentWatch,
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
	SESSION_CONTENT_MAJOR,
	SESSION_CONTENT_MINOR,
	SESSION_CONTENT_REQUIRED_CAPABILITY,
	SESSION_CONTENT_SERVICE,
	createSessionContentTransferAssembler,
	decodeSessionContentFrame,
	encodeSessionContentFrame,
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
	readonly nativeSession: SessionHostNativeSession;
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
	/** Runs after a viewer is allocated, before it is handed back to the endpoint. */
	openViewerHook: (() => void) | undefined;
	/** Publish the install snapshot under a different owner run. */
	watchRunOverride: string | undefined;
	/** Runs after a viewer change was applied and its ordinary snapshot emitted. */
	updateHook: ((rowId: string) => void) | undefined;
	/** Runs before `watchSessionContent` returns, as a retained source change would. */
	installHook: ((rowId: string) => void) | undefined;
	#nextViewerId = 1;
	#sequence = 0;
	#inventoryRevision = 0;

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

	openViewer(): SessionViewerState | undefined {
		this.events.push("openViewer");
		if (this.viewerUnavailable) return undefined;
		const viewer: FakeViewer = {
			viewerId: `viewer-${this.#nextViewerId++}`,
			sessionId: undefined,
			cols: undefined,
			rows: undefined,
			revision: 0,
		};
		this.viewers.set(viewer.viewerId, viewer);
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
		for (const rowId of this.#affectedRows(previousSession, viewer.sessionId)) this.#recompute(rowId);
		for (const rowId of this.#affectedRows(previousSession, viewer.sessionId)) this.emit(rowId);
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
		this.closedViewerIds.push(viewerId);
		if (viewer.sessionId !== undefined) {
			this.#recompute(viewer.sessionId);
			this.emit(viewer.sessionId);
		}
		return true;
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
			inputModes: INPUT_MODES,
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
	#recompute(rowId: string): void {
		const row = this.rows.get(rowId);
		if (row === undefined) return;
		const contributions = [...this.viewers.values()]
			.filter((viewer) => viewer.sessionId === rowId && viewer.cols !== undefined && viewer.rows !== undefined);
		if (contributions.length === 0) return;
		const cols = Math.min(...contributions.map((viewer) => viewer.cols as number));
		const rows = Math.min(...contributions.map((viewer) => viewer.rows as number));
		if (cols === row.cols && rows === row.rows) return;
		row.cols = cols;
		row.rows = rows;
		row.revision += 1;
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
} = {}): Harness {
	const source = options.source ?? new FakeContentSource();
	const channel = new ContentChannel();
	source.events = channel.events;
	const diagnostics: SessionContentHostDiagnosticCode[] = [];
	const allow = { value: true };
	const host = createSessionContentHost({
		source,
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
