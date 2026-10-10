import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Writable } from "node:stream";
import { createSessionHostFrameWriter } from "../src/session-host/frame-writer";
import type { ComposedHostFrame } from "../src/session-host/compositor";

const ESC = "\x1b";

class SyntheticWritable extends EventEmitter {
	readonly writes: Buffer[] = [];
	readonly callbacks: Array<(error?: Error | null) => void> = [];
	readonly writeResults: boolean[] = [];
	deferCallbacks = false;
	throwNextWrite = false;
	endCalls = 0;
	destroyCalls = 0;

	write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean {
		if (this.throwNextWrite) {
			this.throwNextWrite = false;
			throw new Error("synthetic-secret-write-failure");
		}
		this.writes.push(Buffer.from(chunk));
		if (callback) {
			if (this.deferCallbacks) this.callbacks.push(callback);
			else callback();
		}
		return this.writeResults.shift() ?? true;
	}

	completeCallback(index: number, error?: Error): void {
		const callback = this.callbacks[index];
		assert.ok(callback, `missing synthetic write callback ${index}`);
		callback(error);
	}

	end(): this {
		this.endCalls += 1;
		return this;
	}

	destroy(): this {
		this.destroyCalls += 1;
		return this;
	}
}

function frame(lines: string[], cursor = { column: 0, row: 0, visible: false }): ComposedHostFrame {
	return { lines, cursor };
}

function writer(output: SyntheticWritable, options: Parameters<typeof createSessionHostFrameWriter>[1] = {}) {
	return createSessionHostFrameWriter(output as unknown as Writable, options);
}

function outputText(output: SyntheticWritable, index: number): string {
	return output.writes[index]?.toString("utf8") ?? "";
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("construction is inert and start/frame/cleanup own only generated alternate-screen output", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0 });
	assert.equal(output.writes.length, 0);
	assert.equal(output.listenerCount("error"), 0);

	driver.start();
	assert.equal(outputText(output, 0), `${ESC}[?1049h${ESC}[0m${ESC}[?25l`);
	driver.submit({
		lines: [`${ESC}[1;38;2;12;34;56mHi${ESC}[0m`, "row two"],
		cursor: { column: 2, row: 1, visible: true },
	}, 8, 2);
	const rendered = outputText(output, 1);
	assert.ok(rendered.includes(`${ESC}[1;1H${ESC}[0m${ESC}[2K`));
	assert.ok(rendered.includes(`${ESC}[2;1H${ESC}[0m${ESC}[2K`));
	assert.ok(rendered.includes(`${ESC}[1;38;2;12;34;56mHi${ESC}[0m`), "generated RGB SGR survives");
	assert.ok(rendered.endsWith(`${ESC}[?25h${ESC}[2;3H`), "valid focused cursor is shown at 1-based CUP coordinates");
	assert.equal(rendered.includes("\n"), false, "no row uses LF, including the bottom row");

	assert.equal(await driver.close(), true);
	assert.equal(outputText(output, 2), `${ESC}[0m${ESC}[?25h${ESC}[?1049l`);
	assert.equal(output.endCalls, 0, "the caller's stream is not ended");
	assert.equal(output.destroyCalls, 0, "the caller's stream is not destroyed");
});

test("ANSI envelope rejects OSC, non-SGR CSI, controls, and C1 injection while clipping safely", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0 });
	driver.start();
	driver.submit(frame([
		`A${ESC}]2;osc-secret\x07B${ESC}[?25hC\x01D\u009b31mE\u009d52;clip-secret\u009cF\nG`,
	], { column: 1, row: 0, visible: false }), 8, 1);
	const rendered = outputText(output, 1);
	assert.ok(rendered.includes("ABCDEFG"), "safe text on either side of discarded controls is retained");
	assert.equal(rendered.includes("osc-secret"), false);
	assert.equal(rendered.includes("clip-secret"), false);
	assert.equal(rendered.includes(`${ESC}[?25h`), false, "untrusted cursor control does not pass through");
	assert.equal(rendered.includes("\n"), false);

	const before = output.writes.length;
	driver.submit(frame(["A界Z"], { column: 0, row: 0, visible: true }), 1, 1);
	const clipped = outputText(output, before);
	assert.ok(clipped.includes("A"));
	assert.equal(clipped.includes("界"), false, "wide graphemes are not split at a one-cell edge");
	assert.equal(clipped.includes("Z"), false);
	assert.ok(clipped.endsWith(`${ESC}[?25h${ESC}[1;1H`));
	assert.equal(await driver.close(), true);
});

test("resizes and invalid cursors stay inside supplied geometry, including a one-cell frame", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0 });
	driver.start();
	driver.submit(frame(["one", "two"], { column: 3, row: 1, visible: true }), 4, 2);
	assert.ok(outputText(output, 1).includes(`${ESC}[2;4H`));
	driver.submit(frame(["🙂"], { column: 1, row: 0, visible: true }), 1, 1);
	const oneCell = outputText(output, 2);
	assert.ok(oneCell.includes(`${ESC}[1;1H${ESC}[0m${ESC}[2K`));
	assert.ok(oneCell.endsWith(`${ESC}[?25l`), "out-of-geometry cursor is hidden");
	assert.equal(oneCell.includes("🙂"), false, "a wide glyph cannot overrun a 1x1 frame");
	assert.throws(() => driver.submit(frame(["x"]), 0, 1), /cols/);
	assert.throws(() => driver.submit(frame(["x"]), 1, 1001), /rows/);
	assert.equal(await driver.close(), true);
});

test("serialized byte cap counts UTF-8 bytes rather than JavaScript string length", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0, maxFrameBytes: 32 });
	driver.start();
	driver.submit(frame(["é"]), 2, 1);
	assert.equal(output.writes[1].byteLength, 32, "two-byte UTF-8 character fits exactly at the cap");
	assert.throws(() => driver.submit(frame(["🙂"]), 2, 1), /UTF-8 byte limit/,
		"four-byte UTF-8 character exceeds the same cap despite one UTF-16 code unit");
	assert.equal(output.writes.length, 2, "oversized candidate is rejected before writing");
	assert.equal(await driver.close(), true);
});

test("redraw interval coalesces invalidations and a blocked Writable retains only the newest frame", async () => {
	const output = new SyntheticWritable();
	output.writeResults.push(false);
	const driver = writer(output, { redrawIntervalMs: 0 });
	driver.start();
	driver.submit(frame(["superseded"]), 20, 1);
	driver.submit(frame(["newest"]), 20, 1);
	assert.equal(output.writes.length, 1, "backpressure prevents further writes before drain");
	output.emit("drain");
	assert.equal(output.writes.length, 2);
	assert.ok(outputText(output, 1).includes("newest"));
	assert.equal(outputText(output, 1).includes("superseded"), false);
	assert.equal(await driver.close(), true);

	const coalescedOutput = new SyntheticWritable();
	const coalesced = writer(coalescedOutput, { redrawIntervalMs: 80 });
	coalesced.start();
	coalesced.submit(frame(["first"]), 20, 1);
	coalesced.submit(frame(["middle"]), 20, 1);
	coalesced.submit(frame(["latest"]), 20, 1);
	await wait(110);
	assert.equal(coalescedOutput.writes.length, 3, "one scheduled redraw emits the newest invalidation");
	assert.ok(outputText(coalescedOutput, 2).includes("latest"));
	assert.equal(outputText(coalescedOutput, 2).includes("middle"), false);
	assert.equal(await coalesced.close(), true);
});

test("invalidate forces a complete repaint even when content and geometry are unchanged", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0 });
	driver.start();
	driver.submit(frame(["same", "frame"]), 10, 2);
	assert.equal(output.writes.length, 2, "the first frame is complete");
	const complete = Buffer.from(output.writes[1]);
	driver.submit(frame(["same", "frame"]), 10, 2);
	assert.equal(output.writes.length, 2, "an unchanged frame still emits nothing before invalidation");
	driver.invalidate();
	driver.submit(frame(["same", "frame"]), 10, 2);
	assert.equal(output.writes.length, 3, "an invalidated baseline repaints identical content");
	assert.deepEqual(output.writes[2], complete, "the forced repaint is a complete frame, not a no-op diff");
	assert.equal(await driver.close(), true);
});

test("invalidate while a write is blocked still repaints completely after drain", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0 });
	driver.start();
	driver.submit(frame(["base"]), 20, 1);
	assert.equal(output.writes.length, 2);
	output.writeResults.push(false);
	driver.submit(frame(["blocked"]), 20, 1);
	assert.equal(output.writes.length, 3, "the refused frame is retained by the blocked sink");
	const complete = Buffer.from(output.writes[2]);
	driver.invalidate();
	driver.submit(frame(["blocked"]), 20, 1);
	assert.equal(output.writes.length, 3, "the blocked sink retains only the newest identical pending frame");
	output.emit("drain");
	assert.equal(output.writes.length, 4, "drain repaints the invalidated baseline");
	assert.deepEqual(output.writes[3], complete, "the drained payload is a complete frame, not a suppressed diff");
	assert.equal(await driver.close(), true);
});

test("settlement follows written, unchanged, and drained backpressure candidates", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0 });
	const dispositions: string[] = [];
	driver.start();
	driver.submit(frame(["A"]), 20, 1, (value) => dispositions.push(`A:${value}`));
	assert.deepEqual(dispositions, ["A:written"]);

	driver.submit(frame(["A"]), 20, 1, (value) => dispositions.push(`same:${value}`));
	assert.deepEqual(dispositions, ["A:written", "same:unchanged"],
		"an unchanged submission settles without claiming a new emitted hit map");

	output.writeResults.push(false);
	driver.submit(frame(["B"]), 20, 1, (value) => dispositions.push(`B:${value}`));
	assert.equal(dispositions.includes("B:written"), false,
		"a false Writable return is accepted but not settled until drain");
	driver.submit(frame(["C"]), 20, 1, (value) => dispositions.push(`C:${value}`));
	output.emit("drain");
	assert.deepEqual(dispositions, ["A:written", "same:unchanged", "B:written", "C:written"],
		"drain settles the queued candidate before pumping the newest coalesced frame");
	assert.ok(outputText(output, 3).includes("C"));

	const writesBeforeInvalidatedIdentical = output.writes.length;
	driver.invalidate();
	driver.submit(frame(["C"]), 20, 1, (value) => dispositions.push(`identical:${value}`));
	assert.equal(output.writes.length, writesBeforeInvalidatedIdentical + 1,
		"an identical candidate written after invalidation has its own write boundary");
	assert.equal(dispositions.at(-1), "identical:written");
	assert.equal(await driver.close(), true);
});

test("asynchronous accepted writes gate unchanged checks and coalesce to the newest candidate", async () => {
	const output = new SyntheticWritable();
	output.deferCallbacks = true;
	const driver = writer(output, { redrawIntervalMs: 0 });
	const dispositions: string[] = [];
	driver.start();
	driver.submit(frame(["A"]), 20, 1, (value) => dispositions.push(`A:${value}`));
	assert.equal(output.writes.length, 1, "the initial frame waits for alternate-screen write completion");
	output.completeCallback(0);
	assert.equal(output.writes.length, 2, "the first frame starts after the initial write callback");
	assert.equal(dispositions.length, 0, "write() returning true alone does not settle A");

	driver.submit(frame(["A"]), 20, 1, (value) => dispositions.push(`same:${value}`));
	assert.equal(dispositions.length, 0, "an unchanged candidate cannot settle against an incomplete baseline");
	output.completeCallback(1);
	assert.deepEqual(dispositions, ["A:written", "same:unchanged"]);

	driver.submit(frame(["B"]), 20, 1, (value) => dispositions.push(`B:${value}`));
	driver.submit(frame(["C"]), 20, 1, (value) => dispositions.push(`C:${value}`));
	driver.submit(frame(["D"]), 20, 1, (value) => dispositions.push(`D:${value}`));
	assert.equal(output.writes.length, 3, "only B is in flight while C and D coalesce");
	assert.deepEqual(dispositions, ["A:written", "same:unchanged"]);
	output.completeCallback(2);
	assert.equal(output.writes.length, 4, "the newest pending candidate is emitted after B completes");
	assert.ok(outputText(output, 3).includes("D"));
	assert.equal(outputText(output, 3).includes("C"), false);
	output.completeCallback(3);
	assert.deepEqual(dispositions, ["A:written", "same:unchanged", "B:written", "D:written"]);
	output.deferCallbacks = false;
	assert.equal(await driver.close(), true);
});

for (const drainFirst of [false, true]) test(
	`false-return frame waits for callback and drain in either order (drain first: ${drainFirst})`,
	async () => {
		const output = new SyntheticWritable();
		const driver = writer(output, { redrawIntervalMs: 0 });
		const dispositions: string[] = [];
		driver.start();
		output.deferCallbacks = true;
		output.writeResults.push(false);
		driver.submit(frame(["A"]), 20, 1, (value) => dispositions.push(`A:${value}`));
		driver.submit(frame(["B"]), 20, 1, (value) => dispositions.push(`B:${value}`));
		assert.equal(output.writes.length, 2, "B remains pending behind the one in-flight frame");

		if (drainFirst) {
			output.emit("drain");
			assert.equal(dispositions.length, 0, "drain alone is not successful write completion");
			output.completeCallback(0);
		} else {
			output.completeCallback(0);
			assert.equal(dispositions.length, 0, "callback alone is insufficient when write() returned false");
			output.emit("drain");
		}
		assert.deepEqual(dispositions, ["A:written"]);
		assert.equal(output.writes.length, 3, "B starts only after both completion signals");
		assert.ok(outputText(output, 2).includes("B"));
		output.completeCallback(1);
		assert.deepEqual(dispositions, ["A:written", "B:written"]);
		output.deferCallbacks = false;
		assert.equal(await driver.close(), true);
	},
);

test("frame callback errors never settle written and fail the writer closed", async () => {
	const output = new SyntheticWritable();
	let errorCount = 0;
	const driver = writer(output, {
		redrawIntervalMs: 0,
		onError: () => { errorCount += 1; },
	});
	const dispositions: string[] = [];
	driver.start();
	output.deferCallbacks = true;
	driver.submit(frame(["A"]), 20, 1, (value) => dispositions.push(value));
	output.completeCallback(0, new Error("synthetic-secret-frame-callback"));
	assert.equal(dispositions.length, 0);
	assert.equal(errorCount, 1);
	assert.throws(() => driver.submit(frame(["B"]), 20, 1), /unavailable/);
	output.deferCallbacks = false;
	assert.equal(await driver.close(), true, "cleanup can still complete after the failed frame write");
});

test("default redraw cadence is 16 ms and fast bursts coalesce to the newest frame", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const output = new SyntheticWritable();
	const driver = writer(output);
	driver.start();
	driver.submit(frame(["burst-1"]), 20, 1);
	assert.equal(output.writes.length, 2, "the first submit after start writes immediately");
	t.mock.timers.tick(5);
	driver.submit(frame(["burst-2"]), 20, 1);
	driver.submit(frame(["burst-3"]), 20, 1);
	t.mock.timers.tick(10);
	assert.equal(output.writes.length, 2, "a fast burst does not redraw before the default interval elapses");
	t.mock.timers.tick(2);
	assert.equal(output.writes.length, 3, "the scheduled redraw fires at the default 16 ms cadence");
	assert.ok(outputText(output, 2).includes("burst-3"));
	assert.equal(outputText(output, 2).includes("burst-2"), false, "only the newest frame is drawn");
	driver.submit(frame(["next"]), 20, 1);
	t.mock.timers.tick(15);
	assert.equal(output.writes.length, 3, "the next redraw waits for a full default interval from the last write");
	t.mock.timers.tick(2);
	assert.equal(output.writes.length, 4);
	assert.ok(outputText(output, 3).includes("next"));
	assert.equal(await driver.close(), true);
});

test("default cadence keeps newest-only coalescing while a blocked sink waits for drain", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const output = new SyntheticWritable();
	output.writeResults.push(false);
	const driver = writer(output);
	driver.start();
	assert.equal(output.writes.length, 1, "the start write is refused and blocks the sink");
	driver.submit(frame(["first"]), 20, 1);
	t.mock.timers.tick(5);
	driver.submit(frame(["second"]), 20, 1);
	driver.submit(frame(["third"]), 20, 1);
	assert.equal(output.writes.length, 1, "a blocked sink retains only the newest pending frame");
	output.emit("drain");
	assert.equal(output.writes.length, 2, "the first drained frame writes immediately (no prior redraw timestamp)");
	assert.ok(outputText(output, 1).includes("third"));
	assert.equal(outputText(output, 1).includes("second"), false);
	driver.submit(frame(["fourth"]), 20, 1);
	assert.equal(output.writes.length, 2, "the next redraw waits for the default interval from the last write");
	t.mock.timers.tick(16);
	assert.equal(output.writes.length, 3);
	assert.ok(outputText(output, 2).includes("fourth"));
	assert.equal(await driver.close(), true);
});

test("close cancels a pending default-cadence redraw", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const output = new SyntheticWritable();
	const driver = writer(output);
	driver.start();
	driver.submit(frame(["visible"]), 20, 1);
	t.mock.timers.tick(5);
	driver.submit(frame(["pending redraw"]), 20, 1);
	assert.equal(output.writes.length, 2, "the second submit is coalesced into a scheduled redraw");
	const closing = driver.close();
	assert.equal(await closing, true);
	t.mock.timers.tick(1000);
	assert.equal(output.writes.length, 3, "close cancels the scheduled redraw; only cleanup output follows");
	assert.ok(outputText(output, 2).includes(`${ESC}[?1049l`));
});

test("synchronous write failures and throwing error callbacks are guarded and non-sensitive", async () => {
	const output = new SyntheticWritable();
	output.throwNextWrite = true;
	const errors: string[] = [];
	const driver = writer(output, {
		onError: (error) => {
			errors.push(error.message);
			throw new Error("callback-secret");
		},
	});
	assert.doesNotThrow(() => driver.start());
	assert.deepEqual(errors, ["Session host frame output failed"]);
	assert.equal(JSON.stringify(errors).includes("synthetic-secret"), false);
	assert.equal(await driver.close(), true, "cleanup is attempted even after the initial write failed");
	assert.equal(outputText(output, 0), `${ESC}[0m${ESC}[?25h${ESC}[?1049l`);
});

test("async Writable error is reported once and late write callbacks cannot recreate work", async () => {
	const output = new SyntheticWritable();
	output.deferCallbacks = true;
	let errorCount = 0;
	const driver = writer(output, {
		redrawIntervalMs: 0,
		onError: () => { errorCount += 1; },
	});
	driver.start();
	output.emit("error", new Error("stream-secret-diagnostic"));
	assert.equal(errorCount, 1);
	assert.throws(() => driver.submit(frame(["no longer accepted"]), 10, 1), /unavailable/);
	output.deferCallbacks = false;
	assert.equal(await driver.close(), true, "final cleanup can still be flushed after a prior submission failure");
	const writesAtClose = output.writes.length;
	assert.doesNotThrow(() => output.completeCallback(0, new Error("late-secret-callback")));
	assert.equal(errorCount, 1, "error event and late callback are deduplicated");
	assert.equal(output.listenerCount("error"), 0, "a delivered stream error covers callbacks completed afterward");
	assert.equal(output.writes.length, writesAtClose, "late callbacks do not recreate a pending queue");
});

test("async write callbacks and premature Writable close failures are handled once", async () => {
	const callbackOutput = new SyntheticWritable();
	callbackOutput.deferCallbacks = true;
	const callbackErrors: string[] = [];
	const callbackDriver = writer(callbackOutput, {
		onError: (error) => { callbackErrors.push(error.message); },
	});
	callbackDriver.start();
	assert.doesNotThrow(() => callbackOutput.completeCallback(0, new Error("callback-secret")));
	assert.deepEqual(callbackErrors, ["Session host frame output failed"]);
	callbackOutput.deferCallbacks = false;
	assert.equal(await callbackDriver.close(), true);

	const closedOutput = new SyntheticWritable();
	let closeErrorCount = 0;
	const closeDriver = writer(closedOutput, { onError: () => { closeErrorCount += 1; } });
	closeDriver.start();
	closedOutput.emit("close");
	assert.equal(closeErrorCount, 1, "unexpected close is reported once");
	closedOutput.throwNextWrite = true;
	assert.equal(await closeDriver.close(), false, "failed final cleanup is reported as incomplete");
	assert.equal(closeErrorCount, 1);
});

test("real Writable late errors stay guarded after cleanup timeout and release owned listeners", async () => {
	const writtenChunks: Buffer[] = [];
	let pendingWrite: ((error?: Error | null) => void) | undefined;
	let pendingDestroy: (() => void) | undefined;
	const output = new Writable({
		highWaterMark: 1,
		write(chunk, _encoding, callback) {
			writtenChunks.push(Buffer.from(chunk));
			pendingWrite = callback;
		},
		destroy(error, callback) {
			pendingDestroy = () => callback(error);
		},
	});
	let callerErrorCount = 0;
	const callerErrorListener = (): void => { callerErrorCount += 1; };
	output.on("error", callerErrorListener);
	const reportedErrors: string[] = [];
	const driver = createSessionHostFrameWriter(output, {
		cleanupTimeoutMs: 20,
		onError: (error) => { reportedErrors.push(error.message); },
	});
	driver.start();
	const completeHeldWrite = pendingWrite;
	assert.ok(completeHeldWrite, "the real Writable holds the driver's start write");
	assert.equal(await driver.close(), false, "the bounded cleanup expires while the underlying write is held");
	assert.equal(output.listenerCount("error"), 2, "the writer retains only its error guard while an owned write is outstanding");
	assert.equal(writtenChunks.length, 1, "cleanup remains buffered behind the held write");

	const closeObserved = new Promise<void>((resolve) => output.once("close", resolve));
	completeHeldWrite(new Error("late-writable-secret"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(pendingDestroy, "Node has entered the deliberately delayed _destroy callback");
	assert.equal(output.listenerCount("error"), 2,
		"the owned guard survives an immediate while _destroy has not delivered error");
	assert.equal(callerErrorCount, 0, "the delayed stream error has not been delivered yet");
	const completeDestroy = pendingDestroy;
	assert.ok(completeDestroy);
	completeDestroy();
	await Promise.race([
		closeObserved,
		wait(250).then(() => { throw new Error("real Writable did not close after its failed write"); }),
	]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(reportedErrors, ["Session host frame output failed"]);
	assert.equal(callerErrorCount, 1, "the caller's error listener is preserved and receives the stream event");
	assert.equal(writtenChunks.length, 1, "late failure does not recreate or append output");
	assert.equal(output.listenerCount("error"), 1, "the owned error guard is removed after Node's error delivery");
	assert.equal(output.listenerCount("close"), 0, "the retained close cleanup listener is eventually removed too");
	assert.throws(() => driver.submit(frame(["late"]), 1, 1), /closed/);
});

test("close cancels redraws, is idempotent, preserves caller listeners, and bounds a wedged cleanup", async () => {
	const output = new SyntheticWritable();
	const callerError = (): void => {};
	const callerDrain = (): void => {};
	const callerClose = (): void => {};
	output.on("error", callerError);
	output.on("drain", callerDrain);
	output.on("close", callerClose);
	const driver = writer(output, { redrawIntervalMs: 100, cleanupTimeoutMs: 20 });
	driver.start();
	driver.submit(frame(["visible"]), 10, 1);
	driver.submit(frame(["obsolete pending redraw"]), 10, 1);
	output.writeResults.push(false);
	const closing = driver.close();
	assert.equal(driver.close(), closing, "concurrent close calls share one bounded cleanup attempt");
	assert.equal(await closing, false, "write false without drain is incomplete at the deadline");
	const writesAtClose = output.writes.length;
	await wait(120);
	assert.equal(output.writes.length, writesAtClose, "close cancels pending timer work");
	assert.deepEqual(output.listeners("error"), [callerError]);
	assert.deepEqual(output.listeners("drain"), [callerDrain]);
	assert.deepEqual(output.listeners("close"), [callerClose]);
	assert.throws(() => driver.start(), /closed/);
	assert.throws(() => driver.submit(frame(["closed"]), 1, 1), /closed/);
	assert.equal(output.endCalls, 0);
	assert.equal(output.destroyCalls, 0);
});
