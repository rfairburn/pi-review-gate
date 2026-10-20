/**
 * #428: xterm parser diagnostics must never escape the composed frame.
 *
 * These tests drive the REAL production TerminalSurface (pinned
 * @xterm/headless 6.0.0 parser), the production compositor, and the
 * production frame writer with constructed input: a malformed CSI (`ESC [ 3`)
 * immediately followed by U+2026. This is synthetic input, not a replay of any
 * historical session, and it does not attribute an original incident cause.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";

import { composeHostFrame, computeHostLayout } from "../src/session-host/compositor";
import { createSessionHostFrameWriter } from "../src/session-host/frame-writer";
import { TerminalSurface, type TerminalFrame } from "../src/session-host/terminal-surface";
import {
	HostClipboardDiagnosticCollector,
	TerminalDiagnosticsWarning,
	XtermDiagnosticCollector,
	snapshotParserState,
	terminalDiagnosticsHeaderNotice,
	type TerminalDiagnosticEvent,
} from "../src/session-host/terminal-diagnostics";

const MALFORMED = "\x1b[3…";
const SGR = /\x1b\[[0-9;]*m/g;

interface ConsoleCapture {
	readonly calls: string[];
	readonly stderr: string[];
	restore(): void;
}

/** Observe (never suppress for the product) every host console/stderr path. */
function captureHostConsole(): ConsoleCapture {
	const calls: string[] = [];
	const stderr: string[] = [];
	const originals = new Map<string, unknown>();
	for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
		originals.set(method, console[method]);
		(console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
			calls.push(`${method}:${String(args[0])}`);
		};
	}
	const originalWrite = process.stderr.write;
	process.stderr.write = ((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	return {
		calls,
		stderr,
		restore() {
			for (const [method, original] of originals) (console as unknown as Record<string, unknown>)[method] = original;
			process.stderr.write = originalWrite;
		},
	};
}

function text(frame: TerminalFrame): string[] {
	return frame.lines.map((line) => line.replace(SGR, "").trimEnd());
}

async function surfaceWith(
	chunks: readonly string[],
	cols = 40,
	rows = 4,
): Promise<{ surface: TerminalSurface; events: TerminalDiagnosticEvent[] }> {
	const events: TerminalDiagnosticEvent[] = [];
	const surface = new TerminalSurface(cols, rows, { onDiagnostic: (event) => events.push(event) });
	for (const chunk of chunks) {
		surface.write(chunk);
		await surface.flush();
	}
	return { surface, events };
}

test("malformed CSI + ellipsis produces one bounded record and no console or stderr output", async () => {
	const capture = captureHostConsole();
	let result: Awaited<ReturnType<typeof surfaceWith>>;
	try {
		result = await surfaceWith([`before${MALFORMED}after`]);
	} finally {
		capture.restore();
	}
	const { surface, events } = result;
	try {
		assert.deepEqual(capture.calls, [], "xterm never logs through the host console");
		assert.deepEqual(capture.stderr, [], "nothing reaches host stderr outside the writer");
		assert.equal(events.length, 1);
		const [event] = events;
		assert.equal(event!.warningCount, 1);
		assert.equal(event!.suppressed, 0);
		const record = event!.records[0]!;
		assert.equal(record.level, "error");
		assert.equal(record.category, "parser-error");
		assert.equal(record.messageId, "parser-error");
		assert.deepEqual(record.parser, {
			state: 4,
			stateName: "CSI_PARAM",
			code: 0x2026,
			position: 9,
			intermediates: "",
			paramCount: 1,
			params: [3],
			paramsTruncated: false,
		});
		assert.deepEqual(record.context, { cols: 40, rows: 4, buffer: "normal", synchronizedFrameHeld: false });
		assert.equal(record.originatingStack, "not-applicable-parser-state-report");
		assert.equal(record.stack?.kind, "logger-call-site");
		assert.ok(record.stack!.frames.length > 0 && record.stack!.frames.length <= 12);
		assert.ok(record.stack!.frames.every((frame) => frame.startsWith("at ") && frame.length <= 240));
		const serialized = JSON.stringify(record);
		assert.ok(!serialized.includes("before") && !serialized.includes("after"), "no child text retained");
		assert.ok(!serialized.includes("…") && !serialized.includes("\\u001b"), "no raw bytes retained");
		// Parser recovery is unchanged: later valid text keeps rendering.
		surface.write("\r\nlater valid text");
		await surface.flush();
		assert.equal(text(surface.frame())[1], "later valid text");
	} finally {
		surface.dispose();
	}
});

test("valid italic SGR, chunk-split CSI, and synchronized valid output stay diagnostic-free and unchanged", async () => {
	const capture = captureHostConsole();
	try {
		const whole = await surfaceWith(["\x1b[3mitalic…\x1b[0m plain"]);
		const split = await surfaceWith(["\x1b[3", "mitalic…\x1b[0m plain"]);
		const synced = await surfaceWith(["\x1b[?2026h\x1b[3mitalic…\x1b[0m plain\x1b[?2026l"]);
		try {
			for (const candidate of [whole, split, synced]) {
				assert.equal(candidate.events.length, 0, "valid input never warns");
			}
			assert.deepEqual(split.surface.frame(), whole.surface.frame(), "chunk split renders identically");
			assert.deepEqual(synced.surface.frame(), whole.surface.frame(), "synchronized output renders identically");
			assert.ok(whole.surface.frame().styles?.[0]?.runs.some((run) => run.italic === true && run.text.startsWith("italic")));
		} finally {
			whole.surface.dispose();
			split.surface.dispose();
			synced.surface.dispose();
		}
	} finally {
		capture.restore();
	}
	assert.deepEqual(capture.calls, []);
	assert.deepEqual(capture.stderr, []);
});

test("a malformed sequence inside a synchronized frame does not strand the hold", async () => {
	const { surface, events } = await surfaceWith([
		"\x1b[?2026h",
		`held${MALFORMED}\x1b[?2026l`,
	]);
	try {
		assert.equal(events.length, 1);
		assert.equal(events[0]!.records[0]!.context?.synchronizedFrameHeld, true);
		assert.equal(surface.inputModes().mouseTracking, "none");
		surface.write("\x1b[?1000h");
		await surface.flush();
		assert.equal(surface.inputModes().mouseTracking, "vt200", "the frame committed; mouse modes are live again");
		assert.match(text(surface.frame())[0] ?? "", /^held/);
	} finally {
		surface.dispose();
	}
});

test("floods are bounded per surface and every suppressed call is still counted", async () => {
	const { surface, events } = await surfaceWith([MALFORMED.repeat(200)]);
	try {
		const records = events.flatMap((event) => event.records);
		const suppressed = events.reduce((sum, event) => sum + event.suppressed, 0);
		const warnings = events.reduce((sum, event) => sum + event.warningCount, 0);
		assert.equal(warnings, 200, "warning counts include suppressed calls");
		assert.equal(records.length, 16, "burst bound on detailed records/stacks");
		assert.equal(records.length + suppressed, 200);
	} finally {
		surface.dispose();
	}
});

test("collector refills slowly, labels suppression, and never throws into the caller", () => {
	let now = 1_000;
	const delivered: TerminalDiagnosticEvent[] = [];
	const scheduled: (() => void)[] = [];
	const collector = new XtermDiagnosticCollector({
		deliver: (event) => { delivered.push(event); throw new Error("sink failure is contained"); },
		context: () => { throw new Error("context failure is contained"); },
		now: () => now,
		schedule: (callback) => scheduled.push(callback),
		burst: 2,
		refillMs: 1000,
	});
	for (let index = 0; index < 5; index += 1) {
		assert.doesNotThrow(() => collector.logger.error("Parsing error: ", { currentState: 4, code: 0x2026 }));
	}
	assert.equal(delivered.length, 0, "never delivered synchronously inside the logger call");
	scheduled.splice(0).forEach((run) => run());
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0]!.records.length, 2);
	assert.equal(delivered[0]!.suppressed, 3);
	assert.equal(delivered[0]!.records[0]!.context, undefined);
	now += 1000;
	collector.logger.warn("writeSync is unreliable and will be removed soon.");
	scheduled.splice(0).forEach((run) => run());
	const refilled = delivered[1]!.records[0]!;
	assert.equal(refilled.suppressedBefore, 3, "the next detailed record carries the suppressed count");
	assert.equal(refilled.category, "xterm-warning");
	assert.equal(refilled.messageId, "write-sync-unreliable");
	collector.dispose();
	collector.logger.error("Parsing error: ", {});
	assert.equal(scheduled.length, 0, "nothing is collected after disposal");
});

test("#466 host clipboard failures use fixed codes under the same deferred rate bound, with no stack or cause", () => {
	let now = 5_000;
	const delivered: { instanceId: string; event: TerminalDiagnosticEvent }[] = [];
	const scheduled: (() => void)[] = [];
	const collector = new HostClipboardDiagnosticCollector({
		deliver: (instanceId, event) => { delivered.push({ instanceId, event }); throw new Error("sink failure is contained"); },
		now: () => now,
		schedule: (callback) => scheduled.push(callback),
		burst: 2,
		refillMs: 1000,
	});
	assert.doesNotThrow(() => collector.note("native-1", "clipboard-terminal-write-failed"));
	collector.note("native-1", "clipboard-provenance-unavailable");
	collector.note("native-2", "clipboard-unsupported-runtime");
	collector.note("native-2", "clipboard-unsupported-runtime");
	// Unknown codes are refused rather than invented.
	collector.note("native-1", "clipboard-anything" as never);
	for (const inherited of ["constructor", "toString", "__proto__"]) {
		collector.note("native-1", inherited as never);
	}
	assert.equal(delivered.length, 0, "never delivered synchronously inside the routing call");
	assert.equal(scheduled.length, 1, "one deferred delivery for the burst");
	scheduled.splice(0).forEach((run) => run());
	assert.deepEqual(delivered.map(({ instanceId, event }) => [instanceId, event.records.length, event.suppressed, event.warningCount]), [
		["native-1", 2, 0, 2],
		["native-2", 0, 2, 2],
	], "per-row deliveries; calls beyond the burst are counted, never lost");
	const records = delivered.flatMap(({ event }) => event.records);
	assert.deepEqual(records.map((record) => [record.level, record.category, record.messageId]), [
		["error", "host-clipboard", "clipboard-terminal-write-failed"],
		["warn", "host-clipboard", "clipboard-provenance-unavailable"],
	]);
	for (const record of records) {
		assert.deepEqual(Object.keys(record).sort(),
			["category", "level", "messageId", "originatingStack", "suppressedBefore", "time"],
			"fixed fields only: no payload, stack, parser state, error name, or context");
		assert.equal(record.originatingStack, "not-captured", "no xterm parser cause or stack is fabricated");
	}
	now += 1000;
	collector.note("native-2", "clipboard-unsupported-runtime");
	scheduled.splice(0).forEach((run) => run());
	assert.equal(delivered.at(-1)!.event.records[0]!.suppressedBefore, 2, "the next detailed record carries the suppressed count");
	collector.note("native-1", "clipboard-terminal-write-failed");
	collector.flushNow();
	assert.equal(delivered.at(-1)!.event.warningCount, 1, "flushNow hands over pending work synchronously");
	collector.dispose();
	collector.note("native-1", "clipboard-terminal-write-failed");
	scheduled.splice(0).forEach((run) => run());
	collector.flushNow();
	assert.equal(delivered.length, 4, "nothing is collected or delivered after disposal");
});

test("debug/trace messages and arbitrary arguments are classified without retaining their payload", () => {
	const delivered: TerminalDiagnosticEvent[] = [];
	const scheduled: (() => void)[] = [];
	const collector = new XtermDiagnosticCollector({
		deliver: (event) => delivered.push(event),
		schedule: (callback) => scheduled.push(callback),
	});
	const secret = "token=sk-live-SECRET-1234 prompt text";
	collector.logger.debug(`parsing data "${secret}"`, secret);
	collector.logger.trace("sending data (codes)", () => [1, 2, 3]);
	collector.logger.info(`something new ${secret}`, { secret });
	const logged = new Error(`boom ${secret}`);
	logged.name = "RangeError";
	collector.logger.error(logged, secret);
	scheduled.splice(0).forEach((run) => run());
	const records = delivered.flatMap((event) => event.records);
	assert.deepEqual(records.map((record) => record.messageId), ["parsing-data", "sending-data", "unrecognized", "logged-error"]);
	assert.deepEqual(records.map((record) => record.category), ["xterm-log", "xterm-log", "xterm-log", "xterm-warning"]);
	assert.equal(delivered[0]!.warningCount, 1, "only warn/error calls count toward the host warning");
	assert.equal(records[0]!.stack, undefined, "no stack is captured for low-level logs");
	assert.equal(records[3]!.errorName, "RangeError");
	assert.equal(records[3]!.stack?.kind, "logged-error");
	assert.equal(records[3]!.originatingStack, "logged-error-stack");
	assert.ok(!JSON.stringify(records).includes("SECRET"), "messages and arguments are never retained");
});

test("parser snapshots read only ACTIVE parameters, never stale storage past length", () => {
	const storage = new Int32Array(32);
	storage.set([3, 99, 77, 55]);
	const params = {
		params: storage,
		length: 1,
		toArray(): (number | number[])[] {
			const out: (number | number[])[] = [];
			for (let index = 0; index < this.length; index += 1) out.push(this.params[index]!);
			return out;
		},
	};
	const snapshot = snapshotParserState({ currentState: 4, code: 0x2026, position: 2, collect: 0x3f, params });
	assert.deepEqual(snapshot?.params, [3]);
	assert.equal(snapshot?.paramCount, 1);
	assert.equal(snapshot?.intermediates, "?");
	const many = { length: 32, toArray: () => [...Array.from({ length: 32 }, (_, index) => index), [1, 2]] };
	const bounded = snapshotParserState({ currentState: 99, code: 1, position: 0, collect: 0, params: many });
	assert.equal(bounded?.params.length, 16);
	assert.equal(bounded?.paramsTruncated, true);
	assert.equal(bounded?.stateName, "unknown");
	const throwing = { length: 2, toArray: () => { throw new Error("bad"); } };
	assert.deepEqual(snapshotParserState({ params: throwing })?.params, []);
	assert.equal(snapshotParserState(undefined), undefined);
});

test("disposal hands over pending diagnostics first and delivers nothing afterwards", async () => {
	const events: TerminalDiagnosticEvent[] = [];
	const surface = new TerminalSurface(20, 3, { onDiagnostic: (event) => events.push(event) });
	surface.write(MALFORMED);
	await surface.flush();
	assert.equal(events.length, 1);
	surface.dispose();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(events.length, 1);
});

test("a throwing diagnostic owner callback cannot break parsing", async () => {
	const surface = new TerminalSurface(30, 3, {
		onDiagnostic: () => { throw new Error("owner failure"); },
	});
	try {
		surface.write(`${MALFORMED}\r\nstill parsing`);
		await surface.flush();
		assert.equal(text(surface.frame())[1], "still parsing");
	} finally {
		surface.dispose();
	}
});

test("warning state: clearing is fenced by what was displayed and a new error re-warns", () => {
	const warning = new TerminalDiagnosticsWarning();
	assert.equal(warning.view(), undefined);
	warning.note(2);
	const shown = warning.view()!;
	assert.deepEqual(shown, { count: 2, throughCount: 2, logStatus: "ok", failureNotice: false });
	warning.note(1); // arrives after the displayed frame
	assert.equal(warning.clear(shown.throughCount, shown.failureNotice), true);
	assert.deepEqual(warning.view(), { count: 1, throughCount: 3, logStatus: "ok", failureNotice: false });
	warning.clear(3, false);
	assert.equal(warning.view(), undefined);
	warning.setLogStatus("failed", "unsafe-log-path");
	const failure = warning.view()!;
	assert.equal(failure.count, 0);
	assert.equal(failure.failureNotice, true, "a persistence failure warns on its own");
	warning.clear(failure.throughCount, true);
	assert.equal(warning.view(), undefined);
	warning.note(1);
	assert.deepEqual(warning.view(), {
		count: 1, throughCount: 4, logStatus: "failed", logFailure: "unsafe-log-path", failureNotice: false,
	});
	assert.equal(
		terminalDiagnosticsHeaderNotice(warning.view()),
		"! Terminal diagnostics: 1; unsafe log file (clear in sidebar)",
	);
});

test("compositor keeps the host notice visible on the header and clips the title first", () => {
	const layout = computeHostLayout(60, 6, { sidebarVisible: false, focus: "main" });
	const notice = "! Terminal diagnostics: 3 (clear in sidebar)";
	const composed = composeHostFrame(layout, {
		header: `A very long native conversation title \x1b]52;c;ZXZpbA==\x07 continues`,
		headerNotice: notice,
		focus: "main",
	});
	const header = composed.lines[0]!;
	assert.equal(visibleWidth(header), 60);
	assert.ok(header.endsWith(notice), header);
	assert.ok(!header.includes("\x1b"), "the header stays text-only");
	const narrow = composeHostFrame(computeHostLayout(20, 4, { sidebarVisible: false, focus: "main" }), {
		header: "Title",
		headerNotice: notice,
		focus: "main",
	});
	assert.equal(visibleWidth(narrow.lines[0]!), 20);
	assert.ok(narrow.lines[0]!.startsWith("! Terminal"));
	const plain = composeHostFrame(layout, { header: "Title only", focus: "main" });
	assert.equal(plain.lines[0]!.trimEnd(), "Title only", "no notice leaves the title-only header unchanged");
});

class CapturingOutput extends EventEmitter {
	readonly chunks: string[] = [];
	write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean {
		this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		callback?.();
		return true;
	}
}

test("production surface -> compositor -> writer emits only composed output for malformed input", async () => {
	const capture = captureHostConsole();
	const output = new CapturingOutput();
	const writer = createSessionHostFrameWriter(output as never, { redrawIntervalMs: 0 });
	const layout = computeHostLayout(50, 6, { sidebarVisible: false, focus: "main" });
	const warning = new TerminalDiagnosticsWarning();
	const surface = new TerminalSurface(layout.native.cols, layout.native.rows, {
		onDiagnostic: (event) => { warning.note(event.warningCount); },
	});
	try {
		writer.start();
		surface.write(`line one${MALFORMED}\r\nline two`);
		await surface.flush();
		const settled = new Promise<void>((resolve) => {
			writer.submit(composeHostFrame(layout, {
				main: surface.frame(),
				header: "Session",
				headerNotice: terminalDiagnosticsHeaderNotice(warning.view()),
				focus: "main",
			}), 50, 6, () => resolve());
		});
		await settled;
		assert.equal(await writer.close(), true);
	} finally {
		surface.dispose();
		capture.restore();
	}
	const written = output.chunks.join("");
	assert.deepEqual(capture.calls, []);
	assert.deepEqual(capture.stderr, []);
	assert.ok(!/Parsing error|xterm\.js|currentState|collect/.test(written), "no diagnostic dump in writer output");
	assert.ok(written.includes("! Terminal diagnostics: 1 (clear in sidebar)"), "the composed warning is drawn");
	assert.ok(written.includes("line one") && written.includes("line two"));
});
