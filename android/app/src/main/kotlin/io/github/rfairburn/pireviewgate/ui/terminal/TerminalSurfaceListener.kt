package io.github.rfairburn.pireviewgate.ui.terminal

import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind

/**
 * The fixed reasons the surface reports that it cannot carry input.
 *
 * The set is closed on purpose: a caller can branch on every value, and the
 * surface never invents a free-text reason carrying peer or frame content.
 */
enum class InputUnavailableReason {
	/** No binding is installed, so nothing is shown and nothing is attestable. */
	NOT_BOUND,

	/** Bound, but no frame has been committed yet. */
	NO_COMMITTED_FRAME,

	/**
	 * The committed frame's publish states no host-written input source, so the
	 * pixels are on screen and nothing may be typed against them.
	 *
	 * This is not a fault and not a request to supply a source: the surface draws
	 * such a frame in full and refuses input until a publish that states one
	 * arrives. It never invents a source, a permission, or a stand-in receipt.
	 */
	SOURCE_ABSENT,

	/** The committed frame was retired by a newer binding. */
	BINDING_RETIRED,

	/** The committed frame was retired by a layout change. */
	LAYOUT_RETIRED,

	/** The committed frame was retired by a policy change. */
	POLICY_RETIRED,

	/** The view does not have focus. */
	NOT_FOCUSED,

	/** The view is hidden, covered, or its window is not visible. */
	NOT_VISIBLE,

	/** The view is detached from its window. */
	DETACHED,

	/**
	 * The platform cannot confirm a commit for this view. Without a real
	 * frame-commit signal the surface will not claim any frame was drawn, so it
	 * will not carry input either.
	 */
	COMMIT_REPORTING_UNAVAILABLE,

	/** A modal surface (a session chooser, for instance) owns input. */
	MODAL_SUSPENDED,

	/** The caller turned user input off for this surface. */
	USER_INPUT_DISABLED,

	/** The frame could not be laid out, so nothing valid is on screen. */
	FRAME_REJECTED,

	/** The keystroke or paste was refused by the encoders. */
	ENCODER_REFUSED,

	/** A paste exceeded the whole-input bound and was not truncated. */
	PASTE_TOO_LARGE,

	/**
	 * A committed burst exceeded what one commit may carry, and none of it was sent.
	 *
	 * Bulk text belongs to the paste path, which has its own bound. Refusing the whole
	 * commit is what keeps a large burst from becoming a partial one.
	 */
	COMMIT_TOO_LARGE,

	/** A pointer event fell outside the drawn content rectangle. */
	POINTER_OUTSIDE_CONTENT,

	/** The child reports no mouse tracking, or an encoding this surface lacks. */
	MOUSE_REPORTING_OFF,

	/** An IME connection from a retired layout tried to deliver text. */
	IME_CONNECTION_STALE,
}

/**
 * Everything the surface can tell its caller.
 *
 * The surface owns rendering and keystroke encoding. It opens no socket, reads
 * and writes no clipboard, and stores no transcript: it reports what it measured,
 * what it actually committed, and what the user typed against that commit. The
 * caller owns transport, retry, and copy.
 */
interface TerminalSurfaceListener {
	/**
	 * The grid the surface can actually draw with its current size, insets, and
	 * cell metrics. Reported whenever it changes; the caller resizes the owner's
	 * viewport to match and the frames that follow are laid out into it.
	 */
	fun onViewportRequested(cols: Int, rows: Int)

	/**
	 * The platform confirmed that this frame was drawn and submitted. Every input
	 * packet is attributed to a receipt like this one.
	 */
	fun onFrameCommitted(receipt: FrameCommitReceipt)

	/**
	 * The user produced [bytes] of [kind] against the frame [receipt] attests to.
	 *
	 * The packet was encoded against the modes recorded on that receipt. This is
	 * the only path input leaves the surface, and the surface sends nothing
	 * itself: if the caller does not forward it, the keystroke is simply lost.
	 */
	fun onInput(kind: NativeIoInputKind, bytes: ByteArray, receipt: FrameCommitReceipt)

	/**
	 * Input was attempted or a fence dropped, for [reason].
	 *
	 * Reported fail-closed: when the surface is not certain that its current
	 * pixels back a keystroke, it reports here instead of emitting input.
	 */
	fun onInputUnavailable(reason: InputUnavailableReason)

	/**
	 * The modifier chips the surface is holding changed to [modifiers].
	 *
	 * [TerminalSurfaceView.setMobileModifiers] applies the change synchronously, so
	 * a caller that made it already knows the answer. The report exists for the
	 * changes the surface makes on its own — a target, session, or source switch, a
	 * backgrounding, a focus loss, a modal — which the root screen cannot otherwise
	 * see, and whose chips would then be showing a modifier the surface has let go
	 * of. [modifiers] is always a subset of the chips the surface supports.
	 *
	 * Default: nothing. This is a resync notice, not a fence: nothing about input
	 * eligibility depends on a caller hearing it.
	 */
	fun onMobileModifiersChanged(modifiers: Int) {}
}
