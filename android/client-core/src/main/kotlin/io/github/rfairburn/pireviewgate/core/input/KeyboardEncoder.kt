package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import java.nio.charset.StandardCharsets

/** Whether a key arrived as a press, an auto-repeat, or a release. */
enum class TerminalKeyEventType(val wireValue: Int) {
	PRESS(1),
	REPEAT(2),
	RELEASE(3),
}

/** A functional key the owner names rather than a printable codepoint. */
enum class TerminalFunctionKey {
	UP,
	DOWN,
	RIGHT,
	LEFT,
	HOME,
	END,
	INSERT,
	DELETE,
	PAGE_UP,
	PAGE_DOWN,
	F1,
	F2,
	F3,
	F4,
	F5,
	F6,
	F7,
	F8,
	F9,
	F10,
	F11,
	F12,
	KP_BEGIN,
}

/** Kitty keyboard modifier bits, as the owner's translator names them. */
object KeyboardModifiers {
	const val SHIFT = 1
	const val ALT = 2
	const val CTRL = 4
	const val SUPER = 8
	const val HYPER = 16
	const val META = 32
	const val CAPS_LOCK = 64
	const val NUM_LOCK = 128

	/** Lock state is never encoded as a modifier in a packet. */
	const val LOCK_MASK = CAPS_LOCK or NUM_LOCK
}

/**
 * One keystroke before encoding.
 *
 * Exactly one of [codepoint] and [functionKey] carries the identity. Kitty's
 * optional alternate-key fields are carried as reported so a shifted symbol and
 * the physical base-layout key survive to the packet rather than being guessed.
 */
data class TerminalKey(
	val codepoint: Int? = null,
	val functionKey: TerminalFunctionKey? = null,
	val modifiers: Int = 0,
	val eventType: TerminalKeyEventType = TerminalKeyEventType.PRESS,
	val shiftedCodepoint: Int? = null,
	val baseLayoutCodepoint: Int? = null,
)

/**
 * Canonical keyboard packet encoder.
 *
 * This is the owner's own translation, ported so the phone emits the packets a
 * real terminal would: Kitty CSI-u with its disambiguate, event-reporting, and
 * alternate-key flags; xterm `modifyOtherKeys` level 1 and 2; the legacy C0 and
 * Ctrl spellings the pinned key matcher recognizes; SS3 and CSI function,
 * navigation, and keypad forms. Enter, Ctrl+J, and Shift+Enter therefore stay
 * distinct, Ctrl+Alt+Esc, Tab, arrows, and function and navigation keys keep
 * their identities, and typed Unicode leaves as text.
 *
 * The packets describe keystrokes; they carry no authority. Whether one may be
 * sent at all is decided by the caller's committed-frame fence, and the modes
 * passed in are the modes observed on the owner's current frame.
 *
 * Refusals return null: an out-of-range mode bundle, an invalid codepoint, a
 * release the child cannot report, a modifier combination with no unambiguous
 * spelling, and every spelling of Ctrl+Z. The POSIX suspend byte never leaves
 * this encoder, in any keyboard spelling, so a phone keystroke cannot stop or
 * background the hosted child or reach the shell behind it.
 */
object KeyboardEncoder {
	private const val ESC = "\u001b"
	private const val CSI = "$ESC["
	private const val SS3 = "${ESC}O"

	private const val SHIFT = KeyboardModifiers.SHIFT
	private const val ALT = KeyboardModifiers.ALT
	private const val CTRL = KeyboardModifiers.CTRL
	private const val SUPER = KeyboardModifiers.SUPER
	private const val HYPER = KeyboardModifiers.HYPER
	private const val META = KeyboardModifiers.META
	private const val LOCK_MASK = KeyboardModifiers.LOCK_MASK
	private const val XTERM_MODIFIERS = SHIFT or ALT or CTRL or META

	private const val SUSPEND_CONTROL = 0x1a
	private const val Z_BASE_LAYOUT_CODEPOINT = 0x7a

	private val AUTHORITATIVE_IDENTITY_SYMBOLS = setOf(
		'`', '-', '=', '[', ']', '\\', ';', '\'', ',', '.', '/',
		'!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '|', '~',
		'{', '}', ':', '<', '>', '?',
	)

	private val KEYPAD_VALUES: Map<Int, String> = mapOf(
		57399 to "0", 57400 to "1", 57401 to "2", 57402 to "3", 57403 to "4",
		57404 to "5", 57405 to "6", 57406 to "7", 57407 to "8", 57408 to "9",
		57409 to ".", 57410 to "/", 57411 to "*", 57412 to "-", 57413 to "+",
		57414 to "\r", 57415 to "=", 57416 to ",",
	)

	private val KEYPAD_APPLICATION_CODES: Map<Int, String> = mapOf(
		57399 to "p", 57400 to "q", 57401 to "r", 57402 to "s", 57403 to "t",
		57404 to "u", 57405 to "v", 57406 to "w", 57407 to "x", 57408 to "y",
		57409 to "n", 57410 to "o", 57411 to "j", 57412 to "m", 57413 to "k",
		57414 to "M", 57415 to "X", 57416 to "l", 57427 to "E",
	)

	private val KEYPAD_NAVIGATION: Map<Int, TerminalFunctionKey> = mapOf(
		57417 to TerminalFunctionKey.LEFT,
		57418 to TerminalFunctionKey.RIGHT,
		57419 to TerminalFunctionKey.UP,
		57420 to TerminalFunctionKey.DOWN,
		57421 to TerminalFunctionKey.PAGE_UP,
		57422 to TerminalFunctionKey.PAGE_DOWN,
		57423 to TerminalFunctionKey.HOME,
		57424 to TerminalFunctionKey.END,
		57425 to TerminalFunctionKey.INSERT,
		57426 to TerminalFunctionKey.DELETE,
	)

	private val LEGACY_TEXT_KEYS: Set<Int> = (
		listOf(32) +
			(97..122).toList() +
			(48..57).toList() +
			"`-=[]\\;'".map { it.code } +
			",./".map { it.code }
		).toSet()

	private val LEGACY_CTRL_MAP: Map<Int, Int> = mapOf(
		32 to 0, 47 to 31, 48 to 48, 49 to 49, 50 to 0, 51 to 27,
		52 to 28, 53 to 29, 54 to 30, 55 to 31, 56 to 127, 57 to 57,
		63 to 127, 64 to 0, 91 to 27, 92 to 28, 93 to 29, 94 to 30,
		95 to 31, 126 to 30,
	) + (97..122).associateWith { it - 96 }

	/**
	 * Encode one keystroke into the packet the owner's child expects, or null
	 * when this encoder refuses to send it.
	 */
	fun encode(key: TerminalKey, modes: TerminalInputModes): ByteArray? {
		if (isSuspendKey(key)) return null
		val packet = encodeKey(key, modes) ?: return null
		return packet.toByteArray(StandardCharsets.UTF_8)
	}

	/**
	 * Encode joined typed text that carries no escape sequence, mirroring the
	 * owner's plain-text path: C1 controls are refused outright, the POSIX
	 * suspend control is dropped while the rest of the burst is kept, and a burst
	 * that empties out is refused rather than sent as nothing.
	 */
	fun encodeTypedText(text: String): ByteArray? {
		if (text.isEmpty()) return null
		for (index in text.indices) {
			val code = text[index].code
			if (code == 0x1b || (code in 0x80..0x9f)) return null
		}
		val withoutSuspend = text.filter { it.code != SUSPEND_CONTROL }
		if (withoutSuspend.isEmpty()) return null
		return withoutSuspend.toByteArray(StandardCharsets.UTF_8)
	}

	/** True when this keystroke names Ctrl+Z in any spelling. */
	fun isSuspendKey(key: TerminalKey): Boolean = isSuspendKeyEvent(key)

	/**
	 * True when [codepoint] is one of the reserved functional identities — the official
	 * private-use range that names Escape, Insert, Delete, the navigation keys, the
	 * function keys above F12, and the keypad.
	 *
	 * These numbers mean a key, not a glyph. A caller encoding committed text must
	 * refuse a scalar in this range rather than hand it over: this encoder answers a
	 * functional codepoint with the key it names, so a text path that passed one
	 * through would press a different key than the character the user produced.
	 */
	fun isReservedFunctionalCodepoint(codepoint: Int): Boolean = isOfficialFunctionalCodepoint(codepoint)

	/**
	 * True when [codepoint] is a Unicode scalar a person could type as text.
	 *
	 * A forwarded hardware key event carries integers that are not always text: a
	 * dead-key flag, a control or C1 byte from a folded modifier, or a surrogate
	 * half. Those must never become characters, so a caller converts only what this
	 * admits.
	 */
	fun isForwardableTextScalar(codepoint: Int): Boolean =
		codepoint in 0x20..0x10ffff && codepoint !in 0x7f..0x9f && codepoint !in 0xd800..0xdfff

	/**
	 * The text [codepoint] stands for, or null when it is not a typeable scalar.
	 *
	 * The conversion is by scalar value, never by its decimal digits: a forwarded
	 * `a` key is "a", and a supplementary character becomes its surrogate pair, so
	 * the text path sends the UTF-8 the child expects.
	 */
	fun textOfScalar(codepoint: Int): String? =
		if (isForwardableTextScalar(codepoint)) String(Character.toChars(codepoint)) else null

	/* ---------------------------------------------------------------------- *
	 * Codepoint classification
	 * ---------------------------------------------------------------------- */

	private fun isOfficialFunctionalCodepoint(codepoint: Int): Boolean =
		(codepoint in 57358..57363) || (codepoint in 57376..57454)

	private fun isValidKeyboardCodepoint(codepoint: Int): Boolean {
		if (codepoint < 0 || codepoint > 0x10ffff) return false
		if (codepoint in 0xd800..0xdfff) return false
		if (codepoint == 9 || codepoint == 13 || codepoint == 27 || codepoint == 32 || codepoint == 127) return true
		if (codepoint < 0x20 || (codepoint in 0x7f..0x9f)) return false
		if (codepoint in 0xe000..0xf8ff) return isOfficialFunctionalCodepoint(codepoint)
		if (codepoint in 0xf0000..0xffffd) return false
		if (codepoint in 0x100000..0x10fffd) return false
		return true
	}

	private fun isPrintableCodepoint(codepoint: Int): Boolean =
		isValidKeyboardCodepoint(codepoint) &&
			codepoint >= 0x20 &&
			codepoint != 0x7f &&
			!isOfficialFunctionalCodepoint(codepoint)

	private fun isKeypadCodepoint(codepoint: Int): Boolean = codepoint in 57399..57427

	private fun isOrdinaryPrintableKey(codepoint: Int): Boolean = isPrintableCodepoint(codepoint)

	private fun isMokEligible(codepoint: Int): Boolean =
		isOrdinaryPrintableKey(codepoint) || codepoint == 9 || codepoint == 13 || codepoint == 127

	/* ---------------------------------------------------------------------- *
	 * Suspend guard
	 * ---------------------------------------------------------------------- */

	private fun isAuthoritativeIdentityCodepoint(codepoint: Int): Boolean =
		codepoint in 0x61..0x7a || AUTHORITATIVE_IDENTITY_SYMBOLS.contains(codepoint.toChar())

	private fun letterIdentityCodepoint(codepoint: Int, modifiers: Int): Int =
		if ((modifiers and SHIFT) != 0 && codepoint in 0x41..0x5a) codepoint + 0x20 else codepoint

	private fun isSuspendKeyEvent(event: TerminalKey): Boolean {
		val codepoint = event.codepoint ?: return false
		if ((event.modifiers and CTRL) == 0) return false
		val identity = letterIdentityCodepoint(codepoint, event.modifiers)
		if (identity == 0x5a || identity == 0x7a) return true
		return event.baseLayoutCodepoint == Z_BASE_LAYOUT_CODEPOINT && !isAuthoritativeIdentityCodepoint(identity)
	}

	/* ---------------------------------------------------------------------- *
	 * Kitty forms
	 * ---------------------------------------------------------------------- */

	private fun kittyEventSuffix(modes: TerminalInputModes, eventType: TerminalKeyEventType): String =
		if ((modes.kittyFlags and 2) != 0 && eventType != TerminalKeyEventType.PRESS) {
			":${eventType.wireValue}"
		} else {
			""
		}

	private fun kittyCodepointSequence(
		codepoint: Int,
		modifiers: Int,
		eventType: TerminalKeyEventType,
		modes: TerminalInputModes,
		shifted: Int? = null,
		baseLayout: Int? = null,
	): String {
		var keyField = codepoint.toString()
		if ((modes.kittyFlags and 4) != 0 && (shifted != null || baseLayout != null)) {
			keyField += if (shifted != null) ":$shifted" else ":"
			if (baseLayout != null) keyField += ":$baseLayout"
		}
		return "$CSI$keyField;${1 + modifiers}${kittyEventSuffix(modes, eventType)}u"
	}

	private fun csiuFallback(event: TerminalKey, modes: TerminalInputModes): String? {
		val codepoint = event.codepoint ?: return null
		return kittyCodepointSequence(
			codepoint,
			event.modifiers,
			event.eventType,
			modes,
			event.shiftedCodepoint,
			event.baseLayoutCodepoint,
		)
	}

	private fun kittyFunctionalSequence(
		key: TerminalFunctionKey,
		modifiers: Int,
		eventType: TerminalKeyEventType,
		modes: TerminalInputModes,
	): String? {
		val cursorLetter = when (key) {
			TerminalFunctionKey.UP -> "A"
			TerminalFunctionKey.DOWN -> "B"
			TerminalFunctionKey.RIGHT -> "C"
			TerminalFunctionKey.LEFT -> "D"
			else -> null
		}
		if (cursorLetter != null) {
			if (modifiers == 0 && eventType == TerminalKeyEventType.PRESS) {
				return if (modes.applicationCursorKeys) "$SS3$cursorLetter" else "$CSI$cursorLetter"
			}
			return "${CSI}1;${1 + modifiers}${kittyEventSuffix(modes, eventType)}$cursorLetter"
		}
		if (key == TerminalFunctionKey.HOME || key == TerminalFunctionKey.END) {
			val letter = if (key == TerminalFunctionKey.HOME) "H" else "F"
			if (modifiers == 0 && eventType == TerminalKeyEventType.PRESS) return "$CSI$letter"
			return "${CSI}1;${1 + modifiers}${kittyEventSuffix(modes, eventType)}$letter"
		}
		val ss3Letter = when (key) {
			TerminalFunctionKey.F1 -> "P"
			TerminalFunctionKey.F2 -> "Q"
			TerminalFunctionKey.F3 -> "R"
			TerminalFunctionKey.F4 -> "S"
			else -> null
		}
		if (ss3Letter != null) {
			if (modifiers == 0 && eventType == TerminalKeyEventType.PRESS) return "$SS3$ss3Letter"
			if (key == TerminalFunctionKey.F3) {
				return "${CSI}13;${1 + modifiers}${kittyEventSuffix(modes, eventType)}~"
			}
			return "${CSI}1;${1 + modifiers}${kittyEventSuffix(modes, eventType)}$ss3Letter"
		}
		val tildeCode = when (key) {
			TerminalFunctionKey.INSERT -> 2
			TerminalFunctionKey.DELETE -> 3
			TerminalFunctionKey.PAGE_UP -> 5
			TerminalFunctionKey.PAGE_DOWN -> 6
			TerminalFunctionKey.F5 -> 15
			TerminalFunctionKey.F6 -> 17
			TerminalFunctionKey.F7 -> 18
			TerminalFunctionKey.F8 -> 19
			TerminalFunctionKey.F9 -> 20
			TerminalFunctionKey.F10 -> 21
			TerminalFunctionKey.F11 -> 23
			TerminalFunctionKey.F12 -> 24
			else -> null
		}
		if (tildeCode != null) {
			if (modifiers == 0 && eventType == TerminalKeyEventType.PRESS) return "$CSI$tildeCode~"
			return "$CSI$tildeCode;${1 + modifiers}${kittyEventSuffix(modes, eventType)}~"
		}
		if (key == TerminalFunctionKey.KP_BEGIN) {
			if (modifiers == 0 && eventType == TerminalKeyEventType.PRESS) return "${SS3}E"
			return kittyCodepointSequence(57427, modifiers, eventType, modes)
		}
		return null
	}

	/* ---------------------------------------------------------------------- *
	 * Legacy forms
	 * ---------------------------------------------------------------------- */

	private fun actualShiftedCodepoint(event: TerminalKey): Int? {
		if ((event.modifiers and SHIFT) == 0) return event.codepoint
		if (event.shiftedCodepoint != null) return event.shiftedCodepoint
		val codepoint = event.codepoint ?: return null
		if (codepoint == 32) return 32
		if (codepoint in 0x61..0x7a) return codepoint - 0x20
		// Kitty's first codepoint is unshifted. Shifted symbols and
		// locale-dependent letters are never guessed here.
		return null
	}

	/** The text of one codepoint, surrogate pair included. */
	private fun stringOf(codepoint: Int): String = String(Character.toChars(codepoint))

	private fun toText(codepoint: Int?): String? =
		if (codepoint != null && isPrintableCodepoint(codepoint)) stringOf(codepoint) else null

	private fun encodeLegacyControl(event: TerminalKey): String? {
		val codepoint = event.codepoint ?: return null
		val modifiers = event.modifiers and LOCK_MASK.inv()
		val altPrefix = (modifiers and ALT) != 0 || (modifiers and META) != 0
		if ((modifiers and (SHIFT or ALT or CTRL or META).inv()) != 0) return null
		if (codepoint == 27) return if (altPrefix) "$ESC$ESC" else ESC
		if (codepoint == 13) return if (altPrefix) "$ESC\r" else "\r"
		if (codepoint == 9) {
			val value = if ((modifiers and SHIFT) != 0) "${CSI}Z" else "\t"
			return if (altPrefix) "$ESC$value" else value
		}
		if (codepoint == 127) {
			val body = if ((modifiers and CTRL) != 0) "\u0008" else "\u007f"
			return if (altPrefix) "$ESC$body" else body
		}
		return null
	}

	private fun xtermModifierParameter(modifiers: Int): Int {
		var xtermModifiers = 0
		if ((modifiers and SHIFT) != 0) xtermModifiers = xtermModifiers or 1
		if ((modifiers and ALT) != 0) xtermModifiers = xtermModifiers or 2
		if ((modifiers and CTRL) != 0) xtermModifiers = xtermModifiers or 4
		// Kitty's Meta modifier is bit 32; xterm's modifyOtherKeys uses bit 8.
		if ((modifiers and META) != 0) xtermModifiers = xtermModifiers or 8
		return 1 + xtermModifiers
	}

	private fun encodeLegacyText(event: TerminalKey, modes: TerminalInputModes): String? {
		val codepoint = event.codepoint ?: return null
		val modifiers = event.modifiers and LOCK_MASK.inv()
		val unsupported = modifiers and (SHIFT or ALT or CTRL or META).inv()
		if (unsupported != 0) return csiuFallback(event, modes)
		val shift = (modifiers and SHIFT) != 0
		val altPrefix = (modifiers and ALT) != 0 || (modifiers and META) != 0
		val control = (modifiers and CTRL) != 0

		if (control && shift && codepoint == 32) return "${if (altPrefix) ESC else ""}\u0000"
		if (control && shift) return csiuFallback(event, modes)
		if (control) {
			val mapped = LEGACY_CTRL_MAP[codepoint]
			if (mapped != null) return "${if (altPrefix) ESC else ""}${mapped.toChar()}"
			if (altPrefix) {
				return if (LEGACY_TEXT_KEYS.contains(codepoint)) "$ESC${stringOf(codepoint)}" else csiuFallback(event, modes)
			}
			// Kitty's published table leaves ASCII keys outside its control map
			// untouched; a blanket ASCII-and-31 is never applied.
			if (codepoint in 0x20..0x7e) return stringOf(codepoint)
			return csiuFallback(event, modes)
		}

		if (altPrefix && !LEGACY_TEXT_KEYS.contains(codepoint)) return csiuFallback(event, modes)
		val shifted = actualShiftedCodepoint(event)
		if (shift && shifted == null) return csiuFallback(event, modes)
		val text = toText(if (shift) shifted else codepoint) ?: return csiuFallback(event, modes)
		return if (altPrefix) "$ESC$text" else text
	}

	private fun encodeKeypad(event: TerminalKey, modes: TerminalInputModes): String? {
		val codepoint = event.codepoint ?: return null
		if (!isKeypadCodepoint(codepoint)) return null
		if ((modes.kittyFlags and 1) != 0) return csiuFallback(event, modes)
		val modifiers = event.modifiers and LOCK_MASK.inv()
		if (event.eventType != TerminalKeyEventType.PRESS && (modes.kittyFlags and 2) != 0) {
			val navigation = KEYPAD_NAVIGATION[codepoint]
			return if (navigation != null) {
				kittyFunctionalSequence(navigation, modifiers, event.eventType, modes)
			} else {
				csiuFallback(event, modes)
			}
		}
		if (modifiers != 0) {
			val navigation = KEYPAD_NAVIGATION[codepoint]
			if (navigation != null) return kittyFunctionalSequence(navigation, modifiers, event.eventType, modes)
			if (!modes.applicationKeypad) {
				val value = KEYPAD_VALUES[codepoint]
				if (value != null) {
					return encodeKey(
						event.copy(codepoint = value.codePointAt(0), functionKey = null),
						modes,
					)
				}
			}
			return csiuFallback(event, modes)
		}
		if (modes.applicationKeypad) {
			val navigation = KEYPAD_NAVIGATION[codepoint]
			if (navigation != null) return kittyFunctionalSequence(navigation, 0, event.eventType, modes)
			val applicationCode = KEYPAD_APPLICATION_CODES[codepoint] ?: return null
			return "$SS3$applicationCode"
		}
		if (codepoint == 57427) return "${CSI}E"
		val value = KEYPAD_VALUES[codepoint]
		if (value != null) return value
		val navigation = KEYPAD_NAVIGATION[codepoint] ?: return null
		return kittyFunctionalSequence(navigation, 0, event.eventType, modes)
	}

	/* ---------------------------------------------------------------------- *
	 * Routing
	 * ---------------------------------------------------------------------- */

	private fun eventWithNormalizedType(event: TerminalKey, modes: TerminalInputModes): TerminalKey? {
		if (event.eventType == TerminalKeyEventType.RELEASE) {
			if ((modes.kittyFlags and 2) == 0) return null
			// This surface does not advertise Kitty bit 8: Enter, Tab, and
			// Backspace cannot carry release events even with bit 2 enabled.
			val codepoint = event.codepoint
			if (codepoint == 9 || codepoint == 13 || codepoint == 127 || codepoint == 57414) return null
			val modifiedTextKey = codepoint != null &&
				isOrdinaryPrintableKey(codepoint) &&
				(event.modifiers and (ALT or CTRL or SUPER or HYPER or META)) != 0
			if (codepoint != 27 && event.functionKey == null &&
				!isFunctionalPua(codepoint ?: -1) &&
				!modifiedTextKey
			) {
				return null
			}
		}
		if (event.eventType == TerminalKeyEventType.REPEAT && (modes.kittyFlags and 2) == 0) {
			return event.copy(eventType = TerminalKeyEventType.PRESS)
		}
		return event
	}

	private fun isFunctionalPua(codepoint: Int): Boolean = isOfficialFunctionalCodepoint(codepoint)

	private fun encodeKey(eventInput: TerminalKey, modes: TerminalInputModes): String? {
		if (!validModes(modes)) return null
		val event = eventWithNormalizedType(eventInput, modes) ?: return null
		val codepoint = event.codepoint
		val modifiers = event.modifiers and LOCK_MASK.inv()
		val kittyDisambiguation = (modes.kittyFlags and 1) != 0

		if (event.functionKey != null) {
			return kittyFunctionalSequence(event.functionKey, modifiers, event.eventType, modes)
		}
		if (codepoint == null || !isValidKeyboardCodepoint(codepoint)) return null

		if (isKeypadCodepoint(codepoint)) return encodeKeypad(event, modes)
		if (isFunctionalPua(codepoint)) return csiuFallback(event, modes)

		val eventReportingTextKey = event.eventType != TerminalKeyEventType.PRESS &&
			(modes.kittyFlags and 2) != 0 &&
			isOrdinaryPrintableKey(codepoint) &&
			(modifiers and (ALT or CTRL or SUPER or HYPER or META)) != 0
		if (eventReportingTextKey) return csiuFallback(event, modes)

		if (codepoint == 27) {
			if (kittyDisambiguation || modifiers != 0 || event.eventType != TerminalKeyEventType.PRESS) {
				return csiuFallback(event, modes)
			}
			return encodeLegacyControl(event)
		}

		// Preserve legacy C0 bytes by default, but keep modified-key identity for
		// Kitty-disambiguation children and xterm modifyOtherKeys level 2.
		if (!kittyDisambiguation && modes.modifyOtherKeys == 2 && isMokEligible(codepoint) && modifiers != 0) {
			return if ((modifiers and XTERM_MODIFIERS.inv()) == 0) {
				"${CSI}27;${xtermModifierParameter(modifiers)};$codepoint~"
			} else {
				csiuFallback(event, modes)
			}
		}

		if (codepoint == 9 || codepoint == 13 || codepoint == 127) {
			if (modifiers == 0) return encodeLegacyControl(event)
			// In legacy mode only Shift-Tab, Alt-Enter, and Alt-Backspace have
			// unambiguous spellings in the pinned matcher.
			if (kittyDisambiguation) return csiuFallback(event, modes)
			val legacyIdentityIsUnambiguous =
				(codepoint == 9 && modifiers == SHIFT) ||
					(codepoint == 13 && modifiers == ALT) ||
					(codepoint == 127 && modifiers == ALT)
			return if (legacyIdentityIsUnambiguous) encodeLegacyControl(event) else csiuFallback(event, modes)
		}

		if (!isOrdinaryPrintableKey(codepoint)) return null
		val hasKittyTextModifier = (modifiers and (ALT or CTRL or SUPER or HYPER or META)) != 0 ||
			((modifiers and SHIFT) != 0 && (modifiers and CTRL) != 0)
		if (kittyDisambiguation && hasKittyTextModifier) {
			return kittyCodepointSequence(
				codepoint,
				event.modifiers,
				event.eventType,
				modes,
				event.shiftedCodepoint,
				event.baseLayoutCodepoint,
			)
		}

		if (!kittyDisambiguation && modes.modifyOtherKeys == 1 && isMokEligible(codepoint)) {
			if ((modifiers and XTERM_MODIFIERS.inv()) != 0) return csiuFallback(event, modes)
			val legacyAltPrefix = if ((modifiers and (ALT or META)) != 0) ESC else ""
			val ctrlSpaceException = codepoint == 32 && (modifiers and CTRL) != 0
			val ctrlThreeException = codepoint == 51 && (modifiers and CTRL) != 0
			val specialException = codepoint == 9 || codepoint == 127
			val mok1Modifiers = modifiers and (SHIFT or CTRL)
			val onlyLevelOneModifiers = (modifiers and (SHIFT or CTRL).inv()) == 0
			if (ctrlSpaceException) return "$legacyAltPrefix\u0000"
			if (ctrlThreeException && (modifiers and SHIFT) == 0) return "$legacyAltPrefix$ESC"
			if (!specialException && mok1Modifiers != 0 && onlyLevelOneModifiers) {
				return "${CSI}27;${1 + modifiers};$codepoint~"
			}
		}

		return encodeLegacyText(event, modes)
	}

	private fun validModes(modes: TerminalInputModes): Boolean =
		modes.kittyFlags in 0..7 && modes.modifyOtherKeys in 0..2
}
