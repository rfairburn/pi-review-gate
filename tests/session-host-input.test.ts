import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { Key, matchesKey, parseKey, setKittyProtocolActive } from "pi-session-host-tui";
import {
	InputTargetModes,
	InputViewport,
	KeyboardCapabilityObserver,
	normalizeNativeSourceInput,
	translateInput,
} from "../src/session-host/input";

const ESC = "\x1b";
const CSI = `${ESC}[`;
const SS3 = `${ESC}O`;
const viewport: InputViewport = { column: 0, row: 0, cols: 80, rows: 24 };

function modes(overrides: Partial<InputTargetModes> = {}): InputTargetModes {
	return {
		kittyFlags: 0,
		modifyOtherKeys: 0,
		applicationCursorKeys: false,
		applicationKeypad: false,
		bracketedPaste: false,
		mouseTracking: "any",
		mouseEncoding: "sgr",
		...overrides,
	};
}

function translated(data: string, target: Partial<InputTargetModes> = {}, geometry = viewport) {
	return translateInput(data, modes(target), geometry);
}

test("bare Escape, q, Ctrl-C and joined UTF-8 bytes are preserved by the translator", () => {
	assert.equal(translated(ESC), ESC);
	assert.equal(translated("q"), "q");
	assert.equal(translated("\x03"), "\x03");
	assert.equal(translated("plain é🙂"), "plain é🙂");
	assert.equal(translated("\r\n\t\x7f\x0a"), "\r\n\t\x7f\x0a");
	const longAscii = "a".repeat(300);
	const longUnicode = "🙂é".repeat(150);
	assert.equal(translated(longAscii), longAscii, "long joined ASCII text is not treated as an oversized protocol packet");
	assert.equal(translated(longUnicode), longUnicode, "long joined Unicode text is preserved");
	assert.equal(translated(`${CSI}${"9".repeat(300)}u`), undefined, "oversized escape packets remain rejected");
	assert.equal(translated(`${ESC}[?`), undefined, "unknown raw escape packet is dropped");
});

test("Kitty disambiguation, event and alternate-key flags stay independent", () => {
	const shiftedCtrlA = `${CSI}97:65:99;6u`;
	assert.equal(translated(shiftedCtrlA), `${CSI}97;6u`, "legacy child gets extended combo without guessed layout fields");
	assert.equal(translated(shiftedCtrlA, { kittyFlags: 1 }), `${CSI}97;6u`);
	assert.equal(translated(shiftedCtrlA, { kittyFlags: 4 }), shiftedCtrlA, "actual alternate fields survive only when child requested bit 4");
	assert.equal(translated(shiftedCtrlA, { kittyFlags: 7 }), shiftedCtrlA);
	assert.equal(translated(`${CSI}97;5u`, { kittyFlags: 2 }), "\x01", "event-only mode does not force ordinary Ctrl+A into CSI-u");
	assert.equal(translated(`${CSI}97;2u`, { kittyFlags: 4 }), "A", "alternate-only mode does not force shifted text into CSI-u");
	assert.equal(translated(`${CSI}97;5:3u`, { kittyFlags: 0 }), undefined, "release is dropped rather than becoming a press");
	assert.equal(translated(`${CSI}97;5:3u`, { kittyFlags: 2 }), `${CSI}97;5:3u`, "bit 2 preserves a modified-key release without forcing its press into CSI-u");
	assert.equal(translated(`${CSI}27;1:3u`, { kittyFlags: 2 }), `${CSI}27;1:3u`, "event type follows the modifier field, never the codepoint");
	assert.equal(translated(`${CSI}57376;1:3u`, { kittyFlags: 2 }), `${CSI}57376;1:3u`);
	assert.equal(translated(`${CSI}57376;1:3u`, { kittyFlags: 0 }), undefined);
	assert.equal(translated(`${CSI}57376;1:2u`, { kittyFlags: 0 }), `${CSI}57376;1u`, "repeat degrades to press when bit 2 is absent");
	assert.equal(translated(`${CSI}57376;1:2u`, { kittyFlags: 2 }), `${CSI}57376;1:2u`);
	assert.equal(translated(`${CSI}13;1:3u`, { kittyFlags: 2 }), undefined, "Enter release remains suppressed without bit 8");
	assert.equal(translated(`${CSI}9;1:3u`, { kittyFlags: 2 }), undefined, "Tab release remains suppressed without bit 8");
	assert.equal(translated(`${CSI}127;1:3u`, { kittyFlags: 2 }), undefined, "Backspace release remains suppressed without bit 8");
});

test("modifyOtherKeys target policy translates Kitty events instead of raw-passing enhanced packets", () => {
	const ctrlC = `${CSI}99;5u`;
	assert.equal(translated(ctrlC), "\x03");
	assert.equal(translated(ctrlC, { modifyOtherKeys: 1 }), `${CSI}27;5;99~`);
	assert.equal(translated(ctrlC, { modifyOtherKeys: 2 }), `${CSI}27;5;99~`);
	assert.equal(translated(`${CSI}97;33u`, { modifyOtherKeys: 2 }), `${CSI}27;9;97~`, "Kitty Meta maps to xterm's modifyOtherKeys bit 8");
	assert.equal(translated(`${CSI}27;9;97~`, { modifyOtherKeys: 2 }), `${CSI}27;9;97~`, "xterm Meta is decoded back to Kitty Meta");
	assert.equal(translated(`${CSI}97;33u`, { modifyOtherKeys: 1 }), `${ESC}a`, "mode 1 keeps Meta on the legacy escape-prefix path");
	assert.equal(translated(ctrlC, { kittyFlags: 1, modifyOtherKeys: 2 }), ctrlC, "Kitty bit 1 takes precedence over xterm mode");
	assert.equal(translated(`${CSI}13;2u`, { modifyOtherKeys: 0 }), `${CSI}13;2u`, "legacy mode uses CSI-u when CR would lose Shift+Enter identity");
	assert.equal(translated(`${CSI}13;2u`, { modifyOtherKeys: 1 }), `${CSI}13;2u`, "mode 1 uses CSI-u when legacy bytes would lose Shift+Enter identity");
	assert.equal(translated(`${CSI}13;3u`, { modifyOtherKeys: 1 }), `${ESC}\r`, "mode 1 keeps the unambiguous Alt+Enter legacy form");
	assert.equal(translated(`${CSI}127;5u`), `${CSI}127;5u`, "Ctrl+Backspace does not collapse to ambiguous raw BS");
	assert.equal(translated(`${CSI}13;2u`, { modifyOtherKeys: 2 }), `${CSI}27;2;13~`);
	assert.equal(translated(`${CSI}13;3u`, { modifyOtherKeys: 2 }), `${CSI}27;3;13~`);
	assert.equal(translated(`${CSI}13;3u`, { modifyOtherKeys: 0 }), `${ESC}\r`);
	assert.equal(translated(`${CSI}32;5u`, { modifyOtherKeys: 1 }), "\x00", "mode 1 keeps Control-Space exception");
	assert.equal(translated(`${CSI}51;5u`, { modifyOtherKeys: 1 }), ESC, "mode 1 keeps Control-3 exception");
	assert.equal(translated(`${CSI}32;5u`, { modifyOtherKeys: 2 }), `${CSI}27;5;32~`);
	assert.equal(translated(`${CSI}9;6u`, { modifyOtherKeys: 0 }), `${CSI}9;6u`, "Ctrl-Shift-Tab uses the published extended-key fallback");
	assert.equal(translated(`${CSI}9;2u`, { modifyOtherKeys: 2 }), `${CSI}27;2;9~`);
	assert.equal(translated(`${CSI}32;6u`), "\x00", "Ctrl-Shift-Space follows the official C0 table");
	assert.equal(translated(`${CSI}32;2u`), " ", "Shift-Space does not invent a different symbol");
	assert.equal(translated(`${CSI}33;5u`), "!", "unlisted ASCII control mappings are not blanket-masked");
});

test("mode 1 exceptions retain advanced modifiers and Meta prefixes", () => {
	for (const kittyFlags of [0, 2, 4]) {
		for (const codepoint of [32, 51]) {
			for (const modifierParameter of [13, 21]) {
				const packet = `${CSI}${codepoint};${modifierParameter}u`;
				assert.equal(translated(packet, { kittyFlags, modifyOtherKeys: 1 }), packet);
			}
		}
	}
	assert.equal(translated(`${CSI}32;37u`, { modifyOtherKeys: 1 }), `${ESC}\x00`);
	assert.equal(translated(`${CSI}51;37u`, { modifyOtherKeys: 1 }), `${ESC}${ESC}`);
});

test("modified C0 keys preserve Kitty identity for the pinned Pi matcher", () => {
	setKittyProtocolActive(true);
	try {
		for (const kittyFlags of [1, 7]) {
			const cases = [
				[`${CSI}13;2u`, Key.shift("enter")],
				[`${CSI}13;3u`, Key.alt("enter")],
				[`${CSI}13;5u`, Key.ctrl("enter")],
				[`${CSI}13;9u`, Key.super("enter")],
				[`${CSI}9;2u`, Key.shift("tab")],
				[`${CSI}9;5u`, Key.ctrl("tab")],
				[`${CSI}127;2u`, Key.shift("backspace")],
				[`${CSI}127;3u`, Key.alt("backspace")],
				[`${CSI}127;5u`, Key.ctrl("backspace")],
				[`${CSI}127;9u`, Key.super("backspace")],
			] as const;
			for (const [packet, key] of cases) {
				const output = translated(packet, { kittyFlags });
				assert.equal(output, packet, `flags ${kittyFlags} preserve ${key}`);
				assert.equal(matchesKey(output as string, key), true, `public Pi matcher recognizes ${key}`);
			}
		}

		const unmodifiedEnter = translated(`${CSI}13;1u`, { kittyFlags: 1 }) as string;
		const unmodifiedTab = translated(`${CSI}9;1u`, { kittyFlags: 1 }) as string;
		const unmodifiedBackspace = translated(`${CSI}127;1u`, { kittyFlags: 1 }) as string;
		assert.equal(unmodifiedEnter, "\r", "unmodified Enter remains native");
		assert.equal(unmodifiedTab, "\t", "unmodified Tab remains native");
		assert.equal(unmodifiedBackspace, "\x7f", "unmodified Backspace remains native");
		assert.equal(matchesKey(unmodifiedEnter, Key.enter), true);
		assert.equal(matchesKey(unmodifiedTab, Key.tab), true);
		assert.equal(matchesKey(unmodifiedBackspace, Key.backspace), true);
		assert.equal(translated(`${CSI}13;2:3u`, { kittyFlags: 7 }), undefined, "modified C0 releases stay suppressed without bit 8");
		assert.equal(matchesKey(translated(`${CSI}13;2u`, { modifyOtherKeys: 2 }) as string, Key.shift("enter")), true, "mOK2 fallback remains identifiable");
		assert.equal(translated(`${ESC}\x7f`), `${ESC}\x7f`, "legacy Alt+Backspace is preserved byte-for-byte");
		assert.equal(translated(`${ESC}\x08`), `${ESC}\x08`, "the alternate public Alt+Backspace form is preserved too");
		assert.equal(matchesKey(translated(`${ESC}\x7f`) as string, Key.alt("backspace")), true);
		assert.equal(translated(`${ESC}\x7f`, { kittyFlags: 1 }), `${CSI}127;3u`);
		assert.equal(translated(`${ESC}\x7f`, { kittyFlags: 7 }), `${CSI}127;3u`);
		const mokAltBackspace = translated(`${ESC}\x7f`, { modifyOtherKeys: 2 }) as string;
		assert.equal(mokAltBackspace, `${CSI}27;3;127~`);
		assert.equal(matchesKey(mokAltBackspace, Key.alt("backspace")), true, "mOK2 Alt+Backspace remains identifiable");
		assert.equal(matchesKey(translated(`${CSI}1;2C`) as string, Key.shift("right")), true, "explicit modified Shift+Right remains identifiable");
	} finally {
		setKittyProtocolActive(false);
	}
});

test("modified Escape keeps identity without disambiguation bit 1", () => {
	const modifiedEscapePackets = [`${CSI}27;2u`, `${CSI}27;5u`, `${CSI}27;9u`];
	for (const kittyFlags of [0, 2, 4]) {
		for (const packet of modifiedEscapePackets) {
			assert.equal(translated(packet, { kittyFlags }), packet, `flags ${kittyFlags} preserve ${packet}`);
		}
	}
	for (const modifyOtherKeys of [0, 1, 2] as const) {
		for (const packet of modifiedEscapePackets) {
			assert.equal(translated(packet, { modifyOtherKeys }), packet, `modifyOtherKeys ${modifyOtherKeys} preserves ${packet}`);
		}
	}
	assert.equal(translated(`${CSI}27;1u`), ESC, "unmodified Escape remains native");
	assert.equal(translated(ESC), ESC);
	assert.equal(translated(`${CSI}27;2:3u`, { kittyFlags: 2 }), `${CSI}27;2:3u`);
	assert.equal(translated(`${CSI}27;2:3u`, { kittyFlags: 0 }), undefined, "release remains suppressed without bit 2");
});

test("native source Kitty state normalizes only the exact Enter aliases before child translation", () => {
	const escCr = `${ESC}${String.fromCharCode(13)}`;
	const lf = String.fromCharCode(10);
	const cr = String.fromCharCode(13);
	const crlf = `${ESC}${String.fromCharCode(13, 10)}`;
	const ctrlC = String.fromCharCode(3);
	try {
		setKittyProtocolActive(false);
		assert.equal(parseKey(escCr), Key.alt("enter"));
		assert.equal(parseKey(lf), Key.enter);
		assert.equal(normalizeNativeSourceInput(escCr, false), escCr, "legacy ESC-CR remains Alt+Enter for the translator");
		assert.equal(normalizeNativeSourceInput(lf, false), cr, "legacy LF becomes unambiguous Enter for a Kitty child");

		setKittyProtocolActive(true);
		assert.equal(parseKey(escCr), Key.shift("enter"));
		assert.equal(parseKey(lf), Key.shift("enter"));
		const shiftEnter = `${CSI}13;2u`;
		assert.equal(normalizeNativeSourceInput(escCr, true), shiftEnter);
		assert.equal(normalizeNativeSourceInput(lf, true), shiftEnter);
		assert.equal(normalizeNativeSourceInput(crlf, true), crlf, "only the exact complete packet is normalized");

		const paste = `${CSI}200~text${lf}${escCr}${CSI}201~`;
		assert.equal(normalizeNativeSourceInput(paste, true), paste, "paste framing and its body remain opaque");
		for (const packet of [ESC, "q", ctrlC]) {
			assert.equal(normalizeNativeSourceInput(packet, true), packet);
			assert.equal(normalizeNativeSourceInput(packet, false), packet);
		}

		const nativeShift = normalizeNativeSourceInput(lf, true);
		assert.equal(translated(nativeShift, { kittyFlags: 7 }), shiftEnter);
		assert.equal(matchesKey(translated(nativeShift, { kittyFlags: 7 }) as string, Key.shift("enter")), true);

		const nativeEnter = normalizeNativeSourceInput(lf, false);
		setKittyProtocolActive(true);
		assert.equal(translated(nativeEnter, { kittyFlags: 7 }), cr);
		assert.equal(matchesKey(translated(nativeEnter, { kittyFlags: 7 }) as string, Key.enter), true);

		setKittyProtocolActive(false);
		const nativeAlt = normalizeNativeSourceInput(escCr, false);
		setKittyProtocolActive(true);
		assert.equal(translated(nativeAlt, { kittyFlags: 7 }), `${CSI}13;3u`);
		assert.equal(matchesKey(translated(nativeAlt, { kittyFlags: 7 }) as string, Key.alt("enter")), true);
		setKittyProtocolActive(false);
		assert.equal(translated(nativeAlt), escCr);
		assert.equal(matchesKey(translated(nativeAlt) as string, Key.alt("enter")), true);
		assert.equal(translated(nativeAlt, { modifyOtherKeys: 2 }), `${CSI}27;3;13~`);
		assert.equal(matchesKey(translated(nativeAlt, { modifyOtherKeys: 2 }) as string, Key.alt("enter")), true);

		const legacyShift = normalizeNativeSourceInput(escCr, true);
		assert.equal(translated(legacyShift), shiftEnter, "legacy child receives CSI-u rather than ambiguous ESC-CR");
		assert.equal(matchesKey(translated(legacyShift) as string, Key.shift("enter")), true);
		assert.equal(translated(legacyShift, { modifyOtherKeys: 2 }), `${CSI}27;2;13~`);
		assert.equal(matchesKey(translated(legacyShift, { modifyOtherKeys: 2 }) as string, Key.shift("enter")), true);
	} finally {
		setKittyProtocolActive(false);
	}
});

test("legacy Alt-letter packets are not confused with Pi's Alt-B arrow alias", () => {
	assert.equal(translated(`${ESC}b`), `${ESC}b`);
	assert.equal(translated(`${ESC}B`), `${ESC}B`);
	assert.equal(translated(`${ESC}b`, { kittyFlags: 1 }), `${CSI}98;3u`);
	assert.equal(translated(`${ESC}B`, { kittyFlags: 1 }), `${CSI}98;4u`);
	assert.equal(translated(`${ESC}b`, { modifyOtherKeys: 2 }), `${CSI}27;3;98~`);
});

test("Unicode scalars, combining marks, keypad identity, cursor mode and function keys", () => {
	assert.equal(translated(`${CSI}128578;1u`), "🙂");
	assert.equal(translated(`${CSI}769;1u`), "\u0301");
	assert.equal(translated(`${CSI}51;2u`), `${CSI}51;2u`, "unknown shifted symbol is not guessed");
	assert.equal(translated(`${CSI}54:35;2u`), "#", "an actual shifted alternate field is used without guessing");
	assert.equal(translated(`${CSI}57400;1u`, { applicationKeypad: true }), `${SS3}q`);
	assert.equal(translated(`${CSI}57400;1u`, { applicationKeypad: false }), "1");
	assert.equal(translated("1", { applicationKeypad: true }), "1", "plain text does not invent keypad identity");
	assert.equal(translated(`${CSI}57400;1u`, { kittyFlags: 1, applicationKeypad: true }), `${CSI}57400;1u`);
	assert.equal(translated(`${CSI}57414;1u`, { applicationKeypad: true }), `${SS3}M`);
	assert.equal(translated(`${CSI}57414;1u`, { applicationKeypad: false }), "\r");
	assert.equal(translated(`${CSI}57404;1u`), "5", "KP_5 remains numeric text");
	assert.equal(translated(`${CSI}57404;1u`, { applicationKeypad: true }), `${SS3}u`);
	const kpBegin = `${CSI}57427;1u`;
	assert.equal(translated(kpBegin), `${CSI}E`, "KP_BEGIN becomes a supported clear/begin sequence, not numeric 5");
	assert.equal(translated(kpBegin, { applicationKeypad: true }), `${SS3}E`);
	assert.equal(translated(kpBegin, { kittyFlags: 1 }), kpBegin, "Kitty bit 1 keeps canonical KP_BEGIN CSI-u");
	assert.equal(translated(`${SS3}E`), `${CSI}E`);
	assert.equal(translated(`${CSI}E`), `${CSI}E`);
	assert.equal(parseKey(`${CSI}E`), Key.clear);
	assert.equal(matchesKey(`${CSI}E`, Key.clear), true);
	assert.equal(matchesKey(`${SS3}E`, Key.clear), true);
	const kpLeftRelease = `${CSI}57417;1:3u`;
	assert.equal(translated(kpLeftRelease, { kittyFlags: 2 }), `${CSI}1;1:3D`, "KP_LEFT release uses standard modified arrow event encoding");
	assert.equal(matchesKey(`${CSI}1;1:3D`, Key.left), true);
	assert.equal(translated(`${CSI}57417;5:3u`, { kittyFlags: 2 }), `${CSI}1;5:3D`, "navigation release retains modifiers");
	assert.equal(translated(`${CSI}57404;1:2u`, { kittyFlags: 2 }), `${CSI}57404;1:2u`, "KP_5 repeat retains keypad identity");
	assert.equal(translated(`${CSI}57404;1:3u`, { kittyFlags: 2 }), `${CSI}57404;1:3u`, "KP_5 release is not collapsed to a text press");
	const menu = `${CSI}57363;1u`;
	assert.equal(translated(menu), menu, "MENU has no legacy F16 encoding, so retain its canonical Kitty CSI-u identity");
	assert.equal(translated(menu, { kittyFlags: 1 }), menu);
	for (const kittyFlags of [0, 1, 2, 7]) {
		assert.equal(translated(menu, { kittyFlags }), menu);
		const repeat = `${CSI}57363;1:2u`;
		assert.equal(translated(repeat, { kittyFlags }), (kittyFlags & 2) !== 0 ? repeat : menu);
		const release = `${CSI}57363;1:3u`;
		assert.equal(translated(release, { kittyFlags }), (kittyFlags & 2) !== 0 ? release : undefined);
	}
	assert.equal(translated(`${CSI}29~`), undefined, "legacy F16 is never reclassified as MENU");
	assert.equal(translated(`${CSI}57414;1:3u`, { kittyFlags: 2 }), undefined, "keypad Enter release remains suppressed without bit 8");
	assert.equal(translated(`${CSI}97;1:3u`, { kittyFlags: 2 }), undefined, "ordinary text release remains suppressed without bit 8");
	assert.equal(translated(`${CSI}A`, { applicationCursorKeys: false }), `${CSI}A`);
	assert.equal(translated(`${CSI}A`, { applicationCursorKeys: true }), `${SS3}A`);
	assert.equal(translated(`${CSI}1;5A`, { applicationCursorKeys: true }), `${CSI}1;5A`);
	assert.equal(translated(`${SS3}P`), `${SS3}P`);
	assert.equal(translated(`${CSI}15~`), `${CSI}15~`);
	assert.equal(translated(`${CSI}3~`), `${CSI}3~`);
	assert.equal(translated(`${CSI}1~`), `${CSI}H`);
	assert.equal(translated(`${CSI}4~`), `${CSI}F`);
	assert.equal(translated(`${ESC}[[5~`), `${CSI}5~`);
	assert.equal(translated(`${ESC}[[A`), `${SS3}P`);
	assert.equal(translated(`${CSI}a`), `${CSI}1;2A`);
	assert.equal(translated(`${SS3}a`), `${CSI}1;5A`);
	assert.equal(translated(`${CSI}2$`), `${CSI}2;2~`);
	assert.equal(translated(`${CSI}3^`), `${CSI}3;5~`);
	assert.equal(translated(`${CSI}1;5P`), `${CSI}1;5P`);
	assert.equal(translated(`${CSI}1;2C`), `${CSI}1;2C`, "explicit modified Shift+Right remains distinguishable from a DA query");
});

test("cursor-position replies are not child F3 presses", () => {
	for (const kittyFlags of [0, 1, 2, 4, 7]) {
		for (const packet of [`${CSI}1;1R`, `${CSI}1;2R`, `${CSI}1;5R`, `${CSI}?1;2R`]) {
			assert.equal(translated(packet, { kittyFlags }), undefined);
		}
		assert.equal(translated(`${SS3}R`, { kittyFlags }), `${SS3}R`);
		assert.equal(translated(`${CSI}13;2~`, { kittyFlags }), `${CSI}13;2~`);
	}
	assert.equal(translated(`${CSI}13;2:3~`, { kittyFlags: 2 }), `${CSI}13;2:3~`);
	assert.equal(translated(`${CSI}13;2:3~`), undefined);
});

test("malformed, unsafe and device/query packets fail closed", () => {
	for (const packet of [
		`${CSI}?7u`, `${CSI}=7u`, `${CSI}97;257u`, `${CSI}97;1:4u`,
		`${CSI}999999999999999999999999u`, `${CSI}0;1u`, `${CSI}31;5u`,
		`${CSI}57350;1u`, `${CSI}97;1;65u`, `${CSI}97:;1u`, `${CSI}27;17;97~`,
		`${CSI}97;1:3u${CSI}A`, `${CSI}I`, `${CSI}O`, `${ESC}]52;c;secret\x07`,
		`${ESC}P1$r0m${ESC}\\`, `${CSI}c`, `${CSI}0c`, `${CSI}>c`, `${CSI}>0c`, `${CSI}=c`, `${CSI}?1;2c`,
	]) {
		assert.equal(translated(packet), undefined, `dropped ${JSON.stringify(packet)}`);
	}
	assert.equal(translateInput("q", modes({ kittyFlags: 8 }), viewport), undefined, "invalid target masks are rejected");
	assert.equal(translateInput("q", modes(), { column: -1, row: 0, cols: 80, rows: 24 }), undefined);
});

test("bracketed paste is opaque and follows the selected child's mode", () => {
	const body = `secret\x00${CSI}97;1:3u${CSI}<0;1;1M\xff`;
	const packet = `${CSI}200~${body}${CSI}201~`;
	assert.equal(translated(packet), body);
	assert.equal(translated(packet, { bracketedPaste: true }), packet);
	assert.equal(translated(`${CSI}200~unterminated`), undefined);
});

test("mouse ownership is clipped before offsets without edge clamping", () => {
	const child = { column: 10, row: 4, cols: 4, rows: 3 };
	assert.equal(
		translated(`${CSI}<0;12;6M`, { mouseEncoding: "sgr" }, child),
		`${CSI}<0;2;2M`,
	);
	assert.equal(translated(`${CSI}<0;9;6M`, { mouseEncoding: "sgr" }, child), undefined, "left of child does not clamp to its edge");
	assert.equal(translated(`${CSI}<0;12;3M`, { mouseEncoding: "sgr" }, child), undefined, "header rows are not owned by the child");
	assert.equal(translated(`${CSI}<0;14;6M`, { mouseEncoding: "sgr" }, child), `${CSI}<0;4;2M`);
	assert.equal(translated(`${CSI}<0;15;6M`, { mouseEncoding: "sgr" }, child), undefined, "right edge is exclusive");
	assert.equal(translated(`${CSI}<0;12;6M`, { mouseTracking: "none" }, child), undefined);
	assert.equal(translated(`${CSI}<0;12;6M`, { mouseEncoding: "sgr-pixels" }, child), undefined, "pixel coordinates are not fabricated from cells");
});

test("mouse tracking filters and SGR release encoding follow child modes", () => {
	const child = { column: 0, row: 0, cols: 80, rows: 24 };
	assert.equal(translated(`${CSI}<4;2;2M`, { mouseTracking: "x10" }, child), `${CSI}<0;2;2M`, "X10 strips modifiers");
	assert.equal(translated(`${CSI}<0;2;2m`, { mouseTracking: "x10" }, child), undefined, "X10 excludes releases");
	assert.equal(translated(`${CSI}<64;2;2M`, { mouseTracking: "x10" }, child), undefined, "X10 excludes wheel");
	assert.equal(translated(`${CSI}<32;2;2M`, { mouseTracking: "vt200" }, child), undefined, "VT200 excludes motion");
	assert.equal(translated(`${CSI}<32;2;2M`, { mouseTracking: "drag" }, child), `${CSI}<32;2;2M`, "drag permits held-button motion");
	assert.equal(translated(`${CSI}<35;2;2M`, { mouseTracking: "drag" }, child), undefined, "drag excludes free motion");
	assert.equal(translated(`${CSI}<35;2;2M`, { mouseTracking: "any" }, child), `${CSI}<35;2;2M`);
	assert.equal(translated(`${CSI}<64;2;2M`, { mouseTracking: "vt200" }, child), `${CSI}<64;2;2M`, "VT200 includes wheel");
	assert.equal(translated(`${CSI}<0;2;2m`, { mouseTracking: "vt200" }, child), `${CSI}<0;2;2m`);
	assert.equal(translated(`${CSI}<3;2;2m`, { mouseTracking: "vt200" }, child), `${CSI}<3;2;2m`, "ambiguous X10 release stays button 3");
});

test("legacy X10 mouse output stays byte-exact in Buffer form", () => {
	const child = { column: 0, row: 0, cols: 223, rows: 1 };
	const normal = translated(`${CSI}<0;1;1M`, { mouseEncoding: "default" }, child);
	assert.ok(Buffer.isBuffer(normal));
	assert.deepEqual(normal, Buffer.from([0x1b, 0x5b, 0x4d, 32, 33, 33]));

	const highBytePacket = `${ESC}[M${String.fromCharCode(32, 200, 33)}`;
	const highByte = translated(highBytePacket, { mouseEncoding: "default" }, child);
	assert.ok(Buffer.isBuffer(highByte));
	assert.deepEqual(highByte, Buffer.from([0x1b, 0x5b, 0x4d, 32, 200, 33]));

	const unrepresentable = translated(`${CSI}<0;224;1M`, { mouseEncoding: "default" }, { column: 0, row: 0, cols: 224, rows: 1 });
	assert.equal(unrepresentable, undefined, "legacy coordinate overflow is dropped, not wrapped");
});

test("passive capability observation handles fragments, DA fallback, late replies and exact masks", async () => {
	const changes: number[] = [];
	const observer = new KeyboardCapabilityObserver({ onChange: (flags) => changes.push(flags) });
	observer.feed(Buffer.from(`${CSI}?`));
	observer.feed("13u");
	assert.equal(await observer.wait(), 5, "reported flags are masked, not replaced by boolean 7");
	assert.equal(observer.flags, 5);
	assert.deepEqual(changes, [5]);
	observer.dispose();

	const delayedFragment = new KeyboardCapabilityObserver();
	delayedFragment.feed(`${CSI}?5`);
	await new Promise<void>((resolve) => setTimeout(resolve, 70));
	delayedFragment.feed("u");
	assert.equal(await delayedFragment.wait(), 5, "terminal-reply fragments survive the public parser's short sequence timeout");
	delayedFragment.dispose();

	const pasteBreak = new KeyboardCapabilityObserver();
	pasteBreak.feed(`${CSI}?5`);
	await new Promise<void>((resolve) => setTimeout(resolve, 70));
	pasteBreak.feed(`${CSI}200~opaque${CSI}201~`);
	pasteBreak.feed("u");
	assert.equal(await pasteBreak.wait(10), 0, "paste invalidates a timed-out negotiation prefix before following text");
	pasteBreak.dispose();

	const fallback = new KeyboardCapabilityObserver();
	fallback.feed(`${CSI}?1;2c`);
	assert.equal(await fallback.wait(100), 0, "DA sentinel settles with fail-safe zero");
	fallback.feed(`${CSI}?3u`);
	assert.equal(fallback.flags, 3, "a real late flags reply updates after DA fallback");
	fallback.dispose();
});

test("observer timeout, malformed flags, paste opacity and callback failures are contained", async () => {
	const observer = new KeyboardCapabilityObserver({ onChange: () => { throw new Error("observer callback"); } });
	assert.equal(await observer.wait(1), 0, "timeout is fail-safe zero");
	observer.feed(`${CSI}?5u`);
	assert.equal(observer.flags, 5, "a late actual reply is still observed");
	observer.feed(`${CSI}200~${CSI}?7u${CSI}201~`);
	assert.equal(observer.flags, 5, "CSI-looking paste content is ignored");
	observer.dispose();

	const invalid = new KeyboardCapabilityObserver();
	invalid.feed(`${CSI}?999999999999999999999999u`);
	assert.equal(await invalid.wait(100), 0, "invalid flag integers settle safely at zero");
	invalid.dispose();
});

test("observer byte budget preserves confirmed flags and disposal stops late parsing", async () => {
	const observed: number[] = [];
	const observer = new KeyboardCapabilityObserver({ onChange: (flags) => observed.push(flags) });
	observer.feed(`${CSI}?5u`);
	assert.equal(await observer.wait(), 5);
	observer.feed("x".repeat(16 * 1024));
	assert.equal(observer.flags, 5, "over-budget input preserves the last confirmed mask");
	observer.feed(`${CSI}?7u`);
	assert.equal(observer.flags, 5, "parser is destroyed after its byte budget");
	observer.dispose();
	assert.deepEqual(observed, [5]);

	const disposed = new KeyboardCapabilityObserver();
	const pending = disposed.wait(1_000);
	disposed.dispose();
	assert.equal(await pending, 0, "dispose resolves waiters");
	disposed.feed(`${CSI}?7u`);
	assert.equal(disposed.flags, 0, "disposed observer ignores later feed");
});
