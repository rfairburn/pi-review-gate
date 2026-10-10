import { Buffer } from "node:buffer";
import { StdinBuffer } from "pi-session-host-tui";

/** The child terminal's effective modes relevant to routing one input packet. */
export interface InputTargetModes {
	readonly kittyFlags: number;
	readonly modifyOtherKeys: 0 | 1 | 2;
	readonly applicationCursorKeys: boolean;
	readonly applicationKeypad: boolean;
	readonly bracketedPaste: boolean;
	readonly mouseTracking: "none" | "x10" | "vt200" | "drag" | "any";
	readonly mouseEncoding: "default" | "sgr" | "sgr-pixels";
}

export interface InputViewport {
	/** Absolute terminal column of the child viewport's left edge (0-based). */
	readonly column: number;
	/** Absolute terminal row of the child viewport's top edge (0-based). */
	readonly row: number;
	readonly cols: number;
	readonly rows: number;
}

const ESC = "\x1b";
const CSI = `${ESC}[`;
const KITTY_SHIFT_ENTER = `${CSI}13;2u`;
const SS3 = `${ESC}O`;
const KITTY_SHIFT = 1;
const KITTY_ALT = 2;
const KITTY_CTRL = 4;
const KITTY_SUPER = 8;
const KITTY_HYPER = 16;
const KITTY_META = 32;
const KITTY_CAPS_LOCK = 64;
const KITTY_NUM_LOCK = 128;
const LOCK_MODIFIERS = KITTY_CAPS_LOCK | KITTY_NUM_LOCK;
const XTERM_MODIFIERS = KITTY_SHIFT | KITTY_ALT | KITTY_CTRL | KITTY_META;
const MAX_CSI_PACKET_LENGTH = 256;
const OBSERVER_BYTE_BUDGET = 16 * 1024;
const OBSERVER_WINDOW_MS = 5_000;
const NEGOTIATION_FRAGMENT_TIMEOUT_MS = 150;
const MAX_NEGOTIATION_PREFIX_LENGTH = 64;
const DEFAULT_WAIT_MS = 1_000;

const VALID_MOUSE_TRACKING = new Set(["none", "x10", "vt200", "drag", "any"]);
const VALID_MOUSE_ENCODING = new Set(["default", "sgr", "sgr-pixels"]);

interface KeyEvent {
	/** Present for CSI-u and keypad events; legacy function keys use `key`. */
	readonly codepoint?: number;
	readonly key?: SpecialKey;
	readonly modifiers: number;
	readonly eventType: 1 | 2 | 3;
	readonly shifted?: number;
	readonly baseLayout?: number;
}

type SpecialKey =
	| "up" | "down" | "right" | "left" | "home" | "end"
	| "insert" | "delete" | "pageUp" | "pageDown"
	| "f1" | "f2" | "f3" | "f4" | "f5" | "f6"
	| "f7" | "f8" | "f9" | "f10" | "f11" | "f12"
	| "kpBegin";

export interface ParsedMouseInput {
	readonly button: number;
	readonly x: number;
	readonly y: number;
	readonly release: boolean;
	readonly motion: boolean;
	readonly wheel: boolean;
}

function isSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function validModes(modes: InputTargetModes): boolean {
	return Number.isSafeInteger(modes.kittyFlags)
		&& modes.kittyFlags >= 0
		&& modes.kittyFlags <= 7
		&& (modes.modifyOtherKeys === 0 || modes.modifyOtherKeys === 1 || modes.modifyOtherKeys === 2)
		&& typeof modes.applicationCursorKeys === "boolean"
		&& typeof modes.applicationKeypad === "boolean"
		&& typeof modes.bracketedPaste === "boolean"
		&& VALID_MOUSE_TRACKING.has(modes.mouseTracking)
		&& VALID_MOUSE_ENCODING.has(modes.mouseEncoding);
}

function validViewport(viewport: InputViewport): boolean {
	return isSafeInteger(viewport.column)
		&& isSafeInteger(viewport.row)
		&& Number.isSafeInteger(viewport.cols)
		&& viewport.cols > 0
		&& Number.isSafeInteger(viewport.rows)
		&& viewport.rows > 0
		&& Number.isSafeInteger(viewport.column + viewport.cols)
		&& Number.isSafeInteger(viewport.row + viewport.rows);
}

function isUnicodeScalar(codepoint: number): boolean {
	return Number.isSafeInteger(codepoint)
		&& codepoint >= 0
		&& codepoint <= 0x10ffff
		&& !(codepoint >= 0xd800 && codepoint <= 0xdfff);
}

/** Official Kitty functional PUA assignments, and no reserved PUA values. */
function isOfficialFunctionalCodepoint(codepoint: number): boolean {
	return (codepoint >= 57358 && codepoint <= 57363)
		|| (codepoint >= 57376 && codepoint <= 57454);
}

function isValidKeyboardCodepoint(codepoint: number): boolean {
	if (!isUnicodeScalar(codepoint)) return false;
	if (codepoint === 9 || codepoint === 13 || codepoint === 27 || codepoint === 32 || codepoint === 127) return true;
	if (codepoint < 0x20 || (codepoint >= 0x7f && codepoint <= 0x9f)) return false;
	if (codepoint >= 0xe000 && codepoint <= 0xf8ff) return isOfficialFunctionalCodepoint(codepoint);
	if (codepoint >= 0xf0000 && codepoint <= 0xffffd) return false;
	if (codepoint >= 0x100000 && codepoint <= 0x10fffd) return false;
	return true;
}

function isPrintableCodepoint(codepoint: number): boolean {
	return isValidKeyboardCodepoint(codepoint)
		&& codepoint >= 0x20
		&& codepoint !== 0x7f
		&& !isOfficialFunctionalCodepoint(codepoint);
}

function parseDecimal(value: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
	if (value.length === 0 || value.length > 16 || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : undefined;
}

function validAlternateCodepoint(value: string | undefined): number | undefined | null {
	if (value === undefined || value === "") return undefined;
	const parsed = parseDecimal(value, 0x10ffff);
	if (parsed === undefined || !isUnicodeScalar(parsed) || parsed < 0x20 || (parsed >= 0x7f && parsed <= 0x9f)) {
		return null;
	}
	return parsed;
}

function parseKittyCsiU(data: string): KeyEvent | undefined | null {
	if (data.length > MAX_CSI_PACKET_LENGTH) return null;
	const match = /^\x1b\[([0-9]+(?::[0-9]*(?::[0-9]*)?)?)(?:;([0-9]+)(?::([0-9]+))?)?(?:;([0-9]+(?::[0-9]+)*))?u$/.exec(data);
	if (!match) return undefined;
	// Associated-text codepoints (the separate Kitty bit 16 enhancement) are
	// deliberately unsupported; never reinterpret them as a key or leak them.
	if (match[4] !== undefined) return null;

	const keyParts = match[1].split(":");
	if (keyParts.length > 3) return null;
	const codepoint = parseDecimal(keyParts[0], 0x10ffff);
	if (codepoint === undefined || !isValidKeyboardCodepoint(codepoint)) return null;
	const shifted = validAlternateCodepoint(keyParts[1]);
	const baseLayout = validAlternateCodepoint(keyParts[2]);
	if (shifted === null || baseLayout === null) return null;
	// `codepoint:` is malformed; an empty shifted field is only meaningful
	// when a base-layout key follows it (`codepoint::base`).
	if (keyParts.length === 2 && keyParts[1] === "") return null;
	if (keyParts.length === 3 && keyParts[1] === "" && keyParts[2] === "") return null;

	const modifierParameter = match[2] === undefined ? 1 : parseDecimal(match[2], 256);
	if (modifierParameter === undefined || modifierParameter < 1) return null;
	const modifiers = modifierParameter - 1;
	if (shifted !== undefined && (modifiers & KITTY_SHIFT) === 0) return null;
	const eventType = match[3] === undefined ? 1 : parseDecimal(match[3], 3);
	if (eventType !== 1 && eventType !== 2 && eventType !== 3) return null;
	return {
		codepoint,
		modifiers,
		eventType,
		shifted,
		baseLayout,
	};
}

function parseModifierParameter(value: string | undefined): number | undefined {
	if (value === undefined) return 0;
	const parsed = parseDecimal(value, 256);
	return parsed === undefined || parsed < 1 ? undefined : parsed - 1;
}

function parseModifyOtherKeys(data: string): KeyEvent | undefined | null {
	if (data.length > MAX_CSI_PACKET_LENGTH) return null;
	const match = /^\x1b\[27;([0-9]+);([0-9]+)~$/.exec(data);
	if (!match) return undefined;
	const modifierParameter = parseDecimal(match[1], 16);
	const codepoint = parseDecimal(match[2], 0x10ffff);
	if (modifierParameter === undefined || modifierParameter < 2 || codepoint === undefined || !isValidKeyboardCodepoint(codepoint)) {
		return null;
	}
	const xtermModifiers = modifierParameter - 1;
	const modifiers = (xtermModifiers & (KITTY_SHIFT | KITTY_ALT | KITTY_CTRL))
		| ((xtermModifiers & 8) !== 0 ? KITTY_META : 0);
	return { codepoint, modifiers, eventType: 1 };
}

const CSI_LETTER_KEYS: Readonly<Record<string, SpecialKey>> = {
	A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
	P: "f1", Q: "f2", R: "f3", S: "f4",
};

const CSI_TILDE_KEYS: Readonly<Record<number, SpecialKey>> = {
	1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageUp", 6: "pageDown",
	7: "home", 8: "end", 11: "f1", 12: "f2", 13: "f3", 14: "f4",
	15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10",
	23: "f11", 24: "f12",
};

const KEYPAD_SS3_TO_CODEPOINT: Readonly<Record<string, number>> = {
	p: 57399, q: 57400, r: 57401, s: 57402, t: 57403,
	u: 57404, v: 57405, w: 57406, x: 57407, y: 57408,
	n: 57409, o: 57410, j: 57411, m: 57412, k: 57413,
	M: 57414, X: 57415, l: 57416, E: 57427,
};

function isDeviceAttributeRequest(data: string): boolean {
	// CSI c is also an old RxVT Shift+Right alias; device-query safety wins.
	return /^\x1b\[(?:[?>=])?[0-9;]*c$/.test(data);
}

function parseLegacyKeyboardSequence(data: string): KeyEvent | undefined | null {
	if (data.length > MAX_CSI_PACKET_LENGTH) return null;
	if (isDeviceAttributeRequest(data)) return null;
	// CPR overlaps historical modified F3; device-reply safety wins.
	if (/^\x1b\[\??[0-9]+;[0-9]+R$/.test(data)) return null;
	const kitty = parseKittyCsiU(data);
	if (kitty !== undefined) return kitty;
	const otherKeys = parseModifyOtherKeys(data);
	if (otherKeys !== undefined) return otherKeys;

	const ss3 = /^\x1bO([A-Za-z])$/.exec(data);
	if (ss3) {
		const ch = ss3[1];
		if (Object.hasOwn(KEYPAD_SS3_TO_CODEPOINT, ch)) {
			return { codepoint: KEYPAD_SS3_TO_CODEPOINT[ch], modifiers: 0, eventType: 1 };
		}
		const legacyCtrlArrow: Readonly<Record<string, SpecialKey>> = { a: "up", b: "down", c: "right", d: "left" };
		const ctrlArrow = legacyCtrlArrow[ch];
		if (ctrlArrow) return { key: ctrlArrow, modifiers: KITTY_CTRL, eventType: 1 };
		const key = CSI_LETTER_KEYS[ch];
		if (key) return { key, modifiers: 0, eventType: 1 };
		return null;
	}

	if (data === `${CSI}E`) return { codepoint: 57427, modifiers: 0, eventType: 1 };

	const shiftedArrow = /^\x1b\[([a-d])$/.exec(data);
	if (shiftedArrow) {
		const key = CSI_LETTER_KEYS[shiftedArrow[1].toUpperCase()];
		return key ? { key, modifiers: KITTY_SHIFT, eventType: 1 } : null;
	}

	const modifiedTildeKey = /^\x1b\[([2-8])([$^])$/.exec(data);
	if (modifiedTildeKey) {
		const number = parseDecimal(modifiedTildeKey[1], 8);
		const key = number === undefined ? undefined : CSI_TILDE_KEYS[number];
		const modifiers = modifiedTildeKey[2] === "$" ? KITTY_SHIFT : KITTY_CTRL;
		return key ? { key, modifiers, eventType: 1 } : null;
	}

	const oldFunction = /^\x1b\[\[(A|B|C|D|E|5~|6~)$/.exec(data);
	if (oldFunction) {
		const oldKey: Readonly<Record<string, SpecialKey>> = {
			A: "f1", B: "f2", C: "f3", D: "f4", E: "f5", "5~": "pageUp", "6~": "pageDown",
		};
		const key = oldKey[oldFunction[1]];
		return key ? { key, modifiers: 0, eventType: 1 } : null;
	}

	const reverseTab = /^\x1b\[(?:1;([0-9]+))?Z$/.exec(data);
	if (reverseTab) {
		const modifiers = reverseTab[1] === undefined ? KITTY_SHIFT : parseModifierParameter(reverseTab[1]);
		if (modifiers === undefined) return null;
		return { codepoint: 9, modifiers, eventType: 1 };
	}

	const csiLetter = /^\x1b\[(?:1(?:;([0-9]+)(?::([0-9]+))?)?)?([A-D]|[HF]|[P-S])$/.exec(data);
	if (csiLetter) {
		const modifiers = parseModifierParameter(csiLetter[1]);
		const eventType = csiLetter[2] === undefined ? 1 : parseDecimal(csiLetter[2], 3);
		if (modifiers === undefined || (eventType !== 1 && eventType !== 2 && eventType !== 3)) return null;
		const key = CSI_LETTER_KEYS[csiLetter[3]];
		return key ? { key, modifiers, eventType } : null;
	}

	const csiTilde = /^\x1b\[([0-9]+)(?:;([0-9]+)(?::([0-9]+))?)?~$/.exec(data);
	if (csiTilde) {
		const number = parseDecimal(csiTilde[1], 999);
		const modifiers = parseModifierParameter(csiTilde[2]);
		const eventType = csiTilde[3] === undefined ? 1 : parseDecimal(csiTilde[3], 3);
		if (number === undefined || modifiers === undefined || (eventType !== 1 && eventType !== 2 && eventType !== 3)) return null;
		const key = CSI_TILDE_KEYS[number];
		return key ? { key, modifiers, eventType } : null;
	}
	return undefined;
}

const KEYPAD_VALUES: Readonly<Record<number, string>> = {
	57399: "0", 57400: "1", 57401: "2", 57402: "3", 57403: "4",
	57404: "5", 57405: "6", 57406: "7", 57407: "8", 57408: "9",
	57409: ".", 57410: "/", 57411: "*", 57412: "-", 57413: "+",
	57414: "\r", 57415: "=", 57416: ",",
};

const KEYPAD_APPLICATION_CODES: Readonly<Record<number, string>> = {
	57399: "p", 57400: "q", 57401: "r", 57402: "s", 57403: "t",
	57404: "u", 57405: "v", 57406: "w", 57407: "x", 57408: "y",
	57409: "n", 57410: "o", 57411: "j", 57412: "m", 57413: "k",
	57414: "M", 57415: "X", 57416: "l", 57427: "E",
};

const KEYPAD_NAVIGATION: Readonly<Record<number, SpecialKey>> = {
	57417: "left", 57418: "right", 57419: "up", 57420: "down",
	57421: "pageUp", 57422: "pageDown", 57423: "home", 57424: "end",
	57425: "insert", 57426: "delete",
};

function isKeypadCodepoint(codepoint: number): boolean {
	return codepoint >= 57399 && codepoint <= 57427;
}

function isFunctionalPua(codepoint: number): boolean {
	return isOfficialFunctionalCodepoint(codepoint);
}

function isOrdinaryPrintableKey(codepoint: number): boolean {
	return isPrintableCodepoint(codepoint) && !isFunctionalPua(codepoint);
}

function hasModifier(modifiers: number, bit: number): boolean {
	return (modifiers & bit) !== 0;
}

function kittyEventSuffix(modes: InputTargetModes, eventType: 1 | 2 | 3): string {
	return (modes.kittyFlags & 2) !== 0 && eventType !== 1 ? `:${eventType}` : "";
}

function kittyCodepointSequence(
	codepoint: number,
	modifiers: number,
	eventType: 1 | 2 | 3,
	modes: InputTargetModes,
	shifted?: number,
	baseLayout?: number,
): string {
	let keyField = String(codepoint);
	if ((modes.kittyFlags & 4) !== 0 && (shifted !== undefined || baseLayout !== undefined)) {
		if (shifted !== undefined) keyField += `:${shifted}`;
		else keyField += ":";
		if (baseLayout !== undefined) keyField += `:${baseLayout}`;
	}
	const modifierParameter = 1 + modifiers;
	return `${CSI}${keyField};${modifierParameter}${kittyEventSuffix(modes, eventType)}u`;
}

function kittyFunctionalSequence(
	key: SpecialKey,
	modifiers: number,
	eventType: 1 | 2 | 3,
	modes: InputTargetModes,
): string | undefined {
	const arrows: Readonly<Record<string, string>> = { up: "A", down: "B", right: "C", left: "D" };
	const cursorLetter = arrows[key];
	if (cursorLetter) {
		if (modifiers === 0 && eventType === 1) {
			return modes.applicationCursorKeys ? `${SS3}${cursorLetter}` : `${CSI}${cursorLetter}`;
		}
		return `${CSI}1;${1 + modifiers}${kittyEventSuffix(modes, eventType)}${cursorLetter}`;
	}

	if (key === "home" || key === "end") {
		const letter = key === "home" ? "H" : "F";
		if (modifiers === 0 && eventType === 1) return `${CSI}${letter}`;
		return `${CSI}1;${1 + modifiers}${kittyEventSuffix(modes, eventType)}${letter}`;
	}

	if (key === "f1" || key === "f2" || key === "f3" || key === "f4") {
		const letter = ({ f1: "P", f2: "Q", f3: "R", f4: "S" } as const)[key];
		if (modifiers === 0 && eventType === 1) return `${SS3}${letter}`;
		if (key === "f3") return `${CSI}13;${1 + modifiers}${kittyEventSuffix(modes, eventType)}~`;
		return `${CSI}1;${1 + modifiers}${kittyEventSuffix(modes, eventType)}${letter}`;
	}

	const tildeKeys: Readonly<Record<string, number>> = {
		insert: 2, delete: 3, pageUp: 5, pageDown: 6,
		f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
	};
	const tildeCode = tildeKeys[key];
	if (tildeCode !== undefined) {
		if (modifiers === 0 && eventType === 1) return `${CSI}${tildeCode}~`;
		return `${CSI}${tildeCode};${1 + modifiers}${kittyEventSuffix(modes, eventType)}~`;
	}
	if (key === "kpBegin") {
		if (modifiers === 0 && eventType === 1) return `${SS3}E`;
		return kittyCodepointSequence(57427, modifiers, eventType, modes);
	}
	return undefined;
}

function actualShiftedCodepoint(event: KeyEvent): number | undefined {
	if (!hasModifier(event.modifiers, KITTY_SHIFT)) return event.codepoint;
	if (event.shifted !== undefined) return event.shifted;
	const codepoint = event.codepoint;
	if (codepoint === undefined) return undefined;
	if (codepoint === 32) return 32;
	if (codepoint >= 0x61 && codepoint <= 0x7a) return codepoint - 0x20;
	// Kitty's first codepoint is unshifted. Do not guess shifted symbols or
	// locale-dependent letters when the alternate-key field was not reported.
	return undefined;
}

function toText(codepoint: number | undefined): string | undefined {
	return codepoint !== undefined && isPrintableCodepoint(codepoint)
		? String.fromCodePoint(codepoint)
		: undefined;
}

const LEGACY_TEXT_KEYS = new Set<number>([
	32,
	...Array.from({ length: 26 }, (_, index) => 97 + index),
	...Array.from({ length: 10 }, (_, index) => 48 + index),
	...Array.from("`-=[]\\;'", (char) => char.codePointAt(0) ?? 0),
	...Array.from(",./", (char) => char.codePointAt(0) ?? 0),
]);

const LEGACY_CTRL_MAP: Readonly<Record<number, number>> = (() => {
	const mapping: Record<number, number> = {
		32: 0, 47: 31, 48: 48, 49: 49, 50: 0, 51: 27, 52: 28,
		53: 29, 54: 30, 55: 31, 56: 127, 57: 57, 63: 127, 64: 0,
		91: 27, 92: 28, 93: 29, 94: 30, 95: 31, 126: 30,
	};
	for (let cp = 97; cp <= 122; cp++) mapping[cp] = cp - 96;
	return mapping;
})();

function csiuFallback(event: KeyEvent, modes: InputTargetModes): string | undefined {
	if (event.codepoint === undefined) return undefined;
	return kittyCodepointSequence(
		event.codepoint,
		event.modifiers,
		event.eventType,
		modes,
		event.shifted,
		event.baseLayout,
	);
}

function encodeLegacyControl(event: KeyEvent): string | undefined {
	const codepoint = event.codepoint;
	if (codepoint === undefined) return undefined;
	const modifiers = event.modifiers & ~LOCK_MODIFIERS;
	const altPrefix = hasModifier(modifiers, KITTY_ALT) || hasModifier(modifiers, KITTY_META);
	if ((modifiers & ~(KITTY_SHIFT | KITTY_ALT | KITTY_CTRL | KITTY_META)) !== 0) return undefined;
	if (codepoint === 27) return altPrefix ? `${ESC}${ESC}` : ESC;
	if (codepoint === 13) return altPrefix ? `${ESC}\r` : "\r";
	if (codepoint === 9) {
		const shift = hasModifier(modifiers, KITTY_SHIFT);
		const value = shift
			? `${CSI}Z`
			: "\t";
		return altPrefix ? `${ESC}${value}` : value;
	}
	if (codepoint === 127) {
		return `${altPrefix ? ESC : ""}${hasModifier(modifiers, KITTY_CTRL) ? "\x08" : "\x7f"}`;
	}
	return undefined;
}

function isMokEligible(codepoint: number): boolean {
	return isOrdinaryPrintableKey(codepoint) || codepoint === 9 || codepoint === 13 || codepoint === 127;
}

function xtermModifierParameter(modifiers: number): number {
	let xtermModifiers = 0;
	if (hasModifier(modifiers, KITTY_SHIFT)) xtermModifiers |= 1;
	if (hasModifier(modifiers, KITTY_ALT)) xtermModifiers |= 2;
	if (hasModifier(modifiers, KITTY_CTRL)) xtermModifiers |= 4;
	// Kitty's Meta modifier is bit 32; xterm's modifyOtherKeys uses bit 8.
	if (hasModifier(modifiers, KITTY_META)) xtermModifiers |= 8;
	return 1 + xtermModifiers;
}

function eventWithNormalizedType(event: KeyEvent, modes: InputTargetModes): KeyEvent | undefined {
	if (event.eventType === 3) {
		if ((modes.kittyFlags & 2) === 0) return undefined;
		// This surface does not advertise Kitty bit 8: Enter, Tab and
		// Backspace cannot carry release events even with bit 2 enabled.
		if (event.codepoint === 9 || event.codepoint === 13 || event.codepoint === 127 || event.codepoint === 57414) return undefined;
		const modifiedTextKey = event.codepoint !== undefined
			&& isOrdinaryPrintableKey(event.codepoint)
			&& (event.modifiers & (KITTY_ALT | KITTY_CTRL | KITTY_SUPER | KITTY_HYPER | KITTY_META)) !== 0;
		if (event.codepoint !== 27 && event.key === undefined && !isFunctionalPua(event.codepoint ?? -1) && !modifiedTextKey) return undefined;
	}
	if (event.eventType === 2 && (modes.kittyFlags & 2) === 0) {
		return { ...event, eventType: 1 };
	}
	return event;
}

function encodeKeypad(event: KeyEvent, modes: InputTargetModes): string | undefined {
	const codepoint = event.codepoint;
	if (codepoint === undefined || !isKeypadCodepoint(codepoint)) return undefined;
	if ((modes.kittyFlags & 1) !== 0) return csiuFallback(event, modes);
	const modifiers = event.modifiers & ~LOCK_MODIFIERS;
	if (event.eventType !== 1 && (modes.kittyFlags & 2) !== 0) {
		const navigation = KEYPAD_NAVIGATION[codepoint];
		return navigation
			? kittyFunctionalSequence(navigation, modifiers, event.eventType, modes)
			: csiuFallback(event, modes);
	}
	if (modifiers !== 0) {
		const navigation = KEYPAD_NAVIGATION[codepoint];
		if (navigation) return kittyFunctionalSequence(navigation, modifiers, event.eventType, modes);
		if (!modes.applicationKeypad) {
			const value = KEYPAD_VALUES[codepoint];
			if (value !== undefined) {
				return encodeKey({ ...event, codepoint: value.codePointAt(0), key: undefined }, modes);
			}
		}
		return csiuFallback(event, modes);
	}
	if (modes.applicationKeypad) {
		const navigation = KEYPAD_NAVIGATION[codepoint];
		if (navigation) return kittyFunctionalSequence(navigation, 0, event.eventType, modes);
		const applicationCode = KEYPAD_APPLICATION_CODES[codepoint];
		return applicationCode === undefined ? undefined : `${SS3}${applicationCode}`;
	}
	if (codepoint === 57427) return `${CSI}E`;
	const value = KEYPAD_VALUES[codepoint];
	if (value !== undefined) return value;
	const navigation = KEYPAD_NAVIGATION[codepoint];
	return navigation ? kittyFunctionalSequence(navigation, 0, event.eventType, modes) : undefined;
}

function encodeLegacyText(event: KeyEvent, modes: InputTargetModes): string | undefined {
	const codepoint = event.codepoint;
	if (codepoint === undefined) return undefined;
	const modifiers = event.modifiers & ~LOCK_MODIFIERS;
	const unsupported = modifiers & ~(KITTY_SHIFT | KITTY_ALT | KITTY_CTRL | KITTY_META);
	if (unsupported !== 0) return csiuFallback(event, modes);
	const shift = hasModifier(modifiers, KITTY_SHIFT);
	const altPrefix = hasModifier(modifiers, KITTY_ALT) || hasModifier(modifiers, KITTY_META);
	const control = hasModifier(modifiers, KITTY_CTRL);

	if (control && shift && codepoint === 32) return `${altPrefix ? ESC : ""}\x00`;
	if (control && shift) return csiuFallback(event, modes);
	if (control) {
		const mapped = LEGACY_CTRL_MAP[codepoint];
		if (mapped !== undefined) return `${altPrefix ? ESC : ""}${String.fromCharCode(mapped)}`;
		if (altPrefix) {
			return LEGACY_TEXT_KEYS.has(codepoint) ? `${ESC}${String.fromCodePoint(codepoint)}` : csiuFallback(event, modes);
		}
		// Kitty's published table explicitly leaves ASCII keys outside its
		// control map untouched; it does not apply blanket ASCII & 31.
		if (codepoint >= 0x20 && codepoint <= 0x7e) return String.fromCodePoint(codepoint);
		return csiuFallback(event, modes);
	}

	if (altPrefix && !LEGACY_TEXT_KEYS.has(codepoint)) return csiuFallback(event, modes);
	const shifted = actualShiftedCodepoint(event);
	if (shift && shifted === undefined) return csiuFallback(event, modes);
	const outputCodepoint = shift ? shifted : codepoint;
	const text = toText(outputCodepoint);
	if (text === undefined) return csiuFallback(event, modes);
	return `${altPrefix ? ESC : ""}${text}`;
}

function encodeKey(eventInput: KeyEvent, modes: InputTargetModes): string | undefined {
	const event = eventWithNormalizedType(eventInput, modes);
	if (!event) return undefined;
	const codepoint = event.codepoint;
	const modifiers = event.modifiers & ~LOCK_MODIFIERS;
	const kittyDisambiguation = (modes.kittyFlags & 1) !== 0;

	if (event.key !== undefined) {
		return kittyFunctionalSequence(event.key, modifiers, event.eventType, modes);
	}
	if (codepoint === undefined || !isValidKeyboardCodepoint(codepoint)) return undefined;

	if (isKeypadCodepoint(codepoint)) return encodeKeypad(event, modes);
	if (isFunctionalPua(codepoint)) return csiuFallback(event, modes);

	const eventReportingTextKey = event.eventType !== 1
		&& (modes.kittyFlags & 2) !== 0
		&& isOrdinaryPrintableKey(codepoint)
		&& (modifiers & (KITTY_ALT | KITTY_CTRL | KITTY_SUPER | KITTY_HYPER | KITTY_META)) !== 0;
	if (eventReportingTextKey) return csiuFallback(event, modes);

	if (codepoint === 27) {
		if (kittyDisambiguation || modifiers !== 0 || event.eventType !== 1) return csiuFallback(event, modes);
		return encodeLegacyControl(event);
	}

	// Preserve legacy C0 bytes by default, but keep modified-key identity for
	// Kitty-disambiguation children and xterm modifyOtherKeys level 2.
	if (!kittyDisambiguation && modes.modifyOtherKeys === 2 && isMokEligible(codepoint) && modifiers !== 0) {
		if ((modifiers & ~XTERM_MODIFIERS) === 0) {
			return `${CSI}27;${xtermModifierParameter(modifiers)};${codepoint}~`;
		}
		return csiuFallback(event, modes);
	}

	if (codepoint === 9 || codepoint === 13 || codepoint === 127) {
		if (modifiers === 0) return encodeLegacyControl(event);
		// In legacy mode only Shift-Tab, Alt-Enter and Alt-Backspace have
		// unambiguous spellings in the pinned Pi key matcher.
		if (kittyDisambiguation) return csiuFallback(event, modes);
		const legacyIdentityIsUnambiguous = (codepoint === 9 && modifiers === KITTY_SHIFT)
			|| (codepoint === 13 && modifiers === KITTY_ALT)
			|| (codepoint === 127 && modifiers === KITTY_ALT);
		return legacyIdentityIsUnambiguous ? encodeLegacyControl(event) : csiuFallback(event, modes);
	}

	if (!isOrdinaryPrintableKey(codepoint)) return undefined;
	const hasKittyTextModifier = (modifiers & (KITTY_ALT | KITTY_CTRL | KITTY_SUPER | KITTY_HYPER | KITTY_META)) !== 0
		|| (hasModifier(modifiers, KITTY_SHIFT) && hasModifier(modifiers, KITTY_CTRL));
	if (kittyDisambiguation && hasKittyTextModifier) {
		return kittyCodepointSequence(codepoint, event.modifiers, event.eventType, modes, event.shifted, event.baseLayout);
	}

	if (!kittyDisambiguation && modes.modifyOtherKeys === 1 && isMokEligible(codepoint)) {
		if ((modifiers & ~XTERM_MODIFIERS) !== 0) return csiuFallback(event, modes);
		const legacyAltPrefix = (modifiers & (KITTY_ALT | KITTY_META)) !== 0 ? ESC : "";
		const ctrlSpaceException = codepoint === 32 && hasModifier(modifiers, KITTY_CTRL);
		const ctrlThreeException = codepoint === 51 && hasModifier(modifiers, KITTY_CTRL);
		const specialException = codepoint === 9 || codepoint === 127;
		const mok1Modifiers = modifiers & (KITTY_SHIFT | KITTY_CTRL);
		const onlyLevelOneModifiers = (modifiers & ~(KITTY_SHIFT | KITTY_CTRL)) === 0;
		if (ctrlSpaceException) return `${legacyAltPrefix}\x00`;
		if (ctrlThreeException && !hasModifier(modifiers, KITTY_SHIFT)) return `${legacyAltPrefix}${ESC}`;
		if (!specialException && mok1Modifiers !== 0 && onlyLevelOneModifiers) {
			return `${CSI}27;${1 + modifiers};${codepoint}~`;
		}
	}

	return encodeLegacyText(event, modes);
}

export function parseMouseInput(data: string): ParsedMouseInput | undefined | null {
	const isSgrMouse = data.startsWith(`${CSI}<`);
	const isX10Mouse = data.startsWith(`${CSI}M`);
	if (!isSgrMouse && !isX10Mouse) return undefined;
	if (data.length > MAX_CSI_PACKET_LENGTH) return null;
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (sgr) {
		const button = parseDecimal(sgr[1], 255);
		const x = parseDecimal(sgr[2]);
		const y = parseDecimal(sgr[3]);
		if (button === undefined || x === undefined || y === undefined || x < 1 || y < 1) return null;
		const motion = (button & 32) !== 0;
		const wheel = (button & 64) !== 0;
		const release = sgr[4] === "m" || (!motion && !wheel && (button & 3) === 3);
		return { button, x: x - 1, y: y - 1, release, motion, wheel };
	}

	if (isX10Mouse) {
		if (data.length !== 6) return null;
		const encodedButton = data.charCodeAt(3);
		const encodedX = data.charCodeAt(4);
		const encodedY = data.charCodeAt(5);
		if (encodedButton < 32 || encodedButton > 255 || encodedX < 33 || encodedX > 255 || encodedY < 33 || encodedY > 255) return null;
		const button = encodedButton - 32;
		const motion = (button & 32) !== 0;
		const wheel = (button & 64) !== 0;
		const release = !motion && !wheel && (button & 3) === 3;
		return { button, x: encodedX - 33, y: encodedY - 33, release, motion, wheel };
	}
	return null;
}

function mouseAllowed(mouse: ParsedMouseInput, tracking: InputTargetModes["mouseTracking"]): boolean {
	if (tracking === "none") return false;
	if (tracking === "x10") return !mouse.release && !mouse.motion && !mouse.wheel;
	if (tracking === "vt200") return !mouse.motion;
	if (tracking === "drag") return !mouse.motion || (mouse.button & 3) !== 3;
	return true;
}

function translateMouse(mouseInput: ParsedMouseInput, modes: InputTargetModes, viewport: InputViewport): string | Buffer | undefined {
	if (modes.mouseEncoding === "sgr-pixels") return undefined;
	if (mouseInput.x < viewport.column || mouseInput.x >= viewport.column + viewport.cols
		|| mouseInput.y < viewport.row || mouseInput.y >= viewport.row + viewport.rows) return undefined;
	const localX = mouseInput.x - viewport.column;
	const localY = mouseInput.y - viewport.row;
	if (!mouseAllowed(mouseInput, modes.mouseTracking)) return undefined;

	let button = mouseInput.button;
	if (modes.mouseTracking === "x10") button &= ~(4 | 8 | 16);
	if (modes.mouseEncoding === "sgr") {
		return `${CSI}<${button};${localX + 1};${localY + 1}${mouseInput.release ? "m" : "M"}`;
	}

	// Legacy X10 is byte-oriented: a JS Latin-1 string would be UTF-8 encoded
	// by Node and corrupt coordinates above 127, so return the raw bytes.
	const legacyButton = mouseInput.release ? ((button & ~3) | 3) : button;
	const encodedButton = legacyButton + 32;
	const encodedX = localX + 33;
	const encodedY = localY + 33;
	if (encodedButton > 255 || encodedX > 255 || encodedY > 255) return undefined;
	return Buffer.from([0x1b, 0x5b, 0x4d, encodedButton, encodedX, encodedY]);
}

function translatePaste(data: string, modes: InputTargetModes): string | undefined | null {
	const start = `${CSI}200~`;
	const end = `${CSI}201~`;
	if (!data.startsWith(start)) return undefined;
	if (!data.endsWith(end) || data.length < start.length + end.length) return null;
	if (modes.bracketedPaste) return data;
	return data.slice(start.length, data.length - end.length);
}

function translateLegacyAltPacket(data: string, modes: InputTargetModes): string | undefined {
	if (data.length !== 2 || data.charCodeAt(0) !== 0x1b) return undefined;
	const char = data[1];
	const cp = char.codePointAt(0);
	if (cp === 13) return encodeKey({ codepoint: 13, modifiers: KITTY_ALT, eventType: 1 }, modes);
	if (cp === 8 || cp === 127) {
		const encoded = encodeKey({ codepoint: 127, modifiers: KITTY_ALT, eventType: 1 }, modes);
		// Preserve either public legacy Alt+Backspace byte form when the child
		// has no enhanced representation for it.
		return cp === 8 && encoded === `${ESC}\x7f` ? data : encoded;
	}
	if (cp === undefined || cp > 0x7e || cp < 0x20) return undefined;
	let baseCodepoint = cp;
	let modifiers = KITTY_ALT;
	if (cp >= 0x41 && cp <= 0x5a) {
		baseCodepoint = cp + 0x20;
		modifiers |= KITTY_SHIFT;
	}
	if (!LEGACY_TEXT_KEYS.has(baseCodepoint)) return undefined;
	const encoded = encodeKey({ codepoint: baseCodepoint, modifiers, eventType: 1 }, modes);
	return encoded;
}

/**
 * Translate exactly one packet already selected for a live child by its
 * parent. Source-dependent legacy packets must first pass through
 * normalizeNativeSourceInput with the actual source ProcessTerminal state.
 * This function has no focus, ownership, or routing policy; callers must gate
 * the actual main focus and selected live child themselves.
 */
export function translateInput(
	data: string,
	modes: InputTargetModes,
	viewport: InputViewport,
): string | Buffer | undefined {
	if (typeof data !== "string" || data.length === 0 || !validModes(modes) || !validViewport(viewport)) return undefined;

	// Plain joined text is not a protocol packet; let it through before the
	// bounded escape-sequence parsers so long text is never length-truncated.
	if (!data.includes(ESC)) {
		for (const char of data) {
			const codepoint = char.codePointAt(0);
			if (codepoint === undefined || (codepoint >= 0x80 && codepoint <= 0x9f)) return undefined;
		}
		return data;
	}

	const paste = translatePaste(data, modes);
	if (paste !== undefined) return paste === null ? undefined : paste;

	const mouse = parseMouseInput(data);
	if (mouse !== undefined) return mouse === null ? undefined : translateMouse(mouse, modes, viewport);

	const key = parseLegacyKeyboardSequence(data);
	if (key !== undefined) return key === null ? undefined : encodeKey(key, modes);

	const altPacket = translateLegacyAltPacket(data, modes);
	if (altPacket !== undefined) return altPacket;

	// Legacy C0 keys (including a bare Escape and Ctrl-C) remain native.
	// Unknown raw escape packets are never forwarded.
	if (data === ESC) return ESC;
	return undefined;
}

/**
 * Normalize only exact legacy packets whose meaning depends on source Kitty
 * state. Pass the actual public ProcessTerminal.kittyProtocolActive value as
 * sourceKittyProtocolActive; observer flags are not equivalent. Call before
 * translateInput, never inferring source state from child target modes.
 */
export function normalizeNativeSourceInput(data: string, sourceKittyProtocolActive: boolean): string {
	if (sourceKittyProtocolActive && (data === `${ESC}\r` || data === "\n")) return KITTY_SHIFT_ENTER;
	// In legacy source mode LF is plain Enter; CR is the unambiguous spelling
	// when forwarding it to a Kitty-active child.
	if (!sourceKittyProtocolActive && data === "\n") return "\r";
	return data;
}

export interface KeyboardCapabilityObserverOptions {
	readonly onChange?: (flags: number) => void;
}

interface ObserverWaiter {
	readonly resolve: (flags: number) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Passive, bounded observer for real terminal keyboard-capability replies.
 * It never owns stdin and never consumes or replays the observed stream.
 */
export class KeyboardCapabilityObserver {
	private currentFlags = 0;
	private readonly onChange?: (flags: number) => void;
	private readonly parser: StdinBuffer;
	private readonly waiters = new Set<ObserverWaiter>();
	private readonly observationTimer: ReturnType<typeof setTimeout>;
	private negotiationBuffer = "";
	private negotiationTimer?: ReturnType<typeof setTimeout>;
	private fedBytes = 0;
	private ready = false;
	private stopped = false;

	constructor(options: KeyboardCapabilityObserverOptions = {}) {
		this.onChange = options.onChange;
		this.parser = new StdinBuffer({ timeout: 50, escapeTimeout: 10 });
		this.parser.on("data", (sequence: string) => this.observeSequence(sequence));
		// Paste breaks reply contiguity; clear only a pending prefix without
		// inspecting the opaque body.
		this.parser.on("paste", (_body: string) => this.clearNegotiationBuffer());
		this.observationTimer = setTimeout(() => this.stopObserving(), OBSERVER_WINDOW_MS);
		this.observationTimer.unref?.();
	}

	get flags(): number {
		return this.currentFlags;
	}

	feed(data: string | Buffer): void {
		if (this.stopped) return;
		const size = Buffer.isBuffer(data) ? data.length : data.length > OBSERVER_BYTE_BUDGET
			? OBSERVER_BYTE_BUDGET + 1
			: Buffer.byteLength(data, "utf8");
		if (size > OBSERVER_BYTE_BUDGET - this.fedBytes) {
			this.stopObserving();
			return;
		}
		this.fedBytes += size;
		// Convert Buffer chunks to text before feeding StdinBuffer. Its public
		// Buffer compatibility path treats a one-byte high value as Meta input;
		// ASCII CSI replies remain byte-exact while passive observation avoids
		// that unrelated keypress conversion.
		this.parser.process(Buffer.isBuffer(data) ? data.toString("utf8") : data);
	}

	wait(timeoutMs = DEFAULT_WAIT_MS): Promise<number> {
		if (this.ready || this.stopped) return Promise.resolve(this.currentFlags);
		const finiteTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
			? Math.min(Math.floor(timeoutMs), OBSERVER_WINDOW_MS)
			: DEFAULT_WAIT_MS;
		return new Promise<number>((resolve) => {
			const waiter: ObserverWaiter = {
				resolve,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					resolve(this.currentFlags);
				}, finiteTimeout),
			};
			this.waiters.add(waiter);
		});
	}

	dispose(): void {
		this.stopObserving();
	}

	private observeSequence(sequence: string): void {
		if (this.stopped) return;
		if (this.negotiationBuffer) {
			const candidate = this.negotiationBuffer + sequence;
			if (candidate.length <= MAX_NEGOTIATION_PREFIX_LENGTH && this.observeReply(candidate)) {
				this.clearNegotiationBuffer();
				return;
			}
			if (candidate.length <= MAX_NEGOTIATION_PREFIX_LENGTH && this.isNegotiationPrefix(candidate)) {
				this.setNegotiationBuffer(candidate);
				return;
			}
			this.clearNegotiationBuffer();
		}
		if (this.observeReply(sequence)) return;
		if (this.isNegotiationPrefix(sequence)) this.setNegotiationBuffer(sequence);
	}

	private observeReply(sequence: string): boolean {
		const flagsReply = /^\x1b\[\?(\d+)u$/.exec(sequence);
		if (flagsReply) {
			const parsed = parseDecimal(flagsReply[1], 31);
			this.setFlags(parsed === undefined ? 0 : parsed & 7);
			this.setReady();
			return true;
		}
		// Match ProcessTerminal's primary-DA sentinel grammar exactly.
		if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
			this.setReady();
			return true;
		}
		return false;
	}

	private isNegotiationPrefix(sequence: string): boolean {
		return sequence === `${CSI}` || /^\x1b\[\?[\d;]*$/.test(sequence);
	}

	private setNegotiationBuffer(sequence: string): void {
		this.clearNegotiationTimer();
		this.negotiationBuffer = sequence;
		this.negotiationTimer = setTimeout(() => {
			this.negotiationTimer = undefined;
			this.negotiationBuffer = "";
		}, NEGOTIATION_FRAGMENT_TIMEOUT_MS);
		this.negotiationTimer.unref?.();
	}

	private clearNegotiationTimer(): void {
		if (this.negotiationTimer) clearTimeout(this.negotiationTimer);
		this.negotiationTimer = undefined;
	}

	private clearNegotiationBuffer(): void {
		this.clearNegotiationTimer();
		this.negotiationBuffer = "";
	}

	private setFlags(flags: number): void {
		if (this.currentFlags === flags) return;
		this.currentFlags = flags;
		try {
			this.onChange?.(flags);
		} catch {
			// Observer callbacks cannot interrupt terminal input or parser state.
		}
	}

	private setReady(): void {
		if (this.ready) return;
		this.ready = true;
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(this.currentFlags);
		}
		this.waiters.clear();
	}

	private stopObserving(): void {
		if (this.stopped) return;
		this.stopped = true;
		clearTimeout(this.observationTimer);
		this.clearNegotiationBuffer();
		this.parser.removeAllListeners();
		this.parser.destroy();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(this.currentFlags);
		}
		this.waiters.clear();
		this.ready = true;
	}
}
