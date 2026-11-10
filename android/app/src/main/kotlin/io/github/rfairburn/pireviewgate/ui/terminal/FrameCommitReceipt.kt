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
 *
 * [publishSequence] names the publish whose pixels this commit actually drew. Under
 * an unchanged input context ([inputGeneration], [resizeEpoch], and every other
 * context field) a later publish only changes what is displayed, so a receipt for an
 * earlier publish of that context stays a genuine commit of it; see
 * [TerminalViewBinding.sameInputContextAs].
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
	/** The content lane's semantic input generation the drawn binding carried. */
	val inputGeneration: Long,
	/** The content lane's resize epoch the drawn binding carried. */
	val resizeEpoch: Long,
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

	/**
	 * True when this commit belongs to [binding]'s input context: same target and
	 * source, geometry, modes, policy, frame extents, input generation, and resize
	 * epoch, drawn from a publish no newer than [binding]'s. The display content and
	 * the publish sequence are the only things allowed to have moved on.
	 */
	fun inContextOf(binding: TerminalViewBinding?): Boolean {
		binding ?: return false
		return hostId == binding.hostId &&
			connectionGeneration == binding.connectionGeneration &&
			selectionGeneration == binding.selectionGeneration &&
			subscriptionId == binding.subscriptionId &&
			ownerRun == binding.ownerRun &&
			rowId == binding.rowId &&
			InputSourceFence.isSameSource(source, binding.source) &&
			geometry == binding.geometry &&
			modes == binding.modes &&
			policyGeneration == binding.policyGeneration &&
			frameCols == binding.frame.cols &&
			frameRows == binding.frame.rows &&
			inputGeneration == binding.inputGeneration &&
			resizeEpoch == binding.resizeEpoch &&
			publishSequence <= binding.publishSequence
	}

	/** True when [other] is a commit of the same input context as this one. */
	fun sameInputContextAs(other: FrameCommitReceipt): Boolean =
		hostId == other.hostId &&
			connectionGeneration == other.connectionGeneration &&
			selectionGeneration == other.selectionGeneration &&
			subscriptionId == other.subscriptionId &&
			ownerRun == other.ownerRun &&
			rowId == other.rowId &&
			InputSourceFence.isSameSource(source, other.source) &&
			geometry == other.geometry &&
			modes == other.modes &&
			policyGeneration == other.policyGeneration &&
			frameCols == other.frameCols &&
			frameRows == other.frameRows &&
			drawnColumns == other.drawnColumns &&
			drawnRows == other.drawnRows &&
			contentRect == other.contentRect &&
			inputGeneration == other.inputGeneration &&
			resizeEpoch == other.resizeEpoch &&
			bindingEpoch == other.bindingEpoch &&
			layoutEpoch == other.layoutEpoch
}
