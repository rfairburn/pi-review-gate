package io.github.rfairburn.pireviewgate.ui.terminal

import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import io.github.rfairburn.pireviewgate.core.input.ImeCompositionModel

/**
 * The phone's translation of input-method calls into owner input.
 *
 * There is no buffer here, so the contract is inverted from the usual one: an
 * input method's editing calls are not applied to text the phone owns. What
 * leaves the surface is committed text, deletions the user actually asked for, and
 * the Enter key — each encoded against the frame the platform confirmed.
 *
 * [ImeCompositionModel] holds the local half of that contract, including the
 * awkward cases: `commitText` *replaces* a composition rather than appending to
 * it, and a deletion consumes the composition before it can mean a backspace into
 * the owner's screen. Getting those backwards either duplicates half-finished text
 * into the child or deletes characters the user never typed.
 *
 * A connection is disposable. When the input context, the layout, or the lifecycle
 * moves under it, the connection refuses every call and drops its composition.
 * A content-only publish keeps the composition, but sends still need a fresh receipt.
 * [closeConnection] is terminal for that object, so an input method reconnecting
 * gets a fresh one rather than reviving this one.
 */
internal class TerminalInputConnection(
	private val surface: TerminalSurfaceView,
	private val connectionEpoch: Long,
) : BaseInputConnection(surface, true) {
	private val composition = ImeCompositionModel()
	private var closed = false

	/** Stop this connection permanently and discard whatever it was composing. */
	fun invalidate() {
		closed = true
		composition.discard()
	}

	/** What the input method is still composing, for diagnostics and tests. */
	val composingText: String
		get() = composition.composingText

	private fun current(): Boolean = !closed && surface.isConnectionCurrent(connectionEpoch)

	override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
		if (!current()) return false
		// The composing region is replaced, and its text was never sent: only the
		// committed replacement leaves, so "hel" + commit("hello") sends "hello".
		val send = composition.commit(text?.toString().orEmpty())
		if (send.isEmpty()) return true
		return surface.submitTypedText(send)
	}

	override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
		if (!current()) return false
		// Bounded before anything is retained: a composition is what a later commit may
		// carry, so an oversized burst is refused here rather than becoming an oversized
		// packet batch on the UI thread later. Nothing is truncated to fit.
		if (!composition.setComposing(text?.toString())) {
			surface.reportCommitTooLarge()
			return false
		}
		return true
	}

	override fun finishComposingText(): Boolean {
		if (!current()) return false
		// Finished means the input method kept the text: it is sent once, here.
		val pending = composition.finishComposition()
		if (pending.isEmpty()) return true
		return surface.submitTypedText(pending)
	}

	override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
		if (!current()) return false
		// The composition absorbs the deletion first. Only what is left over after
		// the composition is empty is a real backspace into the owner's screen.
		val backspaces = composition.deleteSurrounding(beforeLength, afterLength)
		if (backspaces <= 0) return true
		// Truthful: the caller learns when the deletions could not be carried.
		return surface.submitBackspace(backspaces)
	}

	override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
		if (!current()) return false
		val backspaces = composition.deleteSurroundingInCodePoints(beforeLength, afterLength)
		if (backspaces <= 0) return true
		return surface.submitBackspace(backspaces)
	}

	override fun sendKeyEvent(event: KeyEvent): Boolean {
		if (!current()) return false
		// One path for every route a physical key can take, so the same press cannot be
		// carried twice and modified keys cannot be flattened into text. This route is
		// the input method forwarding a key event, so the modifier chips the user is
		// holding fold in: an IME-forwarded Enter or Backspace must not lose a Ctrl.
		return surface.handleHardwareKey(
			event,
			release = event.action == KeyEvent.ACTION_UP,
			fromIme = true,
		)
	}

	override fun performEditorAction(editorAction: Int): Boolean {
		if (!current()) return false
		if (editorAction != EditorInfo.IME_ACTION_DONE &&
			editorAction != EditorInfo.IME_ACTION_GO &&
			editorAction != EditorInfo.IME_ACTION_NEXT &&
			editorAction != EditorInfo.IME_ACTION_SEND
		) {
			return false
		}
		// Any composition still open was never committed, so it is dropped rather
		// than sent; the action itself means Enter. The result is the surface's: a
		// refused Enter is not reported to the input method as a success.
		composition.discard()
		return surface.submitEnter()
	}

	override fun closeConnection() {
		// Terminal: this object never becomes current again, even at its own epoch.
		invalidate()
		super.closeConnection()
	}
}
