package io.github.rfairburn.pireviewgate.ui.terminal

import io.github.rfairburn.pireviewgate.core.input.CellPosition
import io.github.rfairburn.pireviewgate.core.input.InputSourceFence
import io.github.rfairburn.pireviewgate.core.input.PixelRect
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes

/**
 * Proof of one actual frame commit, as drawn by one binding at one layout.
 *
 * The epochs are the point: [bindingEpoch] and [layoutEpoch] record what was
 * current when the draw pass began, [drawEpoch] names the pass the platform
 * confirmed, and [commitSequence] increases once per accepted commit. A receipt
 * is therefore only ever about pixels the platform finished submitting — its
 * documented meaning is that the render thread drew the hierarchy and handed the
 * frame to the swap chain, and this type deliberately claims nothing about a
 * physical display being lit.
 *
 * [drawnColumns], [drawnRows], and [contentRect] describe the content actually
 * laid out, which may be smaller than the surface: a canonical frame smaller
 * than the measured grid is padded, and a larger one is clipped. Input is only
 * ever attributed to that drawn rectangle.
 *
 * [source] is null when the drawn publish stated no input source. Such a receipt
 * is still the honest statement that these pixels were submitted — it is what
 * [authorizesInput] is for — but it authorizes no keyboard, paste, mouse, or copy
 * traffic, and nothing here manufactures a source, a permission, or any other
 * stand-in to make one look as if it did.
 *
 * Instances are immutable and compared by value, so a caller can hold one across
 * a queued write and ask the surface whether it is still current.
 */
data class FrameCommitReceipt(
	val hostId: String,
	val connectionGeneration: Long,
	val selectionGeneration: Long,
	val subscriptionId: String,
	val ownerRun: String,
	val rowId: String,
	val publishSequence: Long,
	val geometry: SessionGeometry,
	val source: NativeIoInputSource?,
	val modes: TerminalInputModes,
	val policyGeneration: Long,
	val frameCols: Int,
	val frameRows: Int,
	val drawnColumns: Int,
	val drawnRows: Int,
	val contentRect: PixelRect,
	val bindingEpoch: Long,
	val layoutEpoch: Long,
	val drawEpoch: Long,
	val commitSequence: Long,
) {
	/** True when [position] falls inside the content this receipt attests to. */
	fun covers(position: CellPosition): Boolean =
		position.column in 0 until drawnColumns && position.row in 0 until drawnRows

	/**
	 * True when these pixels may back keyboard, paste, mouse, or copy input.
	 *
	 * A display-only commit — one whose publish stated no source — proves pixels and
	 * nothing else, so it never authorizes input. A caller must read this rather than
	 * assume that holding a receipt means anything may be typed.
	 */
	val authorizesInput: Boolean
		get() = InputSourceFence.authorizesInput(source)
}
