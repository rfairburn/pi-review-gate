package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalColorMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Only the SGR the native serializer generates is decoded. Anything that could
 * carry an instruction instead of a style is refused for the whole row, so no
 * control payload can reach the renderer.
 */
class GeneratedSgrStylesTest {

	@Test
	fun plainRowDecodesToDefaultStyle() {
		val spans = GeneratedSgrStyles.parse(row("" to "hello"))
		assertNotNull(spans)
		assertEquals(1, spans.size)
		assertEquals("hello", spans[0].text)
		assertEquals(GeneratedSgrStyles.DEFAULT, spans[0].style)
	}

	@Test
	fun allowlistedAttributesDecode() {
		val spans = GeneratedSgrStyles.parse(row("1;2;3;4;5;7;8;9;53" to "x"))
		val style = assertNotNull(spans).single().style
		assertEquals(true, style.bold)
		assertEquals(true, style.dim)
		assertEquals(true, style.italic)
		assertEquals(true, style.underline)
		assertEquals(true, style.blink)
		assertEquals(true, style.inverse)
		assertEquals(true, style.invisible)
		assertEquals(true, style.strikethrough)
		assertEquals(true, style.overline)
	}

	@Test
	fun colorsDecodeInEveryNativeForm() {
		val basic = assertNotNull(GeneratedSgrStyles.parse(row("31;42" to "a"))).single().style
		assertEquals(TerminalColorMode.PALETTE, basic.fg?.mode)
		assertEquals(1, basic.fg?.value)
		assertEquals(2, basic.bg?.value)

		val bright = assertNotNull(GeneratedSgrStyles.parse(row("95;107" to "a"))).single().style
		assertEquals(13, bright.fg?.value)
		assertEquals(15, bright.bg?.value)

		val palette = assertNotNull(GeneratedSgrStyles.parse(row("38;5;196" to "a"))).single().style
		assertEquals(TerminalColorMode.PALETTE, palette.fg?.mode)
		assertEquals(196, palette.fg?.value)

		val rgb = assertNotNull(GeneratedSgrStyles.parse(row("38;2;10;20;30;48;2;1;2;3" to "a"))).single().style
		assertEquals(TerminalColorMode.RGB, rgb.fg?.mode)
		assertEquals(0x0A141E, rgb.fg?.value)
		assertEquals(0x010203, rgb.bg?.value)
	}

	@Test
	fun resetReturnsToDefaultWithinARow() {
		val spans = assertNotNull(
			GeneratedSgrStyles.parse("$ESC[0m$ESC[1mbold$ESC[0mplain$ESC[0m"),
		)
		assertEquals(2, spans.size)
		assertEquals("bold", spans[0].text)
		assertEquals(true, spans[0].style.bold)
		assertEquals("plain", spans[1].text)
		assertEquals(GeneratedSgrStyles.DEFAULT, spans[1].style)
	}

	@Test
	fun unemitFormsAreRefused() {
		// Never emitted by the serializer: overline-off, underline styles, colors
		// beyond the native groups, and reordered attributes.
		assertNull(GeneratedSgrStyles.parse("$ESC[51mx"))
		assertNull(GeneratedSgrStyles.parse("$ESC[21mx"))
		assertNull(GeneratedSgrStyles.parse("$ESC[4:3mx"))
		assertNull(GeneratedSgrStyles.parse("$ESC[9;8mx"))
		assertNull(GeneratedSgrStyles.parse("$ESC[38;5mx"))
		assertNull(GeneratedSgrStyles.parse("$ESC[38;2;1;2mx"))
		assertNull(GeneratedSgrStyles.parse("$ESC[38;5;256mx"))
	}

	@Test
	fun anyOtherEscapeOrControlIsRefused() {
		// OSC, DCS, cursor movement, device control, and raw control bytes are not
		// styles, and none of them can reach the renderer as one.
		assertNull(GeneratedSgrStyles.parse("$ESC]0;window title\u0007"))
		assertNull(GeneratedSgrStyles.parse("$ESC[2J"))
		assertNull(GeneratedSgrStyles.parse("$ESC[H"))
		assertNull(GeneratedSgrStyles.parse("$ESC[?25l"))
		assertNull(GeneratedSgrStyles.parse("$ESC(B"))
		assertNull(GeneratedSgrStyles.parse("a\u0001b"))
		assertNull(GeneratedSgrStyles.parse("a\u007fb"))
	}

	@Test
	fun textOnlyDropsGeneratedSequences() {
		assertEquals("ab", GeneratedSgrStyles.textOnly(row("1" to "a", "31" to "b")))
		assertNull(GeneratedSgrStyles.textOnly("$ESC[51mx"))
	}
}
