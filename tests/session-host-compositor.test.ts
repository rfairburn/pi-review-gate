import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { sliceByColumn, visibleWidth } from "pi-session-host-tui";
import {
	composeHostFrame,
	computeHostLayout,
	RenderedSidebar,
} from "../src/session-host/compositor";
import { TerminalFrame, TerminalSurface } from "../src/session-host/terminal-surface";

const ESC = "\x1b";
const SGR = /\x1b\[[0-9;]*m/g;

function mainFrame(
	cols: number,
	rows: number,
	lines: string[],
	cursor: { column: number; row: number; visible: boolean } = { column: 0, row: 0, visible: true },
): TerminalFrame {
	return { cols, rows, lines, cursor };
}

function plain(line: string): string {
	return line.replace(SGR, "");
}

function assertBounded(lines: string[], cols: number, rows: number): void {
	assert.equal(lines.length, rows);
	for (const line of lines) {
		assert.equal(visibleWidth(line), cols, `wrong cell width: ${JSON.stringify(line)}`);
	}
}

function noUnsafeControls(lines: string[]): void {
	for (const line of lines) {
		const text = line.replace(SGR, "");
		assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(text), `control survived: ${JSON.stringify(line)}`);
		assert.ok(!text.includes(ESC), `non-SGR escape survived: ${JSON.stringify(line)}`);
	}
}

function resetCount(line: string): number {
	return (line.match(/\x1b\[0m/g) ?? []).length;
}

test("wide layout reserves the header and composes the exact sidebar/divider/native columns", () => {
	const layout = computeHostLayout(60, 4, { sidebarVisible: true, focus: "main" });
	assert.deepEqual(layout, {
		cols: 60,
		rows: 4,
		headerRows: 1,
		native: { column: 33, row: 1, cols: 27, rows: 3 },
		sidebar: { column: 0, row: 1, cols: 32, rows: 3 },
		dividerColumn: 32,
		sidebarOverlay: false,
	});
	const result = composeHostFrame(layout, {
		main: mainFrame(27, 3, ["native", "", "last"]),
		sidebar: { lines: ["side", "", "third"] },
		header: "Host status",
		focus: "main",
	});
	assertBounded(result.lines, 60, 4);
	assert.ok(plain(result.lines[0]).startsWith("Host status"));
	assert.equal(plain(result.lines[1]).slice(0, 32), "side" + " ".repeat(28));
	assert.equal(plain(result.lines[1])[32], "│");
	assert.equal(plain(result.lines[1]).slice(33), "native" + " ".repeat(21));
	assert.equal(result.cursor.visible, true);
	assert.deepEqual(result.cursor, { column: 33, row: 1, visible: true });

	const minimumWide = computeHostLayout(53, 2, { sidebarVisible: true, focus: "main" });
	assert.equal(minimumWide.sidebarOverlay, false);
	assert.deepEqual(minimumWide.native, { column: 33, row: 1, cols: 20, rows: 1 });
});

test("hidden sidebar gives the native pane the full width regardless of frontend focus", () => {
	const layout = computeHostLayout(41, 3, { sidebarVisible: false, focus: "sidebar" });
	assert.deepEqual(layout, {
		cols: 41,
		rows: 3,
		headerRows: 1,
		native: { column: 0, row: 1, cols: 41, rows: 2 },
		sidebarOverlay: false,
	});
	const result = composeHostFrame(layout, {
		main: mainFrame(41, 2, ["native", "row"], { column: 4, row: 0, visible: true }),
		sidebar: { lines: ["not rendered"], cursor: { column: 1, row: 0 } },
		header: "label",
		focus: "sidebar",
	});
	assertBounded(result.lines, 41, 3);
	assert.ok(plain(result.lines[1]).startsWith("native"));
	assert.equal(plain(result.lines[1]).includes("not rendered"), false);
	assert.equal(result.cursor.visible, false, "hidden sidebar cannot claim a cursor");
});

test("narrow layout keeps native geometry stable and overlays only for non-main focus", () => {
	const mainLayout = computeHostLayout(52, 4, { sidebarVisible: true, focus: "main" });
	const sidebarLayout = computeHostLayout(52, 4, { sidebarVisible: true, focus: "sidebar" });
	assert.equal(mainLayout.sidebarOverlay, true);
	assert.equal(mainLayout.native.cols, 52);
	assert.equal(mainLayout.sidebar, undefined, "main focus leaves the overlay out of the frame");
	assert.deepEqual(sidebarLayout.native, mainLayout.native);
	assert.deepEqual(sidebarLayout.sidebar, { column: 0, row: 1, cols: 52, rows: 3 });

	const native = mainFrame(52, 3, ["native main", "second", "third"], { column: 6, row: 1, visible: true });
	const mainResult = composeHostFrame(mainLayout, {
		main: native,
		sidebar: { lines: ["overlay", "overlay2", "overlay3"], cursor: { column: 2, row: 0 } },
		header: "host",
		focus: "main",
	});
	assert.equal(plain(mainResult.lines[1]).slice(0, 11), "native main");
	assert.equal(mainResult.cursor.visible, true);
	assert.deepEqual(mainResult.cursor, { column: 6, row: 2, visible: true });

	const overlayResult = composeHostFrame(sidebarLayout, {
		main: native,
		sidebar: { lines: ["overlay", "overlay2", "overlay3"], cursor: { column: 2, row: 0 } },
		header: "host",
		focus: "sidebar",
	});
	assert.equal(plain(overlayResult.lines[1]).slice(0, 7), "overlay");
	assert.equal(overlayResult.cursor.visible, true);
	assert.deepEqual(overlayResult.cursor, { column: 2, row: 1, visible: true });

	const handoffResult = composeHostFrame(sidebarLayout, {
		main: native,
		sidebar: { lines: ["overlay"], cursor: { column: 2, row: 0 } },
		header: "host",
		focus: "main",
	});
	assertBounded(handoffResult.lines, 52, 4);
	assert.ok(plain(handoffResult.lines[1]).startsWith("native main"));
	assert.deepEqual(handoffResult.cursor, { column: 6, row: 2, visible: true });

	const formLayout = computeHostLayout(52, 4, { sidebarVisible: true, focus: "form" });
	const formResult = composeHostFrame(formLayout, {
		main: native,
		sidebar: { lines: ["form pane"], cursor: { column: 4, row: 0 } },
		header: "host",
		focus: "form",
	});
	assert.equal(plain(formResult.lines[1]).startsWith("form pane"), true);
	assert.deepEqual(formResult.cursor, { column: 4, row: 1, visible: true });
});

test("missing native content shows the welcome fallback despite supplied but hidden sidebar data", () => {
	const sidebar: RenderedSidebar = { lines: ["sidebar data"] };
	const narrowMainFocus = composeHostFrame(
		computeHostLayout(52, 2, { sidebarVisible: true, focus: "main" }),
		{ sidebar, header: "host", focus: "main" },
	);
	assert.ok(plain(narrowMainFocus.lines[1]).startsWith("Welcome —"));
	assert.equal(plain(narrowMainFocus.lines[1]).includes("sidebar data"), false);

	const hiddenSidebar = composeHostFrame(
		computeHostLayout(40, 2, { sidebarVisible: false, focus: "sidebar" }),
		{ sidebar, header: "host", focus: "sidebar" },
	);
	assert.ok(plain(hiddenSidebar.lines[1]).startsWith("Welcome —"));
	assert.equal(plain(hiddenSidebar.lines[1]).includes("sidebar data"), false);

	const visibleSidebar = composeHostFrame(
		computeHostLayout(60, 2, { sidebarVisible: true, focus: "sidebar" }),
		{ sidebar, header: "host", focus: "sidebar" },
	);
	assert.ok(plain(visibleSidebar.lines[1]).startsWith("sidebar data"), "visible sidebar content is preserved");
	assert.ok(plain(visibleSidebar.lines[1]).slice(33).startsWith("Welcome —"), "native pane still receives the fallback");
});

test("one-column and tiny-height layouts remain bounded and reserve a header only when possible", () => {
	const oneByOneMain = computeHostLayout(1, 1, { sidebarVisible: true, focus: "main" });
	assert.equal(oneByOneMain.headerRows, 0);
	assert.deepEqual(oneByOneMain.native, { column: 0, row: 0, cols: 1, rows: 1 });
	const tinyMain = composeHostFrame(oneByOneMain, {
		main: mainFrame(1, 1, ["界"], { column: 0, row: 0, visible: true }),
		header: "ignored because there is no header row",
		focus: "main",
	});
	assertBounded(tinyMain.lines, 1, 1);
	assert.equal(plain(tinyMain.lines[0]), " ", "a wide grapheme is not split into a one-cell pane");

	const oneByOneOverlay = computeHostLayout(1, 1, { sidebarVisible: true, focus: "confirm" });
	assert.equal(oneByOneOverlay.headerRows, 0);
	assert.deepEqual(oneByOneOverlay.sidebar, { column: 0, row: 0, cols: 1, rows: 1 });
	const overlay = composeHostFrame(oneByOneOverlay, {
		sidebar: { lines: ["OK"], cursor: { column: 0, row: 0 } },
		header: "unused",
		focus: "confirm",
	});
	assertBounded(overlay.lines, 1, 1);
	assert.equal(plain(overlay.lines[0]), "O");
	assert.deepEqual(overlay.cursor, { column: 0, row: 0, visible: true });

	const twoRows = computeHostLayout(52, 2, { sidebarVisible: true, focus: "sidebar" });
	assert.equal(twoRows.headerRows, 1);
	assert.equal(twoRows.native.rows, 1);
	const result = composeHostFrame(twoRows, { sidebar: { lines: ["short"] }, header: "H", focus: "sidebar" });
	assertBounded(result.lines, 52, 2);
	assert.ok(plain(result.lines[0]).startsWith("H"));
});

test("pinned width helpers clip CJK, basic emoji, and combining text without a partial wide glyph", () => {
	const layout = computeHostLayout(2, 3, { sidebarVisible: false, focus: "main" });
	const result = composeHostFrame(layout, {
		main: mainFrame(2, 2, ["A界", "A🙂"], { column: 0, row: 0, visible: false }),
		header: "",
		focus: "main",
	});
	assertBounded(result.lines, 2, 3);
	assert.equal(plain(result.lines[1]), "A ", "CJK wide character does not cross the right edge");
	assert.equal(plain(result.lines[1]).includes("界"), false);
	assert.equal(plain(result.lines[2]), "A ", "emoji does not cross the right edge");

	const clippedEmoji = composeHostFrame(computeHostLayout(2, 2, { sidebarVisible: false, focus: "main" }), {
		main: mainFrame(2, 1, ["A🙂"]),
		header: "",
		focus: "main",
	});
	assert.equal(plain(clippedEmoji.lines[1]), "A ", "basic emoji is clipped as a complete grapheme");
	assert.equal(visibleWidth("e\u0301"), 1, "pinned alias recognizes basic combining text");
	assert.equal(sliceByColumn("e\u0301🙂", 0, 2, true), "e\u0301");
	const combining = composeHostFrame(computeHostLayout(2, 2, { sidebarVisible: false, focus: "main" }), {
		main: mainFrame(2, 1, ["e\u0301🙂"]),
		header: "",
		focus: "main",
	});
	assert.equal(plain(combining.lines[1]), "e\u0301 ", "combining sequence stays attached while the following emoji is clipped");
});

test("real styled TerminalSurface snapshots compose with independent pane SGR resets", async () => {
	const surface = new TerminalSurface(5, 2);
	try {
		surface.write(`${ESC}[31mMAIN`);
		await surface.flush();
		const frame = surface.frame();
		const originalFrame = structuredClone(frame);
		const layout = computeHostLayout(60, 3, { sidebarVisible: true, focus: "sidebar" });
		const result = composeHostFrame(layout, {
			main: frame,
			sidebar: { lines: [`${ESC}[32mSIDE`] },
			header: "label",
			focus: "sidebar",
		});
		assertBounded(result.lines, 60, 3);
		assert.deepEqual(frame, originalFrame, "composition does not mutate a surface frame or style data");
		assert.ok(result.lines[1].startsWith(`${ESC}[0m${ESC}[32mSIDE`));
		assert.ok(result.lines[1].includes(`${ESC}[0m│${ESC}[0m`), "divider owns and resets its styling");
		assert.ok(result.lines[1].includes(`${ESC}[31mMAIN${ESC}[0m`));
		assert.ok(resetCount(result.lines[1]) >= 5, "each panel and divider is reset independently");
		assert.equal(plain(result.lines[1]).slice(33, 37), "MAIN");
	} finally {
		surface.dispose();
	}
});

test("unknown ESC followers preserve supplementary Unicode and UTF-8 terminal width", () => {
	const result = composeHostFrame(computeHostLayout(2, 2, { sidebarVisible: false, focus: "main" }), {
		main: mainFrame(2, 1, [`${ESC}🙂X`]),
		header: `${ESC}🙂X`,
		focus: "main",
	});
	assertBounded(result.lines, 2, 2);
	assert.equal(plain(result.lines[0]), "🙂");
	assert.equal(plain(result.lines[1]), "🙂");
	for (const line of result.lines) {
		assert.equal(Buffer.from(line, "utf8").toString("utf8"), line, "output contains no split surrogate");
	}
});

test("header and pane reject OSC, CSI, C0/C1, and non-SGR terminal control injection", () => {
	const layout = computeHostLayout(40, 2, { sidebarVisible: false, focus: "main" });
	const result = composeHostFrame(layout, {
		main: mainFrame(40, 1, [
			`safe${ESC}]2;owned-title\x07tail${ESC}[?25lafter\x01x\u009b31m\u009d52;clip\u009c!`,
		]),
		header: `Host${ESC}]0;window-title\x07${ESC}[2Jstatus\x01\u009b31m\u009d8;;https://example.test\u009c`,
		focus: "main",
	});
	assertBounded(result.lines, 40, 2);
	noUnsafeControls(result.lines);
	assert.ok(plain(result.lines[0]).startsWith("Hoststatus"));
	assert.ok(plain(result.lines[1]).startsWith("safetailafterx!"));
	assert.equal(result.lines[0].includes("window-title"), false);
	assert.equal(result.lines[1].includes("owned-title"), false);
	assert.equal(result.lines[1].includes("https://example.test"), false);
});

test("stale and missing frames are clipped or padded, while unsafe or stale cursors stay hidden", () => {
	const layout = computeHostLayout(10, 3, { sidebarVisible: false, focus: "main" });
	const stale = mainFrame(5, 1, [`${ESC}[31m123456789012345`, "extra"], { column: 4, row: 0, visible: true });
	const original = structuredClone(stale);
	const result = composeHostFrame(layout, { main: stale, header: "h", focus: "main" });
	assertBounded(result.lines, 10, 3);
	assert.ok(plain(result.lines[1]).startsWith("1234567890"));
	assert.equal(plain(result.lines[2]), " ".repeat(10), "missing source rows are padded");
	assert.deepEqual(result.cursor, { column: 0, row: 0, visible: false }, "stale dimensions invalidate cursor geometry");
	assert.deepEqual(stale, original, "stale frame remains unchanged");

	const missing = composeHostFrame(layout, { header: "h", focus: "main" });
	assertBounded(missing.lines, 10, 3);
	assert.equal(missing.cursor.visible, false);
	assert.ok(plain(missing.lines[1]).startsWith("Welcome —"), "an empty host shows safe picker text instead of a blank frame");

	const outsideCursor = composeHostFrame(layout, {
		main: mainFrame(10, 2, ["row"], { column: 12, row: 0, visible: true }),
		header: "h",
		focus: "main",
	});
	assert.equal(outsideCursor.cursor.visible, false, "cursor beyond pane is hidden, not projected outside");

	const wrapPending = composeHostFrame(layout, {
		main: mainFrame(10, 2, ["row"], { column: 10, row: 1, visible: true }),
		header: "h",
		focus: "main",
	});
	assert.deepEqual(wrapPending.cursor, { column: 9, row: 2, visible: true }, "wrap-pending column is clamped within its pane");
});

test("focus handoff chooses only the focused pane cursor; exited frames remain last-frame text", async () => {
	const layoutMain = computeHostLayout(60, 3, { sidebarVisible: true, focus: "main" });
	const frame = mainFrame(27, 2, ["EXITED: final output", ""], { column: 4, row: 0, visible: true });
	const sidebar: RenderedSidebar = { lines: ["picker"], cursor: { column: 1, row: 0 } };
	const mainResult = composeHostFrame(layoutMain, { main: frame, sidebar, header: "host", focus: "main" });
	assert.deepEqual(mainResult.cursor, { column: 37, row: 1, visible: true });
	assert.ok(plain(mainResult.lines[1]).includes("EXITED: final output"));

	const sidebarLayout = computeHostLayout(60, 3, { sidebarVisible: true, focus: "sidebar" });
	const sidebarResult = composeHostFrame(sidebarLayout, { main: frame, sidebar, header: "host", focus: "sidebar" });
	assert.deepEqual(sidebarResult.cursor, { column: 1, row: 1, visible: true });
	assert.ok(plain(sidebarResult.lines[1]).includes("EXITED: final output"), "last frame remains visible without lifecycle interpretation");
	assert.equal(plain(sidebarResult.lines.join("\n")).includes("Idle"), false, "composer invents no exited/idle state");

	const empty = composeHostFrame(computeHostLayout(30, 2, { sidebarVisible: false, focus: "main" }), {
		header: "Session host",
		focus: "main",
	});
	assert.ok(plain(empty.lines[1]).startsWith("Welcome — select a session"));
	assert.equal(visibleWidth(plain(empty.lines[1])), 30);
});

test("dimensions use the TerminalSurface integer bounds", () => {
	for (const cols of [0, -1, 1.5, 1001]) {
		assert.throws(() => computeHostLayout(cols, 2, { sidebarVisible: false, focus: "main" }), /cols/);
	}
	for (const rows of [0, -1, 2.5, 1001]) {
		assert.throws(() => computeHostLayout(2, rows, { sidebarVisible: false, focus: "main" }), /rows/);
	}
});
