import assert from "node:assert/strict";
import test from "node:test";
import { TerminalSurface, TerminalFrame, TerminalInputModes, TerminalSurfaceOptions } from "../src/session-host/terminal-surface";

/**
 * Tests exercise the real pinned production stack: @xterm/headless 6.0.0
 * Terminal + @xterm/addon-unicode11 0.9.0, not mock parser algorithms. The
 * pinned addon and core share the same upstream registry commit
 * (f447274f430fd22513f6adbf9862d19524471c04), which is what Unicode11 width
 * fidelity (CJK width 2, emoji width 2) is validated against here.
 *
 * Unicode note: the addon pins correct width for common CJK, emoji, and
 * combining sequences covered by the tests; newer emoji (multi-codepoint
 * ZWJ/flag/rare-2020s sequences) remain unproven against this pin. No full
 * native Unicode parity is claimed — only what these cases prove.
 *
 * Frame lines serialize the snapshot: sanitized text plus only generated,
 * allowlisted SGR sequences with an explicit leading and trailing reset per
 * row. Tests assert both text (with generated SGR stripped) and the
 * presence/correctness of the generated colors, attributes, and resets.
 *
 * Kitty keyboard facts asserted against the real protocol
 * (sw.kovidgoyal.net/kitty/keyboard-protocol/): five enhancement bits
 * (1 disambiguate, 2 event types, 4 alternate keys, 8 all keys, 16 associated
 * text) with this surface advertising at most 7; per-screen-mode state
 * (normal and alternate buffers independent); pops that empty the stack reset
 * all flags to zero, including after bounded FIFO eviction.
 */

const ESC = "\x1b";
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;

function makeSurface(rows = 4, cols = 20, options: TerminalSurfaceOptions = {}) {
	return new TerminalSurface(cols, rows, options);
}

function plainText(line: string): string {
	assert.ok(!line.replace(SGR_PATTERN, "").includes(ESC), "non-SGR escape in frame line");
	assert.ok(!line.replace(SGR_PATTERN, "").match(/[\u0000-\u001f\u007f-\u009f]/), "control byte in frame line text");
	return line.replace(SGR_PATTERN, "");
}

async function writeAll(surface: TerminalSurface, chunks: string[]): Promise<void> {
	for (const chunk of chunks) {
		surface.write(chunk);
	}
	await surface.flush();
}

test("every snapshot row has explicit SGR boundaries", async () => {
	const surface = makeSurface(3, 10);
	await writeAll(surface, ["plain\r\n", `${ESC}[31mred`]);
	for (const line of surface.frame().lines) {
		assert.ok(line.startsWith(`${ESC}[0m`));
		assert.ok(line.endsWith(`${ESC}[0m`));
	}
	surface.dispose();
});

test("snapshot renders plain text and reports geometry", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, ["hello"]);
	const frame = surface.frame();
	assert.equal(frame.cols, 20);
	assert.equal(frame.rows, 4);
	assert.equal(plainText(frame.lines[0]).trimEnd(), "hello");
	assert.equal(frame.cursor.column, 5);
	assert.equal(frame.cursor.row, 0);
	assert.equal(frame.cursor.visible, true);
	// Default-attribute rows still establish and close default SGR state
	// explicitly, so host styling can never bleed through.
	assert.deepEqual(
		frame.lines[0].match(SGR_PATTERN),
		[`${ESC}[0m`, `${ESC}[0m`],
	);
	surface.dispose();
});

test("parse invalidation is asynchronous: frame is stale immediately, fresh after flush", async () => {
	const surface = makeSurface(4, 20);
	surface.write("hello");
	// Writes are async in xterm; the immediate frame must not assume the
	// parse happened synchronously inside write().
	assert.ok(!plainText(surface.frame().lines[0]).includes("hello"), "immediate frame is stale before parse");
	await surface.flush();
	assert.equal(plainText(surface.frame().lines[0]).trimEnd(), "hello");
	surface.dispose();
});

test("onChange fires after parsed writes, never synchronously on write", async () => {
	let changes = 0;
	const surface = makeSurface(4, 20, { onChange: () => { changes += 1; } });
	surface.write("hello");
	assert.deepEqual(changes, 0);
	await surface.flush();
	assert.ok(changes >= 1, "onChange should fire after parse");
	// A second flush with nothing queued produces no extra notifications.
	const before = changes;
	await surface.flush();
	assert.deepEqual(changes, before);
	surface.dispose();
});

test("buffer switches never expose intermediate state: invalidation only after full parse", async () => {
	let changes = 0;
	const surface = makeSurface(4, 20, { onChange: () => { changes += 1; } });
	// One chunk: enter alt screen, clear, and draw — an invalidation from
	// the raw buffer-switch event would expose the intermediate buffer.
	surface.write("\x1b[?1049h\x1b[2Jalt");
	await surface.flush();
	assert.deepEqual(changes, 1, "exactly one post-parse notification for the chunk");
	const lines = surface.frame().lines.map(plainText);
	assert.ok(lines.join("|").includes("alt"), "alt content rendered in the single notification");
	surface.dispose();
});

test("mode-only changes notify the host after parse through the shared invalidation key", async () => {
	let changes = 0;
	const surface = makeSurface(4, 20, { onChange: () => { changes += 1; } });
	const before = changes;
	// Bracketed paste toggle changes no cell: the mode change alone must
	// surface once, after the parse (not inside the parser hook).
	surface.write("\x1b[?2004h");
	await surface.flush();
	assert.deepEqual(changes, before + 1, "bracketed-paste-only change notified after parse");
	const modes = surface.inputModes();
	assert.equal(modes.bracketedPaste, true);
	surface.dispose();
});

test("frame lines carry generated SGR for palette, RGB, attributes, with explicit resets", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, [
		`${ESC}[31mbold-red${ESC}[0mplain\r\n`,
		`${ESC}[1;3;4mxyz${ESC}[0m\r\n`,
		`${ESC}[38;5;196mc${ESC}[38;2;1;2;3mRGB${ESC}[0m`,
	]);
	const frame = surface.frame();
	// Text is preserved with generated SGR stripped; each row opens and
	// closes with explicit resets so host styling never bleeds through.
	assert.equal(plainText(frame.lines[0]).trimEnd(), "bold-redplain");
	assert.equal(frame.lines[0], `${ESC}[0m${ESC}[31mbold-red${ESC}[0mplain       ${ESC}[0m`);
	assert.equal(plainText(frame.lines[1]).trimEnd(), "xyz");
	assert.equal(frame.lines[1], `${ESC}[0m${ESC}[1;3;4mxyz${ESC}[0m                 ${ESC}[0m`);
	// Palette and RGB runs each end with an explicit reset; the trailing
	// default padding needs none before the row's final boundary reset.
	assert.equal(plainText(frame.lines[2]).trimEnd(), "cRGB");
	assert.ok(frame.lines[2].startsWith(`${ESC}[0m${ESC}[38;5;196mc${ESC}[0m${ESC}[38;2;1;2;3`), `line 2: ${JSON.stringify(frame.lines[2])}`);
	assert.ok(frame.lines[2].endsWith(`                ${ESC}[0m`), "reset closes each non-default run");
	// Structured runs stay available for consumers that avoid SGR parsing.
	assert.ok(frame.styles, "styled rows should export styles");
	const row0 = frame.styles?.find((line) => line.line === 0);
	assert.ok(row0, "row 0 exports runs");
	assert.equal(row0.runs[0].startColumn, 0);
	assert.deepEqual(row0.runs[0].fg, { mode: "palette", value: 1 });
	assert.ok(row0.runs[1].text.startsWith("plain"));
	assert.deepEqual(row0.runs[1].fg, undefined);
	const row1 = frame.styles?.find((line) => line.line === 1);
	assert.ok(row1, "row 1 exports runs");
	assert.equal(row1.runs.length, 2, "\"xyz\" run plus default padding run");
	assert.equal(row1.runs[0].text, "xyz");
	assert.deepEqual(row1.runs[0].bold, true);
	assert.deepEqual(row1.runs[0].italic, true);
	assert.deepEqual(row1.runs[0].underline, true);
	const row2 = frame.styles?.find((line) => line.line === 2);
	assert.ok(row2, "row 2 exports runs");
	assert.equal(row2.runs.length, 3, "palette, RGB, and default padding form three runs");
	assert.deepEqual(row2.runs[0].fg, { mode: "palette", value: 196 });
	assert.deepEqual(row2.runs[1].fg, { mode: "rgb", value: 0x010203 });
	surface.dispose();
});

test("SGR attributes serialize an allowlisted palette: bright/fixed/palette/256 and backgrounds", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, [
		`${ESC}[91mhi${ESC}[38;5;250m256${ESC}[48;5;3mbg${ESC}[0m`,
	]);
	const frame = surface.frame();
	// xterm applies SGR cumulatively: the "bg" cell carries both the still
	// active 250 foreground (palette) and the new 256-palette background 3.
	assert.equal(
		frame.lines[0],
		`${ESC}[0m${ESC}[91mhi${ESC}[0m${ESC}[38;5;250m256${ESC}[0m${ESC}[38;5;250;43mbg${ESC}[0m             ${ESC}[0m`,
		"cumulative SGR serialization with resets between runs",
	);
	// Every escape in the line is generated SGR with only digits/semicolons.
	const escapes = frame.lines[0].match(/\x1b[^m]*m/g) ?? [];
	for (const escape of escapes) {
		assert.match(escape, /^\x1b\[[0-9;]*m$/, `only generated SGR, got ${JSON.stringify(escape)}`);
	}
	surface.dispose();
});

test("row-boundary resets close attributes and keep rows independent", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, [`${ESC}[31mred-only-row${ESC}[0m\r\n${ESC}[48;5;12mblue-bg${ESC}[0m`]);
	const frame = surface.frame();
	assert.equal(frame.lines[0], `${ESC}[0m${ESC}[31mred-only-row${ESC}[0m        ${ESC}[0m`, "explicit resets at attribute transition and row boundary");
	assert.equal(frame.lines[0].startsWith(`${ESC}[0m${ESC}[31m`), true);
	// With an explicit reset in the child's output the next row is clean;
	// without one, native SGR is cumulative (fg persists) and the serializer
	// preserves that native behavior rather than resetting it away.
	assert.equal(frame.lines[1], `${ESC}[0m${ESC}[104mblue-bg${ESC}[0m             ${ESC}[0m`, "row 1 carries only its own attributes after reset");
	const row1 = frame.styles?.find((styled) => styled.line === 1);
	assert.deepEqual(row1?.runs[0].fg, undefined, "no leaked foreground after explicit reset");
	assert.deepEqual(row1?.runs[0].bg, { mode: "palette", value: 12 });
	surface.dispose();
});

test("native cumulative SGR persists across newlines until an explicit reset", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, [`${ESC}[31mred\r\nstill-red`]);
	const frame = surface.frame();
	// fg palette 1 remains active on the second line: cells carry it, so the
	// generated per-row SGR starts with 31 there (attribute preservation).
	assert.ok(frame.lines[1].startsWith(`${ESC}[0m${ESC}[31m`), "native cumulative SGR preserved behind the row's leading reset");
	assert.equal(plainText(frame.lines[1]).trimEnd(), "still-red");
	surface.dispose();
});

test("Unicode11 addon: CJK and emoji measure width 2, combining marks join the base cell", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, ["中", "文", "😀", "́", "next"]);
	const frame = surface.frame();
	const line0 = plainText(frame.lines[0]);
	// Under the plain (non-Unicode11) default, fixture emoji measured width 1;
	// Unicode11 corrects this, which is why the addon is required.
	assert.ok(line0.includes("中文"), `CJK present: ${JSON.stringify(line0)}`);
	assert.ok(line0.includes("😀́"), `emoji + combining present: ${JSON.stringify(line0)}`);
	// Wide chars advance two viewport columns: "next" starts at column 6.
	assert.ok(line0.startsWith("中文😀́next"), `column layout: ${JSON.stringify(line0)}`);
	assert.equal(frame.cursor.column, 10, "CJK/emoji occupy two columns; combining mark adds none");
	surface.dispose();
});

test("wide characters advance columns and are not duplicated by continuation cells", async () => {
	const surface = makeSurface(3, 10);
	await writeAll(surface, ["中X"]);
	const frame = surface.frame();
	assert.equal(plainText(frame.lines[0]).trimEnd(), "中X");
	// "中" spans columns 0-1, "X" sits at column 2, cursor advances to 3.
	assert.equal(frame.cursor.column, 3, "cursor advances past the wide char and X");
	surface.dispose();
});

test("hardware cursor visibility tracks CSI ?25h/l with combined parameters, plus resets", async () => {
	const surface = makeSurface(3, 10);
	await writeAll(surface, [`${ESC}[?1;25l`]);
	assert.equal(surface.frame().cursor.visible, false, "combined DECRST with 25 hides cursor");
	await writeAll(surface, [`${ESC}[?1;25h`]);
	assert.equal(surface.frame().cursor.visible, true, "combined DECSET with 25 shows cursor");
	// Hide, then a supported terminal reset restores visibility.
	await writeAll(surface, [`${ESC}[?25l`]);
	assert.equal(surface.frame().cursor.visible, false);
	await writeAll(surface, [`${ESC}[!p`]);
	assert.equal(surface.frame().cursor.visible, true, "DECSTR restores cursor visibility");
	await writeAll(surface, [`${ESC}[?25l`]);
	await writeAll(surface, [`${ESC}c`]);
	assert.equal(surface.frame().cursor.visible, true, "full reset restores cursor visibility");
	// Other private modes with the same final byte must not disturb tracking.
	await writeAll(surface, [`${ESC}[?7h`]);
	assert.equal(surface.frame().cursor.visible, true);
	surface.dispose();
});

test("alternate buffer snapshots isolate from and restore to the normal buffer", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, ["normal"]);
	await writeAll(surface, [`${ESC}[?1049h`, `${ESC}[2J`, "alt"]);
	assert.ok(surface.frame().lines.map(plainText).join("|").includes("alt"), "alt content visible");
	assert.ok(!surface.frame().lines.map(plainText).join("|").includes("normal"), "normal content hidden on alt");
	await writeAll(surface, [`${ESC}[?1049l`]);
	assert.ok(surface.frame().lines.map(plainText).join("|").includes("normal"), "normal buffer restored after leaving alt");
	surface.dispose();
});

test("normal buffer keeps the viewport on the last rows over bounded scrollback", async () => {
	const surface = makeSurface(5, 10);
	const chunks: string[] = [];
	for (let i = 0; i < 12; i += 1) {
		chunks.push(`line ${i}\r\n`);
	}
	await writeAll(surface, chunks);
	const frame = surface.frame();
	assert.equal(frame.cursor.row, 4, "cursor sits in the last viewport row");
	const joined = frame.lines.map(plainText).join("|");
	assert.ok(joined.includes("line 10"), "recent content visible in the viewport");
	assert.ok(!joined.includes("line 0"), "scrolled-out content not in the viewport");
	surface.dispose();
});

test("resize reflows geometry; invalid dimensions fail explicitly", async () => {
	const surface = makeSurface(4, 10);
	await writeAll(surface, ["hello"]);
	surface.resize(20, 6);
	const frame = surface.frame();
	assert.equal(frame.cols, 20);
	assert.equal(frame.rows, 6);
	assert.equal(plainText(frame.lines[0]).trimEnd(), "hello");
	assert.throws(() => surface.resize(0, 4), /cols/);
	assert.throws(() => surface.resize(10, 0), /rows/);
	assert.throws(() => surface.resize(Number.NaN, 4), /cols/);
	assert.throws(() => surface.resize(Number.POSITIVE_INFINITY, 4), /cols/);
	assert.throws(() => surface.resize(1001, 4), /cols/);
	surface.dispose();
});

test("constructor validation fails explicitly on invalid dimensions and limits", () => {
	assert.throws(() => new TerminalSurface(0, 4), /cols/);
	assert.throws(() => new TerminalSurface(4, -1), /rows/);
	assert.throws(() => new TerminalSurface(4, 1001), /rows/);
	assert.throws(() => new TerminalSurface(4, 4, { scrollback: -5 }), /scrollback/);
	assert.throws(() => new TerminalSurface(4, 4, { maxPendingBytes: 0 }), /maxPendingBytes/);
});

test("queued-data limit fails explicitly instead of silently truncating", () => {
	const surface = makeSurface(4, 10, { maxPendingBytes: 32 });
	assert.throws(() => surface.write("0123456789abcdef0123456789abcdef33"), /budget/);
	// A small write within budget is accepted and drains cleanly.
	surface.write("ok");
	return surface.flush().then(() => surface.dispose());
});

test("queued budget counts UTF-8 bytes, not UTF-16 code units", async () => {
	// "中" is 1 UTF-16 code unit but 3 UTF-8 wire bytes; "😀" is 2 units,
	// 4 bytes. A 2-byte budget must reject the CJK chunk on wire bytes.
	const cjkSurface = makeSurface(4, 10, { maxPendingBytes: 2 });
	assert.throws(() => cjkSurface.write("中"), /budget/);
	cjkSurface.dispose();
	// A 3-byte budget accepts the CJK char and rejects the 4-byte emoji.
	const emojiSurface = makeSurface(4, 10, { maxPendingBytes: 3 });
	assert.doesNotThrow(() => emojiSurface.write("中"));
	assert.throws(() => emojiSurface.write("😀"), /budget/);
	// After the queue drains, an exactly-fitting byte is accepted again.
	await emojiSurface.flush();
	assert.doesNotThrow(() => emojiSurface.write("a"), "after drain the exact byte fits");
	emojiSurface.dispose();
});

test("empty writes are no-ops and cannot enqueue unbounded zero-byte promises", () => {
	const surface = makeSurface(4, 10, { maxPendingBytes: 1 });
	for (let i = 0; i < 5000; i += 1) {
		assert.doesNotThrow(() => surface.write(""), "empty write stays a no-op");
	}
	return surface.flush().then(() => surface.dispose());
});

test("queued-write count is bounded; tiny chunks pause/resume, hard cap fails explicitly", async () => {
	const events: boolean[] = [];
	const surface = makeSurface(4, 20, { onBackpressure: (paused) => { events.push(paused); } });
	// 2200 one-byte chunks stay under the 4096-write hard cap but exceed
	// the 2048 count watermark: queued chunks pause before parsing drains.
	for (let i = 0; i < 2200; i += 1) {
		surface.write("a");
	}
	assert.ok(events.includes(true), "count watermark pauses before the hard cap");
	await surface.flush();
	assert.ok(events.includes(false), "resume after the queue drains");
	surface.dispose();

	// The hard cap fails explicitly, not silently: 4096 accepted, 4097th
	// tiny write rejects while nothing parses mid-loop.
	const hard = makeSurface(4, 20);
	for (let i = 0; i < 4096; i += 1) {
		hard.write("a");
	}
	assert.throws(() => hard.write("a"), /budget/, "the 4097th queued tiny write fails explicitly");
	hard.dispose();
});

test("per-surface reply isolation: replies go only to the owning surface", async () => {
	const repliesA: string[] = [];
	const repliesB: string[] = [];
	const surfaceA = makeSurface(4, 20, { onReply: (data) => { repliesA.push(data); } });
	const surfaceB = makeSurface(4, 20, { onReply: (data) => { repliesB.push(data); } });
	await writeAll(surfaceA, ["hello from A", `${ESC}[c`, `${ESC}[6n`]);
	await writeAll(surfaceB, ["different content B"]);
	assert.equal(repliesB.length, 0, "B did not observe A's query replies");
	assert.equal(plainText(surfaceA.frame().lines[0]).trimEnd(), "hello from A");
	assert.equal(plainText(surfaceB.frame().lines[0]).trimEnd(), "different content B");
	// Built-in DA/DSR replies are routed through onData to the owner.
	assert.ok(repliesA.some((data) => data.includes("c")), "DA1 reply reaches owner");
	assert.ok(repliesA.some((data) => data.endsWith("R")), "DSR cursor report reaches owner");
	surfaceA.dispose();
	surfaceB.dispose();
});

test("simultaneous writes to two surfaces produce independent snapshots", async () => {
	const surfaceA = makeSurface(3, 10);
	const surfaceB = makeSurface(3, 10);
	surfaceA.write("AAA");
	surfaceB.write("BBB");
	await surfaceA.flush();
	await surfaceB.flush();
	assert.equal(plainText(surfaceA.frame().lines[0]).trimEnd(), "AAA");
	assert.equal(plainText(surfaceB.frame().lines[0]).trimEnd(), "BBB");
	surfaceA.dispose();
	surfaceB.dispose();
});

test("Kitty push/query/pop follow the protocol: set zero, add/remove, nested restore", async () => {
	const replies: string[] = [];
	const surface = makeSurface(4, 20, { onReply: (data) => { replies.push(data); } });
	// Native Pi 1.0.4's current fallback query shape: push flags, query, then
	// DA1; the natural parse response sequence is preserved (kitty query
	// reply precedes the built-in DA1 reply) with no native core patch.
	await writeAll(surface, ["\x1b[>7u\x1b[?u\x1b[c"]);
	assert.equal(replies[0], "\x1b[?7u", "kitty query returns pushed flags");
	assert.match(replies[1] ?? "", /\[\?1;/, "DA1 reply follows via onData");

	// CSI = 0;1 u SETS flags to zero; only CSI ? u queries.
	await writeAll(surface, ["\x1b[=0;1u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "set-to-zero replaces flags, not a query");

	// mode 1 set, mode 2 add, mode 3 remove; underlying state preserved.
	await writeAll(surface, ["\x1b[=3;1u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?3u", "mode 1 sets flags");
	await writeAll(surface, ["\x1b[=4;2u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?7u", "mode 2 adds flags");
	await writeAll(surface, ["\x1b[=4;3u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?3u", "mode 3 removes the given flags");

	// Nested restoration: pop restores the state saved by the last push.
	// Stack beneath "set 3" is preserved: [3] at first push, [3,1] at second.
	await writeAll(surface, ["\x1b[>1u\x1b[>2u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?2u", "top of the stack is current");
	await writeAll(surface, ["\x1b[<1u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?1u", "pop restores the previous saved state");
	await writeAll(surface, ["\x1b[<1u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?3u", "next pop restores the deeper saved state");
	// Protocol: the pop that empties the stack resets ALL flags to zero,
	// silently — including the saved state beneath it after FIFO eviction.
	await writeAll(surface, ["\x1b[<1u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "stack-exhausting pop resets flags to zero, not the save beneath");
	await writeAll(surface, ["\x1b[<5u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "pop on an already-empty stack stays silent at zero");
	surface.dispose();
});

test("Kitty stack is bounded per screen mode and drain-to-empty resets to zero", async () => {
	const replies: string[] = [];
	const surface = makeSurface(4, 20, { onReply: (data) => { replies.push(data); } });
	// 40 pushes of flags 7 exceed the cap of 32: the stack stays bounded
	// (FIFO eviction, newest push retained) and the effective flags do not
	// go stale.
	const pushes: string[] = [];
	for (let i = 0; i < 40; i += 1) {
		pushes.push("\x1b[>7u");
	}
	await writeAll(surface, pushes);
	await writeAll(surface, ["\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?7u", "newest push retained when bounding the stack");
	// Pops beyond the cap drain the bounded stack silently; the pop that
	// empties it resets all flags to zero (not the oldest retained save).
	const before = replies.length;
	await writeAll(surface, ["\x1b[<50u"]);
	assert.equal(replies.length, before, "deep drain pops silently");
	await writeAll(surface, ["\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "drain-to-empty resets flags to zero even after FIFO eviction");
	surface.dispose();

	// Exact exhaustion: 43 pushes (32 retained) then exactly 32 pops leaves
	// the stack empty -> ALL flags reset to zero.
	replies.length = 0;
	const exact = makeSurface(4, 20, { onReply: (data) => { replies.push(data); } });
	const exactPushes: string[] = [];
	for (let i = 0; i < 43; i += 1) {
		exactPushes.push("\x1b[>7u");
	}
	await writeAll(exact, exactPushes);
	await writeAll(exact, ["\x1b[<32u"]);
	assert.deepEqual(exact.inputModes().kittyFlags, 0, "exactly exhausting pops reset the effective flags");
	await writeAll(exact, ["\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "query confirms zero at exact stack exhaustion");
	exact.dispose();
});

test("Kitty state is independent per screen mode: alt and normal keep their own flags", async () => {
	const replies: string[] = [];
	const surface = makeSurface(4, 20, { onReply: (data) => { replies.push(data); } });
	// Main buffer: push flags 7.
	await writeAll(surface, ["\x1b[>7u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?7u", "main mode holds the pushed flags");
	// Enter alt screen: its keyboard state starts fresh at zero.
	await writeAll(surface, ["\x1b[?1049h\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "alternate mode starts independent at zero");
	// Set flags 3 on the alternate screen; the main mode's state is untouched.
	await writeAll(surface, ["\x1b[=3;1u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?3u", "alternate mode tracks its own flags");
	// Pop on the alternate screen empties its stack -> zero.
	await writeAll(surface, ["\x1b[<5u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "alternate pop drains to zero, main state untouched");
	// Return to the main buffer: its own flags are restored unchanged.
	await writeAll(surface, ["\x1b[?1049l\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?7u", "return to main restores the main mode's own flags");
	surface.dispose();
});

test("omitted pop count defaults to one (native pi ProcessTerminal's CSI < u)", async () => {
	const replies: string[] = [];
	const surface = makeSurface(4, 20, { onReply: (data) => { replies.push(data); } });
	// The parser hands an omitted count as 0; the protocol default of one
	// applies. Native pi's drainInput/stop emit exactly `CSI < u`, so this
	// must fully clear the negotiated flags.
	await writeAll(surface, ["\x1b[>7u\x1b[<u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "count-less pop pops once and resets to zero");
	assert.equal(surface.inputModes().kittyFlags, 0, "inputModes stops advertising after the count-less pop");
	surface.dispose();
});

test("flags reset to zero on a single push/pop that exhausts the stack", async () => {
	const replies: string[] = [];
	const surface = makeSurface(4, 20, { onReply: (data) => { replies.push(data); } });
	// Set nonzero flags, then a single push/pop cycle must exhaust the stack
	// and reset to zero (not restore the state set beneath).
	await writeAll(surface, ["\x1b[=3;1u\x1b[>7u"]);
	assert.equal(surface.inputModes().kittyFlags, 7, "pushed flags are current while the stack is nonempty");
	await writeAll(surface, ["\x1b[<1u"]);
	assert.equal(surface.inputModes().kittyFlags, 0, "exhausting pop resets despite the nonzero state beneath");
	await writeAll(surface, ["\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "query confirms the reset");
	surface.dispose();
});

test("getSupportedKeyboardFlags masks advertised flags; bad callbacks fail safe to 0", async () => {
	const replies: string[] = [];
	// An owner supporting only flag bit 1 masks every request to 1.
	const masked = makeSurface(4, 20, {
		onReply: (data) => { replies.push(data); },
		getSupportedKeyboardFlags: () => 1,
	});
	await writeAll(masked, ["\x1b[>7u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?1u", "push flags are masked to supported 1");
	await writeAll(masked, ["\x1b[=7;2u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?1u", "set/add is masked to supported 1");
	masked.dispose();

	// A bad callback (out of 0..7) fails safe to 0: nothing is advertised.
	replies.length = 0;
	const unsafe = makeSurface(4, 20, {
		onReply: (data) => { replies.push(data); },
		getSupportedKeyboardFlags: () => 99,
	});
	await writeAll(unsafe, ["\x1b[>7u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "out-of-range support fails safe to zero");
	unsafe.dispose();

	// A throwing callback equally fails safe to 0.
	replies.length = 0;
	const throwing = makeSurface(4, 20, {
		onReply: (data) => { replies.push(data); },
		getSupportedKeyboardFlags: () => { throw new Error("host not ready"); },
	});
	await writeAll(throwing, ["\x1b[>7u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "throwing support callback fails safe to zero");
	throwing.dispose();

	// Support that shrinks after a successful push: queries, add/remove, and
	// pop-restore only expose currently supported bits.
	replies.length = 0;
	let currentSupport = 7;
	const mutable = makeSurface(4, 20, {
		onReply: (data) => { replies.push(data); },
		getSupportedKeyboardFlags: () => currentSupport,
	});
	await writeAll(mutable, ["\x1b[>7u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?7u", "flags advertised while support is 7");
	currentSupport = 0;
	await writeAll(mutable, ["\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "query masks against the shrunk support to zero");
	assert.equal(mutable.inputModes().kittyFlags, 0, "inputModes follows the shrunk support");
	await writeAll(mutable, ["\x1b[=7;2u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "add cannot re-enable unsupported bits");
	await writeAll(mutable, ["\x1b[<5u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "pop-restore is masked by the shrunk support");
	currentSupport = 7;
	await writeAll(mutable, ["\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "previously enabled unsupported bits do not resurface when support returns");
	mutable.dispose();

	// Support that breaks (throwing) after a push stops advertising at once.
	replies.length = 0;
	let broken = false;
	const breakable = makeSurface(4, 20, {
		onReply: (data) => { replies.push(data); },
		getSupportedKeyboardFlags: () => { if (broken) { throw new Error("host gone"); } return 7; },
	});
	await writeAll(breakable, ["\x1b[>7u"]);
	broken = true;
	await writeAll(breakable, ["\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?0u", "throwing support callback masks queried flags to zero");
	assert.equal(breakable.inputModes().kittyFlags, 0, "inputModes reports zero for a broken support callback");
	breakable.dispose();

	// Default (no option): advertised mask is 7 for the virtual input encoder.
	replies.length = 0;
	const def = makeSurface(4, 20, { onReply: (data) => { replies.push(data); } });
	await writeAll(def, ["\x1b[>7u\x1b[?u"]);
	assert.equal(replies[replies.length - 1], "\x1b[?7u", "default support advertises at most 7 of the five protocol bits");
	def.dispose();
});

test("inputModes reports active kitty flags and exact xterm 6 mode fields", async () => {
	const surface = makeSurface(4, 20);
	const initial = surface.inputModes();
	const expectedShape: TerminalInputModes = {
		kittyFlags: 0,
		applicationCursorKeys: false,
		applicationKeypad: false,
		bracketedPaste: false,
		mouseTracking: "none",
		modifyOtherKeys: 0,
		mouseEncoding: "default",
	};
	assert.deepEqual(initial, expectedShape, "idle modes are default VT state");
	await writeAll(surface, ["\x1b[>7u"]);
	assert.equal(surface.inputModes().kittyFlags, 7, "kitty flags follow the active buffer's mode");
	await writeAll(surface, ["\x1b[?1h\x1b[?2004h\x1b[?1003h"]);
	assert.deepEqual(surface.inputModes(), {
		kittyFlags: 7,
		applicationCursorKeys: true,
		applicationKeypad: false,
		bracketedPaste: true,
		mouseTracking: "any",
		modifyOtherKeys: 0,
		mouseEncoding: "default",
	}, "DECSET modes surface through the declared xterm 6 fields");
	await writeAll(surface, ["\x1b="]);
	assert.equal(surface.inputModes().applicationKeypad, true, "DECKPAM ESC = enables application keypad mode");
	await writeAll(surface, ["\x1b>"]);
	assert.equal(surface.inputModes().applicationKeypad, false, "DECKPNM ESC > selects numeric keypad mode");
	await writeAll(surface, ["\x1b[?66h"]);
	assert.equal(surface.inputModes().applicationKeypad, true, "DECSET ?66 also selects application keypad mode");
	await writeAll(surface, ["\x1b[?66l"]);
	assert.equal(surface.inputModes().applicationKeypad, false, "DECRST ?66 returns to numeric keypad mode");
	// Per-buffer: the alternate mode's kitty flags are independent.
	await writeAll(surface, ["\x1b[?1049h\x1b[>5u"]);
	assert.equal(surface.inputModes().kittyFlags, 5, "kitty flags come from the active alternate mode");
	await writeAll(surface, ["\x1b[?1049l"]);
	assert.equal(surface.inputModes().kittyFlags, 7, "restored main mode flags");
	surface.dispose();
});

test("inputModes observes Pi modifyOtherKeys fallback and external-editor disable", async () => {
	const surface = makeSurface(4, 20);
	assert.equal(surface.inputModes().modifyOtherKeys, 0, "fallback starts disabled");
	// Pi ProcessTerminal's Kitty fallback sets modifyOtherKeys mode 2. A zero
	// Kitty flag mask alone cannot distinguish this from legacy keyboard mode.
	await writeAll(surface, ["\x1b[>4;2m"]);
	assert.equal(surface.inputModes().kittyFlags, 0);
	assert.equal(surface.inputModes().modifyOtherKeys, 2, "CSI >4;2m enables the native Pi fallback mode");
	await writeAll(surface, ["\x1b[>5;1m"]);
	assert.equal(surface.inputModes().modifyOtherKeys, 2, "unrelated private CSI command leaves it unchanged");
	await writeAll(surface, ["\x1b[>4;1m"]);
	assert.equal(surface.inputModes().modifyOtherKeys, 1, "mode 1 is observed exactly");
	await writeAll(surface, ["\x1b[>4;0m"]);
	assert.equal(surface.inputModes().modifyOtherKeys, 0, "Pi external-editor drain disables mode 0");
	await writeAll(surface, ["\x1b[>4;2m"]);
	assert.equal(surface.inputModes().modifyOtherKeys, 2);
	await writeAll(surface, ["\x1b[>4;9m"]);
	assert.equal(surface.inputModes().modifyOtherKeys, 2, "unknown values preserve the last supported mode");
	await writeAll(surface, ["\x1b[>4;2;1m"]);
	assert.equal(surface.inputModes().modifyOtherKeys, 2, "unsupported extra parameters preserve the last supported mode");
	await writeAll(surface, ["\x1b[>4m"]);
	assert.equal(surface.inputModes().modifyOtherKeys, 0, "omitted N disables modifyOtherKeys");
	surface.dispose();
});

test("inputModes observes keypad and mouse encodings with xterm parameter ordering", async () => {
	const surface = makeSurface(4, 20);
	assert.equal(surface.inputModes().mouseEncoding, "default");
	await writeAll(surface, ["\x1b[?1006h"]);
	assert.equal(surface.inputModes().mouseEncoding, "sgr");
	await writeAll(surface, ["\x1b[?1016h"]);
	assert.equal(surface.inputModes().mouseEncoding, "sgr-pixels");
	await writeAll(surface, ["\x1b[?1016;1006h"]);
	assert.equal(surface.inputModes().mouseEncoding, "sgr", "last relevant DECSET parameter wins");
	await writeAll(surface, ["\x1b[?1006;1016h"]);
	assert.equal(surface.inputModes().mouseEncoding, "sgr-pixels", "reverse order selects pixel encoding");
	await writeAll(surface, ["\x1b[?1005h\x1b[?1015h"]);
	assert.equal(surface.inputModes().mouseEncoding, "sgr-pixels", "removed legacy encodings have no effect");
	await writeAll(surface, ["\x1b[?1006l"]);
	assert.equal(surface.inputModes().mouseEncoding, "default", "DECRST of either mode resets unconditionally");
	await writeAll(surface, ["\x1b[?1016h\x1b[?1016;1006l"]);
	assert.equal(surface.inputModes().mouseEncoding, "default", "combined DECRST resets to default");
	surface.dispose();
});

test("mode-only input protocol changes invalidate after each complete parse", async () => {
	let changes = 0;
	const surface = makeSurface(4, 20, { onChange: () => { changes += 1; } });
	surface.write("\x1b[>4;2m");
	assert.equal(changes, 0, "modifyOtherKeys observation does not notify synchronously");
	await surface.flush();
	assert.equal(changes, 1, "modifyOtherKeys-only change notifies after parse");
	surface.write("\x1b=");
	assert.equal(changes, 1, "keypad observation does not notify synchronously");
	await surface.flush();
	assert.equal(changes, 2, "application-keypad-only change invalidates after parse");
	surface.write("\x1b[?1006h");
	assert.equal(changes, 2, "mouse encoding observation does not notify synchronously");
	await surface.flush();
	assert.equal(changes, 3, "mouse-encoding-only change invalidates after parse");
	surface.dispose();
});

test("DECSTR retains mouse encoding; RIS resets all observed protocol modes", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, [
		"\x1b[>7u",
		"\x1b[>4;2m",
		"\x1b=\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[?1003h\x1b[?1006h",
	]);
	await writeAll(surface, ["\x1b[!p"]);
	assert.equal(surface.inputModes().mouseEncoding, "sgr", "pinned xterm softReset leaves CoreMouseService encoding unchanged");
	await writeAll(surface, ["\x1bc"]);
	assert.deepEqual(surface.inputModes(), {
		kittyFlags: 0,
		applicationCursorKeys: false,
		applicationKeypad: false,
		bracketedPaste: false,
		mouseTracking: "none",
		modifyOtherKeys: 0,
		mouseEncoding: "default",
	}, "RIS returns native and custom observers to their initial state");
	await writeAll(surface, ["\x1b[>7u\x1b[>4;1m\x1b[?1016h\x1b="]);
	assert.equal(surface.inputModes().kittyFlags, 7, "Kitty observation remains active after RIS");
	assert.equal(surface.inputModes().modifyOtherKeys, 1, "modifyOtherKeys observation remains active after RIS");
	assert.equal(surface.inputModes().mouseEncoding, "sgr-pixels", "mouse encoding observation remains active after RIS");
	assert.equal(surface.inputModes().applicationKeypad, true, "public xterm mode observation remains active after RIS");
	surface.dispose();
});

test("input protocol mode observations are isolated per terminal surface", async () => {
	const surfaceA = makeSurface(3, 10);
	const surfaceB = makeSurface(3, 10);
	await Promise.all([
		writeAll(surfaceA, ["\x1b[>4;2m\x1b[?1006h\x1b="]),
		writeAll(surfaceB, ["\x1b[>4;1m\x1b[?1016h\x1b>"]),
	]);
	assert.deepEqual(surfaceA.inputModes(), {
		kittyFlags: 0,
		applicationCursorKeys: false,
		applicationKeypad: true,
		bracketedPaste: false,
		mouseTracking: "none",
		modifyOtherKeys: 2,
		mouseEncoding: "sgr",
	});
	assert.deepEqual(surfaceB.inputModes(), {
		kittyFlags: 0,
		applicationCursorKeys: false,
		applicationKeypad: false,
		bracketedPaste: false,
		mouseTracking: "none",
		modifyOtherKeys: 1,
		mouseEncoding: "sgr-pixels",
	});
	surfaceA.dispose();
	surfaceB.dispose();
});

test("inputModes after disposal fails explicitly", () => {
	const surface = makeSurface(3, 10);
	surface.dispose();
	assert.throws(() => surface.inputModes(), /disposed/);
});

test("owner callback exceptions never strand the parser's parse lifecycle", async () => {
	let replies = 0;
	const surface = makeSurface(4, 20, {
		onReply: () => { throw new Error("host reply handling broken"); },
		onChange: () => { throw new Error("host change handling broken"); },
	});
	// Query + visible change in one surface with throwing callbacks: the
	// write must still complete its parse promise lifecycle.
	surface.write("\x1b[?u\x1b[?25l");
	await surface.flush();
	assert.ok(replies >= 0, "flush settles even when callbacks throw");
	// Later writes continue to work.
	surface.write("after");
	await surface.flush();
	assert.equal(plainText(surface.frame().lines[0]).trimEnd(), "after");
	surface.dispose();
});

test("Kitty state is isolated per surface", async () => {
	const repliesA: string[] = [];
	const repliesB: string[] = [];
	const surfaceA = makeSurface(3, 10, { onReply: (data) => { repliesA.push(data); } });
	const surfaceB = makeSurface(3, 10, { onReply: (data) => { repliesB.push(data); } });
	await writeAll(surfaceA, [`${ESC}[>7u`]);
	await writeAll(surfaceB, [`${ESC}[?u`]);
	assert.deepEqual(repliesB, ["\x1b[?0u"], "surface B sees no flags from A's push");
	surfaceA.dispose();
	surfaceB.dispose();
});

test("raw OSC 52, window ops, and titles never reach rendered output or replies", async () => {
	const replies: string[] = [];
	const surface = makeSurface(4, 40, { onReply: (data) => { replies.push(data); } });
	const secret64 = "aGVsbG8tc2VjcmV0";
	await writeAll(surface, [
		"before",
		`\x1b]52;c;${secret64}\x1b\\`,
		"\x1b]0;window-title\x07",
		"\x1b[2t",
		"\x1b[9;100;200t",
	]);
	const rendered = surface.frame().lines.map(plainText).join("");
	assert.ok(rendered.includes("before"));
	assert.ok(!rendered.includes("hello-secret"), "OSC 52 decoded payload not rendered");
	assert.ok(!rendered.includes(secret64), "OSC 52 base64 not rendered");
	assert.ok(!rendered.includes("window-title"), "title not rendered");
	assert.deepEqual(replies, [], "no reply generated for swallowed controls");
	surface.dispose();
});

test("frame lines contain only text plus generated allowlisted SGR (no child escape forwarding)", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, [`raw ${ESC}[31m${ESC}[0m text`, "\r\n", `${ESC}]52;c;ZW1wdHk=${ESC}\\`, "\x1b[2t"]);
	for (const line of surface.frame().lines) {
		// Strip every well-formed generated SGR token; nothing else may remain.
		const stripped = line.replace(SGR_PATTERN, "");
		assert.ok(!stripped.includes(ESC), `non-SGR escape forwarded: ${JSON.stringify(line)}`);
		for (const sgr of line.match(/\x1b[^m]*m/g) ?? []) {
			assert.match(sgr, /\x1b\[[0-9;]*m/, `only generated SGR, got ${JSON.stringify(sgr)}`);
		}
	}
	surface.dispose();
});

test("flush resolves for queued writes even when write callbacks complete later", async () => {
	const surface = makeSurface(4, 20);
	// Queue a two-chunk batch without flushing; flush must await both parses.
	surface.write(`${ESC}[31mred${ESC}[0m`);
	surface.write(" plain");
	await surface.flush();
	assert.equal(plainText(surface.frame().lines[0]).trimEnd(), "red plain");
	surface.dispose();
});

test("dispose settles in-flight flush and suppresses owner callbacks", async () => {
	const replies: string[] = [];
	let changes = 0;
	const surface = makeSurface(4, 20, {
		onReply: (data) => { replies.push(data); },
		onChange: () => { changes += 1; },
	});
	// Queue a query; dispose synchronously so no pending parse callback
	// observes a peer callback after disposal.
	surface.write("\x1b[?u");
	const flushing = surface.flush();
	surface.dispose();
	await flushing;
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(replies, [], "pending parse must not call owner replies after dispose");
	assert.deepEqual(changes, 0, "pending parse must not notify onChange after dispose");
	assert.throws(() => surface.write("more"), /disposed/);
	assert.throws(() => surface.frame(), /disposed/);
	// Dispose is idempotent and settles without double-settling errors.
	surface.dispose();
	assert.throws(() => surface.write("x"), /disposed/);
});

test("flush after disposal of a drained surface fails explicitly", async () => {
	const surface = makeSurface(3, 10);
	await writeAll(surface, ["done"]);
	surface.dispose();
	await assert.rejects(surface.flush(), /disposed/);
});

test("flush is deterministic across repeated calls", async () => {
	const surface = makeSurface(3, 10);
	await surface.flush();
	await surface.flush();
	surface.write("x");
	await surface.flush();
	await surface.flush();
	assert.equal(plainText(surface.frame().lines[0]).trimEnd(), "x");
	surface.dispose();
});

test("backpressure watermarks transition high -> low after parse draining", async () => {
	const events: boolean[] = [];
	const surface = makeSurface(24, 80, { onBackpressure: (paused) => { events.push(paused); } });
	const bigChunk = "a".repeat(1 * 1024 * 1024 + 300 * 1024);
	surface.write(bigChunk);
	// Exceeding the high watermark pauses before the chunk has parsed.
	assert.deepEqual(events, [true]);
	await surface.flush();
	assert.deepEqual(events, [true, false], "resume at/below low watermark after parse");
	surface.dispose();
});

test("dispose with tiny queued chunks settles the in-flight flush", async () => {
	const surface = makeSurface(4, 20, { onBackpressure: (paused) => { void paused; } });
	for (let i = 0; i < 2200; i += 1) {
		surface.write("b");
	}
	const flushing = surface.flush();
	surface.dispose();
	await flushing;
	surface.dispose();
});

test("cursor position is 0-based within the viewport after explicit positioning", async () => {
	const surface = makeSurface(4, 10);
	await writeAll(surface, [`${ESC}[2;1H`, "pos"]);
	const frame = surface.frame();
	assert.equal(frame.cursor.column, 3);
	assert.equal(frame.cursor.row, 1);
	surface.dispose();
});

test("wrap-pending cursor remains visible at the right margin", async () => {
	const surface = makeSurface(3, 10);
	await writeAll(surface, ["0123456789"]);
	// Exactly-full row: cursorX === cols is the wrap-pending position, still
	// visible at the clamped last column.
	assert.deepEqual(surface.frame().cursor, {
		column: 9,
		row: 0,
		visible: true,
	});
	await writeAll(surface, ["X"]);
	assert.deepEqual(surface.frame().cursor, {
		column: 1,
		row: 1,
		visible: true,
	});
	await writeAll(surface, [`${ESC}[?25l`]);
	assert.equal(surface.frame().cursor.visible, false);
	surface.dispose();
});

test("rendered output preserves explicit attribute resets at row boundaries", async () => {
	const surface = makeSurface(4, 20);
	await writeAll(surface, [`${ESC}[31mred${ESC}[0m|plain\r\n${ESC}[44mblue-bg${ESC}[0m`]);
	const frame = surface.frame();
	assert.equal(plainText(frame.lines[0]).trimEnd(), "red|plain");
	assert.ok(plainText(frame.lines[0]).includes("|"), "reset boundary kept text separation");
	const row1 = frame.styles?.find((styled) => styled.line === 1);
	assert.ok(row1, "row 1 carries its own background run");
	assert.deepEqual(row1?.runs[0].bg, { mode: "palette", value: 4 });
	assert.ok(row1?.runs.every((run) => !run.text.includes("red")), "reset boundaries keep runs per row");
	surface.dispose();
});