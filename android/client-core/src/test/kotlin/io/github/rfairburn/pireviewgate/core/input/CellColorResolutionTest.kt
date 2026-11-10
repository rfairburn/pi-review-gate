package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalColorMode
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalColorSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CellColorResolutionTest {
	private val defaultForeground = CellColorResolution.rgb(232, 232, 232)
	private val defaultBackground = CellColorResolution.rgb(16, 16, 16)

	private fun resolve(style: SgrStyle): CellColors =
		CellColorResolution.resolve(style, defaultForeground, defaultBackground)

	@Test
	fun `a recorded palette background is painted`() {
		val colors = resolve(SgrStyle(bg = TerminalColorSpec(TerminalColorMode.PALETTE, 4)))
		assertEquals(TerminalPalette.color(4), colors.background)
		assertEquals(defaultForeground, colors.foreground)
	}

	@Test
	fun `a recorded rgb background is painted`() {
		val colors = resolve(SgrStyle(bg = TerminalColorSpec(TerminalColorMode.RGB, 0x123456)))
		assertEquals(CellColorResolution.rgb(0x12, 0x34, 0x56), colors.background)
	}

	@Test
	fun `a recorded rgb foreground is painted`() {
		val colors = resolve(SgrStyle(fg = TerminalColorSpec(TerminalColorMode.RGB, 0x00ff00)))
		assertEquals(CellColorResolution.rgb(0, 255, 0), colors.foreground)
		assertEquals(null, colors.background)
	}

	@Test
	fun `a default background leaves the surface through`() {
		val colors = resolve(SgrStyle(bg = TerminalColorSpec(TerminalColorMode.DEFAULT, 0)))
		assertNull(colors.background)
	}

	@Test
	fun `no style at all paints nothing`() {
		val colors = resolve(SgrStyle())
		assertEquals(defaultForeground, colors.foreground)
		assertNull(colors.background)
	}

	@Test
	fun `inverse swaps the recorded colors`() {
		val fg = TerminalColorSpec(TerminalColorMode.RGB, 0xff0000)
		val bg = TerminalColorSpec(TerminalColorMode.PALETTE, 6)
		val colors = resolve(SgrStyle(fg = fg, bg = bg, inverse = true))
		assertEquals(TerminalPalette.color(6), colors.foreground)
		assertEquals(CellColorResolution.rgb(255, 0, 0), colors.background)
	}

	@Test
	fun `inverse with no recorded colors uses the defaults`() {
		val colors = resolve(SgrStyle(inverse = true))
		assertEquals(defaultBackground, colors.foreground)
		assertEquals(defaultForeground, colors.background)
	}

	@Test
	fun `dim fades only the glyph`() {
		val style = SgrStyle(fg = TerminalColorSpec(TerminalColorMode.RGB, 0xffffff), dim = true)
		val colors = resolve(style)
		assertEquals(CellColorResolution.dim(CellColorResolution.rgb(255, 255, 255)), colors.foreground)
		assertEquals(150, (colors.foreground ushr 24) and 0xff)
		assertEquals(0xffffff, colors.foreground and 0xffffff)
	}

	@Test
	fun `the palette is stable and opaque`() {
		for (index in 0..255) {
			assertEquals("alpha for $index", 255, TerminalPalette.color(index) ushr 24)
		}
		assertEquals(CellColorResolution.rgb(0, 0, 0), TerminalPalette.color(0))
		assertEquals(CellColorResolution.rgb(255, 255, 255), TerminalPalette.color(15))
		assertEquals(TerminalPalette.color(255), TerminalPalette.color(999))
		assertEquals(TerminalPalette.color(0), TerminalPalette.color(-5))
	}
}
