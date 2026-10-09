import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Writable } from "node:stream";
import {
	createSessionHostFrameWriter,
	type SessionHostFrameWriter,
	type SessionHostFrameWriterOptions,
} from "../src/session-host/frame-writer";
import type { ComposedHostFrame } from "../src/session-host/compositor";
import { TerminalSurface } from "../src/session-host/terminal-surface";

const ESC = "\x1b";

/**
 * Output sink that mimics a real Writable under backpressure: a refused
 * write is queued and delivered (in order) when `drain()` flushes it.
 */
class QueuedWritable extends EventEmitter {
	readonly writes: Buffer[] = [];
	private readonly queued: Array<{ buf: Buffer; callback?: (error?: Error | null) => void }> = [];
	writeResults: boolean[] = [];

	get queuedCount(): number {
		return this.queued.length;
	}

	write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean {
		const buf = Buffer.from(chunk);
		if (this.writeResults.shift() ?? true) {
			this.writes.push(buf);
			callback?.();
			return true;
		}
		this.queued.push({ buf, callback });
		return false;
	}

	drain(): void {
		for (const item of this.queued.splice(0)) {
			this.writes.push(item.buf);
			item.callback?.();
		}
		this.emit("drain");
	}

	end(): this {
		return this;
	}

	destroy(): this {
		return this;
	}
}

function frame(lines: string[], cursor = { column: 0, row: 0, visible: false }): ComposedHostFrame {
	return { lines, cursor };
}

function outputText(output: QueuedWritable, index: number): string {
	return output.writes[index]?.toString("utf8") ?? "";
}

/** Assert every generated CUP in `bytes` targets a cell inside the geometry. */
function assertCupWithinGeometry(bytes: string, cols: number, rows: number, label: string): void {
	const pattern = /\x1b\[(\d+);(\d+)H/g;
	let match: RegExpExecArray | null;
	let found = 0;
	while ((match = pattern.exec(bytes)) !== null) {
		const row = Number(match[1]);
		const column = Number(match[2]);
		assert.ok(row >= 1 && row <= rows, `${label}: CUP row ${row} is outside 1..${rows}`);
		assert.ok(column >= 1 && column <= cols, `${label}: CUP column ${column} is outside 1..${cols}`);
		found += 1;
	}
	assert.ok(found >= 1, `${label}: expected at least one generated CUP`);
}

/** Full-frame bytes for a frame from a fresh writer (no baseline yet). */
function fullFrameBytes(frameValue: ComposedHostFrame, cols: number, rows: number): Buffer {
	const output = new QueuedWritable();
	const driver = createSessionHostFrameWriter(output as unknown as Writable, { redrawIntervalMs: 0 });
	driver.start();
	driver.submit(frameValue, cols, rows);
	assert.equal(output.writes.length, 2, "a fresh reference writer emits start plus one full frame");
	return output.writes[1];
}

/**
 * Drives one diff-emitting writer into a real TerminalSurface while a second
 * TerminalSurface receives the full-frame reference for every frame that
 * actually reached the sink. The two surfaces must end in identical state.
 */
class Replay {
	readonly output = new QueuedWritable();
	readonly writer: SessionHostFrameWriter;
	readonly diffSurface: TerminalSurface;
	readonly refSurface: TerminalSurface;
	private cols: number;
	private rows: number;
	private replayed = 0;
	private queuedFrames: Array<{ frameValue: ComposedHostFrame; cols: number; rows: number }> = [];
	private lastSubmitted: { frameValue: ComposedHostFrame; cols: number; rows: number } | undefined;

	constructor(cols: number, rows: number, options: SessionHostFrameWriterOptions = {}) {
		this.cols = cols;
		this.rows = rows;
		this.writer = createSessionHostFrameWriter(this.output as unknown as Writable, {
			redrawIntervalMs: 0,
			...options,
		});
		this.diffSurface = new TerminalSurface(cols, rows);
		this.refSurface = new TerminalSurface(cols, rows);
	}

	start(): void {
		this.writer.start();
		const startBytes = outputText(this.output, 0);
		this.diffSurface.write(startBytes);
		this.refSurface.write(startBytes);
		this.replayed = 1;
	}

	submit(frameValue: ComposedHostFrame, cols: number, rows: number): void {
		if (cols !== this.cols || rows !== this.rows) {
			this.diffSurface.resize(cols, rows);
			this.refSurface.resize(cols, rows);
			this.cols = cols;
			this.rows = rows;
		}
		const writesBefore = this.output.writes.length;
		const queuedBefore = this.output.queuedCount;
		this.writer.submit(frameValue, cols, rows);
		this.lastSubmitted = { frameValue, cols, rows };
		if (this.output.writes.length > writesBefore) {
			this.replayNewWrites();
			this.refSurface.write(fullFrameBytes(frameValue, cols, rows).toString("utf8"));
		} else if (this.output.queuedCount > queuedBefore) {
			// Pumped but refused: the sink queued it until drain.
			this.queuedFrames.push({ frameValue, cols, rows });
		}
	}

	drain(): void {
		const writesBefore = this.output.writes.length;
		this.output.drain();
		const queuedDelivered = this.queuedFrames.length;
		for (const item of this.queuedFrames.splice(0)) {
			this.refSurface.write(fullFrameBytes(item.frameValue, item.cols, item.rows).toString("utf8"));
		}
		if (this.output.writes.length - writesBefore > queuedDelivered) {
			assert.ok(this.lastSubmitted, "a pumped frame must have a submitted candidate");
			this.refSurface.write(
				fullFrameBytes(this.lastSubmitted.frameValue, this.lastSubmitted.cols, this.lastSubmitted.rows)
					.toString("utf8"),
			);
		} else if (this.output.queuedCount > 0) {
			assert.ok(this.lastSubmitted, "a refused pump must have a submitted candidate");
			this.queuedFrames.push(this.lastSubmitted);
		}
		this.replayNewWrites();
	}

	async compare(label: string): Promise<void> {
		await this.diffSurface.flush();
		await this.refSurface.flush();
		assert.deepEqual(this.diffSurface.frame(), this.refSurface.frame(), label);
	}

	dispose(): void {
		this.diffSurface.dispose();
		this.refSurface.dispose();
	}

	private replayNewWrites(): void {
		for (let i = this.replayed; i < this.output.writes.length; i += 1) {
			this.diffSurface.write(this.output.writes[i].toString("utf8"));
		}
		this.replayed = this.output.writes.length;
	}
}

test("row-diff output replays into a real TerminalSurface equal to the full-frame reference", async () => {
	const replay = new Replay(20, 3);
	try {
		replay.start();
		replay.submit(frame(["alpha", "beta", "gamma"]), 20, 3);
		await replay.compare("initial frame is a full redraw");

		const writesBeforeUpdate = replay.output.writes.length;
		replay.submit(frame(["alpha", "BETA", "gamma"], { column: 2, row: 1, visible: true }), 20, 3);
		assert.equal(replay.output.writes.length, writesBeforeUpdate + 1, "the update emits one payload");
		const updateWrite = replay.output.writes[replay.output.writes.length - 1];
		const updateBytes = updateWrite.byteLength;
		const updateFull = fullFrameBytes(frame(["alpha", "BETA", "gamma"], { column: 2, row: 1, visible: true }), 20, 3);
		assert.ok(
			updateBytes < updateFull.byteLength,
			"only the changed row plus cursor suffix is emitted",
		);
		assert.ok(updateBytes <= updateFull.byteLength, "a diff never exceeds the validated complete frame");
		assert.ok(updateWrite.toString("utf8").startsWith(`${ESC}[?25l`), "a changed-row diff masks the cursor before drawing");
		assertCupWithinGeometry(updateWrite.toString("utf8"), 20, 3, "changed-row diff");
		await replay.compare("changed row plus cursor update matches the full-frame reference");

		const writesBeforeIdentical = replay.output.writes.length;
		replay.submit(frame(["alpha", "BETA", "gamma"], { column: 2, row: 1, visible: true }), 20, 3);
		assert.equal(replay.output.writes.length, writesBeforeIdentical, "an identical frame skips output entirely");
		await replay.compare("skipped identical frame leaves the surface unchanged");

		const writesBeforeCursor = replay.output.writes.length;
		replay.submit(frame(["alpha", "BETA", "gamma"], { column: 5, row: 0, visible: true }), 20, 3);
		assert.equal(replay.output.writes.length, writesBeforeCursor + 1, "a cursor-only change emits one payload");
		const cursorBytes = replay.output.writes[replay.output.writes.length - 1].toString("utf8");
		assert.ok(cursorBytes.startsWith(`${ESC}[?25l`), "a cursor-only diff masks the cursor before drawing");
		assert.ok(cursorBytes.includes(`${ESC}[?25h${ESC}[1;6H`), "the cursor-only payload is the cursor sequence");
		assert.equal(cursorBytes.includes(`${ESC}[2K`), false, "a cursor-only change rewrites no rows");
		await replay.compare("cursor-only update matches the full-frame reference");

		const writesBeforeHide = replay.output.writes.length;
		replay.submit(frame(["alpha", "BETA", "gamma"], { column: 0, row: 0, visible: false }), 20, 3);
		assert.equal(replay.output.writes.length, writesBeforeHide + 1, "hiding a visible cursor emits one payload");
		const hideBytes = replay.output.writes[replay.output.writes.length - 1].toString("utf8");
		assert.ok(hideBytes.startsWith(`${ESC}[?25l`), "hiding an already-hidden cursor still masks first");
		assert.ok(hideBytes.includes(`${ESC}[3;6H`), "the resting position is restored before hiding the cursor");
		await replay.compare("visible-to-hidden cursor-only transition matches the full-frame reference");

		const writesBeforeInvalid = replay.output.writes.length;
		replay.submit(frame(["alpha", "BETA", "gamma"], { column: 99, row: 0, visible: true }), 20, 3);
		assert.equal(replay.output.writes.length, writesBeforeInvalid, "an invalid cursor normalizes to hidden without new output");
		await replay.compare("invalid cursor normalized to hidden matches the full-frame reference");
	} finally {
		replay.dispose();
	}
});

test("last-row updates and full-width rows replay equal to the full-frame reference", async () => {
	const replay = new Replay(6, 2);
	try {
		replay.start();
		replay.submit(frame(["abc", "abcdef"]), 6, 2);
		await replay.compare("full-width last row initial frame matches the reference");

		replay.submit(frame(["abc", "XYZxyz"]), 6, 2);
		const lastRowBytes = replay.output.writes[replay.output.writes.length - 1].toString("utf8");
		assert.ok(lastRowBytes.includes(`${ESC}[2;1H`), "the changed last row is rewritten");
		assert.equal(lastRowBytes.includes(`${ESC}[3;`), false, "no redundant resting-position CUP after a rewritten last row");
		await replay.compare("last-row-only update matches the full-frame reference");

		replay.submit(frame(["ABC", "XYZxyz"]), 6, 2);
		const firstRowBytes = replay.output.writes[replay.output.writes.length - 1].toString("utf8");
		assert.ok(firstRowBytes.includes(`${ESC}[2;6H`), "the resting cursor clamps to the final column of a full-width last row");
		assert.equal(firstRowBytes.includes(`${ESC}[2;7H`), false, "no CUP beyond the frame width is generated");
		assertCupWithinGeometry(firstRowBytes, 6, 2, "first-row update");
		await replay.compare("first-row update with restored resting cursor matches the reference");

		// The same clamping applies to a cursor-only diff whose last row is
		// full-width.
		replay.submit(frame(["ABC", "XYZxyz"], { column: 0, row: 0, visible: true }), 6, 2);
		const cursorOnlyBytes = replay.output.writes[replay.output.writes.length - 1].toString("utf8");
		assert.ok(cursorOnlyBytes.includes(`${ESC}[2;6H`), "a cursor-only resting CUP is clamped too");
		assert.equal(cursorOnlyBytes.includes(`${ESC}[2;7H`), false);
		assertCupWithinGeometry(cursorOnlyBytes, 6, 2, "cursor-only full-width update");
		await replay.compare("cursor-only update with a full-width last row matches the reference");
	} finally {
		replay.dispose();
	}
});

test("styles, unicode, and control injection replay equal to the full-frame reference", async () => {
	const styled = (row: string): string[] => [
		row,
		"A界Z🙂e\u0301",
		`osc${ESC}]2;secret\x07tail${ESC}[?25hX\x01Y\u009b31m`,
	];
	const replay = new Replay(12, 3);
	try {
		replay.start();
		replay.submit(frame(styled(`${ESC}[1;38;2;12;34;56mHi${ESC}[0m`)), 12, 3);
		await replay.compare("styled/unicode/injected initial frame matches the reference");

		replay.submit(frame(styled(`${ESC}[4mBye${ESC}[0m`)), 12, 3);
		await replay.compare("a styled row update matches the full-frame reference");

		const rendered = replay.diffSurface.frame();
		assert.equal(rendered.lines[2].includes("secret"), false, "OSC payload never reaches the surface");
	} finally {
		replay.dispose();
	}
});

test("geometry changes force a full redraw that replays equal to the reference", async () => {
	const replay = new Replay(10, 2);
	try {
		replay.start();
		replay.submit(frame(["one", "two"]), 10, 2);
		await replay.compare("initial frame matches the reference");

		replay.submit(frame(["wider", "frame", "third"]), 16, 3);
		assert.deepEqual(
			replay.output.writes[replay.output.writes.length - 1],
			fullFrameBytes(frame(["wider", "frame", "third"]), 16, 3),
			"the geometry change emits a complete frame",
		);
		await replay.compare("grown geometry matches the full-frame reference");

		replay.submit(frame(["small", "again"]), 8, 2);
		await replay.compare("shrunk geometry matches the full-frame reference");
	} finally {
		replay.dispose();
	}
});

test("every nonempty diff masks the cursor, keeps CUP inside geometry, and stays within the complete frame", async () => {
	const cases: Array<{ name: string; lines: string[]; changed: string[]; cols: number; rows: number }> = [
		{
			name: "changed row",
			lines: ["alpha", "beta", "gamma"],
			changed: ["alpha!", "beta", "gamma"],
			cols: 20,
			rows: 3,
		},
		{
			name: "full-width last row",
			lines: ["abc", "abcdef"],
			changed: ["ABC", "abcdef"],
			cols: 6,
			rows: 2,
		},
		{
			name: "styles and control injection",
			lines: [`${ESC}[1;38;2;1;2;3mHi${ESC}[0m`, `osc${ESC}]2;secret\x07tail`, `${ESC}[?25hX\x01Y\u009b31m`],
			changed: [`${ESC}[4mBye${ESC}[0m`, `osc${ESC}]2;secret\x07tail`, `${ESC}[?25hX\x01Y\u009b31m`],
			cols: 12,
			rows: 3,
		},
		{
			name: "wide grapheme",
			lines: ["A界Z"],
			changed: ["B界Z"],
			cols: 5,
			rows: 1,
		},
	];
	for (const item of cases) {
		const output = new QueuedWritable();
		const driver = createSessionHostFrameWriter(output as unknown as Writable, { redrawIntervalMs: 0 });
		driver.start();
		const baseFrame = frame(item.lines);
		driver.submit(baseFrame, item.cols, item.rows);
		const full = output.writes[output.writes.length - 1];
		assert.deepEqual(full, fullFrameBytes(baseFrame, item.cols, item.rows), `${item.name}: the first frame is complete`);
		assertCupWithinGeometry(full.toString("utf8"), item.cols, item.rows, `${item.name}: full frame`);

		const writesBefore = output.writes.length;
		const changedFrame = frame(item.changed, { column: 0, row: 0, visible: true });
		driver.submit(changedFrame, item.cols, item.rows);
		assert.equal(output.writes.length, writesBefore + 1, `${item.name}: the change emits exactly one diff`);
		const diff = output.writes[output.writes.length - 1];
		const changedFull = fullFrameBytes(changedFrame, item.cols, item.rows);
		assert.ok(
			diff.byteLength <= changedFull.byteLength,
			`${item.name}: diff ${diff.byteLength} bytes exceeds the complete frame ${changedFull.byteLength}`,
		);
		const diffText = diff.toString("utf8");
		assert.ok(diffText.startsWith(`${ESC}[?25l`), `${item.name}: the diff masks the cursor before drawing`);
		assertCupWithinGeometry(diffText, item.cols, item.rows, `${item.name}: diff`);

		const noopBefore = output.writes.length;
		driver.submit(changedFrame, item.cols, item.rows);
		assert.equal(output.writes.length, noopBefore, `${item.name}: an unchanged frame emits nothing`);
		assert.equal(await driver.close(), true);
	}
});

test("a diff does not trip a complete-frame byte cap the full frame exactly fits", async () => {
	const cursor = { column: 0, row: 0, visible: true } as const;
	const changedFrame = frame(["AB", "cd"], cursor);
	const full = fullFrameBytes(changedFrame, 4, 2);
	const output = new QueuedWritable();
	const driver = createSessionHostFrameWriter(output as unknown as Writable, {
		redrawIntervalMs: 0,
		maxFrameBytes: full.byteLength,
	});
	driver.start();
	driver.submit(frame(["ab", "cd"], cursor), 4, 2);
	assert.equal(output.writes[1].byteLength, full.byteLength, "the complete frame fits the cap exactly");
	driver.submit(changedFrame, 4, 2);
	const diff = output.writes[2];
	assert.ok(diff.byteLength <= full.byteLength, "the hidden-prefix diff stays within the validated frame size");
	assert.ok(diff.toString("utf8").startsWith(`${ESC}[?25l`));
	assert.equal(await driver.close(), true);
});

test("backpressure coalesces to the newest frame and the baseline follows queued writes", async () => {
	const replay = new Replay(20, 3);
	try {
		replay.start();
		replay.submit(frame(["a", "b", "c"]), 20, 3);
		await replay.compare("initial frame matches the reference");

		replay.output.writeResults.push(false, false);
		replay.submit(frame(["A", "B", "C"]), 20, 3);
		assert.equal(replay.output.queuedCount, 1, "the refused write is queued by the sink");
		replay.submit(frame(["A", "x", "C"]), 20, 3);
		await replay.compare("a blocked sink retains only the newest pending frame");

		replay.drain();
		await replay.compare("drain delivers the queued frame and the coalesced newest diff");

		replay.drain();
		const lastBytes = replay.output.writes[replay.output.writes.length - 1].toString("utf8");
		assert.ok(lastBytes.includes("x"), "the second drain delivers the newest frame");
		await replay.compare("all queued frames settle equal to the full-frame reference");
	} finally {
		replay.dispose();
	}
});

test("the complete-frame byte cap stays synchronous even for a small delta", () => {
	const output = new QueuedWritable();
	const driver = createSessionHostFrameWriter(output as unknown as Writable, {
		redrawIntervalMs: 0,
		maxFrameBytes: 32,
	});
	driver.start();
	driver.submit(frame(["ab"]), 4, 1);
	assert.equal(output.writes.length, 2, "a frame that fits exactly at the cap is accepted");
	const before = output.writes.length;
	assert.throws(() => driver.submit(frame(["abc"]), 4, 1), /UTF-8 byte limit/,
		"one extra character exceeds the complete-frame bound even though the delta is tiny");
	assert.equal(output.writes.length, before, "the oversized candidate writes nothing");
	driver.submit(frame(["b"]), 4, 1);
	assert.equal(output.writes.length, before + 1, "the writer remains usable after a rejected candidate");
});

test("oversized multirow frames reject early without replacing a pending candidate", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const output = new QueuedWritable();
	const driver = createSessionHostFrameWriter(output as unknown as Writable, { maxFrameBytes: 67 });
	driver.start();
	driver.submit(frame(["", "", ""]), 4, 3);
	assert.equal(output.writes.length, 2, "the envelope-only frame fits under the cap");
	t.mock.timers.tick(5);
	driver.submit(frame(["", "", "x"]), 4, 3);
	const before = output.writes.length;
	const sgrRow = `${ESC}[1m`.repeat(10); // 40 bytes of allowlisted styling, zero columns
	assert.throws(() => driver.submit(frame([sgrRow, "", ""]), 4, 3), /UTF-8 byte limit/,
		"the running complete-frame budget rejects before retaining further rows");
	assert.equal(output.writes.length, before, "the oversized candidate writes nothing and replaces no pending frame");
	t.mock.timers.tick(17);
	assert.ok(outputText(output, 2).includes("x"), "the earlier pending candidate is still the one written");
	assert.equal(await driver.close(), true);
});

test("caller mutation cannot affect a pending frame", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const output = new QueuedWritable();
	const driver = createSessionHostFrameWriter(output as unknown as Writable);
	driver.start();
	driver.submit(frame(["original"]), 20, 1);
	assert.equal(output.writes.length, 2, "the first submit writes immediately");
	const lines = ["pending"];
	t.mock.timers.tick(5);
	driver.submit({ lines, cursor: { column: 0, row: 0, visible: false } }, 20, 1);
	lines[0] = "mutated";
	assert.equal(output.writes.length, 2, "the pending frame is coalesced into a scheduled redraw");
	t.mock.timers.tick(17);
	assert.ok(outputText(output, 2).includes("pending"), "the immutable submit-time snapshot is written");
	assert.equal(outputText(output, 2).includes("mutated"), false);
	assert.equal(await driver.close(), true);
});
