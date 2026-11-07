package io.github.rfairburn.pireviewgate.core.input

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The phone lays cells out with the owner's pinned Unicode 11 widths, so a wide
 * cell is always two columns and a combining mark never starts one. These
 * expectations are the owner's model, not a device's font.
 */
class UnicodeCellWidthTest {

	@Test
	fun controlsAndDefaultsMatchTheOwnersTable() {
		assertEquals(0, UnicodeCellWidths.width(0))
		assertEquals(0, UnicodeCellWidths.width(0x1f))
		assertEquals(0, UnicodeCellWidths.width(0x7f))
		assertEquals(0, UnicodeCellWidths.width(0x9f))
		assertEquals(1, UnicodeCellWidths.width(0xa0))
		assertEquals(1, UnicodeCellWidths.width('a'.code))
		assertEquals(1, UnicodeCellWidths.width('~'.code))
	}

	@Test
	fun wideCellsAreTwoColumns() {
		assertEquals(2, UnicodeCellWidths.width(0x1100)) // Hangul Jamo
		assertEquals(2, UnicodeCellWidths.width(0x3000)) // fullwidth space
		assertEquals(2, UnicodeCellWidths.width(0x4e00)) // CJK
		assertEquals(2, UnicodeCellWidths.width(0xac00)) // Hangul syllable
		assertEquals(2, UnicodeCellWidths.width(0xff01)) // fullwidth exclamation
		assertEquals(2, UnicodeCellWidths.width(0x1f600)) // emoji
		assertEquals(2, UnicodeCellWidths.width(0x20004)) // CJK extension B
	}

	@Test
	fun combiningMarksAreZeroWidth() {
		assertEquals(0, UnicodeCellWidths.width(0x0301)) // combining acute
		assertEquals(0, UnicodeCellWidths.width(0x200b)) // zero width space
		assertEquals(0, UnicodeCellWidths.width(0xfe0f)) // variation selector
		assertEquals(0, UnicodeCellWidths.width(0x1d167)) // supplementary combining
	}

	@Test
	fun clustersJoinMarksToTheirBaseCell() {
		val clusters = UnicodeCellWidths.clusters("a\u0301b")
		assertEquals(2, clusters.size)
		assertEquals("a\u0301", clusters[0].text)
		assertEquals(1, clusters[0].advance)
		assertEquals("b", clusters[1].text)
	}

	@Test
	fun clustersKeepWideCellsInOneCell() {
		val clusters = UnicodeCellWidths.clusters("\u65e5x")
		assertEquals(2, clusters.size)
		assertEquals("\u65e5", clusters[0].text)
		assertEquals(2, clusters[0].advance)
		assertEquals("x", clusters[1].text)
		assertEquals(1, clusters[1].advance)
	}

	@Test
	fun supplementaryCodepointsStayOneCell() {
		val clusters = UnicodeCellWidths.clusters("\uD800\uDC00x")
		assertEquals(2, clusters.size)
		assertEquals(1, clusters[0].advance)
		assertEquals(0x10000, clusters[0].text.codePointAt(0))
	}

	@Test
	fun advanceSumsCellsWithoutFontHelp() {
		assertEquals(6, UnicodeCellWidths.advance("\u65e5\u672c\u8a9e"))
		assertEquals(3, UnicodeCellWidths.advance("ab\u0301c"))
		assertEquals(0, UnicodeCellWidths.advance(""))
	}
}
