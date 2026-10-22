/**
 * Focused source tests for the single-target native viewport viewer endpoint
 * (#389 selection content phase).
 *
 * Everything here is in memory: the only channel is a locally owned fake that
 * speaks the settled content protocol, the owner is scripted by the test, and
 * no socket, listener, TLS identity, pairing, process, PTY, store, or filesystem
 * path is touched. The parallel owner-side endpoint is deliberately not
 * imported, so these assertions describe this viewer's contract only: exact
 * fences before an atomic publish, bounded handshake/transfer/stop control,
 * latest-only resize, synchronous clearing on retirement, and no idle-current
 * frame expiry, reconnect, input, or clipboard authority.
 */

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";

import type { PeerByteChannel, PeerChannelClose } from "../src/session-host/network/channel";
import type { PeerKey } from "../src/session-host/network/identity";
import type { PeerAppLane } from "../src/session-host/network/protocol";
import {
	DEFAULT_SESSION_CONTENT_BOUNDS,
	SESSION_CONTENT_MAJOR,
	SESSION_CONTENT_MINOR,
	SESSION_CONTENT_REQUIRED_CAPABILITY,
	SESSION_CONTENT_SERVICE,
	buildSessionContentTransfer,
	decodeSessionContentFrame,
	encodeSessionContentFrame,
	isSessionContentProtocolError,
	resolveSessionContentBounds,
	type SessionContentBuiltTransfer,
	type SessionContentFrame,
	type SessionContentHelloAckFrame,
	type SessionContentSnapshot,
} from "../src/session-host/network/session-content-protocol";
import {
	attachSessionContentViewer,
	isSessionContentViewerError,
	type SessionContentViewer,
	type SessionContentViewerDiagnostic,
	type SessionContentViewerOptions,
} from "../src/session-host/network/session-content-client";
import type {
	TerminalCellRun,
	TerminalFrame,
	TerminalInputModes,
	TerminalLineStyles,
} from "../src/session-host/terminal-surface";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const BOUNDS = resolveSessionContentBounds();
const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN = "22222222-2222-4222-8222-222222222222";
const ROW = "instance-rows-1";
const OTHER_ROW = "instance-rows-2";

const INPUT_MODES: TerminalInputModes = Object.freeze({
	kittyFlags: 0,
	applicationCursorKeys: false,
	applicationKeypad: false,
	bracketedPaste: false,
	mouseTracking: "none",
	modifyOtherKeys: 0,
	mouseEncoding: "default",
});

const FAST_TIMEOUTS: SessionContentViewerOptions["timeouts"] = {
	handshakeTimeoutMs: 200,
	snapshotStartTimeoutMs: 200,
	transferIdleTimeoutMs: 150,
	stopAckTimeoutMs: 80,
};

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

/** One minimal, valid 4x4 RGBA PNG, generated locally so no fixture is trusted. */
function pngBase64(width = 4, height = 4): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const raw = Buffer.alloc(height * (1 + width * 4));
	for (let row = 0; row < height; row += 1) {
		const start = row * (1 + width * 4);
		raw[start] = 0;
		for (let column = 0; column < width; column += 1) {
			const pixel = start + 1 + column * 4;
			raw[pixel] = (row * 17) % 256;
			raw[pixel + 1] = (column * 29) % 256;
			raw[pixel + 2] = 128;
			raw[pixel + 3] = 255;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

const ZERO_CLIP = Object.freeze({ leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 });

/** A small viewport carrying Unicode, structured styles, cursor, and typed PNG. */
function sampleFrame(): TerminalFrame {
	return {
		cols: 12,
		rows: 3,
		lines: [
			"\x1b[0mhi \u4e16\u754c e\u0301\x1b[0m\x1b[0m",
			"\x1b[0m\x1b[1;38;5;196mred\x1b[0m\x1b[38;2;16;32;48mbg\x1b[0m\x1b[0m",
			"\x1b[0m\x1b[4;53munder\x1b[0m\x1b[0m",
		],
		cursor: { column: 3, row: 1, visible: true },
		styles: [
			{ line: 0, runs: [{ startColumn: 0, text: "hi \u4e16\u754c e\u0301" }] },
			{
				line: 1,
				runs: [
					{ startColumn: 0, text: "red", bold: true, fg: { mode: "palette", value: 196 } },
					{ startColumn: 3, text: "bg", bg: { mode: "rgb", value: 0x10_20_30 } },
				],
			},
			{
				line: 2,
				runs: [{ startColumn: 0, text: "under", underline: true, overline: true, fg: { mode: "default", value: 0 } }],
			},
		],
		graphics: {
			images: [{ id: "kitty-7", mimeType: "image/png", widthPx: 4, heightPx: 4, base64: pngBase64() }],
			placements: [{
				id: "placement-7",
				imageId: "kitty-7",
				column: 2,
				row: 1,
				columns: 3,
				rows: 2,
				crop: { x: 0, y: 0, width: 4, height: 4 },
				clip: ZERO_CLIP,
			}],
			fallbacks: [{
				id: "placement-7",
				mimeType: "image/png",
				widthPx: 4,
				heightPx: 4,
				column: 2,
				row: 1,
				columns: 3,
				rows: 2,
				clip: ZERO_CLIP,
			}],
		},
	};
}

/** A normal styled pane whose canonical payload is comfortably larger than 64 KiB. */
function styledFrame(rows: number, cols = 70): TerminalFrame {
	const text = "\u4e16\u754c\u6587\u5b57\u30c6\u30ad";
	const runsPerLine = 10;
	const lines: string[] = [];
	const styles: TerminalLineStyles[] = [];
	for (let row = 0; row < rows; row += 1) {
		let serialized = "\x1b[0m";
		const runs: TerminalCellRun[] = [];
		for (let run = 0; run < runsPerLine; run += 1) {
			const value = (row * runsPerLine + run) % 256;
			runs.push({ startColumn: run * text.length, text, fg: { mode: "palette", value } });
			serialized += `\x1b[38;5;${value}m${text}\x1b[0m`;
		}
		serialized += "\x1b[0m";
		lines.push(serialized);
		styles.push({ line: row, runs });
	}
	return { cols, rows, lines, cursor: { column: 0, row: 0, visible: true }, styles };
}

function transfer(
	frame: TerminalFrame,
	overrides: Partial<Parameters<typeof buildSessionContentTransfer>[0]> = {},
): SessionContentBuiltTransfer {
	return buildSessionContentTransfer({
		subscriptionId: "unset-subscription",
		transferId: "transfer-1",
		hostRunId: RUN,
		sessionId: ROW,
		nativeSession: { sessionId: "native-conversation-1", epoch: 2 },
		sequence: 1,
		geometry: { cols: frame.cols, rows: frame.rows, revision: 0 },
		inputModes: INPUT_MODES,
		frame,
		...overrides,
	});
}

function helloAck(): SessionContentHelloAckFrame {
	return {
		type: "hello_ack",
		service: SESSION_CONTENT_SERVICE,
		major: SESSION_CONTENT_MAJOR,
		minor: SESSION_CONTENT_MINOR,
		capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY],
	};
}

function isFrozenDeep(value: unknown): boolean {
	if (Array.isArray(value)) return Object.isFrozen(value) && value.every(isFrozenDeep);
	if (typeof value === "object" && value !== null) {
		return Object.isFrozen(value) && Object.values(value).every(isFrozenDeep);
	}
	return true;
}

/* ------------------------------------------------------------------------- *
 * Owned fake channel
 * ------------------------------------------------------------------------- */

/**
 * One locally owned content channel. `send` preserves message boundaries exactly
 * like the transport, a scripted owner can answer synchronously from inside the
 * send callback (so an acknowledgement cannot be "missed" by timing), writes can
 * be failed, thrown, or held unsettled, and the close is recorded.
 */
class FakeContentChannel implements PeerByteChannel {
	readonly peerKey: PeerKey;
	readonly lane: PeerAppLane;
	readonly label: string | null = "content";
	readonly sent: Buffer[] = [];
	handlerCount = 0;
	closeCalls = 0;
	bufferedAmount = 0;
	failNextSend = false;
	throwNextSend = false;
	/** Accept the bytes but leave the write's promise unsettled until released. */
	holdSend = false;
	/** Whether closing this side finishes it (a real close is asynchronous). */
	finishOnClose = true;
	/** Runs synchronously inside `send`, before that write's promise settles. */
	onSend: ((bytes: Buffer) => void) | undefined = undefined;
	#handlers = new Set<(bytes: Buffer) => void>();
	#held: Array<() => void> = [];
	#closed: Promise<PeerChannelClose>;
	#resolveClosed!: (value: PeerChannelClose) => void;
	#finished = false;

	constructor(lane: PeerAppLane = "content", peerKey: PeerKey = { keyId: "owner-key", fingerprint: "synthetic-owner" }) {
		this.lane = lane;
		this.peerKey = peerKey;
		this.#closed = new Promise<PeerChannelClose>((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	get closed(): Promise<PeerChannelClose> {
		return this.#closed;
	}

	send(bytes: Uint8Array): Promise<void> {
		if (this.#finished) return Promise.reject(new Error("channel closed"));
		if (this.throwNextSend) {
			this.throwNextSend = false;
			throw new Error("synthetic synchronous send throw");
		}
		if (this.failNextSend) {
			this.failNextSend = false;
			return Promise.reject(new Error("synthetic send failure"));
		}
		const copy = Buffer.from(bytes);
		this.sent.push(copy);
		this.onSend?.(copy);
		if (this.holdSend) {
			return new Promise<void>((resolve) => {
				this.#held.push(() => resolve());
			});
		}
		return Promise.resolve();
	}

	close(): Promise<void> {
		this.closeCalls += 1;
		if (this.finishOnClose) this.finish(1000, "");
		return Promise.resolve();
	}

	onMessage(handler: (bytes: Buffer) => void): () => void {
		this.#handlers.add(handler);
		this.handlerCount = this.#handlers.size;
		return () => {
			this.#handlers.delete(handler);
			this.handlerCount = this.#handlers.size;
		};
	}

	releaseSends(): void {
		const held = this.#held;
		this.#held = [];
		this.holdSend = false;
		for (const resolve of held) resolve();
	}

	/** Deliver one frame from the owner to the viewer. */
	deliver(frame: SessionContentFrame | Uint8Array): void {
		if (this.#finished) return;
		const bytes = frame instanceof Uint8Array
			? Buffer.from(frame)
			: encodeSessionContentFrame(frame, BOUNDS);
		for (const handler of [...this.#handlers]) handler(bytes);
	}

	finish(code = 1000, reason = ""): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#resolveClosed(Object.freeze({ code, reason }));
	}

	frames(): SessionContentFrame[] {
		return this.sent.map((bytes) => decodeSessionContentFrame(bytes, BOUNDS));
	}

	types(): string[] {
		return this.frames().map((frame) => frame.type);
	}
}

interface ScriptedOwner {
	readonly received: SessionContentFrame[];
}

interface OwnerScript {
	readonly autoHelloAck?: boolean;
	readonly autoSubscribe?: boolean;
	readonly autoUnsubscribe?: boolean;
	readonly hostRunId?: string;
	readonly sessionId?: string;
}

/** A minimal scripted owner that answers only what the test asks for. */
function scriptOwner(channel: FakeContentChannel, script: OwnerScript = {}): ScriptedOwner {
	const received: SessionContentFrame[] = [];
	channel.onSend = (bytes) => {
		const frame = decodeSessionContentFrame(bytes, BOUNDS);
		received.push(frame);
		switch (frame.type) {
			case "hello":
				if (script.autoHelloAck ?? true) channel.deliver(helloAck());
				return;
			case "subscribe":
				if (script.autoSubscribe ?? true) {
					channel.deliver({
						type: "subscribed",
						subscriptionId: frame.subscriptionId,
						sessionId: script.sessionId ?? ROW,
						hostRunId: script.hostRunId ?? RUN,
					});
				}
				return;
			case "unsubscribe":
				if (script.autoUnsubscribe ?? true) {
					channel.deliver({ type: "unsubscribed", subscriptionId: frame.subscriptionId });
				}
				return;
			default:
				return;
		}
	};
	return { received };
}

async function settle(times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Fail the test instead of hanging when an endpoint never settles. */
function deadlined<T>(promise: Promise<T>, label: string, ms = 3_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error: unknown) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function viewportViewer(
	channel: FakeContentChannel,
	overrides: Partial<SessionContentViewerOptions> = {},
): SessionContentViewer {
	return attachSessionContentViewer({
		channel,
		hostRunId: RUN,
		sessionId: ROW,
		cols: 80,
		rows: 24,
		timeouts: FAST_TIMEOUTS,
		...overrides,
	});
}

function deliverAll(channel: FakeContentChannel, built: SessionContentBuiltTransfer): void {
	for (const bytes of built.frames) channel.deliver(bytes);
}

/* ------------------------------------------------------------------------- *
 * Attachment refusals
 * ------------------------------------------------------------------------- */

test("attachment needs the dedicated content lane and an exact verified peer key, and never touches a refused channel", () => {
	const app = new FakeContentChannel("app");
	assert.throws(
		() => viewportViewer(app),
		(error: unknown) => error instanceof TypeError,
		"the legacy application lane is refused",
	);
	// Refused before any handler, write, or close: the app lane is left exactly as it was.
	assert.equal(app.handlerCount, 0);
	assert.equal(app.sent.length, 0);
	assert.equal(app.closeCalls, 0);

	for (const peerKey of [
		{ keyId: "", fingerprint: "synthetic" },
		{ keyId: "owner-key", fingerprint: "" },
	]) {
		const unverified = new FakeContentChannel("content", peerKey);
		assert.throws(() => viewportViewer(unverified), (error: unknown) => error instanceof TypeError);
		assert.equal(unverified.handlerCount, 0);
		assert.equal(unverified.sent.length, 0);
		assert.equal(unverified.closeCalls, 0);
	}

	// An unrepresentable immutable target is refused by the very encoder that will
	// build the subscribe, before anything exists on the channel.
	for (const overrides of [
		{ hostRunId: "not an identifier" },
		{ hostRunId: "x".repeat(DEFAULT_SESSION_CONTENT_BOUNDS.maxIdentifierBytes + 1) },
		{ cols: 0 },
		{ rows: DEFAULT_SESSION_CONTENT_BOUNDS.maxRows + 1 },
	]) {
		const channel = new FakeContentChannel();
		assert.throws(
			() => viewportViewer(channel, overrides),
			(error: unknown) => isSessionContentProtocolError(error),
			`${JSON.stringify(overrides)} must be refused`,
		);
		assert.equal(channel.handlerCount, 0);
		assert.equal(channel.sent.length, 0);
		assert.equal(channel.closeCalls, 0);
	}

	// Timeout overrides stay finite and positive, and never mean "unlimited".
	for (const timeouts of [
		{ handshakeTimeoutMs: 0 },
		{ snapshotStartTimeoutMs: -1 },
		{ transferIdleTimeoutMs: 1.5 },
		{ stopAckTimeoutMs: Number.POSITIVE_INFINITY },
	]) {
		const channel = new FakeContentChannel();
		assert.throws(() => viewportViewer(channel, { timeouts }));
		assert.equal(channel.handlerCount, 0);
		assert.equal(channel.sent.length, 0);
		assert.equal(channel.closeCalls, 0);
	}
});

/* ------------------------------------------------------------------------- *
 * Handshake
 * ------------------------------------------------------------------------- */

test("the receiver is installed before hello and one subscribe names the exact pinned run and owner row", async () => {
	const channel = new FakeContentChannel();
	const owner = scriptOwner(channel);
	const viewer = viewportViewer(channel, { cols: 132, rows: 43 });
	await deadlined(viewer.ready, "ready");

	assert.deepEqual(channel.types(), ["hello", "subscribe"], "nothing else is sent before the acknowledgement");
	const hello = decodeSessionContentFrame(channel.sent[0], BOUNDS);
	assert.equal(hello.type, "hello");
	if (hello.type !== "hello") throw new Error("unreachable");
	assert.equal(hello.service, SESSION_CONTENT_SERVICE);
	assert.equal(hello.major, SESSION_CONTENT_MAJOR);
	assert.equal(hello.minor, SESSION_CONTENT_MINOR);
	assert.deepEqual(hello.capabilities, [SESSION_CONTENT_REQUIRED_CAPABILITY]);

	const subscribe = decodeSessionContentFrame(channel.sent[1], BOUNDS);
	assert.equal(subscribe.type, "subscribe");
	if (subscribe.type !== "subscribe") throw new Error("unreachable");
	assert.equal(subscribe.subscriptionId, viewer.subscriptionId);
	assert.equal(subscribe.hostRunId, RUN, "the expected observed run is pinned on the wire");
	assert.equal(subscribe.sessionId, ROW, "the owner row is pinned on the wire");
	assert.equal(subscribe.cols, 132);
	assert.equal(subscribe.rows, 43);
	assert.match(viewer.subscriptionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	assert.equal(owner.received.length, 2);

	// One fresh identifier per viewer: a replacement viewer never reuses it.
	const otherChannel = new FakeContentChannel();
	scriptOwner(otherChannel);
	const other = viewportViewer(otherChannel);
	await deadlined(other.ready, "second ready");
	assert.notEqual(other.subscriptionId, viewer.subscriptionId);

	await deadlined(viewer.stop(), "first stop");
	await deadlined(other.stop(), "second stop");
});

test("ready needs the exact subscribed acknowledgement and never a frame or a foreign tuple", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel, { autoSubscribe: false });
	const viewer = viewportViewer(channel);
	let readyResolved = false;
	let closedResolved = false;
	void viewer.ready.then(() => {
		readyResolved = true;
	}, () => undefined);
	void viewer.closed.then(() => {
		closedResolved = true;
	});

	await settle();
	assert.equal(readyResolved, false, "hello_ack alone never makes the viewer ready");
	assert.deepEqual(channel.types(), ["hello", "subscribe"]);
	assert.equal(closedResolved, false);

	// An acknowledgement for another run cannot make this viewer ready: it is a
	// protocol failure that retires the endpoint with nothing published.
	channel.deliver({ type: "subscribed", subscriptionId: viewer.subscriptionId, sessionId: ROW, hostRunId: OTHER_RUN });
	await deadlined(viewer.closed, "closed after foreign subscribed");
	assert.equal(readyResolved, false);
	assert.equal(closedResolved, true);
	await assert.rejects(
		viewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "protocol-violation",
	);
	assert.equal(viewer.readSnapshot(), undefined);
	assert.equal(channel.closeCalls, 1, "the dedicated content channel is closed once");
	assert.equal(channel.handlerCount, 0, "the receiver is detached on retirement");

	// A refused hello acknowledgement is truthful too and publishes nothing.
	const refusedChannel = new FakeContentChannel();
	scriptOwner(refusedChannel, { autoHelloAck: false });
	const refusedViewer = viewportViewer(refusedChannel);
	refusedChannel.deliver({
		type: "hello_ack",
		service: SESSION_CONTENT_SERVICE,
		major: SESSION_CONTENT_MAJOR + 1,
		minor: SESSION_CONTENT_MINOR,
		capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY],
	});
	await deadlined(refusedViewer.closed, "closed after refused hello");
	await assert.rejects(
		refusedViewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "refused",
	);
	assert.equal(refusedChannel.closeCalls, 1);

	// Content that arrives before the exact acknowledgement is a protocol failure,
	// never an early publish.
	const earlyChannel = new FakeContentChannel();
	scriptOwner(earlyChannel, { autoSubscribe: false });
	const earlyViewer = viewportViewer(earlyChannel, { cols: 12, rows: 3 });
	await settle();
	earlyChannel.deliver(transfer(sampleFrame(), { subscriptionId: earlyViewer.subscriptionId }).frames[0] as Buffer);
	await deadlined(earlyViewer.closed, "closed after a pre-acknowledgement frame");
	assert.equal(earlyViewer.readSnapshot(), undefined, "no frame is current before the acknowledgement");
	await assert.rejects(
		earlyViewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "protocol-violation",
	);
});

test("an acknowledgement delivered from inside the send callback is never missed", async () => {
	const channel = new FakeContentChannel();
	const answeredInsideSend: string[] = [];
	channel.onSend = (bytes) => {
		const frame = decodeSessionContentFrame(bytes, BOUNDS);
		if (frame.type === "hello") {
			answeredInsideSend.push("hello_ack");
			// Delivered synchronously, while this write is still on the stack.
			channel.deliver(helloAck());
			return;
		}
		if (frame.type === "subscribe") {
			answeredInsideSend.push("subscribed");
			channel.deliver({ type: "subscribed", subscriptionId: frame.subscriptionId, sessionId: ROW, hostRunId: RUN });
			return;
		}
		if (frame.type === "unsubscribe") {
			channel.deliver({ type: "unsubscribed", subscriptionId: frame.subscriptionId });
		}
	};
	const viewer = viewportViewer(channel);
	await deadlined(viewer.ready, "ready from in-send acknowledgements");
	assert.deepEqual(answeredInsideSend, ["hello_ack", "subscribed"]);
	assert.equal(channel.types()[0], "hello");
	await deadlined(viewer.stop(), "stop");
});

/* ------------------------------------------------------------------------- *
 * Atomic publish
 * ------------------------------------------------------------------------- */

test("a complete styled, Unicode, PNG viewport is published only at its final chunk and never before", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel);
	const published: Array<SessionContentSnapshot | undefined> = [];
	const diagnostics: SessionContentViewerDiagnostic[] = [];
	const viewer = viewportViewer(channel, {
		onSnapshot: (snapshot) => published.push(snapshot),
		onDiagnostic: (event) => diagnostics.push(event),
	});
	await deadlined(viewer.ready, "ready");

	const frame = styledFrame(100);
	const built = transfer(frame, { subscriptionId: viewer.subscriptionId, sequence: 3 });
	assert.ok(built.byteLength > DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes,
		`a full native viewport (${built.byteLength} bytes) is larger than one message`);
	assert.ok(built.chunkCount > 1, "the viewport pages across bounded chunks");

	channel.deliver(built.frames[0] as Buffer);
	for (let index = 1; index < built.frames.length - 1; index += 1) {
		channel.deliver(built.frames[index] as Buffer);
	}
	assert.equal(viewer.readSnapshot(), undefined, "nothing partial is ever current");
	assert.deepEqual(published, [], "no partial publish reaches a listener");

	channel.deliver(built.frames[built.frames.length - 1] as Buffer);
	const snapshot = viewer.readSnapshot();
	assert.ok(snapshot, "the completed transfer is current");
	assert.equal(published.length, 1);
	assert.equal(published[0], snapshot);
	assert.deepEqual(snapshot.frame.lines, frame.lines, "every styled Unicode row survives exactly");
	assert.deepEqual(snapshot.frame.styles, frame.styles, "structured runs survive exactly");
	assert.deepEqual(snapshot.frame.cursor, frame.cursor);
	assert.equal(snapshot.meta.sequence, 3);
	assert.equal(snapshot.meta.chunkCount, built.chunkCount);
	assert.equal(snapshot.meta.byteLength, built.byteLength);
	assert.deepEqual(snapshot.meta.geometry, { cols: frame.cols, rows: frame.rows, revision: 0 });
	assert.deepEqual(snapshot.meta.inputModes, INPUT_MODES);
	assert.deepEqual(snapshot.meta.nativeSession, { sessionId: "native-conversation-1", epoch: 2 });
	assert.equal(snapshot.meta.subscriptionId, viewer.subscriptionId);
	assert.equal(snapshot.meta.hostRunId, RUN);
	assert.equal(snapshot.meta.sessionId, ROW);
	assert.ok(isFrozenDeep(snapshot), "a published viewport is immutable end to end");

	// A second, small transfer with typed PNG graphics publishes atomically too.
	const graphics = transfer(sampleFrame(), {
		subscriptionId: viewer.subscriptionId,
		transferId: "transfer-2",
		sequence: 9,
		geometry: { cols: 12, rows: 3, revision: 1 },
	});
	deliverAll(channel, graphics);
	const next = viewer.readSnapshot();
	assert.ok(next);
	assert.deepEqual(next.frame.graphics, sampleFrame().graphics, "typed PNG images, placements, and fallbacks survive");
	assert.equal(next.meta.sequence, 9);
	assert.equal(published.length, 2);

	assert.deepEqual(
		diagnostics.filter((event) => event.code === "snapshot_published").map((event) => event.sequence),
		[3, 9],
	);
	await deadlined(viewer.stop(), "stop");
});

/* ------------------------------------------------------------------------- *
 * Fences
 * ------------------------------------------------------------------------- */

interface RefusalCase {
	readonly label: string;
	readonly run: (viewer: SessionContentViewer, channel: FakeContentChannel) => void;
}

/** Every refusal case must retire to `undefined` and close the content channel. */
async function expectRefusal(options: { readonly label: string; readonly build: RefusalCase["run"]; readonly publishes?: boolean }): Promise<void> {
	const channel = new FakeContentChannel();
	scriptOwner(channel);
	const published: Array<SessionContentSnapshot | undefined> = [];
	const viewer = viewportViewer(channel, { cols: 12, rows: 3, onSnapshot: (snapshot) => published.push(snapshot) });
	await deadlined(viewer.ready, `${options.label}: ready`);
	if (options.publishes === true) {
		// Establish a current frame first, so the refusal must clear it.
		deliverAll(channel, transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 4 }));
		assert.ok(viewer.readSnapshot(), `${options.label}: a current frame is required before the refusal`);
	}
	options.build(viewer, channel);
	await deadlined(viewer.closed, `${options.label}: closed`);
	assert.equal(viewer.readSnapshot(), undefined, `${options.label}: nothing is current after the refusal`);
	assert.equal(channel.closeCalls, 1, `${options.label}: the dedicated channel is closed exactly once`);
	assert.equal(channel.handlerCount, 0, `${options.label}: the receiver is detached`);
	if (published.length > 0) {
		assert.equal(published.at(-1), undefined, `${options.label}: the cleared view is reported as undefined`);
	}
}

test("wrong run, row, subscription, sequence, and frame/geometry mismatches fail closed", async () => {
	const cases: RefusalCase[] = [
		{
			label: "wrong owner run",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, hostRunId: OTHER_RUN });
				channel.deliver(built.frames[0] as Buffer);
			},
		},
		{
			label: "wrong owner row",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sessionId: OTHER_ROW });
				channel.deliver(built.frames[0] as Buffer);
			},
		},
		{
			label: "foreign subscription",
			run: (_viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: "foreign-subscription-id" });
				channel.deliver(built.frames[0] as Buffer);
			},
		},
		{
			label: "foreign subscription chunk",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId });
				channel.deliver(built.frames[0] as Buffer);
				const chunk = decodeSessionContentFrame(built.frames[1] as Buffer, BOUNDS);
				if (chunk.type !== "content_chunk") throw new Error("unreachable");
				channel.deliver({ ...chunk, subscriptionId: "foreign-subscription-id" });
			},
		},
		{
			label: "duplicate publish sequence",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 4 });
				channel.deliver(built.frames[0] as Buffer);
			},
		},
		{
			label: "regressed publish sequence",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 3 });
				channel.deliver(built.frames[0] as Buffer);
			},
		},
		{
			label: "frame and geometry mismatch",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 5 });
				const begin = decodeSessionContentFrame(built.frames[0] as Buffer, BOUNDS);
				if (begin.type !== "content_begin") throw new Error("unreachable");
				// The declaration claims a 10-column viewport while the payload is 12.
				channel.deliver({ ...begin, geometry: { cols: 10, rows: begin.geometry.rows, revision: 0 } });
				for (let index = 1; index < built.frames.length; index += 1) {
					channel.deliver(built.frames[index] as Buffer);
				}
			},
		},
		{
			label: "no transfer staged then end",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 6 });
				const end = decodeSessionContentFrame(built.frames[built.frames.length - 1] as Buffer, BOUNDS);
				channel.deliver(end);
			},
		},
	];

	for (const entry of cases) {
		// Each case needs its own current frame when it claims a regression.
		const publishes = entry.label === "regressed publish sequence" || entry.label === "duplicate publish sequence";
		await expectRefusal({ label: entry.label, build: entry.run, publishes });
	}
});

test("partial, missing, reordered, duplicated, overlapping, and foreign-transfer chunks never publish", async () => {
	const cases: RefusalCase[] = [
		{
			label: "missing first chunk",
			run: (viewer, channel) => {
				const built = transfer(styledFrame(100), { subscriptionId: viewer.subscriptionId, sequence: 2 });
				assert.ok(built.chunkCount > 1);
				channel.deliver(built.frames[0] as Buffer);
				channel.deliver(built.frames[2] as Buffer);
			},
		},
		{
			label: "end without any chunk",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 2 });
				channel.deliver(built.frames[0] as Buffer);
				channel.deliver(built.frames[built.frames.length - 1] as Buffer);
			},
		},
		{
			label: "duplicated chunk index",
			run: (viewer, channel) => {
				const built = transfer(styledFrame(100), { subscriptionId: viewer.subscriptionId, sequence: 2 });
				channel.deliver(built.frames[0] as Buffer);
				channel.deliver(built.frames[1] as Buffer);
				channel.deliver(built.frames[1] as Buffer);
			},
		},
		{
			label: "foreign transfer id",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 2 });
				channel.deliver(built.frames[0] as Buffer);
				const chunk = decodeSessionContentFrame(built.frames[1] as Buffer, BOUNDS);
				if (chunk.type !== "content_chunk") throw new Error("unreachable");
				channel.deliver({ ...chunk, transferId: "another-transfer-id" });
			},
		},
		{
			label: "overlapping payload bytes",
			run: (viewer, channel) => {
				const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 2 });
				const begin = decodeSessionContentFrame(built.frames[0] as Buffer, BOUNDS);
				if (begin.type !== "content_begin") throw new Error("unreachable");
				// Declare fewer bytes than the chunk actually carries: the write would
				// overlap past the declared payload, so the transfer is refused whole.
				channel.deliver({ ...begin, byteLength: begin.byteLength - 5, chunkCount: 1 });
				channel.deliver(built.frames[1] as Buffer);
			},
		},
		{
			label: "malformed message",
			run: (_viewer, channel) => {
				channel.deliver(Buffer.from("not a content frame"));
			},
		},
	];

	for (const entry of cases) {
		await expectRefusal({ label: entry.label, build: entry.run });
	}
});

test("an owner end, error, or channel loss clears the frame immediately and never resurrects it", async () => {
	const endChannel = new FakeContentChannel();
	scriptOwner(endChannel);
	const published: Array<SessionContentSnapshot | undefined> = [];
	const viewer = viewportViewer(endChannel, { cols: 12, rows: 3, onSnapshot: (snapshot) => published.push(snapshot) });
	await deadlined(viewer.ready, "ready");
	deliverAll(endChannel, transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 1 }));
	assert.ok(viewer.readSnapshot());
	endChannel.deliver({ type: "end", subscriptionId: viewer.subscriptionId, code: "unavailable" });
	await deadlined(viewer.closed, "closed after owner end");
	assert.equal(viewer.readSnapshot(), undefined);
	assert.deepEqual(published.at(-1), undefined);
	assert.equal(endChannel.closeCalls, 1);

	// Transport loss is a retirement too, and equally never an empty frame.
	const lostChannel = new FakeContentChannel();
	scriptOwner(lostChannel);
	const lostViewer = viewportViewer(lostChannel, { cols: 12, rows: 3 });
	await deadlined(lostViewer.ready, "lost ready");
	deliverAll(lostChannel, transfer(sampleFrame(), { subscriptionId: lostViewer.subscriptionId, sequence: 1 }));
	assert.ok(lostViewer.readSnapshot());
	lostChannel.finish(1006, "synthetic transport loss");
	await deadlined(lostViewer.closed, "closed after transport loss");
	assert.equal(lostViewer.readSnapshot(), undefined);
	assert.equal(lostChannel.closeCalls, 1);

	// An owner error with the active subscription is a truthful refusal.
	const errorChannel = new FakeContentChannel();
	scriptOwner(errorChannel);
	const errorViewer = viewportViewer(errorChannel, { cols: 12, rows: 3 });
	await deadlined(errorViewer.ready, "error ready");
	errorChannel.deliver({ type: "error", code: "not_authorized", subscriptionId: errorViewer.subscriptionId });
	await deadlined(errorViewer.closed, "closed after owner error");
	assert.equal(errorViewer.readSnapshot(), undefined);
	assert.equal(errorChannel.closeCalls, 1);
});

/* ------------------------------------------------------------------------- *
 * Resize
 * ------------------------------------------------------------------------- */

test("resize keeps only the newest dimensions across the handshake and never invents geometry", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel, { autoHelloAck: false });
	const viewer = viewportViewer(channel, { cols: 80, rows: 24 });
	viewer.resize(100, 40);
	viewer.resize(120, 50);

	await settle();
	assert.deepEqual(channel.types(), ["hello"], "no resize is written before the acknowledgement");
	channel.deliver(helloAck());
	await settle();
	const subscribe = channel.frames().find((frame) => frame.type === "subscribe");
	assert.ok(subscribe !== undefined && subscribe.type === "subscribe");
	assert.equal(subscribe.cols, 120, "the subscribe carries the newest requested dimensions");
	assert.equal(subscribe.rows, 50);
	assert.equal(channel.types().filter((type) => type === "resize").length, 0);

	// Ready still needs the exact acknowledgement, and the owner's own frame is the
	// only thing allowed to change the visible geometry.
	channel.deliver({ type: "subscribed", subscriptionId: viewer.subscriptionId, sessionId: ROW, hostRunId: RUN });
	await deadlined(viewer.ready, "ready");
	await settle();
	assert.equal(channel.types().filter((type) => type === "resize").length, 0,
		"dimensions already sent by the subscribe are not repeated");
	assert.equal(viewer.readSnapshot(), undefined, "a resize never fabricates a frame or geometry");

	// Invalid dimensions are a programming error, not a wire request.
	assert.throws(() => viewer.resize(0, 10), (error: unknown) => error instanceof RangeError);
	assert.throws(() => viewer.resize(10, DEFAULT_SESSION_CONTENT_BOUNDS.maxRows + 1),
		(error: unknown) => error instanceof RangeError);
	await deadlined(viewer.stop(), "stop");
});

test("backpressure keeps one resize write in flight and at most one newest queued request", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel);
	const viewer = viewportViewer(channel);
	await deadlined(viewer.ready, "ready");

	channel.holdSend = true;
	viewer.resize(90, 30);
	await settle();
	viewer.resize(91, 31);
	viewer.resize(95, 35);
	viewer.resize(96, 36);
	await settle();
	channel.releaseSends();
	await settle(10);

	const resizes = channel.frames().filter((frame) => frame.type === "resize");
	const dimensions = resizes.map((frame) => (frame.type === "resize" ? [frame.cols, frame.rows] : []));
	assert.deepEqual(dimensions, [[90, 30], [96, 36]],
		"the in-flight write plus the single newest request, never the intermediate ones");
	for (const frame of resizes) {
		if (frame.type !== "resize") continue;
		assert.equal(frame.subscriptionId, viewer.subscriptionId, "every resize names this viewer's exact subscription");
	}
	assert.equal(viewer.readSnapshot(), undefined, "resizing is not content");
	await deadlined(viewer.stop(), "stop");
});

/* ------------------------------------------------------------------------- *
 * Deadlines
 * ------------------------------------------------------------------------- */

test("an unchanged current frame survives and an in-flight transfer that stalls is discarded", async () => {
	// No idle-current-frame expiry: the published view stays current indefinitely.
	const idleChannel = new FakeContentChannel();
	scriptOwner(idleChannel);
	const idleViewer = viewportViewer(idleChannel, {
		cols: 12,
		rows: 3,
		timeouts: { handshakeTimeoutMs: 250, snapshotStartTimeoutMs: 250, transferIdleTimeoutMs: 40, stopAckTimeoutMs: 80 },
	});
	await deadlined(idleViewer.ready, "idle ready");
	deliverAll(idleChannel, transfer(sampleFrame(), { subscriptionId: idleViewer.subscriptionId, sequence: 1 }));
	const current = idleViewer.readSnapshot();
	assert.ok(current);
	let idleClosed = false;
	void idleViewer.closed.then(() => {
		idleClosed = true;
	});
	await delay(140);
	assert.equal(idleViewer.readSnapshot(), current, "an unchanged frame is still current after the transfer deadline");
	assert.equal(idleClosed, false);
	assert.equal(idleChannel.closeCalls, 0);
	// Streaming still works after idling.
	deliverAll(idleChannel, transfer(sampleFrame(), {
		subscriptionId: idleViewer.subscriptionId,
		transferId: "transfer-2",
		sequence: 2,
	}));
	assert.equal(idleViewer.readSnapshot()?.meta.sequence, 2);
	await deadlined(idleViewer.stop(), "idle stop");

	// An in-flight transfer that stops arriving is abandoned whole.
	const stalledChannel = new FakeContentChannel();
	scriptOwner(stalledChannel);
	const stalledViewer = viewportViewer(stalledChannel, {
		cols: 12,
		rows: 3,
		timeouts: { handshakeTimeoutMs: 250, snapshotStartTimeoutMs: 250, transferIdleTimeoutMs: 40, stopAckTimeoutMs: 80 },
	});
	await deadlined(stalledViewer.ready, "stalled ready");
	const built = transfer(styledFrame(100), { subscriptionId: stalledViewer.subscriptionId, sequence: 1 });
	assert.ok(built.chunkCount > 1);
	stalledChannel.deliver(built.frames[0] as Buffer);
	stalledChannel.deliver(built.frames[1] as Buffer);
	await deadlined(stalledViewer.closed, "stalled transfer retirement");
	assert.equal(stalledViewer.readSnapshot(), undefined, "the staged partial is never published");
	assert.equal(stalledChannel.closeCalls, 1);
});

test("the first-transfer deadline is finite and the handshake deadline is finite", async () => {
	const silentChannel = new FakeContentChannel();
	scriptOwner(silentChannel, { autoSubscribe: true });
	const silentViewer = viewportViewer(silentChannel, {
		cols: 12,
		rows: 3,
		timeouts: { handshakeTimeoutMs: 250, snapshotStartTimeoutMs: 30, transferIdleTimeoutMs: 120, stopAckTimeoutMs: 80 },
	});
	await deadlined(silentViewer.ready, "silent ready");
	// Ready resolves on the acknowledgement alone; no frame is required for it.
	assert.equal(silentViewer.readSnapshot(), undefined);
	await deadlined(silentViewer.closed, "first transfer deadline");
	assert.equal(silentViewer.readSnapshot(), undefined);
	assert.equal(silentChannel.closeCalls, 1);

	const muteChannel = new FakeContentChannel();
	const muteViewer = viewportViewer(muteChannel, {
		cols: 12,
		rows: 3,
		timeouts: { handshakeTimeoutMs: 25, snapshotStartTimeoutMs: 250, transferIdleTimeoutMs: 120, stopAckTimeoutMs: 80 },
	});
	await deadlined(muteViewer.closed, "handshake deadline");
	await assert.rejects(
		muteViewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "timeout",
	);
	assert.equal(muteChannel.closeCalls, 1);

	// An owner that acknowledges the hello and then never acknowledges the
	// subscription is bounded by the same finite first-transfer deadline, so the
	// viewer cannot wait forever for `ready`.
	const ignoredChannel = new FakeContentChannel();
	scriptOwner(ignoredChannel, { autoSubscribe: false });
	const ignoredViewer = viewportViewer(ignoredChannel, {
		cols: 12,
		rows: 3,
		timeouts: { handshakeTimeoutMs: 250, snapshotStartTimeoutMs: 25, transferIdleTimeoutMs: 120, stopAckTimeoutMs: 80 },
	});
	await deadlined(ignoredViewer.closed, "unacknowledged subscribe deadline");
	await assert.rejects(
		ignoredViewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "timeout",
	);
	assert.equal(ignoredViewer.readSnapshot(), undefined);
	assert.equal(ignoredChannel.closeCalls, 1);
});

/* ------------------------------------------------------------------------- *
 * Stop
 * ------------------------------------------------------------------------- */

test("stop during the hello retires without inventing an unsubscribe for a subscription the owner never saw", async () => {
	const channel = new FakeContentChannel();
	const viewer = viewportViewer(channel);
	await settle();
	assert.deepEqual(channel.types(), ["hello"]);
	assert.equal(viewer.readSnapshot(), undefined);

	await deadlined(viewer.stop(), "stop during hello");
	assert.deepEqual(channel.types().filter((type) => type !== "hello"), [],
		"no subscribe, resize, or unsubscribe is written");
	assert.equal(channel.closeCalls, 1, "the dedicated content channel is closed independently");
	await assert.rejects(
		viewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "stopped",
	);
	await deadlined(viewer.closed, "closed");
});

test("stop during the subscribe waits for the exact unsubscribe acknowledgement and late replies cannot resurrect", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel, { autoSubscribe: false, autoUnsubscribe: false });
	channel.finishOnClose = false;
	const published: Array<SessionContentSnapshot | undefined> = [];
	const viewer = viewportViewer(channel, {
		cols: 12,
		rows: 3,
		onSnapshot: (snapshot) => published.push(snapshot),
		// A generous stop deadline keeps the assertion about *waiting* honest on a
		// slow machine: the acknowledgement is delivered deliberately below.
		timeouts: { handshakeTimeoutMs: 250, snapshotStartTimeoutMs: 250, transferIdleTimeoutMs: 150, stopAckTimeoutMs: 600 },
	});
	await settle();
	assert.deepEqual(channel.types(), ["hello", "subscribe"]);

	const stopping = viewer.stop();
	let stopped = false;
	void stopping.then(() => {
		stopped = true;
	});
	assert.equal(viewer.readSnapshot(), undefined, "the stop intent clears the frame synchronously");
	await settle();
	assert.equal(stopped, false, "stop waits for its own acknowledgement inside the stop deadline");
	const unsubscribe = channel.frames().find((frame) => frame.type === "unsubscribe");
	assert.ok(unsubscribe !== undefined && unsubscribe.type === "unsubscribe");
	assert.equal(unsubscribe.subscriptionId, viewer.subscriptionId, "the unsubscribe names the exact subscription");

	// Late replies for this viewer's own retired subscription are noise: they are
	// neither published nor a second subscription, and they never make it ready.
	channel.deliver({ type: "subscribed", subscriptionId: viewer.subscriptionId, sessionId: ROW, hostRunId: RUN });
	const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId });
	channel.deliver(built.frames[0] as Buffer);
	channel.deliver(built.frames[1] as Buffer);
	await settle();
	assert.equal(stopped, false);
	assert.equal(viewer.readSnapshot(), undefined);
	assert.deepEqual(published, []);

	channel.deliver({ type: "unsubscribed", subscriptionId: viewer.subscriptionId });
	await deadlined(stopping, "stop with acknowledgement");
	assert.equal(stopped, true);
	await deadlined(viewer.closed, "closed");
	assert.equal(viewer.readSnapshot(), undefined);
	await assert.rejects(
		viewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "stopped",
	);

	// Frames delivered after retirement find no receiver at all.
	channel.deliver(built.frames[1] as Buffer);
	assert.equal(viewer.readSnapshot(), undefined);
	assert.equal(channel.closeCalls, 1);
	assert.equal(channel.handlerCount, 0);
});

test("stop during an in-flight transfer discards the partial and a later owner reply finds no receiver", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel);
	channel.finishOnClose = false;
	const viewer = viewportViewer(channel, { cols: 12, rows: 3 });
	await deadlined(viewer.ready, "ready");
	const built = transfer(styledFrame(100), { subscriptionId: viewer.subscriptionId, sequence: 1 });
	assert.ok(built.chunkCount > 1);
	channel.deliver(built.frames[0] as Buffer);
	channel.deliver(built.frames[1] as Buffer);
	assert.equal(viewer.readSnapshot(), undefined);

	await deadlined(viewer.stop(), "stop during transfer");
	assert.equal(viewer.readSnapshot(), undefined);
	assert.equal(channel.handlerCount, 0, "the receiver is detached as soon as the endpoint retires");
	for (const bytes of built.frames.slice(2)) channel.deliver(bytes);
	assert.equal(viewer.readSnapshot(), undefined, "a late transfer can never be resurrected");
	assert.equal(channel.closeCalls, 1);
});

test("stop without an acknowledgement still closes the transport on its own deadline", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel, { autoUnsubscribe: false });
	channel.finishOnClose = true;
	const viewer = viewportViewer(channel, {
		cols: 12,
		rows: 3,
		timeouts: { handshakeTimeoutMs: 250, snapshotStartTimeoutMs: 250, transferIdleTimeoutMs: 120, stopAckTimeoutMs: 30 },
	});
	await deadlined(viewer.ready, "ready");
	const stopping = viewer.stop();
	await deadlined(stopping, "stop with a withheld acknowledgement");
	assert.equal(channel.closeCalls, 1, "the close does not depend on the owner receipt");
	await deadlined(viewer.closed, "closed");
	assert.equal(viewer.readSnapshot(), undefined);
	assert.equal(channel.handlerCount, 0);

	// Duplicate stop calls join the same retirement instead of sending again.
	await deadlined(viewer.stop(), "second stop");
	assert.equal(channel.types().filter((type) => type === "unsubscribe").length, 1);
});

test("stop during a held resize write retires within its bounded deadline and never restarts delivery", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel);
	const viewer = viewportViewer(channel, {
		cols: 12,
		rows: 3,
		timeouts: { handshakeTimeoutMs: 250, snapshotStartTimeoutMs: 250, transferIdleTimeoutMs: 40, stopAckTimeoutMs: 300 },
	});
	await deadlined(viewer.ready, "ready");
	channel.holdSend = true;
	viewer.resize(90, 30);
	await settle();
	const stopping = viewer.stop();
	assert.equal(viewer.readSnapshot(), undefined, "a resize is not a frame to keep");
	await deadlined(stopping, "stop during a held resize write");
	await deadlined(viewer.closed, "closed");
	assert.equal(viewer.readSnapshot(), undefined);
	assert.equal(channel.handlerCount, 0, "the receiver is detached");
	assert.equal(channel.closeCalls, 1, "the dedicated channel is closed once");
	// The bounded resize write deadline never turns into a subscription restart.
	assert.equal(channel.types().filter((type) => type === "subscribe").length, 1);
});

test("a subscribe queued behind a held hello write is cancelled at execution and never escapes after stop", async () => {
	const channel = new FakeContentChannel();
	// The owner acknowledges the hello from inside the send callback, and the hello
	// write itself stays unsettled: the subscribe is queued behind it.
	channel.holdSend = true;
	// Keep the local close from finishing the fake, so the queued write is judged by
	// the endpoint's own cancellation rather than by the transport's close race.
	channel.finishOnClose = false;
	channel.onSend = (bytes) => {
		const frame = decodeSessionContentFrame(bytes, BOUNDS);
		if (frame.type === "hello") channel.deliver(helloAck());
	};
	const viewer = viewportViewer(channel);
	await settle();
	assert.deepEqual(channel.types(), ["hello"], "the subscribe is still only queued");

	const stopping = viewer.stop();
	assert.equal(viewer.readSnapshot(), undefined);
	// The held hello write finally settles *after* the stop intent.
	channel.releaseSends();
	await deadlined(stopping, "stop with a held hello write");
	await deadlined(viewer.closed, "closed");
	// The queued subscribe was cancelled when it tried to run, so it never reached
	// the transport and no unsubscribe was owed for it either.
	assert.deepEqual(channel.types(), ["hello"], "no subscribe or unsubscribe is written after stop");
	assert.equal(channel.handlerCount, 0);
	assert.equal(channel.closeCalls, 1);
	await assert.rejects(
		viewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "stopped",
	);
});

test("a stop called from the snapshot-clear listener joins the one stop promise", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel);
	let clears = 0;
	let nested: Promise<void> | null = null;
	const viewer = viewportViewer(channel, {
		cols: 12,
		rows: 3,
		onSnapshot: (snapshot) => {
			if (snapshot !== undefined) return;
			clears += 1;
			// Re-entrant: this notification runs synchronously inside stop().
			nested = viewer.stop();
		},
	});
	await deadlined(viewer.ready, "ready");
	deliverAll(channel, transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 1 }));
	assert.ok(viewer.readSnapshot());

	const outer = viewer.stop();
	assert.ok(nested !== null, "the clear notification ran inside stop");
	assert.equal(nested, outer, "the re-entrant stop joins the claimed joined promise");
	await deadlined(outer, "outer stop");
	await deadlined(nested, "nested stop");
	await deadlined(viewer.closed, "closed");
	assert.equal(clears, 1, "the published frame is cleared exactly once");
	assert.equal(channel.types().filter((type) => type === "unsubscribe").length, 1,
		"exactly one unsubscribe, never a duplicate");
	assert.equal(channel.closeCalls, 1);
});

/* ------------------------------------------------------------------------- *
 * Send failures and listener faults
 * ------------------------------------------------------------------------- */

test("failed and throwing control writes are owned, and no construction path leaks an unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		const rejected = new FakeContentChannel();
		rejected.failNextSend = true;
		const rejectedViewer = viewportViewer(rejected);
		await assert.rejects(
			deadlined(rejectedViewer.ready, "rejected ready"),
			(error: unknown) => isSessionContentViewerError(error) && error.code === "send-failed",
		);
		await deadlined(rejectedViewer.closed, "rejected closed");
		assert.equal(rejected.closeCalls, 1);

		const throwing = new FakeContentChannel();
		throwing.throwNextSend = true;
		const throwingViewer = viewportViewer(throwing);
		await assert.rejects(
			deadlined(throwingViewer.ready, "throwing ready"),
			(error: unknown) => isSessionContentViewerError(error) && error.code === "send-failed",
		);
		await deadlined(throwingViewer.closed, "throwing closed");

		// A stalled write is bounded by the existing transfer deadline.
		const stalled = new FakeContentChannel();
		scriptOwner(stalled);
		const stalledViewer = viewportViewer(stalled, {
			timeouts: { handshakeTimeoutMs: 250, snapshotStartTimeoutMs: 250, transferIdleTimeoutMs: 30, stopAckTimeoutMs: 80 },
		});
		await deadlined(stalledViewer.ready, "stalled ready");
		stalled.holdSend = true;
		stalledViewer.resize(90, 30);
		await deadlined(stalledViewer.closed, "stalled write retirement");

		// A viewer that is only constructed (its `ready` never observed) must not
		// surface an unhandled rejection when its handshake expires.
		const abandonedChannel = new FakeContentChannel();
		const abandoned = viewportViewer(abandonedChannel, {
			timeouts: { handshakeTimeoutMs: 20, snapshotStartTimeoutMs: 250, transferIdleTimeoutMs: 120, stopAckTimeoutMs: 80 },
		});
		await deadlined(abandoned.closed, "abandoned closed");

		await settle(10);
		assert.deepEqual(unhandled, [], "every rejection is owned internally as well as exposed");
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("a throwing snapshot listener or diagnostic sink never corrupts the endpoint lifecycle", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel);
	const snapped: Array<SessionContentSnapshot | undefined> = [];
	let snapshots = 0;
	const viewer = viewportViewer(channel, {
		cols: 12,
		rows: 3,
		onSnapshot: (snapshot) => {
			snapshots += 1;
			snapped.push(snapshot);
			throw new Error("synthetic listener fault");
		},
		onDiagnostic: () => {
			throw new Error("synthetic diagnostic fault");
		},
	});
	await deadlined(viewer.ready, "ready");
	deliverAll(channel, transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 1 }));
	assert.ok(viewer.readSnapshot(), "a throwing listener cannot undo a published viewport");
	deliverAll(channel, transfer(sampleFrame(), {
		subscriptionId: viewer.subscriptionId,
		transferId: "transfer-2",
		sequence: 2,
	}));
	assert.equal(viewer.readSnapshot()?.meta.sequence, 2, "the endpoint keeps streaming after a listener fault");
	assert.equal(snapshots, 2);
	await deadlined(viewer.stop(), "stop after listener faults");
	assert.equal(viewer.readSnapshot(), undefined);
	assert.deepEqual(snapped.at(-1), undefined, "clearing still reaches a throwing listener");
});

test("a held send deadline is retired with the endpoint and never reports a late failure", async () => {
	const channel = new FakeContentChannel();
	const diagnostics: SessionContentViewerDiagnostic[] = [];
	// The hello write reaches the transport but its completion never settles.
	channel.holdSend = true;
	const viewer = viewportViewer(channel, {
		onDiagnostic: (event) => diagnostics.push(event),
		timeouts: { handshakeTimeoutMs: 250, snapshotStartTimeoutMs: 250, transferIdleTimeoutMs: 40, stopAckTimeoutMs: 80 },
	});
	await settle();
	assert.equal(channel.sent.length, 1, "the hello write is outstanding, not unsent");

	await deadlined(viewer.stop(), "stop with a held hello write");
	await deadlined(viewer.closed, "closed");
	assert.equal(channel.closeCalls, 1);
	const afterClose = diagnostics.length;

	// Longer than the transfer deadline: a timer that outlived retirement would
	// have reported a send failure by now.
	await delay(120);
	assert.deepEqual(
		diagnostics.slice(afterClose).filter((event) => event.code === "send_failed"),
		[],
		"no send deadline survives retirement",
	);

	// A late transport completion (or rejection) stays owned and stays silent.
	channel.releaseSends();
	await settle(10);
	assert.deepEqual(
		diagnostics.filter((event) => event.code === "send_failed"),
		[],
		"a late write completion never becomes a send failure",
	);
	assert.equal(viewer.readSnapshot(), undefined);
});

/* ------------------------------------------------------------------------- *
 * Reentrant diagnostic callbacks
 * ------------------------------------------------------------------------- */

test("a stop from the snapshot_published diagnostic never republishes the cleared snapshot", async () => {
	const channel = new FakeContentChannel();
	scriptOwner(channel);
	const notified: Array<SessionContentSnapshot | undefined> = [];
	const diagnostics: SessionContentViewerDiagnostic[] = [];
	let viewer: SessionContentViewer;
	viewer = viewportViewer(channel, {
		cols: 12,
		rows: 3,
		onSnapshot: (snapshot) => notified.push(snapshot),
		onDiagnostic: (event) => {
			diagnostics.push(event);
			// Re-entrant stop from inside the publish notification.
			if (event.code === "snapshot_published") void viewer.stop();
		},
	});
	await deadlined(viewer.ready, "ready");
	deliverAll(channel, transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, sequence: 1 }));
	await deadlined(viewer.closed, "closed after the diagnostic stop");

	assert.equal(viewer.readSnapshot(), undefined, "the cleared frame stays cleared");
	assert.equal(diagnostics.filter((event) => event.code === "snapshot_published").length, 1);
	// The clear notification is the last thing the listener saw: the retired snapshot
	// is never handed over after it, so no consumer can redisplay stale content.
	assert.deepEqual(notified, [undefined]);
	assert.equal(notified.filter((snapshot) => snapshot !== undefined).length, 0);
});

test("handshake diagnostics that stop the viewer fence out the remaining continuations", async () => {
	// `hello_accepted` -> stop: the subscribe continuation must not run.
	const helloChannel = new FakeContentChannel();
	scriptOwner(helloChannel);
	let helloViewer: SessionContentViewer;
	helloViewer = viewportViewer(helloChannel, {
		onDiagnostic: (event) => {
			if (event.code === "hello_accepted") void helloViewer.stop();
		},
	});
	await settle();
	await deadlined(helloViewer.closed, "closed after the hello_accepted stop");
	assert.deepEqual(helloChannel.types(), ["hello"], "no subscribe is written after the stop");
	await assert.rejects(
		helloViewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "stopped",
	);

	// `subscribed` -> stop: neither ready nor a first-transfer timer may survive.
	const subscribedChannel = new FakeContentChannel();
	scriptOwner(subscribedChannel);
	let subscribedViewer: SessionContentViewer;
	subscribedViewer = viewportViewer(subscribedChannel, {
		onDiagnostic: (event) => {
			if (event.code === "subscribed") void subscribedViewer.stop();
		},
	});
	await settle();
	await deadlined(subscribedViewer.closed, "closed after the subscribed stop");
	assert.equal(subscribedChannel.types().filter((type) => type === "subscribe").length, 1);
	assert.equal(subscribedChannel.types().filter((type) => type === "resize").length, 0);
	assert.equal(subscribedViewer.readSnapshot(), undefined);
	await assert.rejects(
		subscribedViewer.ready,
		(error: unknown) => isSessionContentViewerError(error) && error.code === "stopped",
	);
});

/* ------------------------------------------------------------------------- *
 * Configured bounds
 * ------------------------------------------------------------------------- */

test("configured bounds govern the viewer's transfer packing and message refusal", async () => {
	const bounds = resolveSessionContentBounds({
		maxFrameBytes: 4_096,
		maxChunkPayloadBytes: 1_024,
		maxTransferBytes: 65_536,
	});
	const channel = new FakeContentChannel();
	scriptOwner(channel);
	const viewer = viewportViewer(channel, { cols: 12, rows: 3, bounds });
	await deadlined(viewer.ready, "ready");
	const built = transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, bounds });
	assert.ok(built.chunkCount > 1, "a smaller configured chunk bound pages even a small viewport");
	assert.ok(built.messageBytes.every((size) => size <= bounds.maxFrameBytes));
	deliverAll(channel, built);
	assert.ok(viewer.readSnapshot(), "the same configured bounds reassemble the complete viewport");
	await deadlined(viewer.stop(), "stop");

	// One message above the configured per-message bound is refused whole.
	const oversizedChannel = new FakeContentChannel();
	scriptOwner(oversizedChannel);
	const oversizedViewer = viewportViewer(oversizedChannel, { cols: 12, rows: 3, bounds });
	await deadlined(oversizedViewer.ready, "oversized ready");
	oversizedChannel.deliver(Buffer.alloc(bounds.maxFrameBytes + 1, 0x20));
	await deadlined(oversizedViewer.closed, "oversized refusal");
	assert.equal(oversizedViewer.readSnapshot(), undefined);
	assert.equal(oversizedChannel.closeCalls, 1);
});

/* ------------------------------------------------------------------------- *
 * Inert facts
 * ------------------------------------------------------------------------- */

test("observed input modes and graphics are inert data with no input, clipboard, or OSC authority", async () => {
	// The codec refuses an input-mode value it cannot represent instead of guessing
	// at it, so nothing outside the settled native facts can ride a frame.
	assert.throws(
		() => transfer(sampleFrame(), {
			inputModes: {
				kittyFlags: 7,
				applicationCursorKeys: true,
				applicationKeypad: true,
				bracketedPaste: true,
				mouseTracking: "sgr" as unknown as TerminalInputModes["mouseTracking"],
				modifyOtherKeys: 2,
				mouseEncoding: "sgr",
			},
		}),
		(error: unknown) => isSessionContentProtocolError(error),
	);

	const channel = new FakeContentChannel();
	scriptOwner(channel);
	const viewer = viewportViewer(channel, { cols: 12, rows: 3 });
	await deadlined(viewer.ready, "ready");
	const inputModes: TerminalInputModes = {
		kittyFlags: 7,
		applicationCursorKeys: true,
		applicationKeypad: true,
		bracketedPaste: true,
		mouseTracking: "drag",
		modifyOtherKeys: 2,
		mouseEncoding: "sgr",
	};
	deliverAll(channel, transfer(sampleFrame(), { subscriptionId: viewer.subscriptionId, inputModes }));
	const snapshot = viewer.readSnapshot();
	assert.ok(snapshot);
	// Observed modes are carried as inert snapshot facts, not as authority.
	assert.deepEqual(snapshot.meta.inputModes, inputModes);
	assert.deepEqual(snapshot.frame.graphics, sampleFrame().graphics, "the typed PNG viewport is carried verbatim");
	// The only writes this endpoint ever makes are its own bounded control frames;
	// no input, clipboard, or OSC frame type exists in this protocol at all.
	for (const type of channel.types()) {
		assert.ok(["hello", "subscribe", "resize", "unsubscribe", "error"].includes(type), `unexpected write ${type}`);
	}
	await deadlined(viewer.stop(), "stop");
});
