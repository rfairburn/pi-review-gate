import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Writable } from "node:stream";
import { deflateSync } from "node:zlib";
import { imageFallback } from "pi-session-host-tui";
import { createSessionHostFrameWriter, type SessionHostFrameWriter } from "../src/session-host/frame-writer";
import type { ComposedHostFrame, HostPaneRect } from "../src/session-host/compositor";
import type { HostGraphicsLayer } from "../src/session-host/graphics-output";
import type { TerminalGraphicsFrame } from "../src/session-host/kitty-graphics";

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

function pngBase64(width: number, height: number, seed: number, noisy = false): string {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const stride = width * 4 + 1;
	const raw = Buffer.alloc(height * stride);
	let random = seed >>> 0 || 1;
	for (let row = 0; row < height; row += 1) {
		raw[row * stride] = 0;
		if (!noisy) {
			raw.fill(seed, row * stride + 1, (row + 1) * stride);
			continue;
		}
		for (let column = 1; column < stride; column += 1) {
			random ^= random << 13;
			random ^= random >>> 17;
			random ^= random << 5;
			raw[row * stride + column] = random & 0xff;
		}
	}
	const chunk = (type: string, data: Buffer): Buffer => {
		const typeBytes = Buffer.from(type, "ascii");
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])));
		return Buffer.concat([length, typeBytes, data, crc]);
	};
	return Buffer.concat([
		signature,
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

function pngCrc32(input: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of input) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function typedGraphics(ownerId: string, pane: HostPaneRect, base64: string): HostGraphicsLayer {
	const crop = { x: 10, y: 5, width: 80, height: 60 };
	const clip = { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 };
	const frame: TerminalGraphicsFrame = {
		images: [{ id: "kitty-7", mimeType: "image/png", widthPx: 200, heightPx: 120, base64 }],
		placements: [
			{
				id: "placement-7a", imageId: "kitty-7", column: -1, row: 0,
				columns: 4, rows: 2, crop, clip: { ...clip, leftColumns: 1 },
			},
			{
				id: "placement-7b", imageId: "kitty-7", column: 2, row: 1,
				columns: 4, rows: 2, crop, clip,
			},
		],
		fallbacks: [
			{ id: "placement-7a", mimeType: "image/png", widthPx: 200, heightPx: 120,
				column: -1, row: 0, columns: 4, rows: 2, clip: { ...clip, leftColumns: 1 } },
			{ id: "placement-7b", mimeType: "image/png", widthPx: 200, heightPx: 120,
				column: 2, row: 1, columns: 4, rows: 2, clip },
		],
	};
	return { ownerId, pane, frame };
}

function sizeableGraphics(
	ownerId: string,
	pane: HostPaneRect,
	image: TerminalGraphicsFrame["images"][number],
	placement: {
		readonly column?: number;
		readonly row?: number;
		readonly columns?: number;
		readonly rows?: number;
		readonly crop?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	} = {},
): HostGraphicsLayer {
	const id = "sizeable-placement";
	const cells = {
		column: placement.column ?? 1,
		row: placement.row ?? 1,
		columns: placement.columns ?? 20,
		rows: placement.rows ?? 8,
	};
	const crop = placement.crop ?? { x: 0, y: 0, width: image.widthPx, height: image.heightPx };
	const clip = { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 };
	return {
		ownerId,
		pane,
		frame: {
			images: [image],
			placements: [{ id, imageId: image.id, ...cells, crop, clip }],
			fallbacks: [{ id, mimeType: "image/png", widthPx: image.widthPx, heightPx: image.heightPx, ...cells, clip }],
		},
	};
}

function countSubstring(text: string, needle: string): number {
	let count = 0;
	let index = 0;
	while ((index = text.indexOf(needle, index)) >= 0) {
		count += 1;
		index += needle.length;
	}
	return count;
}

function uploadedBase64(text: string, imageId: number): string | undefined {
	const commands = [...text.matchAll(/\x1b_G([^;\x1b]*);([A-Za-z0-9+/=]*)\x1b\\/g)];
	const firstIndex = commands.findIndex((command) => command[1]?.startsWith(`a=t,f=100,q=2,i=${imageId}`));
	if (firstIndex < 0) return undefined;
	const first = commands[firstIndex];
	if (!first) return undefined;
	const pieces = [first[2] ?? ""];
	if (!first[1]?.endsWith(",m=1")) return pieces[0];
	for (const command of commands.slice(firstIndex + 1)) {
		if (command[1] !== "m=1" && command[1] !== "m=0") return undefined;
		pieces.push(command[2] ?? "");
		if (command[1] === "m=0") return pieces.join("");
	}
	return undefined;
}

function countPngDecodes(base64: string, action: () => void): number {
	const mutableBuffer = Buffer as unknown as { from: (...args: any[]) => Buffer };
	const originalFrom = mutableBuffer.from;
	let count = 0;
	mutableBuffer.from = (...args: any[]) => {
		if (args[0] === base64 && args[1] === "base64") count += 1;
		return Reflect.apply(originalFrom, Buffer, args) as Buffer;
	};
	try {
		action();
		return count;
	} finally {
		mutableBuffer.from = originalFrom;
	}
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

test("typed Kitty graphics are namespaced, cropped to visible cells, and cleaned only by writer-owned IDs", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0, graphicsEnabled: true });
	driver.start();
	const rows = Array.from({ length: 10 }, () => "");
	const imageA = pngBase64(200, 120, 31);
	const imageB = pngBase64(200, 120, 149);
	const pane = { column: 5, row: 2, cols: 4, rows: 3 };
	driver.submit({ ...frame(rows), graphics: typedGraphics("owner-A", pane, imageA) }, 20, 10);
	const first = outputText(output, 1);
	assert.ok(first.includes(`\x1b_Ga=t,f=100,q=2,i=1;${imageA}\x1b\\`), "the validated PNG is sent as a transmit-only generated upload");
	assert.ok(first.includes("\x1b[3;6H\x1b_Ga=p,q=2,C=1,i=1,p=1,c=3,r=2,x=30,y=5,w=60,h=60\x1b\\"),
		"left clipping advances source pixels and places only three cells at the pane offset");
	assert.ok(first.includes("\x1b[4;8H\x1b_Ga=p,q=2,C=1,i=1,p=2,c=2,r=2,x=10,y=5,w=40,h=60\x1b\\"),
		"right pane clipping crops source pixels rather than distorting a four-cell image into two cells");
	assert.equal(first.includes("kitty-7"), false, "child numeric image IDs are never forwarded");

	driver.submit({ ...frame(rows), graphics: typedGraphics("owner-B", pane, imageB) }, 20, 10);
	const switched = outputText(output, 2);
	const cleanup = switched.indexOf("\x1b_Ga=d,d=I,i=1,q=2\x1b\\");
	const replacement = switched.indexOf("\x1b_Ga=t,f=100,q=2,i=2;");
	assert.ok(cleanup >= 0 && replacement > cleanup, "owner change deletes A's owned image before uploading B's distinct generation");
	assert.ok(switched.includes(`;${imageB}\x1b\\`));
	assert.equal(switched.includes(`;${imageA}\x1b\\`), false);
	assert.equal(switched.includes("\x1b_Ga=d,d=a"), false, "cleanup never issues terminal-global deletion");

	const movedPane = { ...pane, column: 6 };
	driver.submit({ ...frame(rows), graphics: typedGraphics("owner-B", movedPane, imageB) }, 20, 10);
	const resized = outputText(output, 3);
	assert.match(resized, /\x1b_Ga=p,q=2,C=1,i=2,p=3,/,
		"same-owner geometry changes reposition the already-resident image");
	assert.equal(resized.includes("\x1b_Ga=t"), false, "repositioning never retransmits resident PNG bytes");
	assert.equal(resized.includes("\x1b_Ga=d"), false, "replacing a placement by the same image/placement ID needs no delete");

	driver.invalidate();
	driver.submit({ ...frame(rows), graphics: typedGraphics("owner-B", movedPane, imageB) }, 20, 10);
	const redraw = outputText(output, 4);
	assert.ok(redraw.includes("\x1b_Ga=d,d=i,i=2,p=3,q=2\x1b\\"),
		"invalidate targets the exact old placement without freeing resident image data");
	assert.ok(redraw.includes("\x1b_Ga=d,d=i,i=2,p=4,q=2\x1b\\"),
		"invalidate scopes cleanup for every owned placement");
	assert.equal(redraw.includes("\x1b_Ga=d,d=I"), false, "placement repaint does not delete resident image data");
	assert.equal(redraw.includes("\x1b_Ga=t"), false, "placement repaint does not retransmit the PNG");

	driver.submit(frame(rows), 20, 10);
	assert.ok(outputText(output, 5).includes("\x1b_Ga=d,d=I,i=2,q=2\x1b\\"), "omitting the graphics layer clears the prior owner");
	driver.submit({ ...frame(rows), graphics: typedGraphics("owner-A", pane, imageA) }, 20, 10);
	assert.match(outputText(output, 6), /\x1b_Ga=t,f=100,q=2,i=3;/);
	assert.equal(await driver.close(), true);
	const final = outputText(output, 7);
	assert.ok(final.indexOf("\x1b_Ga=d,d=I,i=3,q=2\x1b\\") < final.indexOf("\x1b[0m\x1b[?25h\x1b[?1049l"),
		"close deletes the last owned image before reset/showcursor/leave-altscreen");
});

test("large Kitty image uploads use 4096-byte APC chunks before placing the reassembled PNG", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0, graphicsEnabled: true });
	driver.start();
	const base64 = pngBase64(64, 64, 71, true);
	assert.ok(base64.length > 4096);
	const pane = { column: 0, row: 0, cols: 20, rows: 3 };
	const layer: HostGraphicsLayer = {
		ownerId: "large-image-owner",
		pane,
		frame: {
			images: [{ id: "large-image", mimeType: "image/png", widthPx: 64, heightPx: 64, base64 }],
			placements: [{
				id: "large-placement", imageId: "large-image", column: 0, row: 0, columns: 4, rows: 2,
				crop: { x: 0, y: 0, width: 64, height: 64 },
				clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 },
			}],
			fallbacks: [{
				id: "large-placement", mimeType: "image/png", widthPx: 64, heightPx: 64,
				column: 0, row: 0, columns: 4, rows: 2,
				clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 },
			}],
		},
	};
	const imageFrame = { ...frame(["", "", ""]), graphics: layer };
	driver.submit(imageFrame, 20, 3);
	const bytes = outputText(output, 1);
	const chunks = [...bytes.matchAll(/\x1b_G([^;]*);([A-Za-z0-9+/=]*)\x1b\\/g)];
	assert.ok(chunks.length > 1, "the large PNG is fragmented into Kitty APC payloads");
	assert.ok(chunks.every((chunk) => (chunk[2]?.length ?? Infinity) <= 4096), "each Kitty payload fragment stays within 4096 bytes");
	assert.match(chunks[0]?.[1] ?? "", /a=t,f=100,q=2,i=1,m=1/);
	assert.match(chunks.at(-1)?.[1] ?? "", /^m=0$/);
	assert.ok(chunks.slice(1, -1).every((chunk) => chunk[1] === "m=1"), "every continuation except the final fragment retains m=1");
	assert.equal(chunks.map((chunk) => chunk[2]).join(""), base64, "the ordered fragments reassemble the exact validated PNG");
	const finalChunkEnd = (chunks.at(-1)?.index ?? -1) + (chunks.at(-1)?.[0]?.length ?? 0);
	const placement = bytes.indexOf("\x1b[1;1H\x1b_Ga=p");
	assert.ok(placement > finalChunkEnd, "placement follows the complete multi-APC image transfer");
	assert.equal(await driver.close(), true);

	const exactOutput = new SyntheticWritable();
	const exactBudget = writer(exactOutput, { redrawIntervalMs: 0, graphicsEnabled: true, maxFrameBytes: bytes.length });
	exactBudget.start();
	exactBudget.submit(imageFrame, 20, 3);
	assert.equal(outputText(exactOutput, 1), bytes, "the exact complete chunked output fits the byte budget");
	assert.equal(await exactBudget.close(), true);

	const cappedOutput = new SyntheticWritable();
	const cappedBudget = writer(cappedOutput, { redrawIntervalMs: 0, graphicsEnabled: true, maxFrameBytes: bytes.length - 1 });
	cappedBudget.start();
	cappedBudget.submit(imageFrame, 20, 3);
	const boundedFallback = outputText(cappedOutput, 1);
	assert.equal(boundedFallback.includes("\x1b_Ga=t"), false, "the missing byte cannot omit chunk APC envelopes from the budget");
	assert.ok(Buffer.byteLength(boundedFallback, "utf8") <= bytes.length - 1, "fallback remains inside the configured output bound");
	assert.equal(await cappedBudget.close(), true);
});

test("chunked graphics byte budgeting stays exact when writer IDs gain digits", async () => {
	const base64 = pngBase64(64, 64, 0x363, true);
	const image = Object.freeze({ id: "digit-boundary-image", mimeType: "image/png" as const, widthPx: 64, heightPx: 64, base64 });
	assert.ok(base64.length > 4096, "the test crosses the Kitty payload chunk boundary");
	const pane = { column: 0, row: 0, cols: 40, rows: 10 };
	const rows = Array.from({ length: 10 }, () => "");
	const layer = (ownerId: string): HostGraphicsLayer => sizeableGraphics(ownerId, pane, image);
	const warm = (driver: SessionHostFrameWriter): void => {
		for (let owner = 0; owner < 10; owner += 1) {
			driver.submit({ ...frame(rows), graphics: layer(`digit-owner-${owner}`) }, 40, 10);
		}
	};

	const referenceOutput = new SyntheticWritable();
	const reference = writer(referenceOutput, { redrawIntervalMs: 0, graphicsEnabled: true });
	reference.start();
	warm(reference);
	reference.invalidate();
	reference.submit({ ...frame(rows), graphics: layer("digit-owner-10") }, 40, 10);
	const expected = referenceOutput.writes.at(-1);
	assert.ok(expected);
	assert.ok(outputText(referenceOutput, referenceOutput.writes.length - 1).includes("i=11,p=11,"),
		"the complete reference output uses two-digit image and placement IDs");
	assert.equal(await reference.close(), true);

	const exactOutput = new SyntheticWritable();
	const exact = writer(exactOutput, {
		redrawIntervalMs: 0,
		graphicsEnabled: true,
		maxFrameBytes: expected.byteLength,
	});
	exact.start();
	warm(exact);
	exact.invalidate();
	exact.submit({ ...frame(rows), graphics: layer("digit-owner-10") }, 40, 10);
	assert.deepEqual(exactOutput.writes.at(-1), expected, "two-digit chunk/header and placement bytes fit the exact cap");
	assert.equal(await exact.close(), true);

	const cappedOutput = new SyntheticWritable();
	const capped = writer(cappedOutput, {
		redrawIntervalMs: 0,
		graphicsEnabled: true,
		maxFrameBytes: expected.byteLength - 1,
	});
	capped.start();
	warm(capped);
	capped.invalidate();
	capped.submit({ ...frame(rows), graphics: layer("digit-owner-10") }, 40, 10);
	const fallback = cappedOutput.writes.at(-1);
	assert.ok(fallback);
	assert.equal(fallback.toString("ascii").includes("\x1b_Ga=t"), false,
		"one missing byte selects bounded text fallback rather than truncating a chunked transfer");
	assert.ok(fallback.byteLength <= expected.byteLength - 1);
	assert.equal(await capped.close(), true);
});

test("sizeable immutable PNGs stay resident across scrolling, crop, resize, repaint, ownership, and payload changes", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0, graphicsEnabled: true });
	driver.start();
	const widthPx = 768;
	const heightPx = 512;
	const base64A = pngBase64(widthPx, heightPx, 0x363, true);
	const base64B = pngBase64(widthPx, heightPx, 0x375, true);
	assert.ok(base64A.length > 2_000_000, "the cached-path fixture is a realistic multi-megabyte PNG");
	const imageA = Object.freeze({ id: "same-child-id", mimeType: "image/png" as const, widthPx, heightPx, base64: base64A });
	const imageB = Object.freeze({ id: "same-child-id", mimeType: "image/png" as const, widthPx, heightPx, base64: base64B });
	const rows = Array.from({ length: 10 }, () => "");
	const pane = { column: 0, row: 0, cols: 40, rows: 10 };
	const submit = (graphics: HostGraphicsLayer, lines = rows): void => {
		driver.submit({ ...frame(lines), graphics }, 40, 10);
	};

	assert.equal(countPngDecodes(base64A, () => submit(sizeableGraphics("owner-A", pane, imageA))), 1,
		"the first immutable image is decoded and validated once");
	const initial = output.writes[1]?.toString("ascii") ?? "";
	assert.equal(countSubstring(initial, "\x1b_Ga=t"), 1, "the first frame starts exactly one chunked image transfer");
	assert.equal(countSubstring(initial, "\x1b_G"), Math.ceil(base64A.length / 4096) + 1,
		"the full frame contains exactly the bounded upload chunks and one placement");
	assert.ok(output.writes[1]!.byteLength > base64A.length, "measured output includes the PNG and generated Kitty envelopes");

	const cachedDecodeCount = countPngDecodes(base64A, () => {
		submit(sizeableGraphics("owner-A", pane, imageA), ["stationary text changed", ...rows.slice(1)]);
		submit(sizeableGraphics("owner-A", pane, imageA, { column: 4, row: 2 }));
		submit(sizeableGraphics("owner-A", pane, imageA, {
			column: 4, row: 2, crop: { x: 24, y: 16, width: 700, height: 470 },
		}));
		submit(sizeableGraphics("owner-A", pane, imageA, {
			column: 4, row: 2, columns: 18, rows: 7, crop: { x: 24, y: 16, width: 700, height: 470 },
		}));
		submit(sizeableGraphics("owner-A", { ...pane, column: 1, cols: 39 }, imageA, {
			column: 0, row: 2, columns: 18, rows: 7, crop: { x: 24, y: 16, width: 700, height: 470 },
		}));
	});
	assert.equal(cachedDecodeCount, 0, "same frozen own-data image snapshots skip repeated PNG decoding and validation");
	const stationaryText = output.writes[2]!.toString("ascii");
	assert.equal(stationaryText.includes("\x1b_G"), false, "stationary text changes emit no graphic protocol bytes");
	for (const index of [3, 4, 5, 6]) {
		const placementUpdate = output.writes[index]!.toString("ascii");
		assert.equal(countSubstring(placementUpdate, "\x1b_Ga=p"), 1, "scroll/crop/resize emits one updated placement");
		assert.equal(placementUpdate.includes("\x1b_Ga=t"), false, "placement changes do not retransmit resident image data");
		assert.equal(placementUpdate.includes("\x1b_Ga=d"), false, "same image/placement identity is replaced in place");
		assert.ok(output.writes[index]!.byteLength < 512, "placement-only output remains small relative to the PNG");
	}

	driver.invalidate();
	submit(sizeableGraphics("owner-A", { ...pane, column: 1, cols: 39 }, imageA, {
		column: 0, row: 2, columns: 18, rows: 7, crop: { x: 24, y: 16, width: 700, height: 470 },
	}));
	const repaint = output.writes[7]!.toString("ascii");
	assert.ok(repaint.includes("\x1b_Ga=d,d=i,i=1,p=1,q=2\x1b\\"), "forced repaint deletes only the owned placement pair");
	assert.ok(repaint.includes("\x1b_Ga=p,q=2,C=1,i=1,p=1,"), "forced repaint recreates that placement");
	assert.equal(repaint.includes("\x1b_Ga=d,d=I"), false, "forced repaint preserves resident PNG data");
	assert.equal(repaint.includes("\x1b_Ga=t"), false, "forced repaint does not re-upload the PNG");

	driver.submit(frame(rows), 40, 10); // Form/overlay ownership hides the native pane.
	const hidden = output.writes[8]!.toString("ascii");
	assert.ok(hidden.includes("\x1b_Ga=d,d=I,i=1,q=2\x1b\\"), "hide/form/overlay removes the previous owner's image data");
	const shownDecodeCount = countPngDecodes(base64A, () => submit(sizeableGraphics("owner-A", pane, imageA)));
	assert.equal(shownDecodeCount, 0, "show reuses immutable metadata even though safe hide discarded terminal residency");
	const shown = output.writes[9]!.toString("ascii");
	assert.match(shown, /\x1b_Ga=t,f=100,q=2,i=2,m=1;/, "show restores image data that hide explicitly removed");

	submit(sizeableGraphics("owner-B", pane, imageA));
	const ownerSwitch = output.writes[10]!.toString("ascii");
	assert.ok(ownerSwitch.indexOf("\x1b_Ga=d,d=I,i=2,q=2\x1b\\") < ownerSwitch.indexOf("\x1b_Ga=t,f=100,q=2,i=3,m=1;"),
		"owner switching deletes the prior namespace before uploading the new owner's image");

	assert.equal(countPngDecodes(base64B, () => submit(sizeableGraphics("owner-B", pane, imageB))), 1,
		"a new immutable payload is fully validated once even when the child image ID is unchanged");
	const changedPayload = output.writes[11]!.toString("ascii");
	assert.ok(changedPayload.indexOf("\x1b_Ga=d,d=I,i=3,q=2\x1b\\") < changedPayload.indexOf("\x1b_Ga=t,f=100,q=2,i=4,m=1;"),
		"changed bytes under the same child ID replace the old owned image generation");
	assert.equal(uploadedBase64(changedPayload, 4), base64B, "the new generation uploads its exact validated bytes across APC chunks");
	assert.equal(await driver.close(), true);
	assert.ok(outputText(output, output.writes.length - 1).includes("\x1b_Ga=d,d=I,i=4,q=2\x1b\\"),
		"close cleans the last resident generation before leaving the alternate screen");
});

test("sizeable PNG writes retain callback/drain/coalescing and close ownership fences", async () => {
	const output = new SyntheticWritable();
	output.deferCallbacks = true;
	const driver = writer(output, { redrawIntervalMs: 0, graphicsEnabled: true });
	driver.start();
	output.completeCallback(0);
	const base64 = pngBase64(768, 512, 0x375, true);
	const image = Object.freeze({ id: "pending-image", mimeType: "image/png" as const, widthPx: 768, heightPx: 512, base64 });
	const pane = { column: 0, row: 0, cols: 40, rows: 10 };
	const rows = Array.from({ length: 10 }, () => "");
	const dispositions: string[] = [];
	output.writeResults.push(false);
	driver.submit({ ...frame(rows), graphics: sizeableGraphics("pending-owner", pane, image) }, 40, 10,
		(value) => dispositions.push(`initial:${value}`));
	driver.submit({ ...frame(rows), graphics: sizeableGraphics("pending-owner", pane, image, { column: 3, row: 1 }) }, 40, 10);
	driver.submit({ ...frame(rows), graphics: sizeableGraphics("pending-owner", pane, image, { column: 7, row: 2 }) }, 40, 10,
		(value) => dispositions.push(`latest:${value}`));
	assert.equal(output.writes.length, 2, "the sizeable transfer is the sole in-flight write while newer placements coalesce");
	assert.equal(uploadedBase64(outputText(output, 1), 1), base64, "the in-flight owned payload contains the exact PNG across APC chunks");
	output.completeCallback(1);
	assert.deepEqual(dispositions, [], "callback alone cannot settle a refused transfer before drain");
	output.emit("drain");
	assert.equal(dispositions[0], "initial:written", "the transfer settles only after callback and drain");
	assert.equal(output.writes.length, 3, "drain pumps only the latest coalesced placement");
	const latest = outputText(output, 2);
	assert.equal(latest.includes("\x1b_Ga=t"), false, "coalesced scroll reuses the accepted resident PNG");
	assert.equal(countSubstring(latest, "\x1b_Ga=p"), 1, "the latest frame contains one placement update");
	output.completeCallback(2);
	assert.deepEqual(dispositions, ["initial:written", "latest:written"]);

	const closing = driver.close();
	const cleanupIndex = output.writes.length - 1;
	assert.ok(outputText(output, cleanupIndex).includes("\x1b_Ga=d,d=I,i=1,q=2\x1b\\"),
		"close targets the sizeable image ID still possibly owned by the writer");
	output.completeCallback(3);
	assert.equal(await closing, true);
});

test("mutable and accessor-backed graphics images are revalidated rather than trusted by identity", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0, graphicsEnabled: true });
	driver.start();
	const base64A = pngBase64(32, 24, 0x363, true);
	const base64B = pngBase64(32, 24, 0x375, true);
	const mutableImage: { id: string; mimeType: "image/png"; widthPx: number; heightPx: number; base64: string } = {
		id: "mutable-child-id", mimeType: "image/png", widthPx: 32, heightPx: 24, base64: base64A,
	};
	const pane = { column: 0, row: 0, cols: 40, rows: 10 };
	const submitMutable = (): void => driver.submit({
		...frame(Array.from({ length: 10 }, () => "")),
		graphics: sizeableGraphics("mutable-owner", pane, mutableImage),
	}, 40, 10);
	assert.equal(countPngDecodes(base64A, submitMutable), 1, "a mutable source receives full PNG validation");
	mutableImage.base64 = base64B;
	assert.equal(countPngDecodes(base64B, submitMutable), 1, "changing bytes on the same object is detected and fully revalidated");
	const changed = outputText(output, 2);
	assert.ok(changed.indexOf("\x1b_Ga=d,d=I,i=1,q=2\x1b\\") < changed.indexOf("\x1b_Ga=t,f=100,q=2,i=2,m=1;"),
		"the changed mutable generation deletes the old writer-owned image before uploading new bytes");

	const accessorImage = Object.defineProperties({}, {
		id: { value: "accessor-child-id", enumerable: true },
		mimeType: { value: "image/png", enumerable: true },
		widthPx: { value: 32, enumerable: true },
		heightPx: { value: 24, enumerable: true },
		base64: { get: () => { throw new Error("image accessor must not execute"); }, enumerable: true },
	}) as TerminalGraphicsFrame["images"][number];
	driver.submit({
		...frame(Array.from({ length: 10 }, () => "")),
		graphics: sizeableGraphics("mutable-owner", pane, accessorImage),
	}, 40, 10);
	assert.equal(outputText(output, 3).includes("\x1b_Ga=t"), false, "accessor-backed image metadata is rejected without executing getters");
	assert.ok(outputText(output, 3).includes("\x1b_Ga=d,d=I,i=2,q=2\x1b\\"), "rejected metadata clears any previously visible owner image");
	assert.equal(await driver.close(), true);
});

test("mixed renderable and fallback-only graphics keep each native fallback at its own anchor", async () => {
	const output = new SyntheticWritable();
	const driver = writer(output, { redrawIntervalMs: 0, graphicsEnabled: true });
	driver.start();
	const base64 = pngBase64(4, 4, 82);
	const fallbackText = imageFallback("image/png", { widthPx: 12, heightPx: 8 });
	const clip = { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 };
	const layer: HostGraphicsLayer = {
		ownerId: "mixed-image-owner",
		pane: { column: 0, row: 0, cols: 40, rows: 3 },
		frame: {
			images: [{ id: "accepted-image", mimeType: "image/png", widthPx: 4, heightPx: 4, base64 }],
			placements: [{
				id: "accepted-placement", imageId: "accepted-image", column: 0, row: 0, columns: 6, rows: 1,
				crop: { x: 0, y: 0, width: 4, height: 4 }, clip,
			}],
			fallbacks: [
				{ id: "accepted-placement", mimeType: "image/png", widthPx: 4, heightPx: 4,
					column: 0, row: 0, columns: 6, rows: 1, clip },
				// This metadata represents a different image rejected by the shared
				// terminal graphics budget; its fallback has no renderable placement.
				{ id: "budget-rejected-placement", mimeType: "image/png", widthPx: 12, heightPx: 8,
					column: 0, row: 1, columns: 40, rows: 1, clip },
			],
		},
	};
	driver.submit({ ...frame(["", "", ""]), graphics: layer }, 40, 3);
	const bytes = outputText(output, 1);
	assert.ok(bytes.includes("\x1b_Ga=t,f=100,q=2,i=1;"), "the accepted image remains rendered");
	assert.equal(bytes.split(fallbackText).length - 1, 1, "only the fallback-only placement gets imageFallback text");
	assert.ok(bytes.indexOf(fallbackText) > bytes.indexOf("\x1b[2;1H"), "rejected image text stays at its distinct second-row anchor");
	assert.equal(await driver.close(), true);
});

test("same-image pending redraw falls back safely when invalidate forces a full bounded repaint", async () => {
	const output = new SyntheticWritable();
	output.writeResults.push(true, false);
	const errors: string[] = [];
	const driver = writer(output, {
		redrawIntervalMs: 0,
		maxFrameBytes: 900,
		graphicsEnabled: true,
		onError: (error) => errors.push(error.message),
	});
	driver.start();
	const pane = { column: 0, row: 0, cols: 40, rows: 2 };
	const base64 = pngBase64(4, 4, 91);
	const clip = { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 };
	const layer: HostGraphicsLayer = {
		ownerId: "redraw-owner",
		pane,
		frame: {
			images: [{ id: "redraw-image", mimeType: "image/png", widthPx: 4, heightPx: 4, base64 }],
			placements: [{ id: "redraw-placement", imageId: "redraw-image", column: 0, row: 0, columns: 40, rows: 1,
				crop: { x: 0, y: 0, width: 4, height: 4 }, clip }],
			fallbacks: [{ id: "redraw-placement", mimeType: "image/png", widthPx: 4, heightPx: 4,
				column: 0, row: 0, columns: 40, rows: 1, clip }],
		},
	};
	driver.submit({ ...frame(["", ""]), graphics: layer }, 40, 2);
	driver.submit({ ...frame(["", `${"\x1b[31m".repeat(160)}`]), graphics: layer }, 40, 2);
	driver.invalidate();
	assert.equal(output.writes.length, 2, "the same-signature candidate remains retained behind backpressure");
	output.emit("drain");
	const afterDrain = output.writes.slice(2).map((chunk) => chunk.toString("utf8")).join("");
	assert.ok(afterDrain.includes("\x1b_Ga=d,d=I,i=1,q=2\x1b\\"), "the prior visible generation is cleared before fallback text");
	assert.ok(afterDrain.includes(imageFallback("image/png", { widthPx: 4, heightPx: 4 })), "oversized full redraw retains safe fallback text");
	assert.equal(afterDrain.includes("\x1b_Ga=t"), false, "the forced redraw does not retry an over-budget image transfer");
	assert.ok(output.writes.slice(2).every((chunk) => chunk.length <= 900), "every fallback and scoped-cleanup write stays bounded");
	assert.deepEqual(errors, [], "invalidate cannot turn the retained text frame into an output failure");
	assert.equal(await driver.close(), true);
});

test("queued image deletion is nonresident when budgeting a coalesced graphics candidate", async () => {
	const rows = Array.from({ length: 10 }, () => "");
	const pane = { column: 0, row: 0, cols: 40, rows: 10 };
	const base64 = pngBase64(24, 16, 0x363, true);
	const image = Object.freeze({ id: "queued-delete-image", mimeType: "image/png" as const, widthPx: 24, heightPx: 16, base64 });
	const layer = sizeableGraphics("queued-delete-owner", pane, image, { column: 0, row: 1, columns: 40, rows: 1 });
	const nearCapRows = [`${"\x1b[31m".repeat(2_000)}x`, ...rows.slice(1)];
	const replacementRows = [`${"\x1b[32m".repeat(1_950)}x`, ...rows.slice(1)];
	const measureFullFrame = async (lines: string[]): Promise<number> => {
		const measuredOutput = new SyntheticWritable();
		const measuredWriter = writer(measuredOutput, { redrawIntervalMs: 0, maxFrameBytes: 64_000 });
		measuredWriter.start();
		measuredWriter.submit(frame(lines), 40, 10);
		const bytes = measuredOutput.writes[1]!.byteLength;
		assert.equal(await measuredWriter.close(), true);
		return bytes;
	};
	const nearCapTextBytes = await measureFullFrame(nearCapRows);
	const replacementTextBytes = await measureFullFrame(replacementRows);
	const cleanupBytes = Buffer.byteLength("\x1b_Ga=d,d=I,i=1,q=2\x1b\\", "ascii");
	const maxFrameBytes = nearCapTextBytes + cleanupBytes - 1;
	assert.ok(maxFrameBytes <= 64_000);

	const placementOnlyOutput = new SyntheticWritable();
	const placementOnlyWriter = writer(placementOnlyOutput, {
		redrawIntervalMs: 0, graphicsEnabled: true, maxFrameBytes: 64_000,
	});
	placementOnlyWriter.start();
	placementOnlyWriter.submit({ ...frame(rows), graphics: layer }, 40, 10);
	placementOnlyWriter.invalidate();
	placementOnlyWriter.submit({ ...frame(replacementRows), graphics: layer }, 40, 10);
	const forcedPlacementBytes = placementOnlyOutput.writes[2]!.byteLength;
	const placementOnlyCost = forcedPlacementBytes - replacementTextBytes;
	assert.ok(replacementTextBytes + placementOnlyCost <= maxFrameBytes,
		"the candidate's full-frame text plus placement-only repaint fits the cap");
	assert.equal(await placementOnlyWriter.close(), true);

	const freshOutput = new SyntheticWritable();
	const freshWriter = writer(freshOutput, { redrawIntervalMs: 0, graphicsEnabled: true, maxFrameBytes: 64_000 });
	freshWriter.start();
	freshWriter.submit({ ...frame(replacementRows), graphics: layer }, 40, 10);
	const freshGraphicsCost = freshOutput.writes[1]!.byteLength - replacementTextBytes;
	assert.ok(replacementTextBytes + freshGraphicsCost > maxFrameBytes,
		"the same candidate exceeds the cap when its PNG must be uploaded again");
	assert.equal(await freshWriter.close(), true);

	const output = new SyntheticWritable();
	const errors: string[] = [];
	const dispositions: string[] = [];
	const driver = writer(output, {
		redrawIntervalMs: 0,
		graphicsEnabled: true,
		maxFrameBytes,
		onError: (error) => errors.push(error.message),
	});
	driver.start();
	output.deferCallbacks = true;
	driver.submit({ ...frame(rows), graphics: layer }, 40, 10);
	assert.ok(output.writes[1]!.byteLength <= maxFrameBytes, "the initial PNG becomes resident within the exact test cap");
	output.completeCallback(0);

	output.writeResults.push(false);
	driver.invalidate();
	driver.submit(frame(nearCapRows), 40, 10);
	assert.equal(output.writes.length, 3, "near-cap text queues a delete-only write behind the deferred callback/drain fence");
	assert.equal(output.writes[2]!.byteLength, cleanupBytes);
	assert.ok(outputText(output, 2).includes("\x1b_Ga=d,d=I,i=1,q=2\x1b\\"), "the queued write removes the resident image");

	driver.submit({ ...frame(replacementRows), graphics: layer }, 40, 10,
		(disposition) => dispositions.push(`replacement:${disposition}`));
	assert.equal(output.writes.length, 3, "the replacement candidate waits behind queued image cleanup");
	output.completeCallback(1);
	assert.equal(output.writes.length, 3, "callback alone cannot pass the refused cleanup write");
	output.emit("drain");
	assert.equal(output.writes.length, 4, "the newest candidate resumes after callback and drain");
	const fallback = outputText(output, 3);
	assert.equal(fallback.includes("\x1b_Ga=t"), false, "the deleted PNG is not treated as resident or retransmitted over budget");
	assert.ok(fallback.includes(imageFallback("image/png", { widthPx: 24, heightPx: 16 })),
		"the over-budget native image becomes its bounded text fallback");
	assert.ok(output.writes[3]!.byteLength <= maxFrameBytes);
	output.completeCallback(2);
	assert.deepEqual(dispositions, ["replacement:written"]);
	assert.deepEqual(errors, [], "the stale residency estimate does not fail the writer closed");

	driver.submit(frame(["writer remains usable", ...rows.slice(1)]), 40, 10,
		(disposition) => dispositions.push(`follow-up:${disposition}`));
	assert.equal(output.writes.length, 5, "a later text frame still writes successfully");
	output.completeCallback(3);
	assert.deepEqual(dispositions, ["replacement:written", "follow-up:written"]);
	const closing = driver.close();
	assert.equal(outputText(output, 5).includes("\x1b_Ga=d,d=I,i=1,q=2\x1b\\"), false,
		"settled deletion relinquishes image ownership before close cleanup");
	output.completeCallback(4);
	assert.equal(await closing, true);
	assert.deepEqual(errors, []);
});

test("close targets both generations when an image-owner replacement is still in flight", async () => {
	const output = new SyntheticWritable();
	output.deferCallbacks = true;
	const driver = writer(output, { redrawIntervalMs: 0, graphicsEnabled: true });
	driver.start();
	output.completeCallback(0);
	const pane = { column: 0, row: 0, cols: 20, rows: 4 };
	const rows = Array.from({ length: 4 }, () => "");
	driver.submit({ ...frame(rows), graphics: typedGraphics("owner-A", pane, pngBase64(200, 120, 29)) }, 20, 4);
	output.completeCallback(1);
	driver.submit({ ...frame(rows), graphics: typedGraphics("owner-B", pane, pngBase64(200, 120, 181)) }, 20, 4);
	const closing = driver.close();
	const cleanup = outputText(output, 3);
	assert.ok(cleanup.includes("\x1b_Ga=d,d=I,i=1,q=2\x1b\\"), "cleanup retains the prior owner's possibly visible image");
	assert.ok(cleanup.includes("\x1b_Ga=d,d=I,i=2,q=2\x1b\\"), "cleanup also targets the replacement transfer accepted but not callback-settled");
	output.completeCallback(2);
	output.completeCallback(3);
	assert.equal(await closing, true);
});

test("graphics backpressure retains only the newest bounded candidate and unsupported/oversized images become native fallback text", async () => {
	const output = new SyntheticWritable();
	output.writeResults.push(true, false);
	const driver = writer(output, { redrawIntervalMs: 0, graphicsEnabled: true });
	driver.start();
	const imageA = pngBase64(200, 120, 11);
	const imageB = pngBase64(200, 120, 207);
	const pane = { column: 0, row: 0, cols: 40, rows: 2 };
	const graphicsFrame = (ownerId: string, base64: string): ComposedHostFrame => ({
		...frame(["" , ""]),
		graphics: {
			ownerId,
			pane,
			frame: {
				images: [{ id: "kitty-7", mimeType: "image/png", widthPx: 200, heightPx: 120, base64 }],
				placements: [{ id: "placement-7", imageId: "kitty-7", column: 0, row: 0, columns: 40, rows: 1,
					crop: { x: 0, y: 0, width: 200, height: 120 },
					clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 } }],
				fallbacks: [{ id: "placement-7", mimeType: "image/png", widthPx: 200, heightPx: 120,
					column: 0, row: 0, columns: 40, rows: 1,
					clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 } }],
			},
		},
	});
	driver.submit(graphicsFrame("owner-A", imageA), 40, 2);
	driver.submit(graphicsFrame("owner-B", imageB), 40, 2);
	driver.submit(frame(["latest text", ""]), 40, 2);
	assert.equal(output.writes.length, 2, "the blocked image write is the sole in-flight payload");
	output.emit("drain");
	assert.equal(output.writes.length, 3);
	const afterDrain = outputText(output, 2);
	assert.ok(afterDrain.includes("\x1b_Ga=d,d=I,i=1,q=2\x1b\\"), "the last pending frame cleans the sent image");
	assert.equal(afterDrain.includes(`;${imageB}\x1b\\`), false, "the superseded B transfer is never emitted");
	assert.ok(afterDrain.includes("latest text"));
	assert.equal(await driver.close(), true);

	const fallbackText = imageFallback("image/png", { widthPx: 200, heightPx: 120 });
	const unsupportedOutput = new SyntheticWritable();
	const unsupported = writer(unsupportedOutput, { redrawIntervalMs: 0 });
	unsupported.start();
	unsupported.submit(graphicsFrame("unsupported-owner", imageA), 40, 2);
	const unsupportedBytes = outputText(unsupportedOutput, 1);
	assert.ok(unsupportedBytes.includes(fallbackText), "unsupported output uses Pi's public imageFallback text");
	assert.equal(unsupportedBytes.includes("\x1b_Ga="), false, "unsupported output emits no Kitty protocol");
	assert.equal(await unsupported.close(), true);

	const malformedOutput = new SyntheticWritable();
	const malformed = writer(malformedOutput, { redrawIntervalMs: 0, graphicsEnabled: true });
	malformed.start();
	const malformedCandidate = graphicsFrame("malformed-owner", imageA);
	const malformedLayer = malformedCandidate.graphics;
	assert.ok(malformedLayer);
	const malformedPlacement = malformedLayer.frame.placements[0];
	assert.ok(malformedPlacement);
	malformed.submit({
		...malformedCandidate,
		graphics: {
			...malformedLayer,
			frame: {
				...malformedLayer.frame,
				placements: [{ ...malformedPlacement, clip: { ...malformedPlacement.clip, leftColumns: -1 } }],
			},
		},
	}, 40, 2);
	const malformedBytes = outputText(malformedOutput, 1);
	assert.ok(malformedBytes.includes(fallbackText), "malformed placement controls use bounded safe fallback text");
	assert.equal(malformedBytes.includes("\x1b_Ga=t"), false, "malformed controls never reach Kitty output");
	assert.equal(await malformed.close(), true);

	const oversizedOutput = new SyntheticWritable();
	const errors: string[] = [];
	const oversized = writer(oversizedOutput, {
		redrawIntervalMs: 0,
		graphicsEnabled: true,
		onError: (error) => errors.push(error.message),
	});
	oversized.start();
	const oversizedLayer = graphicsFrame("oversized-owner", "A".repeat(4 * 1024 * 1024 + 4));
	oversized.submit(oversizedLayer, 40, 2);
	const oversizedBytes = outputText(oversizedOutput, 1);
	assert.ok(oversizedBytes.includes(fallbackText), "graphics past the typed payload cap fall back instead of failing text output");
	assert.equal(oversizedBytes.includes("\x1b_Ga=t"), false);
	assert.deepEqual(errors, [], "oversized graphics do not become a host output failure");
	assert.equal(await oversized.close(), true);
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
