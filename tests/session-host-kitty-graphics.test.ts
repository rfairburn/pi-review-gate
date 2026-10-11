import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
	createTerminalGraphicsBudget,
	KittyGraphicsSplitter,
	type TerminalGraphicsBudget,
} from "../src/session-host/kitty-graphics";
import { TerminalSurface } from "../src/session-host/terminal-surface";

const ESC = "\x1b";
const ST = `${ESC}\\`;

function pngBase64(width = 4, height = 4): string {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const raw = Buffer.alloc(height * (width * 4 + 1));
	const makeChunk = (type: string, data: Buffer) => {
		const typeBytes = Buffer.from(type, "ascii");
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crcInput = Buffer.concat([typeBytes, data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(crcInput));
		return Buffer.concat([length, typeBytes, data, crc]);
	};
	return Buffer.concat([
		signature,
		makeChunk("IHDR", header),
		makeChunk("IDAT", deflateSync(raw)),
		makeChunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

function pngWithCorruptIdatCrc(): string {
	const png = Buffer.from(pngBase64(), "base64");
	const idat = 8 + 25;
	const crcOffset = idat + 8 + png.readUInt32BE(idat);
	png[crcOffset] = (png[crcOffset] as number) ^ 1;
	return png.toString("base64");
}

function pngWithDimensions(width: number, height: number): string {
	const png = Buffer.from(pngBase64(), "base64");
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
	return png.toString("base64");
}

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

function transfer(base64: string, options = "c=2,r=2,i=7"): string {
	return `${ESC}_Ga=T,f=100,q=2,C=1,${options};${base64}${ST}`;
}

async function writeAll(surface: TerminalSurface, chunks: string[]): Promise<void> {
	for (const chunk of chunks) {
		surface.write(chunk);
	}
	await surface.flush();
}

function text(frame: ReturnType<TerminalSurface["frame"]>): string {
	return frame.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
}

test("incremental splitter isolates Kitty APC and recognizes an ST split across writes", () => {
	const splitter = new KittyGraphicsSplitter();
	const payload = pngBase64();
	const first = splitter.push(`before${ESC}_Ga=T,f=100;${payload}${ESC}`);
	assert.deepEqual(first, [{ kind: "terminal", data: "before" }]);
	const second = splitter.push(`\\after`);
	assert.deepEqual(second, [
		{ kind: "graphics", command: `Ga=T,f=100;${payload}` },
		{ kind: "terminal", data: "after" },
	]);
	const third = splitter.push("tail");
	assert.deepEqual(third, [{ kind: "terminal", data: "tail" }]);
});

test("split ordinary ESC prefixes preserve terminal CSI positioning and text", async () => {
	const splitter = new KittyGraphicsSplitter();
	assert.deepEqual(splitter.push(ESC), []);
	assert.deepEqual(splitter.push("[2;3Htext"), [
		{ kind: "terminal", data: `${ESC}[2;3Htext` },
	]);
	splitter.dispose();

	const surface = new TerminalSurface(12, 4);
	await writeAll(surface, [ESC, "[2;3H"]);
	assert.equal(surface.frame().cursor.column, 2);
	assert.equal(surface.frame().cursor.row, 1);
	await writeAll(surface, ["text"]);
	assert.equal(text(surface.frame()).split("\n")[1]?.slice(2, 6), "text");
	surface.dispose();
});

test("alternate invalidation follows parsed clears and event-time scrolling", async () => {
	const surface = new TerminalSurface(12, 4);
	const placement = `${ESC}_Ga=p,q=2,C=1,c=2,r=1,i=70${ST}`;
	await writeAll(surface, [`${ESC}[?1049h`, transfer(pngBase64(), "c=2,r=1,i=70")]);
	await writeAll(surface, [`${ESC}[`, "2J"]);
	assert.equal(surface.frame().graphics, undefined, "split ED clears blank image anchors");

	await writeAll(surface, [`${ESC}[1;1H`, placement]);
	await writeAll(surface, [`${ESC}[4;1H\n`]);
	assert.equal(surface.frame().graphics, undefined, "cursor movement before LF is observed at parse time");

	await writeAll(surface, [`${ESC}[1;1H`, placement]);
	await writeAll(surface, [`${ESC}[>2J`]);
	assert.equal(surface.frame().graphics?.placements.length, 1, "unsupported CSI prefixes do not clear placements");

	await writeAll(surface, [`${ESC}[1;1H`, " ".repeat(60)]);
	assert.equal(surface.frame().graphics, undefined, "blank autowrap scrolling invalidates anchors");
	surface.dispose();
});

test("graphics-looking bytes inside OSC, DCS, APC, PM, and SOS remain opaque", () => {
	const fake = `${ESC}_Ga=T,f=100;not-an-image`;
	const inputs = [
		`${ESC}]0;${fake}\x07`,
		`${ESC}P1;${fake}${ST}`,
		`${ESC}_X${fake}${ST}`,
		`${ESC}^${fake}${ST}`,
		`${ESC}X${fake}${ST}`,
	];
	for (const input of inputs) {
		const splitter = new KittyGraphicsSplitter();
		const parts = splitter.push(input);
		assert.deepEqual(parts, [{ kind: "terminal", data: input }]);
		assert.ok(!parts.some((part) => part.kind === "graphics"));
	}
});

test("oversized and over-fragmented APCs are discarded without leaking bytes", () => {
	const oversized = new KittyGraphicsSplitter();
	const parts = oversized.push(`${ESC}_G${"A".repeat(4 * 1024 * 1024 + 1100)}${ST}safe`);
	assert.equal(parts[0]?.kind, "discard");
	assert.deepEqual(parts[1], { kind: "terminal", data: "safe" });

	const fragmented = new KittyGraphicsSplitter();
	fragmented.push(`${ESC}_G`);
	for (let index = 0; index < 4100; index += 1) {
		fragmented.push("A");
	}
	assert.deepEqual(fragmented.push(`${ST}tail`), [
		{ kind: "discard" },
		{ kind: "terminal", data: "tail" },
	]);

	const eventBounded = new KittyGraphicsSplitter();
	const deleteEvent = `${ESC}_Ga=d,d=a${ST}`;
	const eventParts = eventBounded.push(deleteEvent.repeat(5000));
	assert.equal(eventParts.filter((part) => part.kind === "graphics").length, 4096);
	assert.equal(eventParts.filter((part) => part.kind === "graphics-overflow").length, 1);
	assert.ok(eventParts.length <= 4098, "excess commands coalesce without unbounded event objects");
});

test("TerminalSurface ingests only validated Kitty PNGs at event-time cursor positions", async () => {
	const surface = new TerminalSurface(20, 6);
	const png = pngBase64();
	await writeAll(surface, [`A\r\nB${transfer(png)}tail`]);
	const frame = surface.frame();
	assert.deepEqual(text(frame).split("\n").slice(0, 2).map((line) => line.trimEnd()), ["A", "Btail"]);
	assert.deepEqual(frame.graphics?.images.map(({ id, mimeType, widthPx, heightPx }) => ({
		id, mimeType, widthPx, heightPx,
	})), [{ id: "kitty-7", mimeType: "image/png", widthPx: 4, heightPx: 4 }]);
	assert.ok(Object.isFrozen(frame.graphics));
	assert.ok(Object.isFrozen(frame.graphics?.images));
	assert.equal(frame.graphics?.images[0], surface.frame().graphics?.images[0], "frame snapshots reuse immutable payload objects");
	assert.ok(Object.isFrozen(frame.graphics?.placements[0]));
	assert.deepEqual(frame.graphics?.fallbacks[0], {
		id: "image-kitty-7",
		mimeType: "image/png",
		widthPx: 4,
		heightPx: 4,
		column: 1,
		row: 1,
		columns: 2,
		rows: 2,
		clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 },
	});
	assert.deepEqual(frame.graphics?.placements[0], {
		id: "image-kitty-7",
		imageId: "kitty-7",
		column: 1,
		row: 1,
		columns: 2,
		rows: 2,
		crop: { x: 0, y: 0, width: 4, height: 4 },
		clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 },
	});
	assert.equal(frame.cursor.column, 5, "later child text determines the final cursor, not image placement");
	assert.ok(frame.lines.every((line) => !line.replace(/\x1b\[[0-9;]*m/g, "").includes(ESC)));
	surface.dispose();
});

test("intercepted APCs terminate an incomplete VT escape state without changing cursor position", async () => {
	const surface = new TerminalSurface(12, 4);
	await writeAll(surface, [`${ESC}[31`, transfer(pngBase64()), "mtext"]);
	assert.ok(text(surface.frame()).includes("mtext"), "suffix is parsed in ground state after the intercepted APC");
	assert.equal(surface.frame().graphics?.placements[0]?.column, 0);
	assert.ok(
		(surface.frame().styles ?? []).every(({ runs }) => runs.every((run) => run.fg === undefined && run.bg === undefined)),
		"aborted CSI does not apply child colors",
	);
	surface.dispose();
});

test("chunked image data is assembled safely and only the final Kitty event places it", async () => {
	const surface = new TerminalSurface(12, 4);
	const png = pngBase64();
	const split = Math.floor(png.length / 2 / 4) * 4;
	const first = png.slice(0, split);
	const second = png.slice(split);
	await writeAll(surface, [
		`${ESC}_Ga=T,f=100,q=2,C=1,c=2,r=2,i=12,m=1;${first}${ST}`,
		`${ESC}_Gm=0;${second}${ST}`,
	]);
	assert.equal(surface.frame().graphics?.images[0]?.base64, png);
	assert.equal(surface.frame().graphics?.placements[0]?.imageId, "kitty-12");
	surface.dispose();
});

test("native cropped transfers, q/C redraws, and unsigned image IDs are accepted within bounds", async () => {
	const surface = new TerminalSurface(12, 4);
	const png = pngBase64();
	await writeAll(surface, [transfer(png, "c=2,r=2,i=4294967295,y=1,h=2")]);
	assert.deepEqual(surface.frame().graphics?.placements[0]?.crop, { x: 0, y: 1, width: 4, height: 2 });

	const nativePlacement = `${ESC}_Ga=p,q=2,C=1,c=2,r=2,i=4294967295,y=1,h=2${ST}`;
	await writeAll(surface, [`${ESC}[?1049h`, nativePlacement]);
	assert.deepEqual(surface.frame().graphics?.placements[0]?.crop, { x: 0, y: 1, width: 4, height: 2 });
	await writeAll(surface, [`${ESC}_Ga=d,d=a${ST}`, nativePlacement]);
	assert.equal(surface.frame().graphics?.placements.length, 1, "native redraw placement survives d=a then a=p");
	await writeAll(surface, [`${ESC}_Ga=d,d=I,i=4294967295${ST}`]);
	assert.equal(surface.frame().graphics, undefined, "scoped deletion accepts the unsigned 32-bit image id");

	const split = Math.floor(png.length / 2 / 4) * 4;
	await writeAll(surface, [
		`${ESC}_Ga=T,f=100,q=2,C=1,c=2,r=2,i=4294967294,x=1,y=1,w=2,h=2,m=1;${png.slice(0, split)}${ST}`,
		`${ESC}_Gm=0;${png.slice(split)}${ST}`,
	]);
	assert.deepEqual(surface.frame().graphics?.placements.find(({ imageId }) => imageId === "kitty-4294967294")?.crop,
		{ x: 1, y: 1, width: 2, height: 2 });
	await writeAll(surface, [transfer(png, "c=2,r=2,i=4294967293,y=3,h=2")]);
	assert.equal(surface.frame().graphics?.placements.some(({ imageId }) => imageId === "kitty-4294967293"), false);
	assert.ok(surface.frame().graphics?.fallbacks.some(({ id }) => id === "image-kitty-4294967293"),
		"out-of-bounds initial crop is rejected into a payload-free fallback");

	await writeAll(surface, [`${ESC}_Ga=d,d=A${ST}`]);
	await writeAll(surface, [
		transfer(png, "c=2,r=2,i=4294967296"),
		`${ESC}_Ga=p,q=2,C=1,c=2,r=2,i=4294967296${ST}`,
		`${ESC}_Ga=d,d=I,i=4294967296${ST}`,
	]);
	assert.equal(surface.frame().graphics, undefined, "IDs above 0xffffffff are rejected for transfer, placement, and deletion");
	surface.dispose();
});

test("transfer assembly count and PNG dimension/pixel bounds fail before retention", async () => {
	const surface = new TerminalSurface(12, 4);
	const base64 = pngBase64();
	const chunks = [`${ESC}_Ga=T,f=100,q=2,C=1,c=2,r=2,i=50,m=1;${ST}`];
	for (let index = 1; index < 1024; index += 1) {
		chunks.push(`${ESC}_Gm=1;${ST}`);
	}
	chunks.push(`${ESC}_Gm=0;${base64}${ST}`);
	await writeAll(surface, chunks);
	assert.equal(surface.frame().graphics?.fallbacks.length, 1, "excess transfer chunk count degrades to fallback");
	assert.deepEqual(surface.frame().graphics?.fallbacks[0]?.widthPx, 4, "bounded PNG header dimensions survive rejected assembly");
	await writeAll(surface, [transfer(pngWithDimensions(3000, 3000), "c=2,r=2,i=51")]);
	assert.equal(surface.frame().graphics?.images.length, 0, "over-budget pixel dimensions are rejected before caching");
	assert.equal(surface.frame().graphics?.fallbacks[1]?.widthPx, undefined, "out-of-bound dimensions are not exposed");
	surface.dispose();
});

test("shared graphics budget accounts for image allocations and releases on replace/delete/dispose", async () => {
	const budget = createTerminalGraphicsBudget();
	const first = new TerminalSurface(12, 4, { graphicsBudget: budget });
	const second = new TerminalSurface(12, 4, { graphicsBudget: budget });
	const png = pngBase64();
	await writeAll(first, Array.from({ length: 64 }, (_, index) => transfer(png, `c=1,r=1,i=${100 + index}`)));
	await writeAll(second, [transfer(png, "c=1,r=1,i=200")]);
	assert.equal(second.frame().graphics?.images.length, 0, "host-wide image count rejects retention");
	assert.equal(second.frame().graphics?.fallbacks.length, 1, "rejected image keeps only bounded fallback metadata");

	await writeAll(first, [transfer(png, "c=1,r=1,i=100")]);
	assert.equal(first.frame().graphics?.images.length, 64, "same-id replacement releases before reserving");
	await writeAll(first, [`${ESC}_Ga=d,d=I,i=101${ST}`]);
	await writeAll(second, [transfer(png, "c=1,r=1,i=201")]);
	assert.equal(second.frame().graphics?.images.length, 1, "scoped delete releases one host-wide image lease");

	first.dispose();
	await writeAll(second, [transfer(png, "c=1,r=1,i=202")]);
	assert.equal(second.frame().graphics?.images.length, 2, "disposing a surface releases all its retained image leases");
	second.dispose();
});

test("shared placement budget falls back safely and releases on scoped placement deletion", async () => {
	const budget = createTerminalGraphicsBudget();
	const first = new TerminalSurface(12, 4, { graphicsBudget: budget });
	const second = new TerminalSurface(12, 4, { graphicsBudget: budget });
	const png = pngBase64();
	await writeAll(first, [transfer(png, "c=1,r=1,i=300")]);
	const placements = Array.from({ length: 255 }, (_, index) => `${ESC}_Ga=p,i=300,r=1,p=${index + 1}${ST}`);
	await writeAll(first, placements);
	await writeAll(second, [transfer(png, "c=1,r=1,i=400")]);
	assert.equal(second.frame().graphics?.placements.length, 0);
	assert.equal(second.frame().graphics?.fallbacks.length, 1, "placement allocation failure degrades to typed Image fallback");
	await writeAll(first, [`${ESC}_Ga=d,d=I,p=1${ST}`]);
	await writeAll(second, [transfer(png, "c=1,r=1,i=401")]);
	assert.equal(second.frame().graphics?.placements.length, 1, "scoped placement deletion releases the shared slot");
	first.dispose();
	second.dispose();
});

test("shared pending-transfer budget is independent and releases on cancellation", async () => {
	const budget = createTerminalGraphicsBudget();
	const surfaces = Array.from({ length: 10 }, () => new TerminalSurface(12, 4, { graphicsBudget: budget }));
	for (let index = 0; index < 8; index += 1) {
		await writeAll(surfaces[index] as TerminalSurface, [`${ESC}_Ga=T,f=100,q=2,C=1,c=1,r=1,i=${500 + index},m=1;${ST}`]);
	}
	await writeAll(surfaces[8] as TerminalSurface, [`${ESC}_Ga=T,f=100,q=2,C=1,c=1,r=1,i=508,m=1;${ST}`]);
	assert.equal(surfaces[8]?.frame().graphics?.fallbacks.length, 1, "ninth concurrent transfer degrades to a payload-free fallback");
	await writeAll(surfaces[0] as TerminalSurface, [`${ESC}_Ga=d,d=I,i=500${ST}`]);
	await writeAll(surfaces[9] as TerminalSurface, [`${ESC}_Ga=T,f=100,q=2,C=1,c=1,r=1,i=509,m=1;${ST}`]);
	assert.equal(surfaces[9]?.frame().graphics, undefined, "cancellation releases a shared pending-transfer slot");
	for (const surface of surfaces) {
		surface.dispose();
	}
});

test("shared budget charges unterminated APC fragments and releases on overflow, completion, and disposal", async () => {
	const base = createTerminalGraphicsBudget();
	let pendingBytes = 0;
	const budget: TerminalGraphicsBudget = {
		reserveImage: (...args) => base.reserveImage(...args),
		reserveFallbackImage: () => base.reserveFallbackImage(),
		reservePlacement: (fallback) => base.reservePlacement(fallback),
		reservePendingTransfer: () => base.reservePendingTransfer(),
		reservePendingBytes: (bytes) => {
			const lease = base.reservePendingBytes(bytes);
			if (!lease) {
				return undefined;
			}
			pendingBytes += bytes;
			let active = true;
			return Object.freeze({
				release: () => {
					if (active) {
						active = false;
						pendingBytes -= bytes;
						lease.release();
					}
				},
			});
		},
	};
	const surfaces = Array.from({ length: 7 }, () => new TerminalSurface(12, 4, { graphicsBudget: budget }));
	const megabyte = 1024 * 1024;
	const fragment = "A".repeat(2 * megabyte);
	for (let index = 0; index < 5; index += 1) {
		await writeAll(surfaces[index] as TerminalSurface, [`${ESC}_G${fragment}`]);
	}
	const limit = 24 * megabyte;
	const almostTwoMiB = 2 * megabyte - 6;
	await writeAll(surfaces[5] as TerminalSurface, [`${ESC}_G${"A".repeat(almostTwoMiB)}`]);
	assert.equal(pendingBytes, limit, "incomplete fragment bytes are charged across surfaces");
	await writeAll(surfaces[6] as TerminalSurface, [`${ESC}_G`]);
	await writeAll(surfaces[6] as TerminalSurface, ["A".repeat(1024)]);
	assert.equal(pendingBytes, limit, "refused APCs discard further fragments without retaining them");
	await writeAll(surfaces[6] as TerminalSurface, [ST]);
	assert.equal(pendingBytes, limit, "overflow storage remains released while scanning to the terminator");

	const oneFragmentCharge = 2 + 2 * fragment.length;
	await writeAll(surfaces[0] as TerminalSurface, ["B".repeat(3 * megabyte)]);
	assert.equal(pendingBytes, limit - oneFragmentCharge, "local APC overflow releases earlier shared fragment leases");
	(surfaces[0] as TerminalSurface).dispose();
	await writeAll(surfaces[1] as TerminalSurface, [ST]);
	assert.equal(pendingBytes, limit - 2 * oneFragmentCharge, "APC completion releases its fragment lease");
	(surfaces[2] as TerminalSurface).dispose();
	assert.equal(pendingBytes, limit - 3 * oneFragmentCharge, "disposing an unterminated surface releases its fragment lease");
	for (const surface of surfaces.slice(3, 6)) {
		surface.dispose();
	}
	(surfaces[6] as TerminalSurface).dispose();
	assert.equal(pendingBytes, 0);
});

test("per-surface image data cache enforces its bounded image count", async () => {
	const surface = new TerminalSurface(12, 4);
	const png = pngBase64();
	const transfers = Array.from({ length: 65 }, (_, index) => transfer(png, `c=1,r=1,i=${100 + index}`));
	await writeAll(surface, transfers);
	assert.equal(surface.frame().graphics?.images.length, 64);
	assert.equal(surface.frame().graphics?.placements.length, 64);
	surface.dispose();
});

test("unsupported payloads, formats, offsets, and invalid crops fail closed", async () => {
	const surface = new TerminalSurface(12, 4);
	const png = pngBase64();
	const unsupported = [
		`${ESC}_Ga=T,f=24,q=2,C=1,c=2,r=2,i=1;${png}${ST}`,
		`${ESC}_Ga=T,f=100,q=2,C=1,c=2,r=2,i=2,X=1;${png}${ST}`,
		`${ESC}_Ga=T,f=100,q=2,C=1,c=2,r=2,i=3;not-base64${ST}`,
		`${ESC}_Ga=T,f=100,q=2,C=1,c=2,r=2,i=4;${Buffer.from("not png").toString("base64")}${ST}`,
		transfer(pngWithCorruptIdatCrc(), "c=2,r=2,i=5"),
	];
	await writeAll(surface, [...unsupported, "clean text"]);
	const graphics = surface.frame().graphics;
	assert.equal(graphics?.images.length, 0);
	assert.equal(graphics?.placements.length, 0);
	assert.deepEqual(graphics?.fallbacks.map(({ mimeType, widthPx, heightPx }) => ({ mimeType, widthPx, heightPx })), [
		{ mimeType: "image/png", widthPx: undefined, heightPx: undefined },
		{ mimeType: "image/png", widthPx: undefined, heightPx: undefined },
		{ mimeType: "image/png", widthPx: 4, heightPx: 4 },
	]);
	assert.ok(graphics?.fallbacks.every((fallback) => !("base64" in fallback)), "fallback retains no rejected payload");
	assert.ok(text(surface.frame()).includes("clean text"));
	assert.ok(surface.frame().lines.every((line) => !line.replace(/\x1b\[[0-9;]*m/g, "").includes(ESC)));
	surface.dispose();
});

test("alternate placements use bounded crop data, local deletes, and retained image cache", async () => {
	const surface = new TerminalSurface(12, 4);
	const png = pngBase64(4, 4);
	await writeAll(surface, [transfer(png)]);
	assert.ok(surface.frame().graphics, "initial placement is visible in normal buffer");
	await writeAll(surface, [
		`${ESC}[?1049h`,
		`${ESC}_Ga=p,i=7,y=1,h=2,r=2${ST}`,
	]);
	assert.deepEqual(surface.frame().graphics?.placements[0]?.crop, { x: 0, y: 1, width: 4, height: 2 });
	assert.equal(surface.frame().graphics?.placements[0]?.columns, 2, "native alt redraw reuses transfer width");
	await writeAll(surface, ["alternate content changed"]);
	assert.equal(surface.frame().graphics, undefined, "changed alternate text invalidates unmarked stale placements");
	await writeAll(surface, [`${ESC}_Ga=d,d=a${ST}`]);
	assert.equal(surface.frame().graphics, undefined, "d=a clears active alternate placements");
	await writeAll(surface, [`${ESC}[?1049l`]);
	assert.ok(surface.frame().graphics, "alternate clear does not erase normal placements");
	await writeAll(surface, [`${ESC}[?1049h`, `${ESC}_Ga=p,i=7,r=2,y=0,h=3${ST}`]);
	assert.ok(surface.frame().graphics, "image data survives display/buffer switches");
	await writeAll(surface, [`${ESC}_Ga=d,d=I,i=7${ST}`]);
	assert.equal(surface.frame().graphics, undefined, "scoped image deletion removes its placements and data");
	await writeAll(surface, [`${ESC}[?1049l`, transfer(png, "c=2,r=2,i=8"), `${ESC}_Ga=d,d=A${ST}`]);
	assert.equal(surface.frame().graphics, undefined, "d=A clears every local placement and cached image");
	surface.dispose();
});

test("alternate interleaved redraws preserve local anchors while blank/repeated scroll and clear invalidate", async () => {
	const surface = new TerminalSurface(12, 4);
	const png = pngBase64();
	surface.write(`${ESC}[?1049h${ESC}[2J${ESC}[1;1H${transfer(png, "c=2,r=1,i=70")}${ESC}[4;1Hfooter`);
	await surface.flush();
	assert.equal(surface.frame().graphics?.placements.length, 1,
		"unrelated footer text does not invalidate an earlier image in the same redraw write");

	await writeAll(surface, [`${ESC}[2J${ESC}[1;1H`, transfer(png, "c=2,r=1,i=70"), `${ESC}[1S`]);
	assert.equal(surface.frame().graphics, undefined, "scrolling an otherwise blank alternate screen invalidates its image anchor");

	await writeAll(surface, [
		`${ESC}[2J${ESC}[1;1Hsame${ESC}[2;1Hsame${ESC}[3;1Hsame${ESC}[4;1Hsame${ESC}[2;1H`,
		transfer(png, "c=2,r=1,i=70"),
		`${ESC}[1S`,
	]);
	assert.equal(surface.frame().graphics, undefined, "repeated-text scroll invalidates even when visible text compares equal");

	await writeAll(surface, [`${ESC}[2J${ESC}[1;1H`, transfer(png, "c=2,r=1,i=70"), `${ESC}[2J`]);
	assert.equal(surface.frame().graphics, undefined, "full-screen clear removes alternate placements even on blank rows");
	surface.dispose();
});

test("invalid placement crops/offsets do not replace valid placement state", async () => {
	const surface = new TerminalSurface(12, 4);
	await writeAll(surface, [transfer(pngBase64())]);
	await writeAll(surface, [
		`${ESC}_Ga=p,i=7,r=2,y=3,h=2${ST}`,
		`${ESC}_Ga=p,i=7,r=2,y=nope${ST}`,
		`${ESC}_Ga=p,i=7,r=2,y=0,h=2,Y=1${ST}`,
	]);
	assert.equal(surface.frame().graphics?.placements[0]?.crop.y, 0);
	assert.equal(surface.frame().graphics?.placements[0]?.crop.height, 4);
	surface.dispose();
});

test("normal scrollback markers retain event rows and expose partial viewport clipping", async () => {
	const surface = new TerminalSurface(10, 2, { scrollback: 5 });
	const png = pngBase64();
	await writeAll(surface, [`${ESC}[2;1H`, transfer(png, "c=2,r=2,i=9")]);
	await writeAll(surface, ["\r\n", "\r\n"]);
	const placement = surface.frame().graphics?.placements[0];
	assert.ok(placement);
	assert.equal(placement.row, -1, "public normal-buffer marker follows scrollback movement");
	assert.equal(placement.clip.topRows, 1, "partially visible image is clipped, not shifted or resized");
	assert.equal(placement.column, 0);
	assert.equal(placement.rows, 2);
	surface.dispose();
});

test("resize invalidates geometry-bound placements but preserves per-surface image data", async () => {
	const surface = new TerminalSurface(12, 4);
	await writeAll(surface, [transfer(pngBase64())]);
	assert.ok(surface.frame().graphics);
	surface.resize(10, 5);
	assert.equal(surface.frame().graphics, undefined);
	await writeAll(surface, [`${ESC}[?1049h`, `${ESC}_Ga=p,i=7,r=2${ST}`]);
	assert.ok(surface.frame().graphics, "payload cache remains usable after geometry changes");
	surface.dispose();
});
