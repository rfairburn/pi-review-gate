package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.nativeIoSourceEquals

/**
 * How the source carried by one published view stands relative to that view's own
 * target, as the surface must see it.
 *
 * The three cases are the whole set, and they are deliberately not collapsed into
 * a boolean: a view with no source is still a view, while a view whose source
 * names somebody else is a caller mistake that must not be drawn at all.
 */
enum class InputSourceState {
	/** The publish carries one host-written source that names this exact target. */
	STATED,

	/**
	 * The publish carries no source at all — the wire key was absent, or the owner
	 * stated it has none. The frame is drawn, the cursor and graphics included, and
	 * the requested viewport is still reported; nothing is typed against it.
	 */
	DISPLAY_ONLY,

	/**
	 * The publish carries a source that contradicts its own owner run or owner row.
	 * Nothing is laid out, drawn, or made input-eligible by such a binding.
	 */
	CONTRADICTORY,
}

/**
 * The portable half of "these pixels may be drawn, and may anything be typed at
 * them".
 *
 * A viewport snapshot is complete on its own: the frame, its geometry, and the
 * input modes observed on it are everything needed to place glyphs, the cursor,
 * attributes, and typed images. A host-written input source is not part of
 * drawing — it is what makes a keystroke attributable to one owner-side session,
 * so it governs input and nothing else. Keeping that split as plain data is what
 * lets the rule be tested without a view, and it is why a source-less publish is
 * never turned into a blank terminal: there is nothing to invent and nothing to
 * refuse to show.
 *
 * Nothing here grants authority. [authorizesInput] only says a source exists for
 * the caller to echo; the caller's own policy, negotiation, and staleness checks
 * still decide whether a write is accepted.
 */
object InputSourceFence {
	/**
	 * Classify the [source] a binding carries against the target the binding names.
	 *
	 * [ownerRun] and [rowId] are the binding's own owner run and owner row: the
	 * check is that the source does not contradict them, never that it is believed.
	 */
	fun state(source: NativeIoInputSource?, ownerRun: String, rowId: String): InputSourceState {
		val stated = source ?: return InputSourceState.DISPLAY_ONLY
		if (stated.hostRunId != ownerRun || stated.sessionId != rowId) return InputSourceState.CONTRADICTORY
		return InputSourceState.STATED
	}

	/**
	 * True when a commit carrying this source may back keyboard, paste, mouse, or
	 * copy input.
	 *
	 * Display-only commits — the ones a source-less publish produces — prove that
	 * pixels were submitted and nothing more. They authorize no input of any kind,
	 * and no caller may treat one as if it did.
	 */
	fun authorizesInput(source: NativeIoInputSource?): Boolean = source != null

	/**
	 * True when both sides describe the same host-written source, absence included.
	 *
	 * Two absent sides agree; an absent side and a stated side never do, so a
	 * present-to-absent or absent-to-present transition retires whatever proof the
	 * earlier side carried. Stated sides compare by the exact variant-aware rule,
	 * so an A → B → A change is never mistaken for the original A.
	 */
	fun isSameSource(left: NativeIoInputSource?, right: NativeIoInputSource?): Boolean =
		if (left == null || right == null) left == right else nativeIoSourceEquals(left, right)
}
