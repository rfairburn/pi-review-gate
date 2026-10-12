/**
 * Native synchronized-output frames (`CSI ? 2026 h` ... `CSI ? 2026 l`) in the
 * hosted TerminalSurface: committed text/cursor/graphics snapshots, Kitty
 * anchors finalized against completed frames, and fail-closed bounds.
 *
 * The streams below reproduce the shape of Pi 1.1 fullscreen redraws: a
 * synchronized frame that deletes all placements (`a=d,d=a`) and then
 * rewrites every row top to bottom (`CUP; EL 2; row`), with a multi-row image
 * written as one `a=p` at its top row followed by blank lower rows. All PNGs
 * are small synthetic fixtures generated here.
 */
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { computeHostLayout, composeHostFrame } from "../src/session-host/compositor";
import { createSessionHostFrameWriter } from "../src/session-host/frame-writer";
import {
	createTerminalGraphicsBudget,
	type TerminalGraphicsBudget,
	type TerminalGraphicsBudgetLease,
} from "../src/session-host/kitty-graphics";
import { TerminalSurface, type TerminalFrame } from "../src/session-host/terminal-surface";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const BEGIN = `${ESC}[?2026h`;
const END = `${ESC}[?2026l`;
const COLS = 20;
const ROWS = 10;
const IMAGE_ID = 9;
const IMAGE_COLUMNS = 4;
const IMAGE_ROW_PX = 20;

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

function pngBase64(width: number, height: number): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const raw = Buffer.alloc(height * (width * 4 + 1), 0x5a);
	for (let row = 0; row < height; row += 1) {
		raw[row * (width * 4 + 1)] = 0;
	}
	const chunk = (type: string, data: Buffer) => {
		const typeBytes = Buffer.from(type, "ascii");
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
		return Buffer.concat([length, typeBytes, data, crc]);
	};
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function rows(frame: TerminalFrame): string[] {
	return frame.lines.map((line) => plain(line).trimEnd());
}

/** Counts outstanding leases of a real shared budget, split by kind. */
function countingBudget(): { budget: TerminalGraphicsBudget; active: () => { images: number; placements: number; total: number } } {
	const inner = createTerminalGraphicsBudget();
	let images = 0;
	let placements = 0;
	let total = 0;
	const wrap = (lease: TerminalGraphicsBudgetLease | undefined, kind: "image" | "placement" | "other") => {
		if (!lease) {
			return undefined;
		}
		total += 1;
		if (kind === "image") images += 1;
		if (kind === "placement") placements += 1;
		let live = true;
		return {
			release: () => {
				if (!live) return;
				live = false;
				total -= 1;
				if (kind === "image") images -= 1;
				if (kind === "placement") placements -= 1;
				lease.release();
			},
		};
	};
	return {
		budget: {
			reserveImage: (encoded, decoded, pixels) => wrap(inner.reserveImage(encoded, decoded, pixels), "image"),
			reserveFallbackImage: () => wrap(inner.reserveFallbackImage(), "other"),
			reservePlacement: (fallback) => wrap(inner.reservePlacement(fallback), "placement"),
			reservePendingTransfer: () => wrap(inner.reservePendingTransfer(), "other"),
			reservePendingBytes: (bytes) => wrap(inner.reservePendingBytes(bytes), "other"),
		},
		active: () => ({ images, placements, total }),
	};
}

interface Transcript {
	readonly lines: readonly string[];
	readonly imageTop: number;
	readonly imageRows: number;
	readonly png: string;
}

function transcript(imageTop: number, imageRows: number, options: { blankBelow?: number } = {}): Transcript {
	const lines: string[] = [];
	for (let index = 0; index < 40; index += 1) {
		const blank = options.blankBelow !== undefined
			&& index >= imageTop + imageRows && index < imageTop + imageRows + options.blankBelow;
		lines.push(blank ? "" : `text line ${index}`);
	}
	return { lines, imageTop, imageRows, png: pngBase64(IMAGE_COLUMNS * 10, imageRows * IMAGE_ROW_PX) };
}

/** Pi-shaped viewport rows: image line at its top row (top-cropped when scrolled past), blank lower rows. */
function viewport(doc: Transcript, scrollTop: number, transmit: boolean): string[] {
	const screen: string[] = [];
	for (let row = 0; row < ROWS; row += 1) {
		const index = scrollTop + row;
		const offset = index - doc.imageTop;
		if (offset >= 0 && offset < doc.imageRows) {
			const hidden = scrollTop - doc.imageTop;
			if (offset === 0 && transmit) {
				screen.push(`${ESC}_Ga=T,f=100,q=2,C=1,c=${IMAGE_COLUMNS},r=${doc.imageRows},i=${IMAGE_ID};${doc.png}${ST}`);
			} else if (offset === 0) {
				screen.push(`${ESC}_Ga=p,q=2,C=1,c=${IMAGE_COLUMNS},r=${doc.imageRows},i=${IMAGE_ID}${ST}`);
			} else if (row === 0 && hidden > 0) {
				const visible = doc.imageRows - hidden;
				screen.push(`${ESC}_Ga=p,q=2,C=1,c=${IMAGE_COLUMNS},i=${IMAGE_ID},y=${hidden * IMAGE_ROW_PX},h=${visible * IMAGE_ROW_PX},r=${visible}${ST}`);
			} else {
				screen.push("");
			}
		} else {
			screen.push(doc.lines[index] ?? "");
		}
	}
	return screen;
}

function imageVisible(doc: Transcript, scrollTop: number): boolean {
	return doc.imageTop + doc.imageRows > scrollTop && doc.imageTop < scrollTop + ROWS;
}

/** One Pi-shaped native synchronized redraw of every row, top to bottom. */
function nativeFrame(screen: readonly string[], prefix: string): string {
	let data = BEGIN + prefix;
	screen.forEach((line, row) => {
		data += `${ESC}[${row + 1};1H${ESC}[2K${line}`;
	});
	return `${data}${ESC}[?25l${END}`;
}

const ENTER_ALT = `${ESC}[?1049h${ESC}[?7l${ESC}[2J${ESC}[H${ESC}[?25l`;

function scrollSession(doc: Transcript, positions: readonly number[]): { label: string; data: string; expectVisible: boolean; scrollTop: number }[] {
	const frames = [{
		label: "first load",
		data: nativeFrame(viewport(doc, positions[0] as number, true), `${ESC}_Ga=d,d=A,q=2${ST}${ESC}[2J`),
		expectVisible: imageVisible(doc, positions[0] as number),
		scrollTop: positions[0] as number,
	}];
	for (let index = 1; index < positions.length; index += 1) {
		const previous = positions[index - 1] as number;
		const scrollTop = positions[index] as number;
		const redrawImages = imageVisible(doc, previous) || imageVisible(doc, scrollTop);
		frames.push({
			label: `scroll ${previous} -> ${scrollTop}`,
			data: nativeFrame(viewport(doc, scrollTop, false), redrawImages ? `${ESC}_Ga=d,d=a,q=2${ST}` : ""),
			expectVisible: imageVisible(doc, scrollTop),
			scrollTop,
		});
	}
	return frames;
}

async function deliver(surface: TerminalSurface, data: string, fragment: number): Promise<void> {
	if (fragment <= 0) {
		surface.write(data);
	} else {
		for (let offset = 0; offset < data.length; offset += fragment) {
			surface.write(data.slice(offset, offset + fragment));
			if ((offset / fragment) % 64 === 63) {
				await surface.flush();
			}
		}
	}
	await surface.flush();
}

interface ReplayResult {
	readonly finals: string[];
	readonly absentNotifications: string[];
	readonly uploads: number;
}

/** Replay through the surface plus the real compositor and frame writer, like Main. */
async function replay(doc: Transcript, positions: readonly number[], fragment: number): Promise<ReplayResult> {
	let output = "";
	const sink = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			output += chunk.toString("utf8");
			callback();
		},
	});
	const writer = createSessionHostFrameWriter(sink, { graphicsEnabled: true, redrawIntervalMs: 0 });
	writer.start();
	const layout = computeHostLayout(COLS, ROWS + 1, { sidebarVisible: false, focus: "main" });
	const absentNotifications: string[] = [];
	let label = "";
	let mustStayVisible = false;
	const surface: TerminalSurface = new TerminalSurface(COLS, ROWS, {
		onChange: () => {
			const frame = surface.frame();
			if (mustStayVisible && (frame.graphics?.placements.length ?? 0) === 0) {
				absentNotifications.push(label);
			}
			writer.submit(composeHostFrame(layout, {
				main: frame,
				sidebar: { lines: [] },
				...(frame.graphics ? { nativeGraphics: { ownerId: "child", pane: layout.native, frame: frame.graphics } } : {}),
				header: "replay",
				focus: "main",
			}), COLS, ROWS + 1);
		},
	});
	await deliver(surface, ENTER_ALT, fragment);
	const finals: string[] = [];
	let uploadsAfterFirstLoad = 0;
	let previousVisible = false;
	for (const frame of scrollSession(doc, positions)) {
		label = frame.label;
		// A visible image may move, but must never be published absent while
		// the completed native frame still shows it.
		mustStayVisible = previousVisible && frame.expectVisible;
		const before = output.length;
		await deliver(surface, frame.data, fragment);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const final = surface.frame();
		assert.equal(
			(final.graphics?.placements.length ?? 0) > 0,
			frame.expectVisible,
			`${frame.label} (fragment ${fragment}): image visibility at frame end`,
		);
		if (frame.expectVisible) {
			const placement = final.graphics?.placements[0];
			const hidden = Math.max(0, frame.scrollTop - doc.imageTop);
			assert.equal(placement?.row, Math.max(0, doc.imageTop - frame.scrollTop), `${frame.label}: exact event-time row`);
			assert.equal(placement?.column, 0);
			assert.equal(placement?.rows, doc.imageRows - hidden);
			assert.deepEqual(placement?.crop, {
				x: 0,
				y: hidden * IMAGE_ROW_PX,
				width: IMAGE_COLUMNS * 10,
				height: (doc.imageRows - hidden) * IMAGE_ROW_PX,
			}, `${frame.label}: exact crop`);
			assert.equal(final.graphics?.images[0]?.base64, doc.png);
		}
		finals.push(JSON.stringify(final));
		if (frame.label !== "first load" && previousVisible && frame.expectVisible) {
			// Re-entry after a full scroll-out may legitimately upload again.
			uploadsAfterFirstLoad += (output.slice(before).match(/\x1b_G(?:[^;\x1b]*,)?a=[tT](?:,|;)/g) ?? []).length;
		}
		previousVisible = frame.expectVisible;
	}
	surface.dispose();
	await writer.close();
	return { finals, absentNotifications, uploads: uploadsAfterFirstLoad };
}

// Downward moves (1 row), a 2-row jump, 2-row upward moves, top-cropped exit
// and re-entry, and full scroll-out.
const POSITIONS = [0, 1, 2, 3, 5, 3, 1, 3, 6, 9, 10, 12, 10, 9, 7, 4];

test("native top-to-bottom redraws keep a multi-row image over stale lower text without drops or reuploads", async () => {
	const doc = transcript(8, 3);
	const whole = await replay(doc, POSITIONS, 0);
	assert.deepEqual(whole.absentNotifications, [], "no intermediate empty graphics notification during a valid redraw");
	assert.equal(whole.uploads, 0, "the host never re-uploads identical PNG data while scrolling");
	for (const fragment of [64, 1024]) {
		const fragmented = await replay(doc, POSITIONS, fragment);
		assert.deepEqual(fragmented.absentNotifications, [], `fragment ${fragment}: no intermediate absence`);
		assert.equal(fragmented.uploads, 0, `fragment ${fragment}: no reupload`);
		assert.deepEqual(fragmented.finals, whole.finals, `fragment ${fragment}: converges to the same completed frames`);
	}
});

test("one-row and blank-spacer controls stay stable, including 2-row jumps spacers alone do not protect", async () => {
	for (const doc of [transcript(8, 1), transcript(8, 3, { blankBelow: 6 })]) {
		const result = await replay(doc, POSITIONS, 0);
		assert.deepEqual(result.absentNotifications, []);
		assert.equal(result.uploads, 0);
	}
});

async function placedImageSurface(options: { onChange?: () => void; budget?: TerminalGraphicsBudget } = {}): Promise<{ surface: TerminalSurface; doc: Transcript }> {
	const doc = transcript(2, 3);
	const surface = new TerminalSurface(COLS, ROWS, {
		...(options.onChange ? { onChange: options.onChange } : {}),
		...(options.budget ? { graphicsBudget: options.budget } : {}),
	});
	surface.write(ENTER_ALT);
	surface.write(scrollSession(doc, [0])[0]?.data as string);
	await surface.flush();
	assert.equal(surface.frame().graphics?.placements[0]?.row, 2, "image placed at its first-load row");
	return { surface, doc };
}

test("first placement over old text anchors against the completed frame", async () => {
	const surface = new TerminalSurface(COLS, ROWS);
	surface.write(ENTER_ALT);
	surface.write(`${ESC}[1;1Hold one${ESC}[2;1Hold two${ESC}[3;1Hold three${ESC}[4;1Hold four`);
	await surface.flush();
	const doc = transcript(1, 3);
	const screen = viewport(doc, 0, true);
	surface.write(nativeFrame(screen, `${ESC}_Ga=d,d=a,q=2${ST}`));
	await surface.flush();
	const placement = surface.frame().graphics?.placements[0];
	assert.equal(placement?.row, 1);
	assert.equal(placement?.rows, 3);
	surface.dispose();
});

test("unframed overwrites of image rows still invalidate the image", async () => {
	const { surface } = await placedImageSurface();
	surface.write(`${ESC}[4;1Hoverwritten`);
	await surface.flush();
	assert.equal(surface.frame().graphics, undefined, "nonsynchronized text over a covered row removes the image");
	surface.dispose();
});

test("old placements not replaced in a frame are validated, never re-anchored, at frame end", async () => {
	let changes = 0;
	const { surface } = await placedImageSurface({ onChange: () => { changes += 1; } });
	// A frame that only rewrites unrelated rows keeps the image.
	surface.write(`${BEGIN}${ESC}[8;1H${ESC}[2Kunrelated${END}`);
	await surface.flush();
	assert.equal(surface.frame().graphics?.placements.length, 1);

	// A frame that overwrites a covered row without re-placing removes it at
	// commit, but the held committed snapshot still shows it mid-frame.
	changes = 0;
	surface.write(`${BEGIN}${ESC}[4;1H${ESC}[2Kreplacement text`);
	await surface.flush();
	assert.equal(changes, 0, "no notification while the frame is open");
	assert.equal(surface.frame().graphics?.placements.length, 1, "held snapshot");
	assert.ok(!rows(surface.frame()).includes("replacement text"), "held text excludes the incomplete frame");
	surface.write(END);
	await surface.flush();
	assert.equal(surface.frame().graphics, undefined, "covered text changed: committed removal");
	assert.ok(rows(surface.frame()).includes("replacement text"));
	assert.equal(changes, 1, "exactly one notification for the committed frame");
	surface.dispose();
});

test("scoped deletes without replacement commit removal at frame end", async () => {
	for (const deletion of [`a=d,d=I,i=${IMAGE_ID},q=2`, "a=d,d=a,q=2"]) {
		const { surface } = await placedImageSurface();
		surface.write(`${BEGIN}${ESC}_G${deletion}${ST}${ESC}[1;1H${ESC}[2Kstill drawing`);
		await surface.flush();
		assert.equal(surface.frame().graphics?.placements.length, 1, `${deletion}: not published mid-frame`);
		surface.write(END);
		await surface.flush();
		assert.equal(surface.frame().graphics, undefined, `${deletion}: removal committed`);
		surface.dispose();
	}
});

test("destructive controls inside a frame apply to placements made before them", async () => {
	const { surface, doc } = await placedImageSurface();
	const placement = viewport(doc, 0, false)[2] as string;
	surface.write(`${BEGIN}${ESC}_Ga=d,d=a,q=2${ST}${ESC}[3;1H${placement}${ESC}[2J${END}`);
	await surface.flush();
	assert.equal(surface.frame().graphics, undefined, "ED after the placement clears it");
	surface.write(`${BEGIN}${ESC}[2J${ESC}[3;1H${placement}${END}`);
	await surface.flush();
	assert.equal(surface.frame().graphics?.placements.length, 1, "ED before the placement does not");
	surface.dispose();
});

test("a held frame exposes one coherent committed text/cursor state and holds mouse grants", async () => {
	let changes = 0;
	const surface = new TerminalSurface(COLS, ROWS, { onChange: () => { changes += 1; } });
	surface.write(`${ESC}[?1049h${ESC}[1;1Hbefore${ESC}[2;3H`);
	await surface.flush();
	const committed = surface.frame();
	changes = 0;
	surface.write(`${BEGIN}${ESC}[1;1H${ESC}[2Kafter${ESC}[5;7H${ESC}[?1000h${ESC}[?1006h${ESC}[?1h`);
	await surface.flush();
	assert.deepEqual(surface.frame(), committed, "frame() returns the last complete state");
	assert.equal(changes, 0);
	assert.equal(surface.inputModes().mouseTracking, "none", "an incomplete frame cannot grant mouse reporting");
	assert.equal(surface.inputModes().applicationCursorKeys, true, "keyboard protocol follows the child's live state");
	surface.write(END);
	await surface.flush();
	assert.equal(changes, 1);
	assert.equal(rows(surface.frame())[0], "after");
	assert.deepEqual(surface.frame().cursor, { column: 6, row: 4, visible: true });
	assert.equal(surface.inputModes().mouseTracking, "vt200");

	surface.write(`${BEGIN}${ESC}[?1000l`);
	await surface.flush();
	assert.equal(surface.inputModes().mouseTracking, "none", "revocation inside a frame applies at once");
	surface.write(END);
	await surface.flush();
	surface.dispose();
});

test("mouse reporting already enabled before a frame is withheld until the frame commits", async () => {
	const surface = new TerminalSurface(COLS, ROWS);
	surface.write(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h${ESC}[1;1Hbutton`);
	await surface.flush();
	assert.equal(surface.inputModes().mouseTracking, "vt200");
	assert.equal(surface.inputModes().mouseEncoding, "sgr");

	// Unchanged modes: the child redraws interactive rows while frame() still
	// shows the old content, so clicks are not forwarded against either.
	surface.write(`${BEGIN}${ESC}[1;1H${ESC}[2Kmoved`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "button");
	assert.equal(surface.inputModes().mouseTracking, "none", "unchanged mouse modes are still withheld mid-frame");
	assert.equal(surface.inputModes().mouseEncoding, "sgr");

	// Revoke and re-grant inside the same held frame.
	surface.write(`${ESC}[?1000l`);
	await surface.flush();
	assert.equal(surface.inputModes().mouseTracking, "none");
	surface.write(`${ESC}[?1000h`);
	await surface.flush();
	assert.equal(surface.inputModes().mouseTracking, "none", "a re-grant inside an incomplete frame is not authorization");

	surface.write(END);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "moved");
	assert.equal(surface.inputModes().mouseTracking, "vt200", "the completed frame restores reporting");
	surface.dispose();
});

test("requested mouse reporting for outer capture follows the committed frame, separate from packet authorization", async () => {
	let changes = 0;
	const surface = new TerminalSurface(COLS, ROWS, { onChange: () => { changes += 1; } });
	assert.deepEqual(surface.requestedMouseReporting(), { mouseTracking: "none", mouseEncoding: "default" });
	surface.write(`${ESC}[?1049h${ESC}[?1002h${ESC}[?1006h${ESC}[1;1Hrow`);
	await surface.flush();
	assert.deepEqual(surface.requestedMouseReporting(), { mouseTracking: "drag", mouseEncoding: "sgr" });

	// A no-change held frame: the request stays, packets are withheld, and
	// the commit needs no notification because nothing visible changed.
	changes = 0;
	surface.write(`${BEGIN}${ESC}[1;1H${ESC}[2Krow`);
	await surface.flush();
	assert.equal(surface.inputModes().mouseTracking, "none", "packet authorization is still withheld mid-frame");
	assert.deepEqual(surface.requestedMouseReporting(), { mouseTracking: "drag", mouseEncoding: "sgr" },
		"outer capture keeps the committed request mid-frame");
	surface.write(END);
	await surface.flush();
	assert.equal(changes, 0, "a no-change commit does not notify");
	assert.equal(surface.inputModes().mouseTracking, "drag");
	assert.deepEqual(surface.requestedMouseReporting(), { mouseTracking: "drag", mouseEncoding: "sgr" });

	// Revoke then re-grant inside one frame: no mid-frame churn, no notify.
	surface.write(`${BEGIN}${ESC}[?1002l`);
	await surface.flush();
	assert.deepEqual(surface.requestedMouseReporting(), { mouseTracking: "drag", mouseEncoding: "sgr" });
	surface.write(`${ESC}[?1002h${END}`);
	await surface.flush();
	assert.equal(changes, 0);

	// A real revocation and encoding change inside a frame apply at commit
	// and notify the owner, so the outer terminal is reconfigured then.
	surface.write(`${BEGIN}${ESC}[?1002l${ESC}[?1016h`);
	await surface.flush();
	assert.deepEqual(surface.requestedMouseReporting(), { mouseTracking: "drag", mouseEncoding: "sgr" });
	assert.equal(changes, 0);
	surface.write(END);
	await surface.flush();
	assert.equal(changes, 1, "the committed mode change notifies");
	assert.deepEqual(surface.requestedMouseReporting(), { mouseTracking: "none", mouseEncoding: "sgr-pixels" });
	assert.equal(surface.inputModes().mouseTracking, "none");
	surface.dispose();
	assert.throws(() => surface.requestedMouseReporting());
});

test("colon sub-parameter 2026 markers neither open nor close a frame, even fragmented", async () => {
	const surface = new TerminalSurface(COLS, ROWS);
	surface.write(`${ESC}[1;1Hcommitted`);
	await surface.flush();
	for (const [first, second] of [[`${ESC}[?2026:`, "1h"], [`${ESC}[?20`, "26:0h"], [`${ESC}[?25;2026:`, "1h"]]) {
		surface.write(first as string);
		surface.write(`${second}${ESC}[1;1H${ESC}[2Kunframed`);
		await surface.flush();
		assert.equal(rows(surface.frame())[0], "unframed", `${JSON.stringify(first + second)} did not open a frame`);
		surface.write(`${ESC}[1;1H${ESC}[2Kcommitted`);
		await surface.flush();
	}

	surface.write(`${BEGIN}${ESC}[1;1H${ESC}[2Khalf drawn`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "committed");
	for (const [first, second] of [[`${ESC}[?2026:`, "1l"], [`${ESC}[?25;20`, "26:1l"]]) {
		surface.write(first as string);
		surface.write(second as string);
		await surface.flush();
		assert.equal(rows(surface.frame())[0], "committed", `${JSON.stringify(first + second)} did not close the frame`);
	}
	surface.write(END);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "half drawn", "only the exact end marker commits");
	surface.dispose();
});

test("only typed parsed DECSET/DECRST 2026 opens or closes a frame", async () => {
	const surface = new TerminalSurface(COLS, ROWS);
	// String payloads are data to the pinned parser. (A raw ESC or C1 CSI
	// inside a string terminates it in VT parsing, so such bytes are real
	// markers to xterm and are deliberately treated exactly as xterm does.)
	const marker = BEGIN.slice(1);
	const fakes: (string | string[])[] = [
		`${ESC}]0;${marker}\x07`,
		`${ESC}]8;;https://example.invalid/${marker}${ST}`,
		`${ESC}P${marker}${ST}`,
		`${ESC}_X${marker}${ST}`,
		`${ESC}^${marker}${ST}`,
		`${ESC}X${marker}${ST}`,
		// Kitty APCs are split out before xterm; even an embedded ESC CSI is swallowed.
		`${ESC}_Ga=d,d=a;${BEGIN}${ST}`,
		[`${ESC}_Ga=T,f=100,m=1;${ESC}[`, "?2026h", `AAAA${ST}`],
		`${ESC}[?2026\x18h`,
		`${ESC}[?2026$h`,
		`${ESC}[2026h`,
		`${ESC}[>2026h`,
	];
	for (const [index, fake] of fakes.entries()) {
		for (const chunk of typeof fake === "string" ? [fake] : fake) {
			surface.write(chunk);
		}
		surface.write(`${ESC}[1;1H${ESC}[2Kvisible ${index}`);
		await surface.flush();
		assert.equal(rows(surface.frame())[0], `visible ${index}`, `fake marker ${JSON.stringify(fake)} did not open a frame`);
	}
	// Fragmented and combined real markers do open one.
	surface.write(`${ESC}[?20`);
	surface.write(`26h${ESC}[1;1H${ESC}[2Kheld`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], `visible ${fakes.length - 1}`, "fragmented CSI opens a frame");
	surface.write(`${ESC}[?25;20`);
	surface.write("26l");
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "held", "combined/fragmented CSI closes it");
	surface.write(`${ESC}[?25;2026h${ESC}[1;1H${ESC}[2Kagain`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "held", "combined parameters open a frame");
	surface.write(`${END}`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "again");
	surface.dispose();
});

test("nested begins are idempotent and stray ends are ignored", async () => {
	const surface = new TerminalSurface(COLS, ROWS);
	surface.write(`${END}${ESC}[1;1Hstray end ok`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "stray end ok");
	surface.write(`${BEGIN}${ESC}[1;1H${ESC}[2Kone${BEGIN}${ESC}[1;1H${ESC}[2Ktwo`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "stray end ok");
	surface.write(END);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "two");
	surface.dispose();
});

test("a frame missing its end is released by the time bound with anchors and callbacks settled", async () => {
	let changes = 0;
	const { surface, doc } = await placedImageSurface({ onChange: () => { changes += 1; } });
	changes = 0;
	surface.write(`${BEGIN}${ESC}_Ga=d,d=a,q=2${ST}${nativeFrame(viewport(doc, 1, false), "").slice(BEGIN.length, -END.length)}`);
	await surface.flush();
	assert.equal(surface.frame().graphics?.placements[0]?.row, 2, "held");
	await new Promise<void>((resolve) => setTimeout(resolve, 1150));
	assert.equal(changes, 1, "the time bound publishes once without a parse");
	assert.equal(surface.frame().graphics?.placements[0]?.row, 1, "the expired frame's anchors were finalized");
	surface.write(`${ESC}[1;1H${ESC}[2Klater${END}`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "later", "the late end marker is harmless");
	surface.dispose();
});

/** Disarm a held frame's expiry timer so only the byte/count bounds can end it. */
function disarmTimeBound(surface: TerminalSurface): void {
	const held = (surface as unknown as { syncFrame?: { timer: ReturnType<typeof setTimeout> } }).syncFrame;
	assert.ok(held, "a frame is held");
	clearTimeout(held.timer);
}

test("the frame chunk-count bound alone releases the hold at a write boundary", async () => {
	const surface = new TerminalSurface(COLS, ROWS);
	surface.write(`${ESC}[?1049h${ESC}[?7l${ESC}[1;1Hcommitted`);
	await surface.flush();
	surface.write(`${BEGIN}${ESC}[1;1H${ESC}[2Kcounted`);
	await surface.flush();
	disarmTimeBound(surface);
	// The opening chunk counts as one; 8191 more reach the 8192-chunk bound.
	for (let index = 0; index < 8191; index += 1) {
		surface.write(`${ESC}[2;1H`);
		if (index % 1000 === 999) {
			await surface.flush();
		}
	}
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "committed", "held at exactly the bound");
	surface.write(`${ESC}[2;1H`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "counted", "one chunk past the bound publishes the live state");
	surface.write(END);
	await surface.flush();
	surface.dispose();
});

test("the frame byte bound alone releases the hold at a write boundary", async () => {
	const surface = new TerminalSurface(COLS, ROWS);
	surface.write(`${ESC}[?1049h${ESC}[?7l${ESC}[1;1Hcommitted`);
	await surface.flush();
	const opening = `${BEGIN}${ESC}[1;1H${ESC}[2Kbytes`;
	surface.write(opening);
	await surface.flush();
	disarmTimeBound(surface);
	const prefix = `${ESC}[3;1H`;
	const megabyte = `${prefix}${"x".repeat(1024 * 1024 - prefix.length)}`;
	assert.equal(Buffer.byteLength(megabyte), 1024 * 1024);
	for (let index = 0; index < 7; index += 1) {
		surface.write(megabyte);
		await surface.flush();
	}
	// 7 MiB plus the opening chunk is under the 8 MiB bound.
	assert.equal(rows(surface.frame())[0], "committed", "held below the byte bound");
	surface.write(megabyte);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "bytes", "crossing the byte bound publishes the live state");
	surface.write(END);
	await surface.flush();
	surface.dispose();
});

test("resize during a held frame drops it and never exposes stale geometry", async () => {
	const { surface, doc } = await placedImageSurface();
	surface.write(`${BEGIN}${ESC}_Ga=d,d=a,q=2${ST}${ESC}[3;1H${viewport(doc, 0, false)[2]}`);
	await surface.flush();
	surface.resize(COLS + 2, ROWS + 1);
	const frame = surface.frame();
	assert.equal(frame.cols, COLS + 2);
	assert.equal(frame.rows, ROWS + 1);
	assert.equal(frame.graphics, undefined, "geometry-bound placements are invalidated, provisional ones included");
	surface.write(`${ESC}[1;1H${ESC}[2Kafter resize${END}`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "after resize");
	surface.dispose();
});

test("buffer switches inside a frame end the hold and discard provisional anchors", async () => {
	const { surface, doc } = await placedImageSurface();
	surface.write(`${BEGIN}${ESC}_Ga=d,d=a,q=2${ST}${ESC}[4;1H${viewport(doc, 0, false)[2]}${ESC}[?1049l`);
	await surface.flush();
	assert.equal(surface.frame().graphics, undefined, "normal buffer shown immediately");
	surface.write(`${ESC}[?1049h`);
	await surface.flush();
	assert.equal(surface.frame().graphics, undefined, "the provisional alternate placement was discarded, not guessed");
	surface.write(`${BEGIN}${ESC}c${ESC}[1;1Hreset`);
	await surface.flush();
	assert.equal(rows(surface.frame())[0], "reset", "RIS ends a held frame");
	surface.dispose();
});

test("retained snapshot payload stays charged until released, and dispose/failure settle everything", async () => {
	const counted = countingBudget();
	let changes = 0;
	const { surface } = await placedImageSurface({ budget: counted.budget, onChange: () => { changes += 1; } });
	assert.deepEqual({ images: counted.active().images, placements: counted.active().placements }, { images: 1, placements: 1 });
	surface.write(`${BEGIN}${ESC}_Ga=d,d=A,q=2${ST}`);
	await surface.flush();
	assert.equal(surface.frame().graphics?.images.length, 1, "held snapshot still references the payload");
	assert.equal(counted.active().images, 1, "and it remains charged");
	assert.equal(counted.active().placements, 1);
	surface.write(END);
	await surface.flush();
	assert.equal(surface.frame().graphics, undefined);
	assert.equal(counted.active().total, 0, "released once the snapshot is no longer retained");

	// Dispose while held: callbacks stop, flush settles, all leases released,
	// and the time-bound timer never fires afterwards.
	const second = await placedImageSurface({ budget: counted.budget, onChange: () => { changes += 1; } });
	second.surface.write(`${BEGIN}${ESC}_Ga=d,d=A,q=2${ST}${ESC}[1;1Hpartial`);
	const pending = second.surface.flush();
	second.surface.dispose();
	await pending;
	changes = 0;
	await new Promise<void>((resolve) => setTimeout(resolve, 1100));
	assert.equal(changes, 0, "no callbacks after dispose");
	assert.equal(counted.active().total, 0);

	// Parser failure while held fails closed and releases the retained snapshot.
	const third = await placedImageSurface({ budget: counted.budget });
	third.surface.write(`${BEGIN}${ESC}_Ga=d,d=A,q=2${ST}`);
	await third.surface.flush();
	assert.equal(counted.active().images, 1);
	(third.surface as unknown as { terminal: { write: () => void } }).terminal.write = () => {
		throw new Error("synthetic parser failure");
	};
	third.surface.write("more");
	await assert.rejects(third.surface.flush(), /parse pipeline failed/);
	assert.equal(third.surface.frame().graphics, undefined, "no stale held snapshot after failure");
	assert.equal(counted.active().images, 0);
	third.surface.dispose();
	surface.dispose();
	assert.equal(counted.active().total, 0);
});
