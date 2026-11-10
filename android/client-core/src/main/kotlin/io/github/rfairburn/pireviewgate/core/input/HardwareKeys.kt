package io.github.rfairburn.pireviewgate.core.input

/**
 * A physical keystroke reduced to the facts a platform key event supplies.
 *
 * Keeping the translation off the platform object is what makes the interesting
 * cases testable: the character a key produces belongs to the user's active key
 * map, not to the key code, so a suite can present a Cyrillic, Greek, or
 * dead-key-folded event without a device.
 */
data class HardwareKeyFacts(
	/**
	 * Layout-resolved identities for this press, most authoritative first.
	 *
	 * A platform reports the character the key produced with the modifiers it saw,
	 * which for a held Ctrl is usually the folded control byte rather than the
	 * letter. Later candidates come from the same key map with fewer modifiers
	 * applied, which is the identity the packet needs alongside a modifier mask.
	 */
	val unicodeCandidates: List<Int>,

	/** The character the same key produces with shift applied, when it has one. */
	val shiftedUnicode: Int? = null,

	/** [KeyboardModifiers] bits, lock state included. */
	val modifiers: Int = 0,

	val eventType: TerminalKeyEventType = TerminalKeyEventType.PRESS,

	/**
	 * The key's identity on the base layout, when the platform can name one.
	 *
	 * This is metadata, never the character to send: it is what lets a refusal such
	 * as Ctrl+Z stay a refusal on a layout where the key reads as something else.
	 */
	val baseLayoutCodepoint: Int? = null,
)

/**
 * Turning a modified physical key into a canonical keystroke.
 *
 * Only keys carrying Ctrl, Alt, Meta, or Super are translated here. An unmodified
 * printable key stays with the input method, which owns composition, dead keys, and
 * Unicode entry; a modified one has control meaning that the text path would lose.
 *
 * The identity always comes from the active key map, so a Cyrillic or Greek layout
 * yields its own letter and a shifted symbol keeps the alternate the map offers.
 * When no candidate is a typeable scalar — a dead key, a bare control byte — the
 * event is declined rather than turned into digits or a guess.
 */
object HardwareKeys {
	/** The modifier bits that make a printable key worth translating here. */
	const val CONTROL_BEARING_MASK =
		KeyboardModifiers.CTRL or KeyboardModifiers.ALT or KeyboardModifiers.META or KeyboardModifiers.SUPER

	/**
	 * The facts a key press supplies, from the key map's two answers.
	 *
	 * [unmodifiedUnicodeChar] is what the key produces with no modifiers applied,
	 * and that is the canonical identity. [shiftedUnicodeChar] is what it produces
	 * with shift applied, kept as the alternate. The event's own value folds the
	 * modifiers that were actually held, so it is never the identity: taking it
	 * would turn Ctrl+Shift+/ into a "?" keystroke instead of a "/" with a "?"
	 * alternate, and Ctrl+Shift+J into an uppercase letter instead of Ctrl+Shift on
	 * the letter J.
	 */
	fun facts(
		unmodifiedUnicodeChar: Int,
		shiftedUnicodeChar: Int,
		modifiers: Int,
		eventType: TerminalKeyEventType,
		baseLayoutCodepoint: Int?,
	): HardwareKeyFacts = HardwareKeyFacts(
		unicodeCandidates = listOf(unmodifiedUnicodeChar),
		shiftedUnicode = shiftedUnicodeChar,
		modifiers = modifiers,
		eventType = eventType,
		baseLayoutCodepoint = baseLayoutCodepoint,
	)

	/** The canonical keystroke, or null when this event is not this adapter's to handle. */
	fun printableKey(facts: HardwareKeyFacts): TerminalKey? {
		// Lock bits travel with the event: the encoder decides what they mean to the
		// letter's identity, and this adapter does not pre-empt that.
		val modifiers = facts.modifiers
		if (modifiers and CONTROL_BEARING_MASK == 0) return null
		val base = facts.unicodeCandidates.firstOrNull { KeyboardEncoder.isForwardableTextScalar(it) }
			?: return null
		val shifted = if ((modifiers and KeyboardModifiers.SHIFT) != 0) {
			facts.shiftedUnicode?.takeIf {
				KeyboardEncoder.isForwardableTextScalar(it) && it != base
			}
		} else {
			null
		}
		return TerminalKey(
			codepoint = base,
			modifiers = modifiers,
			eventType = facts.eventType,
			shiftedCodepoint = shifted,
			baseLayoutCodepoint = facts.baseLayoutCodepoint,
		)
	}
}
