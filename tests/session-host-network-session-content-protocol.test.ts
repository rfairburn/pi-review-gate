/**
 * Focused contract tests for the bounded native viewport content protocol
 * (#389 content phase).
 *
 * Everything here is pure and in-memory: no socket, listener, process, timer,
 * filesystem path, or product state is touched. Frames are hand-built native
 * `TerminalFrame` shapes (including structured styles, cursor, input modes, and
 * typed Kitty PNG graphics), and PNG payloads are generated locally so the
 * shared native validator is exercised rather than a test-local approximation.
 *
 * The assertions are about the settled contract: the per-message bound is not a
 * whole-viewport or text-only limit, a complete typed viewport crosses as
 * bounded sequential chunks and becomes current only after a matching end, and
 * malformed, stale, cross-transfer, oversized, or unsafe data refuses with a
 * fixed code and no partial publish or silent trimming.
 */

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { validateTerminalGraphicsPng } from "../src/session-host/kitty-graphics";
import { decodeRosterBridgeFrame, encodeRosterBridgeFrame } from "../src/session-host/network/index";
import {
	DEFAULT_SESSION_CONTENT_BOUNDS,
	NATIVE_COPY_MAX_ENCODED_CHARS,
	NATIVE_TEXT_PASTE_MAX_BYTES,
	SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES,
	SESSION_CONTENT_KNOWN_OPTIONAL_CAPABILITIES,
	SESSION_CONTENT_MAJOR,
	SESSION_CONTENT_MINOR,
	SESSION_CONTENT_NATIVE_IO_CAPABILITY,
	SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
	SESSION_CONTENT_REQUIRED_CAPABILITY,
	SESSION_CONTENT_SERVICE,
	SessionContentProtocolError,
	buildNativeCopyInline,
	buildNativeCopyPaged,
	buildNativeInputInline,
	buildNativeInputPaste,
	buildSessionContentTransfer,
	createNativeCopyAssembler,
	createNativeInputAssembler,
	createSessionContentTransferAssembler,
	decodeSessionContentFrame,
	decodeSessionContentViewport,
	encodeSessionContentFrame,
	encodeSessionContentViewport,
	isSessionContentProtocolError,
	nativeIoSourceEquals,
	negotiateSessionContentHello,
	resolveSessionContentBounds,
	reviewSessionContentHelloAck,
	sessionContentWireCodeForFailure,
	type NativeIoCompletedCopy,
	type NativeIoCompletedInput,
	type NativeIoCopyEvent,
	type NativeIoCopyUnavailableReason,
	type NativeIoInputKind,
	type NativeIoSource,
	type SessionContentBounds,
	type SessionContentFailureCode,
	type SessionContentFrame,
	type SessionContentHelloFrame,
	type SessionContentSnapshot,
} from "../src/session-host/network/session-content-protocol";
import {
	ROSTER_BRIDGE_MAJOR,
	ROSTER_BRIDGE_MINOR,
	ROSTER_BRIDGE_REQUIRED_CAPABILITY,
	ROSTER_BRIDGE_SERVICE,
} from "../src/session-host/network/roster-bridge-protocol";
import type { TerminalCellRun, TerminalFrame, TerminalInputModes, TerminalLineStyles } from "../src/session-host/terminal-surface";

/* ------------------------------------------------------------------------- *
 * Fixtures
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

function pngHeader(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return header;
}

function pngFromChunks(chunks: ReadonlyArray<readonly [string, Buffer]>): string {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return Buffer.concat([
		signature,
		...chunks.map(([type, data]) => pngChunk(type, data)),
	]).toString("base64");
}

function pngBase64(width = 4, height = 4): string {
	return pngFromChunks([
		["IHDR", pngHeader(width, height)],
		["IDAT", deflateSync(Buffer.alloc(height * (width * 4 + 1)))],
		["IEND", Buffer.alloc(0)],
	]);
}

/** A PNG whose IDAT data byte no longer matches its recorded CRC. */
function pngWithCorruptCrc(): string {
	const bytes = Buffer.from(pngBase64(), "base64");
	// signature (8) + IHDR chunk (25) + IDAT length/type (8) = first data byte.
	bytes[41] = (bytes[41] as number) ^ 0xff;
	return bytes.toString("base64");
}

/** A deterministic, incompressible valid PNG large enough to need several messages. */
function pngNoiseBase64(width: number, height: number): string {
	const stride = width * 4 + 1;
	const raw = Buffer.alloc(height * stride);
	let state = 0x1234_5678;
	for (let index = 0; index < raw.length; index += 1) {
		if (index % stride === 0) continue;
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		raw[index] = state >>> 24;
	}
	return pngFromChunks([
		["IHDR", pngHeader(width, height)],
		["IDAT", deflateSync(raw)],
		["IEND", Buffer.alloc(0)],
	]);
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
				runs: [{
					startColumn: 0,
					text: "under",
					underline: true,
					overline: true,
					fg: { mode: "default", value: 0 },
				}],
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

/** A normal styled pane whose JSON payload is comfortably larger than 64 KiB. */
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

function transferOptions(
	frame: TerminalFrame,
	overrides: Partial<Parameters<typeof buildSessionContentTransfer>[0]> = {},
): Parameters<typeof buildSessionContentTransfer>[0] {
	return {
		subscriptionId: "sub-1",
		transferId: "transfer-1",
		hostRunId: "run-1",
		sessionId: "instance-1",
		nativeSession: { sessionId: "native-session-1", epoch: 3 },
		sequence: 1,
		geometry: { cols: frame.cols, rows: frame.rows, revision: 0 },
		inputModes: INPUT_MODES,
		frame,
		...overrides,
	};
}

function framesOf(built: ReturnType<typeof buildSessionContentTransfer>): SessionContentFrame[] {
	return built.frames.map((bytes) => decodeSessionContentFrame(bytes));
}

function tamperedFrame(mutate: (frame: Record<string, any>) => void): TerminalFrame {
	const copy = JSON.parse(JSON.stringify(sampleFrame())) as Record<string, any>;
	mutate(copy);
	return copy as TerminalFrame;
}

function refused(code: SessionContentFailureCode, run: () => unknown, message?: string): void {
	assert.throws(
		run,
		(error: unknown) => isSessionContentProtocolError(error) && error.code === code,
		message,
	);
}

function isFrozenDeep(value: unknown): boolean {
	if (Array.isArray(value)) return Object.isFrozen(value) && value.every(isFrozenDeep);
	if (typeof value === "object" && value !== null) {
		return Object.isFrozen(value) && Object.values(value).every(isFrozenDeep);
	}
	return true;
}

/* ------------------------------------------------------------------------- *
 * Control frames
 * ------------------------------------------------------------------------- */

test("every control variant roundtrips through one message without extra state", () => {
	const frames: SessionContentFrame[] = [
		{
			type: "hello",
			service: SESSION_CONTENT_SERVICE,
			major: SESSION_CONTENT_MAJOR,
			minor: SESSION_CONTENT_MINOR,
			capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY],
		},
		{
			type: "hello_ack",
			service: SESSION_CONTENT_SERVICE,
			major: SESSION_CONTENT_MAJOR,
			minor: SESSION_CONTENT_MINOR,
			capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY],
		},
		{ type: "subscribe", subscriptionId: "sub-1", hostRunId: "run-1", sessionId: "instance-1", cols: 80, rows: 24 },
		{ type: "subscribed", subscriptionId: "sub-1", sessionId: "instance-1", hostRunId: "run-1" },
		{ type: "resize", subscriptionId: "sub-1", cols: 120, rows: 40 },
		{ type: "unsubscribe", subscriptionId: "sub-1" },
		{ type: "unsubscribed", subscriptionId: "sub-1" },
		{ type: "end", subscriptionId: "sub-1", code: "replaced" },
		{ type: "error", code: "transfer_failed" },
		{ type: "error", code: "bad_frame", subscriptionId: "sub-1" },
	];
	for (const frame of frames) {
		const bytes = encodeSessionContentFrame(frame);
		assert.deepEqual(decodeSessionContentFrame(bytes), frame);
		assert.ok(Object.isFrozen(decodeSessionContentFrame(bytes)));
	}
	assert.equal(SESSION_CONTENT_SERVICE, "pi-peer-session-content-v1");
	assert.equal(SESSION_CONTENT_MAJOR, 1);
	assert.equal(SESSION_CONTENT_MINOR, 0);
	assert.equal(SESSION_CONTENT_REQUIRED_CAPABILITY, "native-viewport-v1");
});

test("subscribe requires the exact observed owner-run identifier before any geometry request", () => {
	const frame = { type: "subscribe", subscriptionId: "sub-1", hostRunId: "run-1", sessionId: "instance-1", cols: 80, rows: 24 } as const;
	assert.deepEqual(decodeSessionContentFrame(encodeSessionContentFrame(frame)), frame);
	for (const invalid of [undefined, null, "", 1, "x".repeat(65), "run\n1"]) {
		const candidate: Record<string, unknown> = { ...frame, hostRunId: invalid };
		if (invalid === undefined) delete candidate.hostRunId;
		refused("invalid_frame", () => encodeSessionContentFrame(candidate as unknown as SessionContentFrame));
		refused("bad_frame", () => decodeSessionContentFrame(Buffer.from(JSON.stringify(candidate))));
	}
});

test("control frames refuse unknown keys, wrong types, foreign prototypes, and bad bytes", () => {
	const hello: SessionContentHelloFrame = {
		type: "hello",
		service: SESSION_CONTENT_SERVICE,
		major: 1,
		minor: 0,
		capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY],
	};
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ ...hello, extra: 1 } as unknown as SessionContentFrame),
		"an unknown key is not encoded",
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ ...hello, major: "1" } as unknown as SessionContentFrame),
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ ...hello, capabilities: ["native-viewport-v1", "native-viewport-v1"] }),
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ ...hello, capabilities: Array.from({ length: 17 }, (_, index) => `cap-${index}`) }),
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ ...hello, service: "evil\u0000service" }),
	);
	refused("invalid_frame", () => encodeSessionContentFrame([] as unknown as SessionContentFrame));
	refused("invalid_frame", () => encodeSessionContentFrame(null as unknown as SessionContentFrame));
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame(Object.assign(Object.create({ type: "hello" }), hello) as SessionContentFrame),
		"an inherited field is never read as a frame field",
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ type: "subscribe", subscriptionId: "sub 1", hostRunId: "run-1", sessionId: "instance-1", cols: 80, rows: 24 }),
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ type: "subscribe", subscriptionId: "sub-1", hostRunId: "run-1", sessionId: "instance-1", cols: 0, rows: 24 }),
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ type: "subscribe", subscriptionId: "sub-1", hostRunId: "run-1", sessionId: "instance-1", cols: 1_001, rows: 24 }),
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ type: "end", subscriptionId: "sub-1", code: "free text" } as unknown as SessionContentFrame),
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ type: "error", code: "peer said no" } as unknown as SessionContentFrame),
	);
	refused(
		"invalid_frame",
		() => encodeSessionContentFrame({ type: "subscribe", subscriptionId: "x".repeat(65), hostRunId: "run-1", sessionId: "instance-1", cols: 80, rows: 24 }),
	);

	// Decode side: bytes are the only input, so the same schema rules apply.
	const valid = encodeSessionContentFrame(hello);
	refused("bad_frame", () => decodeSessionContentFrame(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])));
	refused("bad_frame", () => decodeSessionContentFrame(Buffer.from("{not json")));
	refused("bad_frame", () => decodeSessionContentFrame(Buffer.alloc(0)));
	refused(
		"frame_too_large",
		() => decodeSessionContentFrame(Buffer.concat([valid, Buffer.alloc(DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes)])),
	);
	refused(
		"bad_frame",
		() => decodeSessionContentFrame(Buffer.from(JSON.stringify({ ...hello, extra: 1 }), "utf8")),
	);
	refused(
		"bad_frame",
		() => decodeSessionContentFrame(Buffer.from(JSON.stringify({ ...hello, major: "1" }), "utf8")),
	);
	refused(
		"bad_frame",
		() => decodeSessionContentFrame(Buffer.from('{"type":"hello","service":"x","major":1,"minor":0,"capabilities":[],"__proto__":{"admin":true}}', "utf8")),
		"a prototype-poisoning key is an unknown key",
	);
	assert.ok(Buffer.isBuffer(valid));
	const nullProto = Object.assign(Object.create(null), hello) as SessionContentFrame;
	assert.deepEqual(decodeSessionContentFrame(encodeSessionContentFrame(nullProto)), hello);
});

test("inherited object names are never frame types", () => {
	for (const type of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
		refused(
			"bad_frame",
			() => decodeSessionContentFrame(Buffer.from(JSON.stringify({ type }), "utf8")),
			`decode refuses the inherited name ${type} with a fixed code`,
		);
		refused(
			"invalid_frame",
			() => encodeSessionContentFrame({ type } as unknown as SessionContentFrame),
			`encode refuses the inherited name ${type} with a fixed code`,
		);
	}
});

test("decoding unsafe or malformed viewport payload bytes refuses with a fixed code", () => {
	const frame = tamperedFrame((value) => {
		delete value.styles;
		delete value.graphics;
	});
	const unsafeLine = JSON.stringify({
		...frame,
		lines: ["\x1b]52;c;Y2xpcGJvYXJk\x07", frame.lines[1] as string, frame.lines[2] as string],
	});
	refused("bad_frame", () => decodeSessionContentViewport(Buffer.from(unsafeLine, "utf8")));
	refused(
		"bad_frame",
		() => decodeSessionContentViewport(Buffer.from(JSON.stringify({ ...frame, currentFile: "/secret" }), "utf8")),
	);
	refused("bad_frame", () => decodeSessionContentViewport(Buffer.from([0x7b, 0xff, 0xfe])));
	refused("bad_frame", () => decodeSessionContentViewport(Buffer.from("{not json")));
	refused("bad_frame", () => decodeSessionContentViewport(Buffer.alloc(0)));
	refused("bad_frame", () => decodeSessionContentViewport(Buffer.from("[]", "utf8")));
});

test("negotiation narrows to the requested feature and never implies a grant", () => {
	const hello: SessionContentHelloFrame = {
		type: "hello",
		service: SESSION_CONTENT_SERVICE,
		major: 1,
		minor: 5,
		capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, "future-optional"],
	};
	assert.deepEqual(negotiateSessionContentHello(hello), {
		ok: true,
		major: 1,
		minor: 0,
		capabilities: [],
	});
	assert.deepEqual(
		negotiateSessionContentHello({ ...hello, service: "pi-peer-app-v1" }),
		{ ok: false, code: "unsupported_version" },
	);
	assert.deepEqual(
		negotiateSessionContentHello({ ...hello, major: 2 }),
		{ ok: false, code: "unsupported_version" },
	);
	assert.deepEqual(
		negotiateSessionContentHello({ ...hello, capabilities: [] }),
		{ ok: false, code: "missing_capability" },
	);
	assert.deepEqual(
		reviewSessionContentHelloAck({ ...hello, type: "hello_ack", minor: 0, capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY] }, {
			capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY],
		}),
		{ ok: true, minor: 0, capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY] },
	);
	assert.deepEqual(
		reviewSessionContentHelloAck({ ...hello, type: "hello_ack", capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, "unoffered"] }, {
			capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY],
		}),
		{ ok: false, code: "protocol_violation" },
	);
	assert.deepEqual(
		reviewSessionContentHelloAck({ ...hello, type: "hello_ack", minor: 1 }, { capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY] }),
		{ ok: false, code: "protocol_violation" },
	);
});

/* ------------------------------------------------------------------------- *
 * Bounds
 * ------------------------------------------------------------------------- */

test("bounds are finite, relational, and refuse unknown or unusable overrides", () => {
	assert.deepEqual(DEFAULT_SESSION_CONTENT_BOUNDS, {
		maxFrameBytes: 65_536,
		maxTransferBytes: 64 * 1024 * 1024,
		maxChunkPayloadBytes: 32 * 1024,
		maxIdentifierBytes: 64,
		maxCapabilities: 16,
		maxCapabilityIdBytes: 64,
		maxCols: 1_000,
		maxRows: 1_000,
	});
	assert.ok(Object.isFrozen(DEFAULT_SESSION_CONTENT_BOUNDS));
	const resolved = resolveSessionContentBounds({ maxFrameBytes: 4_096, maxChunkPayloadBytes: 1_024 });
	assert.equal(resolved.maxFrameBytes, 4_096);
	assert.equal(resolved.maxChunkPayloadBytes, 1_024);
	assert.ok(Object.isFrozen(resolved));

	for (const overrides of [
		{ maxFrameBytes: 0 },
		{ maxFrameBytes: -1 },
		{ maxFrameBytes: 1.5 },
		{ maxFrameBytes: Number.POSITIVE_INFINITY },
		{ maxFrameBytes: "4096" },
		{ maxFrameByte: 4_096 },
		{ maxChunkPayloadBytes: 65_536 },
		{ maxChunkPayloadBytes: 49_153 },
		{ maxTransferBytes: 1_024, maxChunkPayloadBytes: 2_048 },
	]) {
		refused("invalid_bounds", () => resolveSessionContentBounds(overrides as Partial<SessionContentBounds>));
	}
});

test("local failures map onto fixed wire codes only", () => {
	assert.equal(sessionContentWireCodeForFailure("frame_too_large"), "frame_too_large");
	assert.equal(sessionContentWireCodeForFailure("transfer_too_large"), "transfer_failed");
	assert.equal(sessionContentWireCodeForFailure("transfer_failed"), "transfer_failed");
	assert.equal(sessionContentWireCodeForFailure("invalid_bounds"), "protocol_violation");
	assert.equal(sessionContentWireCodeForFailure("bad_frame"), "bad_frame");
	assert.equal(sessionContentWireCodeForFailure("invalid_frame"), "bad_frame");
	const error = new SessionContentProtocolError("bad_frame");
	assert.equal(error.name, "SessionContentProtocolError");
	assert.equal(error.message, "session content frame could not be decoded");
	assert.ok(isSessionContentProtocolError(error));
});

/* ------------------------------------------------------------------------- *
 * Complete native viewport transfer
 * ------------------------------------------------------------------------- */

test("a complete styled Unicode native viewport with typed graphics roundtrips atomically", () => {
	const frame = sampleFrame();
	const built = buildSessionContentTransfer(transferOptions(frame));
	assert.equal(built.byteLength, encodeSessionContentViewport(frame).length);
	assert.equal(built.chunkCount, 1);
	assert.equal(built.frames.length, 3, "begin, one chunk, end");
	assert.deepEqual(built.messageBytes, built.frames.map((bytes) => bytes.length));
	assert.equal(built.totalMessageBytes, built.frames.reduce((total, bytes) => total + bytes.length, 0));

	const assembler = createSessionContentTransferAssembler();
	const decoded = framesOf(built);
	assert.equal(decoded[0]?.type, "content_begin");
	const begin = decoded[0];
	if (begin?.type !== "content_begin") throw new Error("expected begin");
	assert.equal(begin.sessionId, "instance-1", "the owner row id is carried, not derived from screen text");
	assert.deepEqual(begin.nativeSession, { sessionId: "native-session-1", epoch: 3 });
	assert.equal(begin.geometry.revision, 0, "a zero geometry revision is valid");
	assert.deepEqual(begin.inputModes, INPUT_MODES);

	const staged: Array<SessionContentSnapshot | undefined> = [];
	for (const message of decoded) {
		staged.push(assembler.accept(message));
	}
	assert.deepEqual(staged.slice(0, -1), decoded.slice(0, -1).map(() => undefined), "nothing publishes before end");
	const snapshot = staged[staged.length - 1];
	assert.ok(snapshot);
	assert.deepEqual(snapshot.frame, frame, "every line, run, cursor, mode, image, and placement survives");
	assert.equal(snapshot.meta.byteLength, built.byteLength);
	assert.equal(snapshot.meta.chunkCount, built.chunkCount);
	assert.deepEqual(snapshot.meta.geometry, { cols: 12, rows: 3, revision: 0 });
	assert.equal(snapshot.meta.sequence, 1);
	assert.ok(isFrozenDeep(snapshot), "the completed snapshot is immutable end to end");

	// The payload codec is symmetric on its own.
	assert.deepEqual(decodeSessionContentViewport(encodeSessionContentViewport(frame)), frame);

	// The snapshot owns fresh data: mutating the caller's frame changes nothing.
	const source = frame.lines;
	source.push("late mutation");
	assert.equal(snapshot.frame.lines.length, 3);
});

test("a normal viewport above 64 KiB pages across bounded messages and reassembles exactly", () => {
	const frame = styledFrame(100);
	const payloadBytes = encodeSessionContentViewport(frame).length;
	assert.ok(payloadBytes > DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes, `payload is ${payloadBytes} bytes`);

	const built = buildSessionContentTransfer(transferOptions(frame));
	assert.equal(built.byteLength, payloadBytes);
	assert.equal(built.chunkCount, Math.ceil(payloadBytes / DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes));
	assert.ok(built.chunkCount > 1, "one message cannot carry this viewport");
	assert.equal(built.frames.length, built.chunkCount + 2);
	for (const size of built.messageBytes) {
		assert.ok(size <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes, `message ${size} fits one channel message`);
	}

	const assembler = createSessionContentTransferAssembler();
	const decoded = framesOf(built);
	let snapshot: SessionContentSnapshot | undefined;
	for (const message of decoded) {
		const completed = assembler.accept(message);
		if (completed !== undefined) snapshot = completed;
	}
	assert.ok(snapshot);
	assert.equal(snapshot.frame.lines.length, frame.rows, "the complete row count crosses unchanged");
	assert.deepEqual(snapshot.frame.lines, frame.lines, "no row was dropped or trimmed");
	assert.deepEqual(snapshot.frame.styles, frame.styles, "structured runs survive paging");
	assert.ok(Object.isFrozen(snapshot.frame.lines));
});

test("a native viewport carrying a multi-message PNG keeps the payload intact", () => {
	const png = pngNoiseBase64(128, 128);
	const frame: TerminalFrame = {
		cols: 20,
		rows: 6,
		lines: Array.from({ length: 6 }, () => "\x1b[0m\x1b[1mimage-row\x1b[0m\x1b[0m"),
		cursor: { column: 9, row: 5, visible: true },
		styles: [{
			line: 0,
			runs: [{ startColumn: 0, text: "image-row", bold: true }],
		}],
		graphics: {
			images: [{ id: "kitty-9", mimeType: "image/png", widthPx: 128, heightPx: 128, base64: png }],
			placements: [{
				id: "placement-9",
				imageId: "kitty-9",
				column: 0,
				row: 0,
				columns: 8,
				rows: 4,
				crop: { x: 0, y: 0, width: 128, height: 128 },
				clip: ZERO_CLIP,
			}],
			fallbacks: [{
				id: "placement-9",
				mimeType: "image/png",
				widthPx: 128,
				heightPx: 128,
				column: 0,
				row: 0,
				columns: 8,
				rows: 4,
				clip: ZERO_CLIP,
			}],
		},
	};
	const built = buildSessionContentTransfer(transferOptions(frame));
	assert.ok(built.byteLength > DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes, `payload is ${built.byteLength} bytes`);
	assert.ok(built.chunkCount > 1, "the PNG-bearing viewport needs several messages");
	for (const size of built.messageBytes) {
		assert.ok(size <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes);
	}
	const assembler = createSessionContentTransferAssembler();
	let snapshot: SessionContentSnapshot | undefined;
	for (const message of framesOf(built)) {
		const completed = assembler.accept(message);
		if (completed !== undefined) snapshot = completed;
	}
	assert.ok(snapshot);
	assert.equal(snapshot.frame.graphics?.images[0]?.base64, png, "the PNG payload crosses whole, never filtered");
	assert.equal(snapshot.frame.graphics?.images[0]?.widthPx, 128);
	assert.deepEqual(snapshot.frame.graphics?.placements[0]?.crop, { x: 0, y: 0, width: 128, height: 128 });
	assert.deepEqual(snapshot.frame.lines, frame.lines);
});

test("small configured bounds keep actual per-message sizes and chunk facts honest", () => {
	const bounds = resolveSessionContentBounds({
		maxFrameBytes: 4_096,
		maxChunkPayloadBytes: 1_024,
		maxTransferBytes: 65_536,
	});
	const frame = styledFrame(10);
	const built = buildSessionContentTransfer(transferOptions(frame, { bounds }));
	assert.ok(built.byteLength > bounds.maxFrameBytes, "the viewport is larger than one message");
	assert.equal(built.chunkCount, Math.ceil(built.byteLength / bounds.maxChunkPayloadBytes));
	assert.ok(built.chunkCount > 1);
	for (const size of built.messageBytes) {
		assert.ok(size <= bounds.maxFrameBytes, `message ${size} respects the configured smaller bound`);
	}
	const assembler = createSessionContentTransferAssembler(bounds);
	const decoded = framesOf(built);
	let snapshot: SessionContentSnapshot | undefined;
	for (const message of decoded) {
		const completed = assembler.accept(message);
		if (completed !== undefined) snapshot = completed;
	}
	assert.ok(snapshot);
	assert.equal(snapshot.meta.byteLength, built.byteLength);
	refused(
		"transfer_failed",
		() => assembler.accept(decoded.at(-1) as SessionContentFrame),
		"a replayed end after completion publishes nothing",
	);
});

test("tiny chunks cost one bounded buffer, not one object per chunk", () => {
	const frame = sampleFrame();
	const payload = encodeSessionContentViewport(frame);
	const chunkOf = (index: number): SessionContentFrame => ({
		type: "content_chunk",
		subscriptionId: "sub-1",
		transferId: "transfer-1",
		index,
		data: Buffer.from([payload[index] as number]).toString("base64"),
	});
	const beginOf = (byteLength: number, chunkCount: number): SessionContentFrame => ({
		type: "content_begin",
		subscriptionId: "sub-1",
		transferId: "transfer-1",
		hostRunId: "run-1",
		sessionId: "instance-1",
		nativeSession: null,
		sequence: 1,
		geometry: { cols: frame.cols, rows: frame.rows, revision: 0 },
		inputModes: INPUT_MODES,
		byteLength,
		chunkCount,
	});

	// One byte per message, one chunk per byte: still a single bounded buffer.
	const bytewise = createSessionContentTransferAssembler();
	assert.equal(bytewise.accept(beginOf(payload.length, payload.length)), undefined);
	for (let index = 0; index < payload.length; index += 1) {
		assert.equal(bytewise.accept(chunkOf(index)), undefined);
	}
	const snapshot = bytewise.accept({ type: "content_end", subscriptionId: "sub-1", transferId: "transfer-1", sequence: 1 });
	assert.ok(snapshot);
	assert.deepEqual(snapshot.frame, frame);

	// A hostile declaration of millions of one-byte chunks allocates at most the
	// declared payload once, and reset() drops it instead of retaining chunks.
	const bulkBytes = 8 * 1024 * 1024;
	const hostile = createSessionContentTransferAssembler();
	assert.equal(hostile.accept(beginOf(bulkBytes, bulkBytes)), undefined);
	for (let index = 0; index < 2; index += 1) {
		assert.equal(hostile.accept({
			type: "content_chunk",
			subscriptionId: "sub-1",
			transferId: "transfer-1",
			index,
			data: "AA==",
		}), undefined);
	}
	hostile.reset();
	refused(
		"transfer_failed",
		() => hostile.accept({ type: "content_end", subscriptionId: "sub-1", transferId: "transfer-1", sequence: 1 }),
	);
});

test("an oversized viewport is refused honestly instead of being trimmed or filtered", () => {
	const frame = styledFrame(100);
	const payloadBytes = encodeSessionContentViewport(frame).length;
	const bounds = resolveSessionContentBounds({ maxTransferBytes: 50_000 });
	assert.ok(payloadBytes > bounds.maxTransferBytes);
	refused("transfer_too_large", () => buildSessionContentTransfer(transferOptions(frame, { bounds })));
	refused(
		"transfer_too_large",
		() => decodeSessionContentViewport(encodeSessionContentViewport(frame), bounds),
		"the ceiling is enforced on decode as well",
	);
	// Geometry that disagrees with the frame is a caller bug, never a sent transfer.
	refused(
		"invalid_frame",
		() => buildSessionContentTransfer(transferOptions(frame, { geometry: { cols: 71, rows: 100, revision: 0 } })),
	);
});

/* ------------------------------------------------------------------------- *
 * Assembly refusals
 * ------------------------------------------------------------------------- */

test("reordered, duplicated, foreign, truncated, and mismatched transfers never publish", () => {
	const built = buildSessionContentTransfer(transferOptions(styledFrame(100)));
	const decoded = framesOf(built);
	const begin = decoded[0] as SessionContentFrame;
	const chunks = decoded.slice(1, -1);
	const end = decoded[decoded.length - 1] as SessionContentFrame;
	assert.ok(chunks.length > 1);

	const reordered = createSessionContentTransferAssembler();
	reordered.accept(begin);
	refused("transfer_failed", () => reordered.accept(chunks[1] as SessionContentFrame));

	const duplicated = createSessionContentTransferAssembler();
	duplicated.accept(begin);
	duplicated.accept(chunks[0] as SessionContentFrame);
	refused("transfer_failed", () => duplicated.accept(chunks[0] as SessionContentFrame));

	const crossTransfer = createSessionContentTransferAssembler();
	const other = buildSessionContentTransfer(transferOptions(styledFrame(10), { transferId: "transfer-2" }));
	const otherChunk = framesOf(other)[1] as SessionContentFrame;
	crossTransfer.accept(begin);
	refused("transfer_failed", () => crossTransfer.accept(otherChunk));

	const truncated = createSessionContentTransferAssembler();
	truncated.accept(begin);
	for (const chunk of chunks.slice(0, -1)) truncated.accept(chunk);
	refused("transfer_failed", () => truncated.accept(end));

	const wrongSequence = createSessionContentTransferAssembler();
	wrongSequence.accept(begin);
	for (const chunk of chunks) wrongSequence.accept(chunk);
	refused("transfer_failed", () => wrongSequence.accept({
		type: "content_end",
		subscriptionId: "sub-1",
		transferId: "transfer-1",
		sequence: 2,
	}));
	refused(
		"transfer_failed",
		() => createSessionContentTransferAssembler().accept(chunks[0] as SessionContentFrame),
		"a chunk without a begin is refused",
	);

	const earlyEnd = createSessionContentTransferAssembler();
	earlyEnd.accept(begin);
	refused("transfer_failed", () => earlyEnd.accept(end));

	const secondBegin = createSessionContentTransferAssembler();
	secondBegin.accept(begin);
	refused("transfer_failed", () => secondBegin.accept(begin), "one in-flight transfer per channel");
});

test("declared byte and chunk counts are enforced before allocation and at end", () => {
	const frame = sampleFrame();
	const built = buildSessionContentTransfer(transferOptions(frame));
	const decoded = framesOf(built);
	const begin = decoded[0];
	if (begin?.type !== "content_begin") throw new Error("expected begin");
	const chunk = decoded[1] as SessionContentFrame;
	const end = decoded[2] as SessionContentFrame;

	// Declared payload smaller than the first chunk's real bytes.
	const smaller = createSessionContentTransferAssembler();
	smaller.accept({ ...begin, byteLength: 10, chunkCount: 1 });
	refused("transfer_failed", () => smaller.accept(chunk));

	// Declared payload larger than what arrived.
	const larger = createSessionContentTransferAssembler();
	larger.accept({ ...begin, byteLength: begin.byteLength + 100 });
	larger.accept(chunk);
	refused("transfer_failed", () => larger.accept(end));

	// Declared one chunk too many.
	const extraChunk = createSessionContentTransferAssembler();
	extraChunk.accept({ ...begin, chunkCount: 2 });
	extraChunk.accept(chunk);
	refused("transfer_failed", () => extraChunk.accept(end));

	// A chunk that would exceed the declared payload is refused before append.
	const overrun = createSessionContentTransferAssembler();
	overrun.accept({ ...begin, byteLength: 1_024, chunkCount: 1 });
	refused(
		"transfer_failed",
		() => overrun.accept({
			type: "content_chunk",
			subscriptionId: "sub-1",
			transferId: "transfer-1",
			index: 0,
			data: Buffer.alloc(1_025, 0x20).toString("base64"),
		}),
	);
	refused(
		"transfer_failed",
		() => overrun.accept({ type: "content_end", subscriptionId: "sub-1", transferId: "transfer-1", sequence: 1 }),
		"the refused partial is discarded, so a later end cannot complete it",
	);
});

test("assembler refuses out-of-bound begin declarations before any transfer exists", () => {
	const built = buildSessionContentTransfer(transferOptions(sampleFrame()));
	const begin = framesOf(built)[0];
	if (begin?.type !== "content_begin") throw new Error("expected begin");

	const assembler = createSessionContentTransferAssembler();
	refused(
		"bad_frame",
		() => assembler.accept({ ...begin, byteLength: DEFAULT_SESSION_CONTENT_BOUNDS.maxTransferBytes + 1 }),
	);
	refused("bad_frame", () => assembler.accept({ ...begin, chunkCount: begin.byteLength + 1 }));
	refused("bad_frame", () => assembler.accept({
		...begin,
		byteLength: 40_000,
		chunkCount: 1,
	}));
	refused("bad_frame", () => assembler.accept({ ...begin, sequence: 0 }));
	refused("bad_frame", () => assembler.accept({ ...begin, sequence: 1.5 }));
	refused("bad_frame", () => assembler.accept({
		...begin,
		geometry: { cols: begin.geometry.cols, rows: begin.geometry.rows, revision: -1 },
	}));
	refused("bad_frame", () => assembler.accept({
		...begin,
		nativeSession: { sessionId: "native-session-1", epoch: 0 },
	}));
	refused("bad_frame", () => assembler.accept({
		...begin,
		nativeSession: { sessionId: "native-session-1", epoch: 1, extra: true } as never,
	}));
	refused("bad_frame", () => assembler.accept({
		...begin,
		inputModes: { ...INPUT_MODES, kittyFlags: 8 },
	}));
	refused("bad_frame", () => assembler.accept({
		...begin,
		inputModes: { ...INPUT_MODES, mouseTracking: "always" } as never,
	}));
	// A refused declaration never leaves a partial transfer behind.
	refused(
		"transfer_failed",
		() => assembler.accept({ type: "content_end", subscriptionId: "sub-1", transferId: "transfer-1", sequence: 1 }),
	);
});

test("assembler refuses malformed chunks inside a valid transfer and discards it", () => {
	const built = buildSessionContentTransfer(transferOptions(sampleFrame()));
	const decoded = framesOf(built);
	const begin = decoded[0];
	if (begin?.type !== "content_begin") throw new Error("expected begin");
	const validChunk = decoded[1] as SessionContentFrame;
	const end = decoded[2] as SessionContentFrame;

	const oversizedChunk = (): SessionContentFrame => ({
		type: "content_chunk",
		subscriptionId: "sub-1",
		transferId: "transfer-1",
		index: 0,
		data: Buffer.alloc(DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes + 1).toString("base64"),
	});

	for (const [code, malformed] of [
		["frame_too_large", oversizedChunk()],
		["bad_frame", {
			type: "content_chunk",
			subscriptionId: "sub-1",
			transferId: "transfer-1",
			index: 0,
			data: "not base64!",
		} as SessionContentFrame],
		["bad_frame", {
			type: "content_chunk",
			subscriptionId: "sub-1",
			transferId: "transfer-1",
			index: 0,
			data: Buffer.alloc(8).toString("base64").replace(/=+$/, ""),
		} as SessionContentFrame],
		["transfer_failed", {
			type: "content_chunk",
			subscriptionId: "sub-1",
			transferId: "transfer-1",
			index: 1,
			data: Buffer.alloc(4).toString("base64"),
		} as SessionContentFrame],
	] as const) {
		const assembler = createSessionContentTransferAssembler();
		assembler.accept(begin);
		refused(code, () => assembler.accept(malformed), `refused ${code}`);
		// The refused chunk discarded the partial: a valid chunk and end cannot
		// complete the transfer afterwards.
		refused("transfer_failed", () => assembler.accept(validChunk));
		refused("transfer_failed", () => assembler.accept(end));
	}
});

test("a native viewport whose geometry disagrees with begin is refused at end", () => {
	const built = buildSessionContentTransfer(transferOptions(sampleFrame()));
	const decoded = framesOf(built);
	const begin = decoded[0];
	if (begin?.type !== "content_begin") throw new Error("expected begin");
	const assembler = createSessionContentTransferAssembler();
	assembler.accept({ ...begin, geometry: { cols: 13, rows: 3, revision: 0 } });
	for (const message of decoded.slice(1, -1)) assembler.accept(message);
	refused("bad_frame", () => assembler.accept(decoded.at(-1) as SessionContentFrame));
});

test("reset drops a stale partial and controls never disturb an in-flight transfer", () => {
	const built = buildSessionContentTransfer(transferOptions(styledFrame(10)));
	const decoded = framesOf(built);
	const begin = decoded[0] as SessionContentFrame;
	const chunks = decoded.slice(1, -1);
	const end = decoded[decoded.length - 1] as SessionContentFrame;

	const assembler = createSessionContentTransferAssembler();
	assembler.accept(begin);
	assembler.accept(chunks[0] as SessionContentFrame);
	assert.equal(
		assembler.accept({ type: "hello_ack", service: SESSION_CONTENT_SERVICE, major: 1, minor: 0, capabilities: [] }),
		undefined,
		"a control frame is the endpoint's business",
	);
	assembler.reset();
	refused("transfer_failed", () => assembler.accept(end), "a stale partial can never complete");
	assembler.reset();
	assembler.reset();

	const continued = createSessionContentTransferAssembler();
	continued.accept(begin);
	continued.accept({ type: "resize", subscriptionId: "sub-1", cols: 70, rows: 10 });
	for (const chunk of chunks) continued.accept(chunk);
	const snapshot = continued.accept(end);
	assert.ok(snapshot);
});

/* ------------------------------------------------------------------------- *
 * Native viewport validation
 * ------------------------------------------------------------------------- */

test("only allowlisted generated SGR and visible text reach a published frame", () => {
	const accepted = [
		"\x1b[0mplain\x1b[0m",
		"\x1b[0m\x1b[1;2;3;4;5;7;8;9;53;38;5;196;48;2;1;2;3mstyled\x1b[0m\x1b[0m",
		"\x1b[0m\u4e16\u754c e\u0301 \u0915\u094d\u0937\x1b[0m",
		"\x1b[0m\x1b[1mfaint-bold\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[31mfg-simple\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[91mfg-bright\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[41mbg-simple\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[101mbg-bright\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[38;5;16mfg-indexed\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[1;48;5;255mbg-indexed\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[3mitalic-only\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[53moverline-only\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[4;53munderline-overline\x1b[0m\x1b[0m",
		"\x1b[0m\x1b[4;53;38;2;255;0;0;48;5;0mrgb-and-indexed\x1b[0m\x1b[0m",
	];
	for (const line of accepted) {
		assert.equal(
			decodeSessionContentViewport(encodeSessionContentViewport(tamperedFrame((frame) => {
				frame.lines = [line, line, line];
				delete frame.styles;
				delete frame.graphics;
			}))).lines[0],
			line,
		);
	}

	const rejected = [
		"\x1b]0;window title\x07",
		"\x1b]52;c;Y2xpcGJvYXJk\x07",
		"\x1b[2J",
		"\x1b[1;1H",
		"bell\u0007",
		"c1\u009bcontrol",
		"del\u007f",
		"\x1b_Ga=T;payload\x1b\\",
		"\x1bP1$r0m\x1b\\",
		// Not a form generateSgr can emit: no empty list, no unsupported
		// attributes, no reordered/incomplete/out-of-range color groups.
		"\x1b[0m\x1b[memit-nothing\x1b[0m",
		"\x1b[0m\x1b[51moverlined-superscript\x1b[0m",
		"\x1b[0m\x1b[21mdouble-underline\x1b[0m",
		"\x1b[0m\x1b[2;1mreordered\x1b[0m",
		"\x1b[0m\x1b[9;8mreordered-attributes\x1b[0m",
		"\x1b[0m\x1b[0;1mreset-in-list\x1b[0m",
		"\x1b[0m\x1b[01mleading-zero\x1b[0m",
		"\x1b[0m\x1b[38;5;999mout-of-range-index\x1b[0m",
		"\x1b[0m\x1b[38;2;1;2mincomplete-rgb\x1b[0m",
		"\x1b[0m\x1b[38;9;1munknown-color-mode\x1b[0m",
		"\x1b[0m\x1b[1;;mempty-param\x1b[0m",
		"\x1b[0m\x1b[;1mempty-first-param\x1b[0m",
	];
	for (const line of rejected) {
		refused(
			"invalid_frame",
			() => encodeSessionContentViewport(tamperedFrame((frame) => {
				frame.lines = [line, line, line];
				delete frame.styles;
				delete frame.graphics;
			})),
			`refused control payload ${JSON.stringify(line)}`,
		);
	}

	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.currentFile = "/home/robert/secret.ts";
		delete frame.styles;
		delete frame.graphics;
	})), "no full owner row field can ride along");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.lines = frame.lines.slice(0, 2);
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.cols = 0;
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.rows = DEFAULT_SESSION_CONTENT_BOUNDS.maxRows + 1;
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.cursor.column = frame.cols;
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.cursor.visible = "yes";
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.styles[0].runs[0].startColumn = frame.cols;
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.styles[0].runs = [];
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.styles[0].runs[0].bold = false;
	})), "the native serializer never emits a false attribute");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.styles[1].runs[0].fg = { mode: "palette", value: 300 };
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.styles[1].runs[0].fg = { mode: "hsv", value: 1 };
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.styles[1].runs[1].startColumn = 0;
	})), "runs are strictly ordered");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.styles[2].line = 1;
	})), "style lines are strictly ordered");
});

test("shared native PNG validation is reused for every typed image", () => {
	const valid = pngBase64();
	const validated = validateTerminalGraphicsPng(valid);
	assert.equal(validated?.widthPx, 4);
	assert.equal(validated?.heightPx, 4);
	assert.ok((validated?.byteLength ?? 0) > 0);
	assert.equal(validateTerminalGraphicsPng(pngWithCorruptCrc()), undefined);
	assert.equal(validateTerminalGraphicsPng(pngBase64(8_193, 4)), undefined);
	assert.equal(validateTerminalGraphicsPng(pngFromChunks([
		["IHDR", pngHeader(4, 4)],
		["acTL", Buffer.alloc(8)],
		["IDAT", deflateSync(Buffer.alloc(4 * 17))],
		["IEND", Buffer.alloc(0)],
	])), undefined, "animated PNGs are outside the native subset");
	assert.equal(validateTerminalGraphicsPng(`${valid}\n`), undefined);
	assert.equal(validateTerminalGraphicsPng(`${valid}A`), undefined, "a stray trailing base64 character is refused");
	assert.equal(validateTerminalGraphicsPng(valid.slice(0, -1)), undefined, "a truncated base64 payload is refused");
	assert.equal(validateTerminalGraphicsPng(""), undefined);

	for (const base64 of [pngWithCorruptCrc(), pngBase64(8_193, 4), `${valid}\n`]) {
		refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
			frame.graphics.images[0].base64 = base64;
		})), "the wire path uses the same decoder limits");
	}
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.images[0].widthPx = 8;
		frame.graphics.images[0].heightPx = 8;
	})), "declared dimensions must match the validated PNG");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.images.push({ ...frame.graphics.images[0] });
	})), "duplicate image ids are refused");
});

test("image, placement, fallback, crop, and clip references follow native frame semantics", () => {
	const accepted = tamperedFrame((frame) => {
		// A fallback-only placement (rejected image payload) is native output.
		frame.graphics.placements = [];
		frame.graphics.fallbacks = [{
			id: "image-9",
			mimeType: "image/png",
			column: 4,
			row: 0,
			columns: 2,
			rows: 2,
			clip: ZERO_CLIP,
		}];
	});
	assert.equal(decodeSessionContentViewport(encodeSessionContentViewport(accepted)).graphics?.fallbacks.length, 1);

	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.placements[0].imageId = "kitty-8";
	})), "a placement must reference a carried image");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.placements[0].crop.width = 5;
	})), "crop must stay inside the image");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.placements[0].crop.height = 0;
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.placements[0].clip = { leftColumns: 1, topRows: 0, rightColumns: 0, bottomRows: 0 };
	})), "clip must be the native viewport-edge derivation");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.placements[0].column = frame.cols;
	})), "an off-screen placement is not in a native frame");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.placements[0].row = frame.rows;
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.placements[0].row = -2;
		frame.graphics.placements[0].rows = 2;
		frame.graphics.placements[0].clip = { leftColumns: 0, topRows: 2, rightColumns: 0, bottomRows: 0 };
	})), "a placement that contributes no visible cell is refused");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.placements.push({ ...frame.graphics.placements[0] });
	})), "duplicate placement ids are refused");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.fallbacks[0].row = 0;
	})), "a matching fallback must describe the same footprint");
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.fallbacks[0].mimeType = "image/jpeg";
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics.images[0].mimeType = "image/jpeg";
	})));
	refused("invalid_frame", () => encodeSessionContentViewport(tamperedFrame((frame) => {
		frame.graphics = { images: [], placements: "none", fallbacks: [] };
	})));
});

test("a clipped native placement at the viewport edge is preserved", () => {
	const clipped = tamperedFrame((frame) => {
		// 3 columns wide, starting at the last visible column: right clip = 2.
		frame.cols = 12;
		frame.graphics.placements[0] = {
			id: "placement-7",
			imageId: "kitty-7",
			column: 10,
			row: 0,
			columns: 3,
			rows: 2,
			crop: { x: 1, y: 0, width: 3, height: 4 },
			clip: { leftColumns: 0, topRows: 0, rightColumns: 1, bottomRows: 0 },
		};
		frame.graphics.fallbacks[0] = {
			id: "placement-7",
			mimeType: "image/png",
			widthPx: 4,
			heightPx: 4,
			column: 10,
			row: 0,
			columns: 3,
			rows: 2,
			clip: { leftColumns: 0, topRows: 0, rightColumns: 1, bottomRows: 0 },
		};
	});
	const decoded = decodeSessionContentViewport(encodeSessionContentViewport(clipped));
	assert.deepEqual(decoded.graphics?.placements[0]?.clip, {
		leftColumns: 0,
		topRows: 0,
		rightColumns: 1,
		bottomRows: 0,
	});
});

test("a tall top-clipped native placement anchored above a short viewport is preserved", () => {
	const clip = { leftColumns: 0, topRows: 20, rightColumns: 0, bottomRows: 7 };
	const tall = tamperedFrame((frame) => {
		frame.rows = 3;
		frame.cursor = { column: 0, row: 0, visible: true };
		frame.graphics.placements[0] = {
			id: "placement-7",
			imageId: "kitty-7",
			column: 0,
			row: -20,
			columns: 4,
			rows: 30,
			crop: { x: 0, y: 0, width: 4, height: 4 },
			clip,
		};
		frame.graphics.fallbacks[0] = {
			id: "placement-7",
			mimeType: "image/png",
			widthPx: 4,
			heightPx: 4,
			column: 0,
			row: -20,
			columns: 4,
			rows: 30,
			clip: { ...clip },
		};
	});
	const decoded = decodeSessionContentViewport(encodeSessionContentViewport(tall));
	assert.equal(decoded.graphics?.placements[0]?.row, -20, "a tall placement may start far above the viewport");
	assert.equal(decoded.graphics?.placements[0]?.rows, 30);
	assert.deepEqual(decoded.graphics?.placements[0]?.clip, clip);
	assert.deepEqual(decoded.graphics?.fallbacks[0]?.clip, clip);

	// It also survives a complete transfer unchanged.
	const assembler = createSessionContentTransferAssembler();
	let snapshot: SessionContentSnapshot | undefined;
	for (const message of framesOf(buildSessionContentTransfer(transferOptions(tall)))) {
		const completed = assembler.accept(message);
		if (completed !== undefined) snapshot = completed;
	}
	assert.deepEqual(snapshot?.frame.graphics?.placements[0]?.clip, clip);
});

test("metadata-v1 framing keeps its unknown-key fail-closed behavior", () => {
	assert.equal(ROSTER_BRIDGE_SERVICE, "pi-peer-roster-v1");
	assert.equal(ROSTER_BRIDGE_MAJOR, 1);
	assert.equal(ROSTER_BRIDGE_MINOR, 0);
	assert.equal(ROSTER_BRIDGE_REQUIRED_CAPABILITY, "roster-v1");
	const hello = {
		type: "hello" as const,
		service: ROSTER_BRIDGE_SERVICE,
		major: ROSTER_BRIDGE_MAJOR,
		minor: ROSTER_BRIDGE_MINOR,
		capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY],
	};
	assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(hello)), hello);
	assert.throws(
		() => decodeRosterBridgeFrame(Buffer.from(JSON.stringify({ ...hello, extra: true }), "utf8")),
		(error: unknown) => error instanceof Error && (error as { code?: string }).code === "bad_frame",
	);
});

/* ------------------------------------------------------------------------- *
 * Optional native IO frames (native input and native text copy)
 * ------------------------------------------------------------------------- */

function nativeSource(overrides: Partial<NativeIoSource> = {}): NativeIoSource {
	return {
		hostRunId: "run-1",
		sessionId: "instance-1",
		nativeSession: { sessionId: "native-session-1", epoch: 3 },
		geometry: { cols: 80, rows: 24, revision: 7 },
		viewerRevision: 2,
		sourceToken: "host-source-token-1",
		...overrides,
	};
}

/** The source of the `transferOptions()` publish: same run, row, tuple, and geometry. */
function contentSource(overrides: Partial<NativeIoSource> = {}): NativeIoSource {
	return {
		hostRunId: "run-1",
		sessionId: "instance-1",
		nativeSession: { sessionId: "native-session-1", epoch: 3 },
		geometry: { cols: 12, rows: 3, revision: 0 },
		viewerRevision: 2,
		sourceToken: "host-source-token-1",
		...overrides,
	};
}

/** A copy event carrying the same tuple as `nativeSource()`'s native session. */
function copyEvent(
	encoded: string,
	overrides: { readonly sessionId?: string; readonly sessionEpoch?: number } = {},
): NativeIoCopyEvent {
	return { kind: "copy", encoded, sessionId: "native-session-1", sessionEpoch: 3, ...overrides };
}

function unavailableEvent(
	reason: NativeIoCopyUnavailableReason,
	overrides: { readonly sessionId?: string; readonly sessionEpoch?: number } = {},
): NativeIoCopyEvent {
	return { kind: "unavailable", reason, sessionId: "native-session-1", sessionEpoch: 3, ...overrides };
}

function pasteOptions(
	text: string | Uint8Array,
	overrides: Partial<Parameters<typeof buildNativeInputPaste>[0]> = {},
): Parameters<typeof buildNativeInputPaste>[0] {
	return {
		subscriptionId: "sub-1",
		inputId: "input-1",
		ordinal: 1,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		text,
		...overrides,
	};
}

function copyBase(): {
	readonly subscriptionId: string;
	readonly copyId: string;
	readonly sequence: number;
	readonly source: NativeIoSource;
	readonly dispatchId: number;
} {
	return { subscriptionId: "sub-1", copyId: "copy-1", sequence: 1, source: nativeSource(), dispatchId: 1 };
}

function copyOptions(
	overrides: Partial<Parameters<typeof buildNativeCopyPaged>[0]> = {},
): Parameters<typeof buildNativeCopyPaged>[0] {
	return { ...copyBase(), encoded: Buffer.from("copy").toString("base64"), ...overrides };
}

function copyInlineOptions(
	event: NativeIoCopyEvent,
	overrides: Partial<Parameters<typeof buildNativeCopyInline>[0]> = {},
): Parameters<typeof buildNativeCopyInline>[0] {
	return { ...copyBase(), event, ...overrides };
}

function assembleInput(
	frames: readonly SessionContentFrame[],
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): NativeIoCompletedInput | undefined {
	const assembler = createNativeInputAssembler(bounds);
	let completed: NativeIoCompletedInput | undefined;
	for (const frame of frames) {
		const result = assembler.accept(frame);
		if (result === undefined) continue;
		assert.equal(completed, undefined, "one native input completes once");
		completed = result;
	}
	return completed;
}

function assembleCopy(
	frames: readonly SessionContentFrame[],
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): NativeIoCompletedCopy | undefined {
	const assembler = createNativeCopyAssembler(bounds);
	let completed: NativeIoCompletedCopy | undefined;
	for (const frame of frames) {
		const result = assembler.accept(frame);
		if (result === undefined) continue;
		assert.equal(completed, undefined, "one native copy completes once");
		completed = result;
	}
	return completed;
}

function decodedFrames(
	built: { readonly frames: readonly Buffer[] },
	bounds: SessionContentBounds = DEFAULT_SESSION_CONTENT_BOUNDS,
): SessionContentFrame[] {
	return built.frames.map((message) => decodeSessionContentFrame(message, bounds));
}

test("the native IO capability is implementable but never offered or acknowledged by default", () => {
	assert.deepEqual([...SESSION_CONTENT_KNOWN_OPTIONAL_CAPABILITIES], [], "no optional capability is negotiable on its own");
	assert.deepEqual([...SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES], [
		SESSION_CONTENT_NATIVE_IO_CAPABILITY,
		SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
	]);
	const hello: SessionContentHelloFrame = {
		type: "hello",
		service: SESSION_CONTENT_SERVICE,
		major: SESSION_CONTENT_MAJOR,
		minor: 4,
		capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY],
	};
	assert.deepEqual(
		negotiateSessionContentHello(hello),
		{ ok: true, major: SESSION_CONTENT_MAJOR, minor: SESSION_CONTENT_MINOR, capabilities: [] },
		"an implementable capability is never offered or accepted by default",
	);
	assert.deepEqual(
		negotiateSessionContentHello(hello, { supportedOptionalCapabilities: [] }),
		{ ok: true, major: SESSION_CONTENT_MAJOR, minor: SESSION_CONTENT_MINOR, capabilities: [] },
	);
	assert.deepEqual(
		negotiateSessionContentHello(hello, {
			supportedOptionalCapabilities: [SESSION_CONTENT_NATIVE_IO_CAPABILITY],
		}),
		{
			ok: true,
			major: SESSION_CONTENT_MAJOR,
			minor: SESSION_CONTENT_MINOR,
			capabilities: [SESSION_CONTENT_NATIVE_IO_CAPABILITY],
		},
		"only an explicit opt-in records the capability",
	);
	for (const options of [
		{ supportedOptionalCapabilities: ["unimplemented"] },
		{ supportedOptionalCapabilities: [SESSION_CONTENT_NATIVE_IO_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY] },
		{ supportedOptionalCapability: [SESSION_CONTENT_NATIVE_IO_CAPABILITY] },
		{ supportedOptionalCapabilities: SESSION_CONTENT_NATIVE_IO_CAPABILITY },
		{ supportedOptionalCapabilities: [""] },
	]) {
		refused("invalid_bounds", () => negotiateSessionContentHello(hello, options as never));
	}

	const ack = (capabilities: readonly string[]): Parameters<typeof reviewSessionContentHelloAck>[0] => ({
		type: "hello_ack",
		service: SESSION_CONTENT_SERVICE,
		major: SESSION_CONTENT_MAJOR,
		minor: SESSION_CONTENT_MINOR,
		capabilities,
	});
	assert.deepEqual(
		reviewSessionContentHelloAck(ack([SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY]), {
			capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY],
		}),
		{ ok: false, code: "protocol_violation" },
		"an acknowledgement can never select a capability this side did not offer",
	);
	assert.deepEqual(
		reviewSessionContentHelloAck(ack([SESSION_CONTENT_REQUIRED_CAPABILITY, "future-optional"]), {
			capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, "future-optional"],
		}),
		{ ok: false, code: "protocol_violation" },
		"a capability this build cannot implement is never accepted",
	);
	assert.deepEqual(
		reviewSessionContentHelloAck(ack([SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY]), {
			capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY],
		}),
		{
			ok: true,
			minor: SESSION_CONTENT_MINOR,
			capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY],
		},
	);
});

test("native IO source identity is exact, never an equal-dimensions ABA assumption", () => {
	const original = nativeSource();
	assert.equal(nativeIoSourceEquals(original, nativeSource()), true);
	assert.equal(
		nativeIoSourceEquals(original, nativeSource({ geometry: { cols: 80, rows: 24, revision: 8 } })),
		false,
		"the same dimensions with a new geometry revision are a different source",
	);
	assert.equal(nativeIoSourceEquals(original, nativeSource({ viewerRevision: 3 })), false);
	assert.equal(
		nativeIoSourceEquals(original, nativeSource({ nativeSession: { sessionId: "native-session-1", epoch: 4 } })),
		false,
	);
	assert.equal(nativeIoSourceEquals(original, nativeSource({ sourceToken: "host-source-token-2" })), false);
});

test("content_begin carries a native IO source only when a publisher states one", () => {
	const frame = sampleFrame();
	const plain = framesOf(buildSessionContentTransfer(transferOptions(frame)))[0];
	if (plain?.type !== "content_begin") throw new Error("expected begin");
	assert.equal(Object.hasOwn(plain, "inputSource"), false, "a legacy publish keeps its exact key set");

	const explicitNull = framesOf(buildSessionContentTransfer(transferOptions(frame, { inputSource: null })))[0];
	if (explicitNull?.type !== "content_begin") throw new Error("expected begin");
	assert.equal(explicitNull.inputSource, null);

	const source = contentSource();
	const built = buildSessionContentTransfer(transferOptions(frame, { inputSource: source }));
	const carried = framesOf(built)[0];
	if (carried?.type !== "content_begin") throw new Error("expected begin");
	assert.deepEqual(carried.inputSource, source, "the source roundtrips exactly, epoch and revisions included");
	assert.ok(isFrozenDeep(carried.inputSource));

	const snapshot = assembleContent(built);
	assert.ok(snapshot);
	assert.deepEqual(snapshot.meta.inputSource, source);
	const legacy = assembleContent(buildSessionContentTransfer(transferOptions(frame)));
	assert.ok(legacy);
	assert.equal(Object.hasOwn(legacy.meta, "inputSource"), false, "a legacy snapshot is unchanged");

	// Malformed or foreign source shapes are refused before coherence is even reached.
	for (const invalid of [
		{ ...source, nativeSession: null },
		{ ...source, nativeSession: { sessionId: "native-session-1", epoch: 0 } },
		{ ...source, viewerRevision: 0 },
		{ ...source, geometry: { cols: 12, rows: 3 } },
		{ ...source, geometry: { cols: 12, rows: 3, revision: -1 } },
		{ ...source, sourceToken: "" },
		{ ...source, sourceToken: "x".repeat(129) },
		{ ...source, sourceToken: "host source token" },
		{ ...source, hostRunId: "run\n1" },
		{ ...source, agentPath: "/tmp/agent" },
		{ ...source, inputGrant: true },
		{ ...source, lease: "granted" },
	]) {
		refused(
			"bad_frame",
			() => buildSessionContentTransfer(transferOptions(frame, { inputSource: invalid as unknown as NativeIoSource })),
			"a malformed, missing, or foreign source field never publishes",
		);
	}

	// A well-formed source that describes a DIFFERENT snapshot is mixed metadata.
	const coherent = decodeSessionContentFrame(
		buildSessionContentTransfer(transferOptions(frame, { inputSource: contentSource() })).frames[0] as Buffer,
	);
	if (coherent.type !== "content_begin") throw new Error("expected begin");
	assert.deepEqual(coherent.inputSource, contentSource(), "the same snapshot in both places is accepted");
	const mixed: ReadonlyArray<readonly [string, NativeIoSource]> = [
		["a different owner run", contentSource({ hostRunId: "run-2" })],
		["a different owner row", contentSource({ sessionId: "instance-2" })],
		["a different native session id", contentSource({ nativeSession: { sessionId: "native-session-2", epoch: 3 } })],
		["a different native epoch", contentSource({ nativeSession: { sessionId: "native-session-1", epoch: 4 } })],
		[
			"a different geometry revision at the same dimensions",
			contentSource({ geometry: { cols: 12, rows: 3, revision: 1 } }),
		],
		["different dimensions", contentSource({ geometry: { cols: 13, rows: 3, revision: 0 } })],
	];
	for (const [label, invalid] of mixed) {
		refused(
			"invalid_frame",
			() => buildSessionContentTransfer(transferOptions(frame, { inputSource: invalid })),
			`the publisher refuses ${label}`,
		);
		refused(
			"invalid_frame",
			() => encodeSessionContentFrame({ ...coherent, inputSource: invalid }),
			`encoding refuses ${label}`,
		);
		refused(
			"bad_frame",
			() => decodeSessionContentFrame(Buffer.from(JSON.stringify({ ...coherent, inputSource: invalid }))),
			`decoding refuses ${label}`,
		);
	}

	// A frame that reports no native session cannot be handed a live tuple.
	const noTuple = { ...coherent, nativeSession: null };
	refused("invalid_frame", () => encodeSessionContentFrame({ ...noTuple, inputSource: contentSource() }));
	refused(
		"bad_frame",
		() => decodeSessionContentFrame(Buffer.from(JSON.stringify({ ...noTuple, inputSource: contentSource() }))),
	);
	const nullSourceNoTuple = decodeSessionContentFrame(Buffer.from(JSON.stringify({ ...noTuple, inputSource: null })));
	if (nullSourceNoTuple.type !== "content_begin") throw new Error("expected begin");
	assert.equal(nullSourceNoTuple.inputSource, null, "an unavailable source claims no tuple");
});

function assembleContent(built: ReturnType<typeof buildSessionContentTransfer>): SessionContentSnapshot | undefined {
	const assembler = createSessionContentTransferAssembler();
	let snapshot: SessionContentSnapshot | undefined;
	for (const message of framesOf(built)) snapshot = assembler.accept(message) ?? snapshot;
	return snapshot;
}

test("inline native input completes exactly one packet per ordinal", () => {
	const assembler = createNativeInputAssembler();
	const packets: ReadonlyArray<readonly [NativeIoInputKind, string]> = [
		["keyboard", "\x1b[A"],
		["mouse", "\x1b[<0;13;4M"],
		["paste", "ls -la\r\u0000ctrl\u4e16"],
	];
	let ordinal = 0;
	for (const [kind, data] of packets) {
		ordinal += 1;
		const built = buildNativeInputInline({
			subscriptionId: "sub-1",
			inputId: `input-${ordinal}`,
			ordinal,
			source: nativeSource(),
			inputModes: INPUT_MODES,
			kind,
			data,
		});
		assert.equal(built.frames.length, 1);
		assert.equal(built.chunkCount, 1);
		assert.equal(built.byteLength, Buffer.byteLength(data, "utf8"));
		assert.ok(built.totalMessageBytes <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes);
		const decoded = decodeSessionContentFrame(built.frames[0] as Buffer);
		if (decoded.type !== "input") throw new Error("expected an inline input");
		assert.equal(decoded.kind, kind);
		assert.deepEqual(decoded.source, nativeSource());
		const completed = assembler.accept(decoded);
		assert.ok(completed);
		assert.equal(completed.kind, kind);
		assert.equal(completed.text, data, "the payload roundtrips byte for byte");
		assert.equal(completed.byteLength, Buffer.byteLength(data, "utf8"));
		assert.deepEqual(completed.source, nativeSource());
		assert.deepEqual(completed.inputModes, INPUT_MODES);
	}

	// A malformed packet is never repaired locally.
	refused("invalid_frame", () => buildNativeInputInline({
		subscriptionId: "sub-1",
		inputId: "input-9",
		ordinal: 9,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		kind: "mouse",
		data: "\x1b[<0;13M",
	}));
	refused("invalid_frame", () => buildNativeInputInline({
		subscriptionId: "sub-1",
		inputId: "input-9",
		ordinal: 9,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		kind: "keyboard",
		data: Buffer.from([0x61, 0xff]),
	}));
	// An inline frame is chunk-bounded; a larger paste must page instead.
	refused("transfer_too_large", () => buildNativeInputInline({
		subscriptionId: "sub-1",
		inputId: "input-9",
		ordinal: 9,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		kind: "paste",
		data: "y".repeat(DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes + 1),
	}));
});

test("an atomic native text paste crosses the chunk bound up to exactly 1 MiB", () => {
	assert.equal(NATIVE_TEXT_PASTE_MAX_BYTES, 1_048_576);
	assert.equal(DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes, 32 * 1024);
	assert.equal(DEFAULT_SESSION_CONTENT_BOUNDS.maxTransferBytes, 64 * 1024 * 1024);

	const text = `${"a".repeat(40_000)}\u4e16\u754c\u0000\x1b`;
	const built = buildNativeInputPaste(pasteOptions(text));
	assert.ok(built.chunkCount > 1, "a paste above the raw chunk bound is paged, never truncated");
	assert.equal(built.frames.length, built.chunkCount + 2);
	assert.equal(built.byteLength, Buffer.byteLength(text, "utf8"));
	assert.deepEqual(built.messageBytes, built.frames.map((message) => message.length));
	assert.ok(built.messageBytes.every((size) => size <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes));
	const decoded = decodedFrames(built);
	for (const frame of decoded) {
		if (frame.type !== "input_chunk") continue;
		assert.ok(Buffer.from(frame.data, "base64").length <= DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes);
	}
	const completed = assembleInput(decoded);
	assert.ok(completed);
	assert.equal(completed.text, text);
	assert.equal(completed.byteLength, Buffer.byteLength(text, "utf8"));

	// Exactly 1 MiB of decoded text is accepted whole.
	const exact = "b".repeat(NATIVE_TEXT_PASTE_MAX_BYTES);
	const whole = buildNativeInputPaste(pasteOptions(exact, { inputId: "input-2", ordinal: 2 }));
	assert.equal(whole.byteLength, NATIVE_TEXT_PASTE_MAX_BYTES);
	assert.equal(whole.chunkCount, NATIVE_TEXT_PASTE_MAX_BYTES / DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes);
	const wholeCompleted = assembleInput(decodedFrames(whole));
	assert.equal(wholeCompleted?.text.length, NATIVE_TEXT_PASTE_MAX_BYTES);
	assert.equal(wholeCompleted?.data.length, NATIVE_TEXT_PASTE_MAX_BYTES);

	// One byte over the cap is refused before any frame exists.
	refused(
		"transfer_too_large",
		() => buildNativeInputPaste(pasteOptions("c".repeat(NATIVE_TEXT_PASTE_MAX_BYTES + 1), {
			inputId: "input-3",
			ordinal: 3,
		})),
	);

	// A hand-declared paste above the cap never completes, and leaves nothing behind.
	const overCap = createNativeInputAssembler();
	refused("bad_frame", () => overCap.accept({
		type: "input_begin",
		subscriptionId: "sub-1",
		inputId: "input-3",
		ordinal: 3,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		kind: "paste",
		byteLength: NATIVE_TEXT_PASTE_MAX_BYTES + 1,
		chunkCount: 33,
	}));
	refused("transfer_failed", () => overCap.accept({
		type: "input_end",
		subscriptionId: "sub-1",
		inputId: "input-3",
		ordinal: 3,
	}));

	// The paste cap is a text bound, not a transport bound, and no image or
	// clipboard payload is expressible on either input shape.
	refused("bad_frame", () => decodeSessionContentFrame(Buffer.from(JSON.stringify({
		type: "input_begin",
		subscriptionId: "sub-1",
		inputId: "input-4",
		ordinal: 4,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		kind: "paste",
		byteLength: 4,
		chunkCount: 1,
		image: "png",
	}))));
	const inlineDecoded = decodeSessionContentFrame(buildNativeInputInline({
		subscriptionId: "sub-1",
		inputId: "input-5",
		ordinal: 5,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		kind: "paste",
		data: "text",
	}).frames[0] as Buffer);
	refused("bad_frame", () => decodeSessionContentFrame(Buffer.from(JSON.stringify({
		...inlineDecoded,
		clipboard: "image/png",
	}))));
});

test("native text preserves a leading BOM instead of silently rewriting it", () => {
	const inlineText = "\uFEFFx";
	const inline = buildNativeInputInline({
		subscriptionId: "sub-1",
		inputId: "input-1",
		ordinal: 1,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		kind: "paste",
		data: inlineText,
	});
	const inlineCompleted = assembleInput(decodedFrames(inline));
	assert.ok(inlineCompleted);
	assert.equal(inlineCompleted.text, inlineText, "a leading U+FEFF is text, not a byte-order mark to discard");
	assert.equal(inlineCompleted.byteLength, 4);
	assert.equal(Buffer.from(inlineCompleted.data).toString("hex"), "efbbbf78");

	const pagedText = `\uFEFF${"w".repeat(40_000)}`;
	const paged = buildNativeInputPaste(pasteOptions(pagedText, { inputId: "input-2", ordinal: 2 }));
	assert.equal(paged.byteLength, Buffer.byteLength(pagedText, "utf8"));
	const pagedCompleted = assembleInput(decodedFrames(paged));
	assert.ok(pagedCompleted);
	assert.equal(pagedCompleted.text, pagedText, "the leading BOM survives paging and assembly");
	assert.equal(Buffer.from(pagedCompleted.data).subarray(0, 3).toString("hex"), "efbbbf");

	// A BOM-prefixed encoded copy is not silently cleaned into canonical base64.
	const encoded = Buffer.from("bom").toString("base64");
	refused("invalid_frame", () => buildNativeCopyInline(copyInlineOptions(copyEvent(`\uFEFF${encoded}`))));
	const assembler = createNativeCopyAssembler();
	assert.equal(assembler.accept({
		type: "copy_begin",
		subscriptionId: "sub-1",
		copyId: "copy-1",
		sequence: 1,
		source: nativeSource(),
		dispatchId: 1,
		byteLength: 3 + encoded.length,
		chunkCount: 1,
	}), undefined);
	assert.equal(assembler.accept({
		type: "copy_chunk",
		subscriptionId: "sub-1",
		copyId: "copy-1",
		index: 0,
		data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encoded, "ascii")]).toString("base64"),
	}), undefined);
	refused("bad_frame", () => assembler.accept({
		type: "copy_end",
		subscriptionId: "sub-1",
		copyId: "copy-1",
		sequence: 1,
	}), "a BOM-prefixed copy payload is never canonical base64");
	refused("transfer_failed", () => assembler.accept({
		type: "copy_end",
		subscriptionId: "sub-1",
		copyId: "copy-1",
		sequence: 1,
	}), "the refused partial is discarded");
});

test("paged transfers shrink their chunks to fit a tight message bound", () => {
	// Valid bounds where a full 32 KiB chunk plus its JSON envelope cannot fit.
	const tight = resolveSessionContentBounds({ maxFrameBytes: 43_700 });
	assert.equal(tight.maxChunkPayloadBytes, DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes);

	const pasteText = `${"t".repeat(39_990)}\u4e16\u754c`;
	const paste = buildNativeInputPaste(pasteOptions(pasteText, { bounds: tight }));
	assert.ok(paste.chunkCount >= 2);
	assert.deepEqual(paste.messageBytes, paste.frames.map((message) => message.length));
	assert.ok(
		paste.messageBytes.every((size) => size <= tight.maxFrameBytes),
		"every paste message fits the tight bound",
	);
	const pasteCompleted = assembleInput(decodedFrames(paste, tight), tight);
	assert.equal(pasteCompleted?.text, pasteText);
	assert.equal(pasteCompleted?.byteLength, Buffer.byteLength(pasteText, "utf8"));

	const encoded = Buffer.from("u".repeat(75_000), "utf8").toString("base64");
	const copy = buildNativeCopyPaged(copyOptions({ encoded, bounds: tight }));
	assert.equal(copy.byteLength, encoded.length);
	assert.ok(copy.chunkCount >= 4);
	assert.deepEqual(copy.messageBytes, copy.frames.map((message) => message.length));
	assert.ok(
		copy.messageBytes.every((size) => size <= tight.maxFrameBytes),
		"every copy message fits the tight bound",
	);
	const copyCompleted = assembleCopy(decodedFrames(copy, tight), tight);
	assert.ok(copyCompleted);
	assert.equal(copyCompleted.event.kind, "copy");
	if (copyCompleted.event.kind !== "copy") throw new Error("expected a copy event");
	assert.equal(copyCompleted.event.encoded, encoded, "the tight bound never truncates the payload");

	// The shrink is local to the tight bound: default bounds still use full raw chunks.
	const full = buildNativeInputPaste(pasteOptions("v".repeat(40_000), { inputId: "input-2", ordinal: 2 }));
	assert.equal(full.chunkCount, 2);
	const firstChunk = decodedFrames(full)[1];
	if (firstChunk?.type !== "input_chunk") throw new Error("expected a chunk");
	assert.equal(Buffer.from(firstChunk.data, "base64").length, DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes);
});

test("fragmented or replayed native input never yields a completed packet", () => {
	const built = buildNativeInputPaste(pasteOptions("d".repeat(70_000)));
	const frames = decodedFrames(built);
	const begin = frames[0] as SessionContentFrame;
	const chunks = frames.slice(1, -1);
	const end = frames[frames.length - 1] as SessionContentFrame;
	assert.ok(chunks.length >= 3);

	const feed = (
		sequence: readonly SessionContentFrame[],
	): { readonly completed: NativeIoCompletedInput[]; readonly code?: SessionContentFailureCode } => {
		const assembler = createNativeInputAssembler();
		const completed: NativeIoCompletedInput[] = [];
		try {
			for (const frame of sequence) {
				const result = assembler.accept(frame);
				if (result !== undefined) completed.push(result);
			}
			return { completed };
		} catch (error) {
			if (!isSessionContentProtocolError(error)) throw error;
			return { completed, code: error.code };
		}
	};

	const cases: ReadonlyArray<readonly [string, readonly SessionContentFrame[]]> = [
		["missing part", [begin, ...chunks.slice(1), end]],
		["duplicated part", [begin, chunks[0] as SessionContentFrame, chunks[0] as SessionContentFrame, ...chunks.slice(1), end]],
		["reordered part", [begin, chunks[1] as SessionContentFrame, chunks[0] as SessionContentFrame, ...chunks.slice(2), end]],
		["premature end", [begin, chunks[0] as SessionContentFrame, end]],
		["foreign input id", [begin, { ...(chunks[0] as object), inputId: "other-input" } as unknown as SessionContentFrame]],
		["second begin", [begin, { ...(begin as object), inputId: "other-input" } as unknown as SessionContentFrame]],
		["chunk without begin", [chunks[0] as SessionContentFrame]],
		["end without begin", [end]],
	];
	for (const [label, sequence] of cases) {
		const outcome = feed(sequence);
		assert.equal(outcome.code, "transfer_failed", label);
		assert.deepEqual(outcome.completed, [], `${label} never completes an input`);
	}

	// Parts that assemble to non-UTF-8 bytes refuse at the end, after being accepted.
	const invalidUtf8 = createNativeInputAssembler();
	assert.equal(invalidUtf8.accept({
		type: "input_begin",
		subscriptionId: "sub-1",
		inputId: "input-8",
		ordinal: 8,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		kind: "paste",
		byteLength: 2,
		chunkCount: 1,
	}), undefined);
	assert.equal(invalidUtf8.accept({
		type: "input_chunk",
		subscriptionId: "sub-1",
		inputId: "input-8",
		index: 0,
		data: Buffer.from([0x61, 0xff]).toString("base64"),
	}), undefined);
	refused("bad_frame", () => invalidUtf8.accept({
		type: "input_end",
		subscriptionId: "sub-1",
		inputId: "input-8",
		ordinal: 8,
	}));
	refused("transfer_failed", () => invalidUtf8.accept({
		type: "input_end",
		subscriptionId: "sub-1",
		inputId: "input-8",
		ordinal: 8,
	}), "the refused partial is discarded");

	// A completed ordinal never completes twice, and its parts are not replayable.
	const replay = createNativeInputAssembler();
	assert.equal(replay.accept(begin), undefined);
	for (const chunk of chunks) replay.accept(chunk);
	assert.ok(replay.accept(end));
	for (const frame of [begin, ...chunks, end]) {
		refused("transfer_failed", () => replay.accept(frame), "a replayed input never completes");
	}
});

test("a full native text copy crosses bounded pages and completes atomically", () => {
	const text = "z".repeat(75_000);
	const encoded = Buffer.from(text, "utf8").toString("base64");
	assert.equal(encoded.length, NATIVE_COPY_MAX_ENCODED_CHARS);
	assert.equal(NATIVE_COPY_MAX_ENCODED_CHARS, 100_000);

	const built = buildNativeCopyPaged(copyOptions({ encoded }));
	assert.ok(built.chunkCount > 1, "a producer-bound copy is paged, never reduced to a message size");
	assert.equal(built.frames.length, built.chunkCount + 2);
	assert.equal(built.byteLength, encoded.length);
	assert.deepEqual(built.messageBytes, built.frames.map((message) => message.length));
	assert.ok(built.messageBytes.every((size) => size <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes));

	const frames = decodedFrames(built);
	const begin = frames[0];
	if (begin?.type !== "copy_begin") throw new Error("expected copy begin");
	assert.equal(begin.byteLength, encoded.length);
	assert.equal(begin.chunkCount, built.chunkCount);
	assert.equal(Object.hasOwn(begin, "event"), false, "the header never carries the clipboard payload");
	const completed = assembleCopy(frames);
	assert.ok(completed);
	assert.equal(completed.event.kind, "copy");
	if (completed.event.kind !== "copy") throw new Error("expected a copy event");
	assert.equal(completed.event.encoded, encoded, "the entire 100,000-character payload survives");
	assert.equal(completed.event.sessionId, nativeSource().nativeSession.sessionId, "the event tuple follows the header source");
	assert.equal(completed.event.sessionEpoch, nativeSource().nativeSession.epoch);
	assert.equal(completed.sequence, 1);
	assert.deepEqual(completed.source, nativeSource());

	// Above the unchanged producer bound, malformed, and non-text payloads refuse.
	refused(
		"transfer_too_large",
		() => buildNativeCopyPaged(copyOptions({ encoded: Buffer.from("y".repeat(75_003)).toString("base64") })),
	);
	refused(
		"invalid_frame",
		() => buildNativeCopyPaged(copyOptions({ encoded: `${encoded.slice(0, -1)}!` })),
	);
	refused(
		"invalid_frame",
		() => buildNativeCopyPaged(copyOptions({ encoded: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64") })),
	);
	// A small copy still fits one inline message.
	const inline = buildNativeCopyInline(copyInlineOptions(
		copyEvent(Buffer.from("small").toString("base64")),
		{ sequence: 2, dispatchId: 2 },
	));
	assert.equal(inline.frames.length, 1);
	const inlineCompleted = assembleCopy(decodedFrames(inline));
	assert.equal(inlineCompleted?.event.kind, "copy");
});

test("copy emission order is the copy sequence, never the native input dispatch order", () => {
	const assembler = createNativeCopyAssembler();
	const first = buildNativeCopyInline(copyInlineOptions(
		copyEvent(Buffer.from("first").toString("base64")),
		{ sequence: 1, dispatchId: 2 },
	));
	const second = buildNativeCopyInline(copyInlineOptions(
		copyEvent(Buffer.from("second").toString("base64")),
		{ sequence: 2, dispatchId: 1 },
	));
	const one = assembler.accept(decodeSessionContentFrame(first.frames[0] as Buffer));
	const two = assembler.accept(decodeSessionContentFrame(second.frames[0] as Buffer));
	assert.equal(one?.sequence, 1);
	assert.equal(one?.dispatchId, 2, "the copy caused by an earlier dispatch may arrive first");
	assert.equal(two?.sequence, 2);
	assert.equal(two?.dispatchId, 1, "an asynchronous copy from input A may follow input B");
	assert.notEqual(one, undefined);
	assert.notEqual(two, undefined);

	// Emission order is still fenced: a completed sequence never publishes twice.
	refused("transfer_failed", () => assembler.accept(decodeSessionContentFrame(first.frames[0] as Buffer)));
	refused("transfer_failed", () => assembler.accept(decodeSessionContentFrame(second.frames[0] as Buffer)));
	const stalePaged = buildNativeCopyPaged(copyOptions({
		sequence: 2,
		dispatchId: 9,
		encoded: Buffer.from("q".repeat(40_000)).toString("base64"),
	}));
	const staleAssembler = createNativeCopyAssembler();
	assert.ok(staleAssembler.accept(decodeSessionContentFrame(second.frames[0] as Buffer)));
	refused(
		"transfer_failed",
		() => staleAssembler.accept(decodeSessionContentFrame(stalePaged.frames[0] as Buffer)),
		"a replayed emission sequence is refused before any page is buffered",
	);

	// An unavailable copy is inline, fixed-reason only, and never carries payload.
	const unavailable = buildNativeCopyInline(copyInlineOptions(
		unavailableEvent("unsupported-runtime"),
		{ sequence: 3, dispatchId: 4 },
	));
	const three = assembler.accept(decodeSessionContentFrame(unavailable.frames[0] as Buffer));
	assert.deepEqual(three?.event, unavailableEvent("unsupported-runtime"));
	assert.equal(three?.dispatchId, 4);
	refused("invalid_frame", () => buildNativeCopyInline(copyInlineOptions(
		unavailableEvent("unsupported" as unknown as NativeIoCopyUnavailableReason),
		{ sequence: 4 },
	)));
	refused("invalid_frame", () => buildNativeCopyInline(copyInlineOptions(
		{ ...copyEvent(Buffer.from("x").toString("base64")), image: "png" } as unknown as NativeIoCopyEvent,
		{ sequence: 4 },
	)));
	refused("invalid_frame", () => buildNativeCopyInline(copyInlineOptions(
		copyEvent("\x1b]52;c;ZA==\x07"),
		{ sequence: 4 },
	)));
});

test("a copy names one authenticated native tuple in both its source and its event", () => {
	const encoded = Buffer.from("copied text").toString("base64");
	// The coherent pair roundtrips on the wire and completes.
	const built = buildNativeCopyInline(copyInlineOptions(copyEvent(encoded)));
	const decoded = decodeSessionContentFrame(built.frames[0] as Buffer);
	if (decoded.type !== "copy") throw new Error("expected copy");
	assert.equal(decoded.event.sessionId, nativeSource().nativeSession.sessionId);
	assert.equal(decoded.event.sessionEpoch, nativeSource().nativeSession.epoch);
	const completed = createNativeCopyAssembler().accept(decoded);
	assert.deepEqual(completed?.event, copyEvent(encoded));

	// A mixed pair is refused on the encode side, the decode side, and in assembly.
	const mixedEvents: ReadonlyArray<readonly [string, NativeIoCopyEvent]> = [
		["a different native session id", copyEvent(encoded, { sessionId: "native-session-2" })],
		["a different native epoch", copyEvent(encoded, { sessionEpoch: 4 })],
		["an unavailable event for another conversation", unavailableEvent("unsupported-runtime", { sessionEpoch: 9 })],
	];
	for (const [label, event] of mixedEvents) {
		refused(
			"invalid_frame",
			() => buildNativeCopyInline(copyInlineOptions(event)),
			`the publisher refuses ${label}`,
		);
		refused(
			"invalid_frame",
			() => encodeSessionContentFrame({ ...decoded, event }),
			`encoding refuses ${label}`,
		);
		refused(
			"bad_frame",
			() => decodeSessionContentFrame(Buffer.from(JSON.stringify({ ...decoded, event }))),
			`decoding refuses ${label}`,
		);
		const assembler = createNativeCopyAssembler();
		refused("bad_frame", () => assembler.accept({ ...decoded, event }), `assembly refuses ${label}`);
		// A refused mixed event never commits the sequence it named.
		assert.equal(assembler.accept(decodeSessionContentFrame(built.frames[0] as Buffer))?.sequence, 1);
	}

	// A paged copy inherits the header source's tuple; nothing else can supply it,
	// so the completed event and the preserved header source always agree.
	const headerSource = nativeSource({ nativeSession: { sessionId: "native-session-9", epoch: 5 } });
	const paged = buildNativeCopyPaged(copyOptions({
		source: headerSource,
		encoded: Buffer.from("p".repeat(40_000)).toString("base64"),
	}));
	const pagedCompleted = assembleCopy(decodedFrames(paged));
	assert.equal(pagedCompleted?.event.kind, "copy");
	assert.equal(pagedCompleted?.event.sessionId, "native-session-9");
	assert.equal(pagedCompleted?.event.sessionEpoch, 5);
	assert.equal(pagedCompleted?.source.nativeSession.sessionId, "native-session-9", "the header source is preserved");
	assert.equal(pagedCompleted?.source.nativeSession.epoch, 5);
});

test("a paged copy publishes nothing unless every part is contiguous and exact", () => {
	const encoded = Buffer.from("q".repeat(50_000), "utf8").toString("base64");
	const built = buildNativeCopyPaged(copyOptions({ encoded }));
	const frames = decodedFrames(built);
	assert.ok(frames.length >= 4, "the fixture spans at least three pages");
	const begin = frames[0] as SessionContentFrame;
	const chunks = frames.slice(1, -1);
	const end = frames[frames.length - 1] as SessionContentFrame;

	const feed = (
		sequence: readonly SessionContentFrame[],
	): { readonly completed: NativeIoCompletedCopy[]; readonly code?: SessionContentFailureCode } => {
		const assembler = createNativeCopyAssembler();
		const completed: NativeIoCompletedCopy[] = [];
		try {
			for (const frame of sequence) {
				const result = assembler.accept(frame);
				if (result !== undefined) completed.push(result);
			}
			return { completed };
		} catch (error) {
			if (!isSessionContentProtocolError(error)) throw error;
			return { completed, code: error.code };
		}
	};

	const cases: ReadonlyArray<readonly [string, readonly SessionContentFrame[]]> = [
		["missing part", [begin, ...chunks.slice(1), end]],
		["duplicated part", [begin, chunks[0] as SessionContentFrame, chunks[0] as SessionContentFrame, ...chunks.slice(1), end]],
		["reordered part", [begin, chunks[1] as SessionContentFrame, chunks[0] as SessionContentFrame, ...chunks.slice(2), end]],
		["premature end", [begin, chunks[0] as SessionContentFrame, end]],
		["foreign copy id", [begin, { ...(chunks[0] as object), copyId: "other-copy" } as unknown as SessionContentFrame]],
		["mismatched end sequence", [begin, ...chunks, { ...(end as object), sequence: 7 } as unknown as SessionContentFrame]],
		["page without begin", [chunks[0] as SessionContentFrame]],
	];
	for (const [label, sequence] of cases) {
		const outcome = feed(sequence);
		assert.equal(outcome.code, "transfer_failed", label);
		assert.deepEqual(outcome.completed, [], `${label} never completes a copy`);
	}
	assert.deepEqual(assembleCopy(frames)?.event, copyEvent(encoded));
});

test("native IO frames leave the bounded viewport transfer and its bounds unchanged", () => {
	assert.equal(DEFAULT_SESSION_CONTENT_BOUNDS.maxTransferBytes, 64 * 1024 * 1024);
	assert.equal(DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes, 65_536);
	assert.equal(DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes, 32 * 1024);

	const snapshot = assembleContent(buildSessionContentTransfer(transferOptions(sampleFrame())));
	assert.ok(snapshot);
	assert.ok((snapshot.frame.graphics?.images.length ?? 0) > 0, "typed PNG viewport content still roundtrips");
	assert.deepEqual(snapshot.frame.graphics?.images, sampleFrame().graphics?.images);

	// A native IO frame is recognized, still closed, and never a legacy shape.
	const input = decodedFrames(buildNativeInputInline({
		subscriptionId: "sub-1",
		inputId: "input-1",
		ordinal: 1,
		source: nativeSource(),
		inputModes: INPUT_MODES,
		kind: "keyboard",
		data: "a",
	}))[0];
	assert.equal(input?.type, "input");
	assert.equal(input !== undefined && "subscriptionId" in input, true);
});
