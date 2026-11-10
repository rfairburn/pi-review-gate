package io.github.rfairburn.pireviewgate.core.input

/**
 * What one input-method connection has typed, so the input method can read it back
 * and correct the current word instead of retyping it.
 *
 * The phone still owns no buffer. The ledger only remembers text this connection itself
 * handed off. That is an assumption about the remote line, not a fact the owner confirmed:
 * a refusal, a key the ledger did not produce, or a shell that rewrote the line can all make
 * it wrong. So the ledger keeps three parts apart and never claims more than it handed off:
 *
 *  - [knownText] (K): text this connection submitted since its context last started over.
 *    It is believed to sit just before the remote cursor.
 *  - [composingText] (C): the input method's composition. It is local and was never sent,
 *    and [ImeCompositionModel] holds it with the same rules as before.
 *  - [remarkedLength] (S): how many trailing UTF-16 units of K the composition re-marks.
 *    A re-marked word was already sent. Committing a correction to it sends only the
 *    changed suffix: backspaces for the code points that differ, then the new text.
 *
 * The input method sees the document `K[0, K.length - S) + C` with the cursor at its end,
 * starting at the logical offset [base]. Every write turns into one plan: how many
 * backspaces to send, then which text, and the state that holds once that has left. Text
 * that never left the phone is never deleted remotely, and nothing is invented. There is
 * no Space, no Enter, no cursor key, and no retyping of an earlier word. A range that does
 * not end at the cursor, starts before the known text, or splits a surrogate pair is not
 * supported, and it changes nothing.
 *
 * The context is recent and bounded. At most [MAX_CONTEXT_CODEPOINTS] are kept. Trimming
 * the oldest text moves [base] forward, so the offsets the input method was given stay
 * valid. That is a retention bound only. It never refuses input and never caps a commit.
 * [floor] forgets the context, for example after a key or paste the ledger did not
 * produce. It keeps a composition that was never sent. It drops one that re-marks
 * text already sent, since that text can then be neither deleted nor retyped safely.
 *
 * Not thread-safe: one connection drives it from the UI thread.
 */
class ImeEditLedger {
	private val composition = ImeCompositionModel()
	private val known = StringBuilder()

	/** Document index where the composition starts. Meaningful only while composing. */
	private var composeStart = 0

	/** Document index of a selection start that ends at the cursor, or -1 when collapsed. */
	private var selectionStart = -1

	/** The logical editor offset of document index 0. */
	var base: Int = 0
		private set

	/**
	 * Advances whenever the context starts over. A plan made, or a refusal reported,
	 * under an older generation no longer describes this context.
	 */
	var generation: Long = 0
		private set

	/** Text this connection submitted since the context last started over (K). */
	val knownText: String
		get() = known.toString()

	/** The local composition, never sent (C). */
	val composingText: String
		get() = composition.composingText

	/** True while the input method is composing. */
	val hasComposition: Boolean
		get() = composition.hasComposition

	/** Trailing UTF-16 units of [knownText] that the composition re-marks (S). */
	val remarkedLength: Int
		get() = if (hasComposition) known.length - composeStart else 0

	/** What the input method may read: `K[0, K.length - S) + C`. */
	val document: String
		get() = if (hasComposition) known.substring(0, composeStart) + composition.composingText else known.toString()

	private val documentLength: Int
		get() = if (hasComposition) composeStart + composition.composingText.length else known.length

	private val cursorIndex: Int
		get() = if (selectionStart >= 0) selectionStart else documentLength

	/** The logical selection start. Equal to [selectionEnd] when collapsed. */
	val selectionStartOffset: Int
		get() = base + cursorIndex

	/** The logical selection end, which is always the cursor at the end of the document. */
	val selectionEnd: Int
		get() = base + documentLength

	/** The logical composition start, or -1. */
	val compositionStart: Int
		get() = if (hasComposition) base + composeStart else -1

	/** The logical composition end, or -1. */
	val compositionEnd: Int
		get() = if (hasComposition) base + documentLength else -1

	/** The document index of the selection start, for caps-mode queries. */
	val cursorDocumentIndex: Int
		get() = cursorIndex

	/* ---------------------------------------------------------------- *
	 * Readers
	 * ---------------------------------------------------------------- */

	/** Up to [length] UTF-16 units before the selection start, never starting mid-pair. */
	fun textBeforeCursor(length: Int): String {
		val doc = document
		val end = cursorIndex
		var start = (end - length.coerceAtLeast(0)).coerceAtLeast(0)
		if (start in 1 until end && doc[start].isLowSurrogate() && doc[start - 1].isHighSurrogate()) start += 1
		return doc.substring(start, end)
	}

	/** The selected text, or null when the selection is collapsed. */
	fun selectedText(): String? {
		if (selectionStart < 0) return null
		return document.substring(selectionStart, documentLength)
	}

	/**
	 * The text around the selection: up to [beforeLength] units before it, the selection,
	 * and nothing after, since the cursor is always at the end. Returns that text and its
	 * document start index.
	 */
	fun surroundingText(beforeLength: Int): Pair<String, Int> {
		val doc = document
		val selection = cursorIndex
		var start = (selection - beforeLength.coerceAtLeast(0)).coerceAtLeast(0)
		if (start in 1 until selection && doc[start].isLowSurrogate() && doc[start - 1].isHighSurrogate()) start += 1
		return doc.substring(start) to start
	}

	/* ---------------------------------------------------------------- *
	 * Writers. Each returns a plan, and nothing changes until [apply].
	 * ---------------------------------------------------------------- */

	/**
	 * The input method committed [text], replacing the composition or the selection.
	 *
	 * Null when [text] itself is more than one commit may carry
	 * ([ImeCommitEncoder.isOversized]). The commit ceiling applies to what the input method
	 * supplied, not only to the changed suffix that would leave, so a long replacement that
	 * shares a long known prefix is still refused whole. As before, the composition is
	 * dropped and nothing is sent.
	 */
	fun commitText(text: String): ImeEditPlan? {
		if (ImeCommitEncoder.isOversized(text)) {
			dropComposition()
			return null
		}
		val doc = document
		return plan(doc.substring(0, replaceStart()) + text, -1)
	}

	/**
	 * The input method composes [text] over the composition or the selection.
	 *
	 * Null when [text] is larger than one commit may carry. The composition is dropped
	 * then, exactly as before, and nothing is truncated to fit.
	 */
	fun setComposingText(text: String): ImeEditPlan? {
		if (text.codePointCount(0, text.length) > ImeCompositionModel.MAX_COMPOSING_CODEPOINTS) {
			dropComposition()
			return null
		}
		val start = replaceStart()
		val prefix = document.substring(0, start)
		return if (text.isEmpty()) plan(prefix, -1) else plan(prefix + text, start)
	}

	/** The input method kept its composition. Unsent composing text is sent once. */
	fun finishComposingText(): ImeEditPlan {
		if (!hasComposition) return ImeEditPlan.none(generation)
		return plan(document, -1)
	}

	/**
	 * Re-mark [start, end) as the composition, or null when the range is not supported.
	 *
	 * An empty range finishes the composition, as the platform's own editor does. A
	 * supported range ends at the cursor, starts at or after [base], does not split a
	 * surrogate pair, and fits in one commit. Re-marking text that was already sent sends
	 * nothing.
	 */
	fun setComposingRegion(start: Int, end: Int): ImeEditPlan? {
		val from = minOf(start, end)
		val to = maxOf(start, end)
		if (from == to) return finishComposingText()
		val doc = document
		val index = tailRangeStart(doc, from, to) ?: return null
		val region = doc.substring(index)
		if (region.codePointCount(0, region.length) > ImeCompositionModel.MAX_COMPOSING_CODEPOINTS) return null
		return plan(doc, index)
	}

	/**
	 * Replace [start, end) with [text] and finish any composition, or null when the range
	 * is not supported or [text] is more than one commit may carry. A supported range ends
	 * at the cursor (see [setComposingRegion]). A refusal changes nothing.
	 */
	fun replaceText(start: Int, end: Int, text: String): ImeEditPlan? {
		if (ImeCommitEncoder.isOversized(text)) return null
		val doc = document
		val index = tailRangeStart(doc, minOf(start, end), maxOf(start, end)) ?: return null
		return plan(doc.substring(0, index) + text, -1)
	}

	/**
	 * Select [start, end). Only a collapsed cursor at the end, or a selection that ends at
	 * the cursor while nothing is composed, is supported. Returns false and changes nothing
	 * otherwise. Nothing is ever sent for a selection.
	 */
	fun setSelection(start: Int, end: Int): Boolean {
		val from = minOf(start, end)
		val to = maxOf(start, end)
		val doc = document
		if (from == to && to.toLong() - base == doc.length.toLong()) {
			selectionStart = -1
			return true
		}
		if (hasComposition) return false
		val index = tailRangeStart(doc, from, to) ?: return false
		selectionStart = if (index == doc.length) -1 else index
		return true
	}

	/**
	 * Delete [count] before the cursor, counted in UTF-16 units or, with [inCodePoints],
	 * in code points.
	 *
	 * The composition absorbs the deletion first, by exactly the rules of
	 * [ImeCompositionModel], and that alone never sends anything. What is left deletes known
	 * text: one backspace per code point, however many UTF-16 units it takes. A cut through
	 * a surrogate pair takes the whole character, as the composition does. Anything beyond
	 * the known text passes through unchanged as before: that many backspaces for text the
	 * ledger never knew.
	 *
	 * When the composition absorbs the whole deletion but no longer covers as much of the
	 * re-marked tail of K as it did, the code points this deletion took out of that tail were
	 * already sent. They leave now, one backspace each, so the deletion cannot be lost when
	 * the composition later ends without a commit. Never more than this one deletion removed,
	 * and never a composition's own UTF-16 length read as an offset into K: a candidate that
	 * changed the composition's scalar widths keeps its own debt deferred, and deleting only
	 * what the composition had grown past the sent tail still sends nothing.
	 * A deletion that reaches past such a composition answers the same way: what leaves is
	 * this request's own share — the composition's code points, the known prefix it consumed,
	 * and the remainder the ledger never knew — and the rest of K stays believed sent.
	 *
	 * Null while a selection is active. The platform deletes before the selection start,
	 * not at the cursor, and reaching that text would mean deleting the selection remotely
	 * and retyping it. That is not supported, so nothing changes and the selection stays.
	 */
	fun deleteBefore(count: Int, inCodePoints: Boolean): ImeEditPlan? {
		if (count <= 0) return ImeEditPlan.none(generation)
		if (selectionStart >= 0) return null
		val wasComposing = hasComposition
		val prefixEnd = if (wasComposing) composeStart else known.length
		val composingBefore = composition.composingText
		val composingPointsBefore = composingBefore.codePointCount(0, composingBefore.length)
		val remainder = if (inCodePoints) {
			composition.deleteSurroundingInCodePoints(count, 0)
		} else {
			composition.deleteSurrounding(count, 0)
		}
		if (remainder <= 0) {
			val doc = known.substring(0, prefixEnd) + composition.composingText
			val start = if (composition.hasComposition) prefixEnd else -1
			return plan(doc, start, composingPointsBefore = composingPointsBefore)
		}
		val prefix = known.substring(0, prefixEnd)
		val keptPrefix: String
		val unknown: Int
		if (inCodePoints) {
			val points = prefix.codePointCount(0, prefix.length)
			if (remainder <= points) {
				keptPrefix = prefix.substring(0, prefix.offsetByCodePoints(prefix.length, -remainder))
				unknown = 0
			} else {
				keptPrefix = ""
				unknown = remainder - points
			}
		} else if (remainder <= prefix.length) {
			var keep = prefix.length - remainder
			if (splitsPair(prefix, keep)) keep -= 1
			keptPrefix = prefix.substring(0, keep)
			unknown = 0
		} else {
			keptPrefix = ""
			unknown = remainder - prefix.length
		}
		val current = known.toString()
		if (wasComposing &&
			composingPointsBefore < current.codePointCount(prefixEnd, current.length)
		) {
			// Consume this request, not the candidate's earlier deferred deletion.
			val deletions = (composingPointsBefore.toLong() +
				prefix.codePointCount(keptPrefix.length, prefix.length) + unknown)
				.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
			val knownPoints = current.codePointCount(0, current.length)
			val keep = current.offsetByCodePoints(current.length, -minOf(deletions, knownPoints))
			return ImeEditPlan(
				deletions = deletions,
				text = "",
				known = current.substring(0, keep),
				composeStart = 0,
				composing = "",
				unknownDeletions = (deletions - knownPoints).coerceAtLeast(0),
				generation = generation,
				noChange = false,
			)
		}
		return plan(keptPrefix, -1, unknown)
	}

	/* ---------------------------------------------------------------- *
	 * State changes
	 * ---------------------------------------------------------------- */

	/**
	 * Adopt [plan] once everything it sends has been handed off. False, with nothing
	 * changed, when the context started over after the plan was made.
	 */
	fun apply(plan: ImeEditPlan): Boolean {
		if (plan.generation != generation) return false
		if (plan.noChange) return true
		known.setLength(0)
		known.append(plan.known)
		base = (base.toLong() - plan.unknownDeletions).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()
		composition.setComposing(plan.composing)
		composeStart = if (composition.hasComposition) plan.composeStart else 0
		selectionStart = -1
		normalize()
		return true
	}

	/**
	 * Drop the composition without sending it. Text already sent stays known, so the
	 * document becomes [knownText] again.
	 */
	fun dropComposition() {
		composition.discard()
		composeStart = 0
		selectionStart = -1
	}

	/**
	 * Forget the known context. Use this after anything the ledger did not produce left,
	 * or anything it produced was refused. [generation] advances.
	 *
	 * A composition that was never sent stays local and unsent, at the same offsets. A
	 * composition that re-marks text already sent is dropped. Without the context, that
	 * text can be neither deleted nor retyped safely: deleting it might hit text that is
	 * not there, and retyping it would duplicate it. So nothing more is sent for it.
	 */
	fun floor() {
		if (remarkedLength > 0) {
			composition.discard()
			composeStart = 0
		}
		val shift = if (hasComposition) composeStart else known.length
		base = (base.toLong() + shift).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
		known.setLength(0)
		composeStart = 0
		selectionStart = -1
		generation += 1
	}

	/**
	 * One plain backspace left outside a plan, for example a key the input method
	 * forwarded. Only valid with nothing composed. It removes the last known code point,
	 * or moves the start back when nothing is known.
	 */
	fun forwardedBackspace() {
		selectionStart = -1
		if (hasComposition) {
			floor()
			return
		}
		if (known.isEmpty()) {
			if (base > 0) base -= 1
			return
		}
		known.setLength(known.offsetByCodePoints(known.length, -1))
	}

	/** Forget everything, composition included. The connection is going away. */
	fun discard() {
		composition.discard()
		known.setLength(0)
		composeStart = 0
		selectionStart = -1
		generation += 1
	}

	/* ---------------------------------------------------------------- *
	 * Internals
	 * ---------------------------------------------------------------- */

	private fun replaceStart(): Int = when {
		hasComposition -> composeStart
		selectionStart >= 0 -> selectionStart
		else -> known.length
	}

	/** The document index of [from], when [from, to) is a supported range ending at the cursor. */
	private fun tailRangeStart(doc: String, from: Int, to: Int): Int? {
		if (to.toLong() - base != doc.length.toLong()) return null
		val index = from.toLong() - base
		if (index < 0 || index > doc.length) return null
		if (splitsPair(doc, index.toInt())) return null
		return index.toInt()
	}

	/**
	 * The minimal changed suffix that turns K into [newDocument], keeping the composition
	 * that starts at [newComposeStart] (or -1) local.
	 *
	 * When K already begins with everything outside the new composition, nothing is sent
	 * and the composition re-marks the rest of K. Otherwise the shared code-point prefix
	 * stays, every later known code point gets one backspace, and the rest of the target
	 * is typed. [unknownDeletions] backspaces for text before K are added unchanged.
	 *
	 * [composingPointsBefore] is the composition's code-point count as an explicit deletion
	 * found it, and only [deleteBefore] supplies it: every other writer, including a candidate
	 * replacement, passes -1 and keeps deferring exactly as before. When that deletion left the
	 * composition covering fewer of the re-marked tail's code points than it covered before,
	 * the difference was already sent and leaves now, one backspace each, so the keystroke
	 * cannot be lost when the composition later ends without a commit. It is never more than
	 * this deletion removed, and the mapping goes through K's own code-point boundaries rather
	 * than reading the composition's UTF-16 length as an offset into K, so a candidate that
	 * changed the composition's scalar widths is neither over-deleted nor split across a
	 * surrogate pair, and that candidate's own change stays deferred. A deletion that empties
	 * the composition is answered the same way rather than by the whole-tail diff below:
	 * what leaves is still only this keystroke's share, and the rest of K stays believed sent.
	 */
	private fun plan(
		newDocument: String,
		newComposeStart: Int,
		unknownDeletions: Int = 0,
		composingPointsBefore: Int = -1,
	): ImeEditPlan {
		val committed = if (newComposeStart < 0) newDocument else newDocument.substring(0, newComposeStart)
		val composing = if (newComposeStart < 0) "" else newDocument.substring(newComposeStart)
		val current = known.toString()
		if (unknownDeletions == 0 &&
			(composing.isNotEmpty() || composingPointsBefore >= 0) && current.startsWith(committed)
		) {
			if (composingPointsBefore >= 0) {
				val sentTailPoints = current.codePointCount(committed.length, current.length)
				val coveredBefore = minOf(composingPointsBefore, sentTailPoints)
				val coveredNow = minOf(composing.codePointCount(0, composing.length), sentTailPoints)
				val fallenOut = coveredBefore - coveredNow
				if (fallenOut > 0) {
					val keep = current.offsetByCodePoints(current.length, -fallenOut)
					return ImeEditPlan(
						deletions = fallenOut,
						text = "",
						known = current.substring(0, keep),
						composeStart = committed.length,
						composing = composing,
						unknownDeletions = 0,
						generation = generation,
						noChange = false,
					)
				}
			}
			return ImeEditPlan(0, "", current, committed.length, composing, 0, generation, noChange = false)
		}
		val shared = commonPrefix(current, committed)
		val deletions = (current.codePointCount(shared, current.length).toLong() + unknownDeletions)
			.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
		return ImeEditPlan(
			deletions = deletions,
			text = committed.substring(shared),
			known = committed,
			composeStart = committed.length,
			composing = composing,
			unknownDeletions = unknownDeletions,
			generation = generation,
			noChange = false,
		)
	}

	/** Cut K after its last control character, then bound it to the recent context. */
	private fun normalize() {
		var cut = -1
		for (index in known.indices.reversed()) {
			val unit = known[index]
			if (unit < ' ' || unit == '\u007f') {
				cut = index + 1
				break
			}
		}
		if (cut > 0) dropFront(cut)
		val points = known.codePointCount(0, known.length)
		if (points > MAX_CONTEXT_CODEPOINTS) {
			var units = known.offsetByCodePoints(0, points - MAX_CONTEXT_CODEPOINTS)
			if (hasComposition) units = minOf(units, composeStart)
			dropFront(units)
		}
	}

	private fun dropFront(units: Int) {
		if (units <= 0) return
		known.delete(0, units)
		base = (base.toLong() + units).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
		if (hasComposition) composeStart -= units
	}

	companion object {
		/**
		 * The most recent code points of submitted text kept as context.
		 *
		 * It is the commit ceiling, and it bounds retention only: what one commit may
		 * carry is also the most that can usefully be read back, and nothing is refused
		 * because of it.
		 */
		const val MAX_CONTEXT_CODEPOINTS: Int = ImeCommitEncoder.MAX_COMMIT_CODEPOINTS

		private fun commonPrefix(a: String, b: String): Int {
			val limit = minOf(a.length, b.length)
			var index = 0
			while (index < limit && a[index] == b[index]) index += 1
			if (index > 0 && a[index - 1].isHighSurrogate()) index -= 1
			return index
		}

		private fun splitsPair(text: CharSequence, index: Int): Boolean =
			index > 0 && index < text.length && text[index - 1].isHighSurrogate() && text[index].isLowSurrogate()
	}
}

/**
 * What one input-method write sends, and the state the ledger adopts once it has left.
 *
 * [deletions] backspaces go first, then [text]. Both are handed off together as one
 * prepared batch or not at all. Handing them off is not remote execution, and the owner
 * may still refuse any of it later.
 */
class ImeEditPlan internal constructor(
	val deletions: Int,
	val text: String,
	internal val known: String,
	internal val composeStart: Int,
	internal val composing: String,
	internal val unknownDeletions: Int,
	internal val generation: Long,
	internal val noChange: Boolean,
) {
	/** True when nothing has to leave the phone. */
	val sendsNothing: Boolean
		get() = deletions == 0 && text.isEmpty()

	internal companion object {
		fun none(generation: Long) = ImeEditPlan(0, "", "", 0, "", 0, generation, noChange = true)
	}
}
