package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.MouseEncodingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.MouseTrackingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalCursor
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes

/**
 * Hand-built inputs for the layout, style, and packet suites.
 *
 * Everything is in memory and synthetic: no session, socket, credential, or
 * product state is touched. Row text follows the native serializer's shape —
 * a leading reset, generated SGR, a trailing reset — so the suites exercise the
 * same form the wire codec admits rather than a test-local approximation.
 */

internal const val ESC = "\u001b"

internal fun modes(
	kittyFlags: Int = 0,
	applicationCursorKeys: Boolean = false,
	applicationKeypad: Boolean = false,
	bracketedPaste: Boolean = false,
	mouseTracking: MouseTrackingMode = MouseTrackingMode.NONE,
	modifyOtherKeys: Int = 0,
	mouseEncoding: MouseEncodingMode = MouseEncodingMode.DEFAULT,
): TerminalInputModes = TerminalInputModes(
	kittyFlags = kittyFlags,
	applicationCursorKeys = applicationCursorKeys,
	applicationKeypad = applicationKeypad,
	bracketedPaste = bracketedPaste,
	mouseTracking = mouseTracking,
	modifyOtherKeys = modifyOtherKeys,
	mouseEncoding = mouseEncoding,
)

internal fun frame(
	cols: Int,
	rows: Int,
	lines: List<String>,
	cursor: TerminalCursor = TerminalCursor(0, 0, true),
	styles: List<io.github.rfairburn.pireviewgate.core.protocol.content.TerminalLineStyles>? = null,
): TerminalFrame = TerminalFrame(cols = cols, rows = rows, lines = lines, cursor = cursor, styles = styles)

/** One serialized row in the shape the native serializer emits. */
internal fun row(vararg spans: Pair<String, String>): String {
	val builder = StringBuilder("$ESC[0m")
	for ((params, text) in spans) {
		if (params.isNotEmpty()) builder.append(ESC).append('[').append(params).append('m')
		builder.append(text)
	}
	builder.append("$ESC[0m")
	return builder.toString()
}

internal val geometry = SessionGeometry(cols = 80, rows = 24, revision = 7)
