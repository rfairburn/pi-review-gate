/**
 * Focused tests for the terminal surface's native clipboard capsule OSC (#466)
 * and the unchanged raw OSC 52 denial.
 *
 * Scope: these cases use the real pinned @xterm/headless parse pipeline and
 * prove only this class's boundary — the capsule payload is handed verbatim to
 * the owner's callback exactly once, is never rendered/replied/logged by the
 * surface, and never becomes a clipboard action here. Capsule authentication
 * belongs to the receiver's owner; host routing/fencing belongs to the manager
 * and Main tests. No real terminal, clipboard, or child process is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { NATIVE_CLIPBOARD_OSC } from "../src/session-host/native-clipboard";
import { TerminalSurface, type TerminalSurfaceOptions } from "../src/session-host/terminal-surface";

const ESC = "\x1b";
const BEL = "\x07";
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;

/** The exact wire shape the owned child adapter emits for one verified request. */
function capsuleOsc(capsule: string): string {
	return `${ESC}]${NATIVE_CLIPBOARD_OSC};${capsule}${BEL}`;
}

function plainText(line: string): string {
	assert.ok(!line.replace(SGR_PATTERN, "").includes(ESC), "non-SGR escape in frame line");
	return line.replace(SGR_PATTERN, "");
}

function frameText(surface: TerminalSurface): string {
	return surface.frame().lines.map((line) => plainText(line)).join("\n");
}

async function writeAll(surface: TerminalSurface, chunks: readonly string[]): Promise<void> {
	for (const chunk of chunks) {
		surface.write(chunk);
	}
	await surface.flush();
}

function makeSurface(options: TerminalSurfaceOptions = {}): TerminalSurface {
	return new TerminalSurface(20, 4, options);
}

test("the native capsule OSC reaches the owner verbatim once and never reaches frame text", async () => {
	const capsules: string[] = [];
	const replies: string[] = [];
	const surface = makeSurface({
		onNativeClipboardCapsule: (capsule) => capsules.push(capsule),
		onReply: (data) => replies.push(data),
	});
	try {
		await writeAll(surface, ["visible", capsuleOsc("prg-native-copy-v1;SECRETBODY;base64mac")]);
		assert.deepEqual(capsules, ["prg-native-copy-v1;SECRETBODY;base64mac"]);
		const rendered = frameText(surface);
		assert.ok(rendered.includes("visible"), "ordinary output still renders");
		assert.ok(!rendered.includes("SECRETBODY"), "capsule body never renders");
		assert.ok(!rendered.includes("prg-native-copy-v1"), "capsule prefix never renders");
		assert.ok(!rendered.includes(String(NATIVE_CLIPBOARD_OSC)), "capsule OSC number never renders");
		assert.deepEqual(replies, [], "the capsule generates no reply to the child");
	} finally {
		surface.dispose();
	}
});

test("raw OSC 52 stays swallowed: no capsule callback, no rendering, no reply", async () => {
	const capsules: string[] = [];
	const replies: string[] = [];
	const surface = makeSurface({
		onNativeClipboardCapsule: (capsule) => capsules.push(capsule),
		onReply: (data) => replies.push(data),
	});
	const secret64 = Buffer.from("raw-child-secret", "utf8").toString("base64");
	try {
		await writeAll(surface, ["shown", `${ESC}]52;c;${secret64}${BEL}`, `${ESC}]52;p;${secret64}${BEL}`]);
		assert.deepEqual(capsules, [], "raw OSC 52 never becomes a capsule request");
		const rendered = frameText(surface);
		assert.ok(rendered.includes("shown"));
		assert.ok(!rendered.includes(secret64), "OSC 52 payload never renders");
		assert.ok(!rendered.includes("raw-child-secret"));
		assert.deepEqual(replies, []);
	} finally {
		surface.dispose();
	}
});

test("an unverified or malformed capsule is still claimed and never rendered", async () => {
	const capsules: string[] = [];
	const surface = makeSurface({ onNativeClipboardCapsule: (capsule) => capsules.push(capsule) });
	const forged = "prg-native-copy-v1;not-base64!!;deadbeef";
	try {
		await writeAll(surface, ["after", capsuleOsc(forged), "done"]);
		// Claiming it is the surface's job; rejecting it is the receiver's job.
		assert.deepEqual(capsules, [forged]);
		const rendered = frameText(surface);
		assert.ok(rendered.includes("after") && rendered.includes("done"));
		assert.ok(!rendered.includes("deadbeef"), "forged capsule text never renders");
		assert.ok(!rendered.includes("not-base64"), "forged capsule body never renders");
	} finally {
		surface.dispose();
	}
});

test("Unicode and multiline payloads cross the capsule channel as opaque text, unchanged", async () => {
	const capsules: string[] = [];
	const surface = makeSurface({ onNativeClipboardCapsule: (capsule) => capsules.push(capsule) });
	const encoded = Buffer.from("héllo 🌍\ttabbed\nsecond line — ünïcödé", "utf8").toString("base64");
	const capsule = `prg-native-copy-v1;${encoded};${"a".repeat(64)}`;
	try {
		await writeAll(surface, [capsuleOsc(capsule)]);
		assert.deepEqual(capsules, [capsule], "the exact capsule text crosses once");
		assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "héllo 🌍\ttabbed\nsecond line — ünïcödé");
		assert.equal(frameText(surface).includes(encoded), false);
	} finally {
		surface.dispose();
	}
});

test("a capsule OSC split across write chunks still delivers exactly once", async () => {
	const capsules: string[] = [];
	const surface = makeSurface({ onNativeClipboardCapsule: (capsule) => capsules.push(capsule) });
	const capsule = "prg-native-copy-v1;SPLITBODY;macvalue";
	const osc = capsuleOsc(capsule);
	try {
		await writeAll(surface, [osc.slice(0, 4), osc.slice(4, 17), osc.slice(17)]);
		assert.deepEqual(capsules, [capsule]);
		assert.ok(!frameText(surface).includes("SPLITBODY"));
	} finally {
		surface.dispose();
	}
});

test("unrelated OSC numbers never reach the capsule callback or the frame", async () => {
	const capsules: string[] = [];
	const surface = makeSurface({ onNativeClipboardCapsule: (capsule) => capsules.push(capsule) });
	try {
		await writeAll(surface, [
			"body",
			`${ESC}]0;ICON_TITLE_NEVER${BEL}`,
			`${ESC}]2;WINDOW_TITLE_NEVER${BEL}`,
			`${ESC}]10;?${BEL}`,
			`${ESC}]778;NEIGHBOUR_OSC${BEL}`,
		]);
		assert.deepEqual(capsules, []);
		const rendered = frameText(surface);
		assert.ok(!rendered.includes("ICON_TITLE_NEVER"));
		assert.ok(!rendered.includes("WINDOW_TITLE_NEVER"));
		assert.ok(!rendered.includes("NEIGHBOUR_OSC"));
	} finally {
		surface.dispose();
	}
});

test("a throwing capsule callback cannot strand the parse lifecycle", async () => {
	let changes = 0;
	const surface = makeSurface({
		onNativeClipboardCapsule: () => {
			throw new Error("owner callback failure");
		},
		onChange: () => {
			changes += 1;
		},
	});
	try {
		await writeAll(surface, [capsuleOsc("prg-native-copy-v1;BODY;mac")]);
		await writeAll(surface, ["later-line"]);
		assert.ok(frameText(surface).includes("later-line"), "parsing continues after a throwing callback");
		assert.ok(changes > 0);
	} finally {
		surface.dispose();
	}
});

test("a surface without a capsule owner swallows the capsule OSC silently", async () => {
	const surface = makeSurface();
	try {
		await writeAll(surface, ["text", capsuleOsc("prg-native-copy-v1;UNOWNED;mac")]);
		const rendered = frameText(surface);
		assert.ok(rendered.includes("text"));
		assert.ok(!rendered.includes("UNOWNED"));
		assert.ok(!rendered.includes("prg-native-copy-v1"));
	} finally {
		surface.dispose();
	}
});

test("no capsule callback fires after disposal", async () => {
	const capsules: string[] = [];
	const surface = makeSurface({ onNativeClipboardCapsule: (capsule) => capsules.push(capsule) });
	surface.write(capsuleOsc("prg-native-copy-v1;AFTER_DISPOSE;mac"));
	surface.dispose();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(capsules, [], "a disposed surface delivers nothing to its owner");
});
