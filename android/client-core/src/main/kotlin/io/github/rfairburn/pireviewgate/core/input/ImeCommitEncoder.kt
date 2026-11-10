package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes

/**
 * One input-method commit, or one repeated editing key, turned into the packets it
 * means — as a whole batch, or not at all.
 *
 * A commit is one user action even when it carries several codepoints, so the
 * batch is atomic: if any part of it has no spelling this child can be given, the
 * whole commit is refused. Delivering the representable prefix would leave the
 * child holding half of what the user typed with no way for anyone to tell, which
 * is a worse outcome than sending nothing and saying so.
 *
 * Two encodings are in play, and the choice belongs to the owner's translation,
 * not to a device:
 *  - with no modifier held, text leaves as text — exactly [KeyboardEncoder.encodeTypedText],
 *    because the input method owns dead keys, compose sequences, and Unicode entry,
 *    and the child expects UTF-8 for that;
 *  - with a modifier held, that meaning has to survive, so every Unicode scalar
 *    leaves as its own keystroke encoded by [KeyboardEncoder.encode]. A batch is
 *    built by codepoint, never by UTF-16 unit, so a supplementary character is one
 *    keystroke and a surrogate half never is.
 *
 * An embedded newline is the Enter keystroke either way, never a bare line feed:
 * Enter, Ctrl+Enter, and Shift+Enter stay distinguishable the way the owner's own
 * translation keeps them.
 *
 * Paste is not this encoder's business, and latched modifier chips never reach it:
 * an explicit paste is the text the user chose, and [PasteEncoder] owns it.
 */
object ImeCommitEncoder {
	private const val ENTER_CODEPOINT = 13
	private const val BACKSPACE_CODEPOINT = 127
	private const val NEWLINE = '\n'

	/**
	 * The most Unicode scalars one commit, or one repeated keystroke batch, may carry.
	 *
	 * A commit is a user action, and a user action is short. Text larger than this is
	 * a bulk payload, and the owner already has a path for bulk text with its own
	 * bound: an explicit paste. Holding the ceiling here is what keeps one commit from
	 * allocating an unbounded packet list and driving an unbounded number of listener
	 * calls on the UI thread.
	 */
	const val MAX_COMMIT_CODEPOINTS: Int = 4096

	/**
	 * The most deletions one editing request may ask for.
	 *
	 * A backspace is the one editing key an input method can ask for many of at once,
	 * and a request far beyond what a person can press is not an edit. The ceiling
	 * lives here so it is one rule rather than a clamp each caller invents: a request
	 * above it encodes to nothing. A caller that wants to say why checks this constant
	 * itself before reporting.
	 */
	const val MAX_DELETION_REQUEST: Int = 32

	/**
	 * True when [text] carries more than one commit may.
	 *
	 * A caller checks this to refuse truthfully and in advance: an oversized commit is
	 * never truncated and never delivered as a prefix.
	 */
	fun isOversized(text: String): Boolean = text.codePointCount(0, text.length) > MAX_COMMIT_CODEPOINTS

	/**
	 * The packets for one committed [text] with [modifiers] held, in order, or null
	 * when any part of it cannot be spelled for this child.
	 *
	 * Malformed UTF-16 is refused outright. A lone surrogate would otherwise be turned
	 * into a replacement character on the wire, which is a silent rewrite of what the
	 * user committed.
	 */
	fun encode(text: String, modifiers: Int, modes: TerminalInputModes): List<ByteArray>? {
		if (text.isEmpty()) return null
		if (!isWellFormed(text)) return null
		if (isOversized(text)) return null
		val packets = ArrayList<ByteArray>()
		var index = 0
		while (index < text.length) {
			val newline = text.indexOf(NEWLINE, index)
			val run = if (newline < 0) text.substring(index) else text.substring(index, newline)
			if (!appendRun(packets, run, modifiers, modes)) return null
			if (newline < 0) break
			if (!appendKey(packets, ENTER_CODEPOINT, modifiers, modes)) return null
			index = newline + 1
		}
		return packets.ifEmpty { null }
	}

	/** The packet for one Enter press with [modifiers] held, or null when it has no spelling. */
	fun encodeEnter(modifiers: Int, modes: TerminalInputModes): ByteArray? =
		encodeKey(ENTER_CODEPOINT, modifiers, modes)

	/**
	 * [count] backspaces with [modifiers] held, or null when the request is above
	 * [MAX_DELETION_REQUEST] or the keystroke has no spelling — in which case none of
	 * them are sent rather than some.
	 */
	fun encodeBackspaces(count: Int, modifiers: Int, modes: TerminalInputModes): List<ByteArray>? {
		if (count <= 0 || count > MAX_DELETION_REQUEST) return null
		val packet = encodeKey(BACKSPACE_CODEPOINT, modifiers, modes) ?: return null
		return List(count) { packet }
	}

	private fun appendRun(packets: MutableList<ByteArray>, run: String, modifiers: Int, modes: TerminalInputModes): Boolean {
		if (run.isEmpty()) return true
		if (modifiers == 0) {
			val text = KeyboardEncoder.encodeTypedText(run) ?: return false
			packets += text
			return true
		}
		var index = 0
		while (index < run.length) {
			val codepoint = run.codePointAt(index)
			// A committed scalar that happens to be one of the encoder's reserved
			// functional identities is not the keystroke that number names: the glyph the
			// user committed and the key the packet would press are different things, and
			// answering with the key would be a translation nobody asked for. Refuse the
			// whole commit instead. With no chip held this scalar leaves as text, which is
			// what it is.
			if (KeyboardEncoder.isReservedFunctionalCodepoint(codepoint)) return false
			if (!appendKey(packets, codepoint, modifiers, modes)) return false
			index += Character.charCount(codepoint)
		}
		return true
	}

	private fun appendKey(packets: MutableList<ByteArray>, codepoint: Int, modifiers: Int, modes: TerminalInputModes): Boolean {
		val packet = encodeKey(codepoint, modifiers, modes) ?: return false
		packets += packet
		return true
	}

	/**
	 * True when [text] is a well-formed sequence of Unicode scalars.
	 *
	 * A lone surrogate is refused rather than encoded: UTF-8 conversion turns it into a
	 * replacement character, which would send something other than what the user
	 * committed. Supplementary characters, which are exactly one high followed by one
	 * low surrogate, are well formed and pass.
	 */
	private fun isWellFormed(text: String): Boolean {
		var index = 0
		while (index < text.length) {
			val unit = text[index]
			when {
				unit.isHighSurrogate() -> {
					if (index + 1 >= text.length || !text[index + 1].isLowSurrogate()) return false
					index += 2
				}
				unit.isLowSurrogate() -> return false
				else -> index += 1
			}
		}
		return true
	}

	private fun encodeKey(codepoint: Int, modifiers: Int, modes: TerminalInputModes): ByteArray? =
		KeyboardEncoder.encode(TerminalKey(codepoint = codepoint, modifiers = modifiers), modes)
}
