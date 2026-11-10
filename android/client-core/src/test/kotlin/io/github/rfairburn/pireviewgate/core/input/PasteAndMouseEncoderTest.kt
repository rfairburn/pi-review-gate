package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.MouseEncodingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.MouseTrackingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import java.nio.charset.StandardCharsets
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Whole-input paste bounds and canonical mouse reports in content coordinates. */
class PasteAndMouseEncoderTest {

	@Test
	fun pasteWrapsOnlyWhenTheChildAskedForIt() {
		val plain = modes(bracketedPaste = false)
		assertContentEquals(
			"ls -la".toByteArray(StandardCharsets.UTF_8),
			PasteEncoder.encode("ls -la", plain.bracketedPaste),
		)
		val bracketed = modes(bracketedPaste = true)
		assertEquals(
			"$ESC[200~ls -la$ESC[201~",
			PasteEncoder.encode("ls -la", bracketed.bracketedPaste)?.toString(StandardCharsets.ISO_8859_1),
		)
	}

	@Test
	fun pasteBodyStaysOpaque() {
		// A paste is data the child asked for: control bytes inside it are kept.
		val encoded = PasteEncoder.encode("a\u0001\u001ab", bracketedPaste = false)
		assertContentEquals("a\u0001\u001ab".toByteArray(StandardCharsets.UTF_8), encoded)
	}

	@Test
	fun pasteIsWholeOrNothing() {
		val whole = buildString { repeat(PasteEncoder.MAX_PASTE_BYTES) { append('x') } }
		assertTrue(PasteEncoder.fits(whole))
		assertEquals(PasteEncoder.MAX_PASTE_BYTES, PasteEncoder.encode(whole, false)?.size)
		val over = whole + "y"
		assertFalse(PasteEncoder.fits(over))
		assertNull(PasteEncoder.encode(over, false))
		assertNull(PasteEncoder.encode("", false))
	}

	@Test
	fun pasteBoundCountsUtf8BytesNotCharacters() {
		val multiByte = buildString { repeat(PasteEncoder.MAX_PASTE_BYTES / 3 + 1) { append('\u65e5') } }
		assertFalse(PasteEncoder.fits(multiByte))
	}

	@Test
	fun sgrReportsUseOneBasedContentCoordinates() {
		val modes = modes(mouseTracking = MouseTrackingMode.ANY, mouseEncoding = MouseEncodingMode.SGR)
		assertEquals(
			"$ESC[<0;6;4M",
			MouseEncoder.encode(TerminalPointerEvent(button = 0, column = 5, row = 3), modes, 80, 24)
				?.toString(StandardCharsets.ISO_8859_1),
		)
		assertEquals(
			"$ESC[<3;6;4m",
			MouseEncoder.encode(
				TerminalPointerEvent(button = 3, column = 5, row = 3, release = true),
				modes,
				80,
				24,
			)?.toString(StandardCharsets.ISO_8859_1),
		)
	}

	@Test
	fun legacyReportsAreRawBytesNotText() {
		val modes = modes(mouseTracking = MouseTrackingMode.ANY, mouseEncoding = MouseEncodingMode.DEFAULT)
		val encoded = MouseEncoder.encode(TerminalPointerEvent(button = 0, column = 200, row = 3), modes, 800, 24)
		assertContentEquals(byteArrayOf(0x1b, 0x5b, 0x4d, 32, 233.toByte(), 36), encoded)
	}

	@Test
	fun unrequestedReportsAreDropped() {
		val none = modes(mouseTracking = MouseTrackingMode.NONE, mouseEncoding = MouseEncodingMode.SGR)
		assertNull(MouseEncoder.encode(TerminalPointerEvent(0, 1, 1), none, 80, 24))

		val x10 = modes(mouseTracking = MouseTrackingMode.X10, mouseEncoding = MouseEncodingMode.SGR)
		assertNull(MouseEncoder.encode(TerminalPointerEvent(0, 1, 1, motion = true), x10, 80, 24))
		assertNull(MouseEncoder.encode(TerminalPointerEvent(0, 1, 1, release = true), x10, 80, 24))

		val vt200 = modes(mouseTracking = MouseTrackingMode.VT200, mouseEncoding = MouseEncodingMode.SGR)
		assertNull(MouseEncoder.encode(TerminalPointerEvent(0, 1, 1, motion = true), vt200, 80, 24))
		assertNotNullReport(TerminalPointerEvent(0, 1, 1, release = true), vt200)
	}

	private fun assertNotNullReport(pointer: TerminalPointerEvent, modes: TerminalInputModes) {
		val encoded = MouseEncoder.encode(pointer, modes, 80, 24)
		assertTrue(encoded != null && encoded.isNotEmpty())
	}

	@Test
	fun dragTrackingKeepsHeldButtonMotionOnly() {
		val drag = modes(mouseTracking = MouseTrackingMode.DRAG, mouseEncoding = MouseEncodingMode.SGR)
		assertNotNullReport(TerminalPointerEvent(button = 0, column = 1, row = 1, motion = true), drag)
		assertNull(
			MouseEncoder.encode(
				TerminalPointerEvent(button = 3, column = 1, row = 1, motion = true),
				drag,
				80,
				24,
			),
		)
	}

	@Test
	fun reportsNeverLeaveTheDrawnContent() {
		val modes = modes(mouseTracking = MouseTrackingMode.ANY, mouseEncoding = MouseEncodingMode.SGR)
		assertNull(MouseEncoder.encode(TerminalPointerEvent(0, 40, 5), modes, 40, 24))
		assertNull(MouseEncoder.encode(TerminalPointerEvent(0, -1, 5), modes, 40, 24))
		assertNull(MouseEncoder.encode(TerminalPointerEvent(0, 5, 24), modes, 40, 24))
	}

	@Test
	fun pixelEncodingIsRefusedRatherThanInvented() {
		val modes = modes(mouseTracking = MouseTrackingMode.ANY, mouseEncoding = MouseEncodingMode.SGR_PIXELS)
		assertNull(MouseEncoder.encode(TerminalPointerEvent(0, 1, 1), modes, 80, 24))
	}
}
