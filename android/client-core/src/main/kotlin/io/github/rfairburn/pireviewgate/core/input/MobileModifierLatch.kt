package io.github.rfairburn.pireviewgate.core.input

/**
 * Which modifier chips the phone's root screen is holding down right now.
 *
 * A soft keyboard has no Ctrl key and no Alt key, so a native terminal screen
 * offers them as chips: the user taps Ctrl, then taps a letter, and the letter is
 * meant to arrive as Ctrl+letter. The chips are not keystrokes, so they cannot
 * travel through the platform's key event modifiers; they are held here and
 * folded into the keystroke at encoding time by [KeyboardEncoder].
 *
 * The latch is deliberately narrow:
 *  - only the bits in [SUPPORTED] can be held, so a chip cannot latch something
 *    the phone has no way to represent;
 *  - it never touches paste. An explicit paste is the text the user chose, and
 *    latched chips do not rewrite it;
 *  - [clear] is how a target change retires the chips, so a Ctrl meant for one
 *    session cannot arrive at the next one after a switch, a backgrounding, or a
 *    modal.
 *
 * This is state, not a decision: whether a keystroke may be sent at all stays with
 * the surface's committed-frame fence and the caller's own gates.
 */
class MobileModifierLatch {
	/** The [KeyboardModifiers] bits currently held; always a subset of [SUPPORTED]. */
	var modifiers: Int = 0
		private set

	/** True when nothing is held, which is when typed text leaves as plain text. */
	val isPlain: Boolean
		get() = modifiers == 0

	/**
	 * Hold exactly [modifiers].
	 *
	 * False, with the state untouched, when the request names a bit the phone does
	 * not offer: a partial latch would be worse than a refused one, because the
	 * user would see a chip lit that is not doing what it says.
	 */
	fun set(modifiers: Int): Boolean {
		if (modifiers and SUPPORTED.inv() != 0) return false
		this.modifiers = modifiers
		return true
	}

	/** Flip [bits] on or off. False, with the state untouched, for an unsupported bit. */
	fun toggle(bits: Int): Boolean {
		if (bits == 0 || bits and SUPPORTED.inv() != 0) return false
		modifiers = modifiers xor bits
		return true
	}

	/**
	 * Let go of every chip.
	 *
	 * True when something was actually held, so a caller only reports a change the
	 * user could see.
	 */
	fun clear(): Boolean {
		val wasHeld = modifiers != 0
		modifiers = 0
		return wasHeld
	}

	/**
	 * The modifier mask a keystroke carries once the held chips are folded in.
	 *
	 * A keystroke the input method forwards — Enter or Backspace as a key event, say —
	 * arrives with the platform's own modifier bits, which know nothing about the
	 * chips. Folding keeps both sources of meaning together, so the same editing key
	 * cannot mean one thing through the text path and another through a forwarded key
	 * event. Lock bits and everything else the event already carries are untouched.
	 */
	fun fold(eventModifiers: Int): Int = modifiers or eventModifiers

	companion object {
		/** The chips a phone screen may hold: Ctrl, Alt, and Shift, and nothing else. */
		const val SUPPORTED: Int = KeyboardModifiers.CTRL or KeyboardModifiers.ALT or KeyboardModifiers.SHIFT
	}
}
