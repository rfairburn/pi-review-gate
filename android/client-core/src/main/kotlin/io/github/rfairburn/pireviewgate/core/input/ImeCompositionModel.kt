package io.github.rfairburn.pireviewgate.core.input

/**
 * What an input method's composition means to a surface that holds no text.
 *
 * The phone does not own a buffer, so a composition is local state whose only
 * job is to keep uncommitted text from being sent and to keep an input method's
 * edits from being mistaken for keystrokes into the owner's screen:
 *
 *  - `commitText` *replaces* the composing region. The composing text was never
 *    sent, so it is discarded and only the committed replacement leaves;
 *  - finishing a composition means the input method kept the text, so it is sent
 *    once;
 *  - a deletion around the cursor consumes the local composition first. Only
 *    what is left over after the composition is empty can be a real backspace
 *    into the owner's screen;
 *  - a stale or closed connection drops the composition outright: the user never
 *    committed it, and latent text must not reach a newer frame.
 *
 * What is retained is bounded by what one commit may carry: composition storage is
 * not a scratch buffer, and an input method that keeps pushing text into it is not
 * composing. Refusing to retain more is the honest answer, and it is what keeps an
 * oversized burst from becoming an oversized packet batch later.
 */
class ImeCompositionModel {
	private val composing = StringBuilder()

	/** The text the input method is still composing. */
	val composingText: String
		get() = composing.toString()

	/** True while something is being composed. */
	val hasComposition: Boolean
		get() = composing.isNotEmpty()

	/**
	 * Replace the local composition. Nothing leaves the surface.
	 *
	 * False when [text] is more than one commit could carry, in which case nothing is
	 * retained — the previous composition is dropped either way, so no text the user
	 * never committed can arrive later. The caller reports the refusal; nothing is
	 * silently truncated to fit.
	 */
	fun setComposing(text: String?): Boolean {
		composing.setLength(0)
		if (text.isNullOrEmpty()) return true
		if (text.codePointCount(0, text.length) > MAX_COMPOSING_CODEPOINTS) return false
		composing.append(text)
		return true
	}

	/**
	 * The input method committed [committed], replacing whatever it was
	 * composing. Returns the text to send — the committed text alone.
	 */
	fun commit(committed: String): String {
		composing.setLength(0)
		return committed
	}

	/**
	 * The input method finished with its composition and kept the text. Returns
	 * the text to send, or an empty string when there was nothing pending.
	 */
	fun finishComposition(): String {
		val pending = composing.toString()
		composing.setLength(0)
		return pending
	}

	/**
	 * The input method asked to delete [beforeLength] cells before the cursor and
	 * [afterLength] after it. Returns how many of those are real backspaces for
	 * the owner's screen, after the local composition absorbs what it can.
	 * Forward deletion has no meaning here: the phone does not hold a cursor.
	 */
	fun deleteSurrounding(beforeLength: Int, afterLength: Int): Int {
		if (beforeLength <= 0) return 0
		val consumed = minOf(beforeLength, composing.length)
		// The cut is counted in UTF-16 units, but a supplementary character is two of
		// them. A boundary that bisects a pair takes the whole scalar with it: leaving a
		// lone high surrogate behind would corrupt the rest of the composition, and the
		// text that survives was never sent anyway, so no extra host deletion is owed.
		var kept = composing.length - consumed
		if (kept > 0 && kept < composing.length &&
			composing[kept - 1].isHighSurrogate() && composing[kept].isLowSurrogate()
		) {
			kept -= 1
		}
		composing.setLength(kept)
		return beforeLength - consumed
	}

	/**
	 * Like [deleteSurrounding], but [beforeLength] counts Unicode code points rather
	 * than UTF-16 units. Forward deletion is still ignored, and only the remainder
	 * after consuming the composition is owed to the owner's screen.
	 */
	fun deleteSurroundingInCodePoints(beforeLength: Int, afterLength: Int): Int {
		if (beforeLength <= 0) return 0
		val consumed = minOf(beforeLength, composing.codePointCount(0, composing.length))
		val kept = composing.offsetByCodePoints(composing.length, -consumed)
		composing.setLength(kept)
		return beforeLength - consumed
	}

	/** Drop any pending composition without sending it. */
	fun discard() {
		composing.setLength(0)
	}

	companion object {
		/**
		 * The most Unicode scalars a composition may retain.
		 *
		 * It is the commit ceiling on purpose: whatever is held here has to be
		 * committable, so the two bounds can never disagree.
		 */
		const val MAX_COMPOSING_CODEPOINTS: Int = ImeCommitEncoder.MAX_COMMIT_CODEPOINTS
	}
}
