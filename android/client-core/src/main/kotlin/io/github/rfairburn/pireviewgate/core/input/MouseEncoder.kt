package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.MouseEncodingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.MouseTrackingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import java.nio.charset.StandardCharsets

/**
 * One pointer observation in viewport content coordinates.
 *
 * [column] and [row] are 0-based cells inside the drawn content rectangle, never
 * pixels and never absolute screen coordinates. [button] is the terminal button
 * code: 0 left, 1 middle, 2 right, 3 no button, 64 wheel up, 65 wheel down, with
 * bit 32 marking motion as the protocol does.
 */
data class TerminalPointerEvent(
	val button: Int,
	val column: Int,
	val row: Int,
	val release: Boolean = false,
	val motion: Boolean = false,
	val wheel: Boolean = false,
)

/**
 * Encoder for canonical mouse reports.
 *
 * Reports are produced only for the tracking mode the owner actually observed:
 * X10 keeps presses only, VT200 keeps presses and releases, drag keeps presses,
 * releases, and drags with a button held, and any reports everything. A press
 * the child never asked to be told about is dropped rather than sent, because an
 * unrequested report is a keystroke the application did not ask for.
 *
 * Coordinates are the drawn content's own cells, so a report can never describe
 * a position the viewer did not show. `sgr-pixels` is refused: the phone reports
 * cells, and inventing pixel coordinates the owner would have to reinterpret is
 * not a substitute.
 */
object MouseEncoder {
	private const val MOTION_BIT = 32
	private const val WHEEL_BIT = 64
	private const val NO_BUTTON = 3

	/**
	 * Encode [event] for the modes on the current frame, or null when the child
	 * does not want it, the encoding is unsupported, or the cell lies outside the
	 * [drawnColumns] by [drawnRows] content rectangle.
	 */
	fun encode(
		event: TerminalPointerEvent,
		modes: TerminalInputModes,
		drawnColumns: Int,
		drawnRows: Int,
	): ByteArray? {
		if (modes.mouseEncoding == MouseEncodingMode.SGR_PIXELS) {
			return null
		}
		if (event.button < 0 || event.button > 255) return null
		if (event.column < 0 || event.row < 0) return null
		if (event.column >= drawnColumns || event.row >= drawnRows) return null
		if (!allowed(event, modes.mouseTracking)) return null

		var button = event.button
		if (modes.mouseTracking == MouseTrackingMode.X10) button = button and (4 or 8 or 16).inv()

		if (modes.mouseEncoding == MouseEncodingMode.SGR) {
			val terminator = if (event.release) "m" else "M"
			return "\u001b[<$button;${event.column + 1};${event.row + 1}$terminator".toByteArray(StandardCharsets.UTF_8)
		}

		// Legacy X10 is byte-oriented: the encoded triple is emitted as raw bytes,
		// never as text that a UTF-8 encoder could widen.
		val legacyButton = if (event.release) (button and 3.inv()) or NO_BUTTON else button
		val encodedButton = legacyButton + 32
		val encodedX = event.column + 33
		val encodedY = event.row + 33
		if (encodedButton > 255 || encodedX > 255 || encodedY > 255) return null
		return byteArrayOf(0x1b, 0x5b, 0x4d, encodedButton.toByte(), encodedX.toByte(), encodedY.toByte())
	}

	private fun allowed(event: TerminalPointerEvent, tracking: MouseTrackingMode): Boolean = when (tracking) {
		MouseTrackingMode.NONE -> false
		MouseTrackingMode.X10 -> !event.release && !event.motion && !event.wheel
		MouseTrackingMode.VT200 -> !event.motion
		MouseTrackingMode.DRAG -> !event.motion || (event.button and 3) != NO_BUTTON
		MouseTrackingMode.ANY -> true
	}
}
