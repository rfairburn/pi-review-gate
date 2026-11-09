package io.github.rfairburn.pireviewgate.ui.terminal

import android.text.TextUtils
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.SurroundingText
import android.view.inputmethod.TextAttribute
import android.view.inputmethod.TextSnapshot
import io.github.rfairburn.pireviewgate.core.input.ImeCommitEncoder
import io.github.rfairburn.pireviewgate.core.input.ImeCompositionModel
import io.github.rfairburn.pireviewgate.core.input.ImeEditLedger
import io.github.rfairburn.pireviewgate.core.input.ImeEditPlan
import java.lang.ref.WeakReference

/**
 * The phone's translation of input-method calls into owner input.
 *
 * There is no buffer here, so the contract is inverted from the usual one: an
 * input method's editing calls are not applied to text the phone owns. What
 * leaves the surface is committed text, deletions the user actually asked for, and
 * the Enter key — each encoded against the frame the platform confirmed.
 *
 * [ImeEditLedger] holds the local half of that contract. Its composition follows
 * [ImeCompositionModel], including the awkward cases: `commitText` *replaces* a
 * composition rather than appending to it, and a deletion consumes the composition
 * before it can mean a backspace into the owner's screen. Getting those backwards
 * either duplicates half-finished text into the child or deletes characters the user
 * never typed.
 *
 * The ledger also remembers the recent text this connection itself submitted, and the
 * input method reads it back as the text before the cursor. With it, a keyboard that
 * re-marks or replaces the word it just typed is answered with the minimal changed
 * suffix: backspaces for the code points that differ, then the new text, as one prepared
 * batch. It is not replayed as a duplicate word. That context is only what this
 * connection handed off. It is not the remote line, and the owner never confirms it. A
 * key, paste, pointer report, or Enter the ledger did not produce, a latched chip, or a
 * refusal the caller reports makes it forget the context. A composition that was never
 * sent survives that, exactly as before. A re-marked word that was already sent is dropped
 * instead: it can no longer be deleted or retyped safely. Ranges that do not end at the
 * cursor are not supported, and they send nothing. Every write still leaves at once. Batch edits delay only the selection
 * notification to the input method.
 *
 * No call ever reaches the inherited Editable: every reader answers from the ledger, and
 * every writer that would edit the inherited Editable is overridden, so no fake text can be
 * shown to the input method or silently "succeed".
 *
 * A connection is disposable. When the input context, the layout, or the lifecycle
 * moves under it, the connection refuses every call and drops its composition and context.
 * A content-only publish keeps both, but sends still need a fresh receipt.
 * [closeConnection] is terminal for that object, so an input method reconnecting
 * gets a fresh one rather than reviving this one.
 */
internal class TerminalInputConnection(
	private val surface: TerminalSurfaceView,
	private val connectionEpoch: Long,
) : BaseInputConnection(surface, true) {
	private val ledger = ImeEditLedger()
	private var closed = false
	private var batchDepth = 0
	private var forceReportAfterBatch = false

	/** The surface's emission count as of the last packet this connection accounted for. */
	private var syncedEmissions = surface.inputEmissions

	/** Selection start and end, then composition start and end, as last told to the IME. */
	private var reported = intArrayOf(0, 0, -1, -1)

	/** How many selection notifications this connection sent. For tests. */
	internal var selectionReports = 0
		private set

	/** The last selection notification: start, end, composition start, composition end. For tests. */
	internal val reportedSelection: List<Int>
		get() = reported.toList()

	/** Stop this connection permanently and discard its composition and context. */
	fun invalidate() {
		closed = true
		ledger.discard()
	}

	/** What the input method is still composing, for diagnostics and tests. */
	val composingText: String
		get() = ledger.composingText

	/** The submitted text this connection is treating as context. For tests. */
	internal val contextText: String
		get() = ledger.knownText

	/**
	 * The notice for a packet leaving now. If the caller reports it as not sent, this
	 * connection forgets its context, but only if that is still the context the packet
	 * was typed in. A newer connection or a later context never hears about it.
	 */
	internal fun refusalNotice(): TerminalInputRefusal {
		val connection = WeakReference(this)
		val generation = ledger.generation
		return TerminalInputRefusal { connection.get()?.contextRefused(generation) }
	}

	private fun contextRefused(generation: Long) {
		if (closed || generation != ledger.generation) return
		ledger.floor()
		reportSelection()
	}

	private fun current(): Boolean = !closed && surface.isConnectionCurrent(connectionEpoch)

	/**
	 * True when the connection may act. Before acting, forget the context if anything
	 * this connection did not account for has left, or if a chip is held. With a chip,
	 * what leaves is modified keystrokes, not text the remote line keeps.
	 */
	private fun prepare(): Boolean {
		if (!current()) return false
		if (surface.inputEmissions != syncedEmissions) {
			ledger.floor()
			syncedEmissions = surface.inputEmissions
		}
		if (surface.selectedMobileModifiers() != 0) ledger.floor()
		return true
	}

	/**
	 * Send [plan] now and adopt it once all of it was handed off.
	 *
	 * A refusal before anything left drops the composition, exactly as a refused commit
	 * or deletion always did, and keeps the context. A batch that stopped part-way, or that
	 * the caller refused while it was being handed off, also forgets the context. No part of
	 * it is replayed.
	 */
	private fun perform(plan: ImeEditPlan): Boolean {
		if (plan.sendsNothing) {
			ledger.apply(plan)
			reportSelection()
			return true
		}
		val generation = ledger.generation
		val delivery = surface.submitImeEdit(plan.deletions, plan.text) { !closed && ledger.generation == generation }
		val delivered = delivery == TerminalSurfaceView.ImeEditDelivery.DELIVERED
		if (delivered && ledger.apply(plan)) {
			if (surface.selectedMobileModifiers() != 0) ledger.floor()
		} else if (delivery == TerminalSurfaceView.ImeEditDelivery.REFUSED && ledger.generation == generation) {
			ledger.dropComposition()
		} else {
			ledger.floor()
			ledger.dropComposition()
		}
		syncedEmissions = surface.inputEmissions
		reportSelection()
		return delivered
	}

	/** A range edit that is not supported: nothing is sent, and the input method hears the truth. */
	private fun unsupported(): Boolean {
		reportSelection(force = true)
		return false
	}

	/**
	 * Tell the input method where the selection and composition are, when they moved. A
	 * batch edit delays only this notification. Every send inside it has already left.
	 */
	private fun reportSelection(force: Boolean = false) {
		if (!current()) return
		if (batchDepth > 0) {
			forceReportAfterBatch = forceReportAfterBatch || force
			return
		}
		val next = intArrayOf(
			ledger.selectionStartOffset,
			ledger.selectionEnd,
			ledger.compositionStart,
			ledger.compositionEnd,
		)
		if (!force && next.contentEquals(reported)) return
		reported = next
		selectionReports += 1
		surface.updateImeSelection(next[0], next[1], next[2], next[3])
	}

	/* ---------------------------------------------------------------- *
	 * Readers: answered from the ledger, never from the inherited Editable.
	 * ---------------------------------------------------------------- */

	override fun getTextBeforeCursor(length: Int, flags: Int): CharSequence? {
		if (!prepare()) return super.getTextBeforeCursor(length, flags)
		return ledger.textBeforeCursor(length)
	}

	override fun getTextAfterCursor(length: Int, flags: Int): CharSequence? {
		if (!prepare()) return super.getTextAfterCursor(length, flags)
		// The cursor is always at the end of what this connection knows.
		return ""
	}

	override fun getSelectedText(flags: Int): CharSequence? {
		if (!prepare()) return super.getSelectedText(flags)
		return ledger.selectedText()
	}

	override fun getCursorCapsMode(reqModes: Int): Int {
		if (!prepare()) return super.getCursorCapsMode(reqModes)
		return TextUtils.getCapsMode(ledger.document, ledger.cursorDocumentIndex, reqModes)
	}

	override fun getSurroundingText(beforeLength: Int, afterLength: Int, flags: Int): SurroundingText? {
		if (!prepare()) return super.getSurroundingText(beforeLength, afterLength, flags)
		val (text, start) = ledger.surroundingText(beforeLength)
		val offset = ledger.base + start
		return SurroundingText(text, ledger.selectionStartOffset - offset, ledger.selectionEnd - offset, offset)
	}

	override fun takeSnapshot(): TextSnapshot? {
		if (!prepare()) return super.takeSnapshot()
		val surrounding = getSurroundingText(SNAPSHOT_CONTEXT, SNAPSHOT_CONTEXT, 0) ?: return null
		val caps = getCursorCapsMode(
			TextUtils.CAP_MODE_CHARACTERS or TextUtils.CAP_MODE_WORDS or TextUtils.CAP_MODE_SENTENCES,
		)
		return TextSnapshot(surrounding, ledger.compositionStart, ledger.compositionEnd, caps)
	}

	/* ---------------------------------------------------------------- *
	 * Writers
	 * ---------------------------------------------------------------- */

	override fun beginBatchEdit(): Boolean {
		if (!current()) return false
		batchDepth += 1
		return true
	}

	override fun endBatchEdit(): Boolean {
		if (batchDepth > 0) batchDepth -= 1
		if (batchDepth == 0) {
			val force = forceReportAfterBatch
			forceReportAfterBatch = false
			reportSelection(force)
		}
		return batchDepth > 0
	}

	override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
		if (!prepare()) return false
		// The composing region is replaced, and its text was never sent: only the
		// committed replacement leaves, so "hel" + commit("hello") sends "hello". A
		// re-marked word that was already sent leaves only its changed suffix.
		val plan = ledger.commitText(text?.toString().orEmpty())
		if (plan == null) {
			// Whole-operation refusal, judged on what the input method supplied rather than
			// on the changed suffix: none of it is sent, and the composition is dropped.
			surface.reportCommitTooLarge()
			reportSelection()
			return false
		}
		return perform(plan)
	}

	override fun commitText(text: CharSequence, newCursorPosition: Int, textAttribute: TextAttribute?): Boolean =
		commitText(text, newCursorPosition)

	override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
		if (!prepare()) return false
		// Bounded before anything is retained: a composition is what a later commit may
		// carry, so an oversized burst is refused here rather than becoming an oversized
		// packet batch on the UI thread later. Nothing is truncated to fit.
		val plan = ledger.setComposingText(text?.toString().orEmpty())
		if (plan == null) {
			surface.reportCommitTooLarge()
			reportSelection()
			return false
		}
		return perform(plan)
	}

	override fun setComposingText(text: CharSequence, newCursorPosition: Int, textAttribute: TextAttribute?): Boolean =
		setComposingText(text, newCursorPosition)

	override fun setComposingRegion(start: Int, end: Int): Boolean {
		if (!prepare()) return false
		// Re-marking the word just typed sends nothing. Only a range that ends at the
		// cursor and starts within the known context is supported.
		val plan = ledger.setComposingRegion(start, end) ?: return unsupported()
		return perform(plan)
	}

	override fun setComposingRegion(start: Int, end: Int, textAttribute: TextAttribute?): Boolean =
		setComposingRegion(start, end)

	override fun finishComposingText(): Boolean {
		if (!prepare()) return false
		// Finished means the input method kept the text: unsent text is sent once, here.
		return perform(ledger.finishComposingText())
	}

	override fun setSelection(start: Int, end: Int): Boolean {
		if (!prepare()) return false
		// Only a selection ending at the cursor can be replaced without moving the remote
		// cursor. Nothing is sent for a selection, and no arrow key is invented.
		if (!ledger.setSelection(start, end)) return unsupported()
		reportSelection()
		return true
	}

	override fun replaceText(
		start: Int,
		end: Int,
		text: CharSequence,
		newCursorPosition: Int,
		textAttribute: TextAttribute?,
	): Boolean {
		if (!prepare()) return false
		val replacement = text.toString()
		if (ImeCommitEncoder.isOversized(replacement)) {
			// The commit ceiling applies to the supplied replacement, not only to its diff.
			surface.reportCommitTooLarge()
			return unsupported()
		}
		val plan = ledger.replaceText(start, end, replacement) ?: return unsupported()
		return perform(plan)
	}

	override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
		if (!prepare()) return false
		// The composition absorbs the deletion first. What is left deletes known text one
		// code point per backspace, and anything beyond it passes through as before. The
		// caller learns when the deletions could not be carried. With a selection active,
		// the text to delete sits before the selection, which is not supported.
		val plan = ledger.deleteBefore(beforeLength, inCodePoints = false) ?: return unsupported()
		return perform(plan)
	}

	override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
		if (!prepare()) return false
		val plan = ledger.deleteBefore(beforeLength, inCodePoints = true) ?: return unsupported()
		return perform(plan)
	}

	override fun sendKeyEvent(event: KeyEvent): Boolean {
		if (!prepare()) return false
		val before = surface.inputEmissions
		val generation = ledger.generation
		// One path for every route a physical key can take, so the same press cannot be
		// carried twice and modified keys cannot be flattened into text. This route is
		// the input method forwarding a key event, so the modifier chips the user is
		// holding fold in: an IME-forwarded Enter or Backspace must not lose a Ctrl.
		val handled = surface.handleHardwareKey(
			event,
			release = event.action == KeyEvent.ACTION_UP,
			fromIme = true,
		)
		// A plain Backspace that left removed one character, which the context can follow.
		// Any other key that left is caught by the next call's check and forgets the context.
		if (surface.inputEmissions == before + 1 && ledger.generation == generation &&
			!ledger.hasComposition && surface.isPlainBackspace(event)
		) {
			if (event.action == KeyEvent.ACTION_DOWN) ledger.forwardedBackspace()
			syncedEmissions = surface.inputEmissions
			reportSelection()
		}
		return handled
	}

	override fun performEditorAction(editorAction: Int): Boolean {
		if (!prepare()) return false
		if (editorAction != EditorInfo.IME_ACTION_DONE &&
			editorAction != EditorInfo.IME_ACTION_GO &&
			editorAction != EditorInfo.IME_ACTION_NEXT &&
			editorAction != EditorInfo.IME_ACTION_SEND
		) {
			return false
		}
		// Any composition still open was never committed, so it is dropped rather
		// than sent; the action itself means Enter. The result is the surface's: a
		// refused Enter is not reported to the input method as a success. The Enter
		// starts a new line, so the next call forgets the context.
		ledger.dropComposition()
		val sent = surface.submitEnter()
		reportSelection()
		return sent
	}

	override fun closeConnection() {
		// Terminal: this object never becomes current again, even at its own epoch.
		invalidate()
		super.closeConnection()
	}

	private companion object {
		/** UTF-16 units of context a snapshot carries before the cursor. */
		const val SNAPSHOT_CONTEXT = 1024
	}
}
