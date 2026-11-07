package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalCellRun
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalCursor
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalGraphicsClip
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalGraphicsCrop
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalGraphicsPlacement
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalLineStyles
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Cell placement, padding, and clipping. The owner's frame is canonical and the
 * measured grid is whatever the phone has, so a layout is the intersection and
 * never a re-flowed guess.
 */
class TerminalCellLayoutTest {

	private fun cells(layout: TerminalLayout, row: Int): List<TerminalCell> = layout.rows.single { it.row == row }.cells

	@Test
	fun plainRowPlacesOneCellPerColumn() {
		val layout = assertNotNull(
			TerminalCellLayout.layout(frame(4, 1, listOf(row("" to "abcd"))), requestedCols = 4, requestedRows = 1),
		)
		assertEquals(4, layout.drawnColumns)
		assertEquals(1, layout.drawnRows)
		assertEquals(listOf(0, 1, 2, 3), cells(layout, 0).map { it.column })
		assertEquals("abcd", cells(layout, 0).joinToString("") { it.text })
	}

	@Test
	fun smallerGridClipsAndLargerGridPads() {
		val clipped = assertNotNull(TerminalCellLayout.layout(frame(8, 4, List(4) { row("" to "abcdefgh") }), 3, 2))
		assertEquals(3, clipped.drawnColumns)
		assertEquals(2, clipped.drawnRows)
		assertEquals(2, clipped.rows.size)
		assertEquals(listOf("a", "b", "c"), cells(clipped, 0).map { it.text })

		val padded = assertNotNull(TerminalCellLayout.layout(frame(3, 2, List(2) { row("" to "abc") }), 10, 6))
		assertEquals(3, padded.drawnColumns)
		assertEquals(2, padded.drawnRows)
		assertEquals(2, padded.rows.size)
	}

	@Test
	fun wideCellsOccupyTwoColumns() {
		val layout = assertNotNull(
			TerminalCellLayout.layout(frame(5, 1, listOf(row("" to "\u65e5x\u672c"))), 5, 1),
		)
		val cells = cells(layout, 0)
		assertEquals(listOf(0, 2, 3), cells.map { it.column })
		assertEquals(listOf(2, 1, 2), cells.map { it.span })
	}

	@Test
	fun aWideCellStraddlingTheClipEdgeIsNotDrawn() {
		val layout = assertNotNull(TerminalCellLayout.layout(frame(3, 1, listOf(row("" to "a\u65e5b"))), 2, 1))
		assertEquals(2, layout.drawnColumns)
		assertEquals(listOf("a"), cells(layout, 0).map { it.text })
	}

	@Test
	fun combiningMarksJoinTheirBaseCell() {
		val layout = assertNotNull(TerminalCellLayout.layout(frame(3, 1, listOf(row("" to "a\u0301bc"))), 3, 1))
		val cells = cells(layout, 0)
		assertEquals(listOf(0, 1, 2), cells.map { it.column })
		assertEquals("a\u0301", cells[0].text)
		assertEquals(1, cells[0].span)
	}

	@Test
	fun structuredRunsAnchorTheirStartColumn() {
		val styles = listOf(
			TerminalLineStyles(
				line = 0,
				runs = listOf(
					TerminalCellRun(startColumn = 0, text = "ab"),
					TerminalCellRun(startColumn = 2, text = "c\u65e5", bold = true),
				),
			),
		)
		// The row's own text must agree with the structured runs; the wide cell
		// keeps the run start columns the owner recorded.
		val layout = assertNotNull(
			TerminalCellLayout.layout(frame(5, 1, listOf(row("" to "ab", "1" to "c\u65e5")), styles = styles), 5, 1),
		)
		val cells = cells(layout, 0)
		assertEquals(listOf(0, 1, 2, 3), cells.map { it.column })
		assertEquals(false, cells[0].style.bold)
		assertEquals(true, cells[3].style.bold)
		assertEquals(2, cells[3].span)
	}

	@Test
	fun structuredTextThatDisagreesWithTheRowIsRefused() {
		val styles = listOf(
			TerminalLineStyles(line = 0, runs = listOf(TerminalCellRun(startColumn = 0, text = "different"))),
		)
		assertNull(TerminalCellLayout.layout(frame(4, 1, listOf(row("" to "abcd")), styles = styles), 4, 1))
	}

	@Test
	fun malformedFramesAreRefused() {
		// A row count that does not match the frame, a non-native row, and a
		// nonsense grid all fail closed instead of drawing a partial guess.
		assertNull(TerminalCellLayout.layout(frame(4, 2, listOf(row("" to "abcd"))), 4, 2))
		assertNull(TerminalCellLayout.layout(frame(4, 1, listOf("$ESC[51mabcd")), 4, 1))
		assertNull(TerminalCellLayout.layout(frame(4, 1, listOf(row("" to "abcd"))), 0, 1))
		assertNull(TerminalCellLayout.layout(frame(4, 1, listOf(row("" to "abcd"))), 1001, 1))
	}

	@Test
	fun cursorOnlyAppearsWhenItIsInsideTheDrawnContent() {
		val visible = assertNotNull(
			TerminalCellLayout.layout(frame(4, 2, List(2) { row("" to "abcd") }, TerminalCursor(3, 1, true)), 4, 2),
		)
		assertEquals(TerminalCursorLayout(3, 1), visible.cursor)

		val hidden = assertNotNull(
			TerminalCellLayout.layout(frame(4, 2, List(2) { row("" to "abcd") }, TerminalCursor(3, 1, false)), 4, 2),
		)
		assertNull(hidden.cursor)

		val clipped = assertNotNull(
			TerminalCellLayout.layout(frame(4, 2, List(2) { row("" to "abcd") }, TerminalCursor(3, 1, true)), 2, 2),
		)
		assertNull(clipped.cursor)
	}

	@Test
	fun pointerMappingOnlyAnswersInsideDrawnContent() {
		val geometry = CellGeometry(originX = 4, originY = 8, cellWidthPx = 10, cellHeightPx = 20, columns = 3, rows = 2)
		assertEquals(CellPosition(0, 0), geometry.cellOf(4f, 8f))
		assertEquals(CellPosition(2, 1), geometry.cellOf(33f, 47f))
		assertNull(geometry.cellOf(3f, 8f))
		assertNull(geometry.cellOf(34f, 8f))
		assertNull(geometry.cellOf(4f, 48f))
		assertEquals(PixelRect(4, 8, 34, 48), geometry.contentRect)
	}

	@Test
	fun graphicsPlacementMapsCellsAndCropToPixels() {
		val geometry = CellGeometry(originX = 0, originY = 0, cellWidthPx = 8, cellHeightPx = 16, columns = 10, rows = 5)
		val placement = TerminalGraphicsPlacement(
			id = "p1",
			imageId = "i1",
			column = 1,
			row = 1,
			columns = 4,
			rows = 2,
			crop = TerminalGraphicsCrop(x = 0, y = 0, width = 32, height = 32),
			clip = TerminalGraphicsClip(0, 0, 0, 0),
		)
		val drawable = assertNotNull(TerminalGraphicsGeometry.placement(placement, 32, 32, geometry))
		assertEquals(PixelRect(8, 16, 40, 48), drawable.destination)
		assertEquals(0f, drawable.sourceLeft)
		assertEquals(32f, drawable.sourceWidth)
	}

	@Test
	fun graphicsClipAndOverflowAreHonoured() {
		val geometry = CellGeometry(originX = 0, originY = 0, cellWidthPx = 8, cellHeightPx = 16, columns = 3, rows = 2)
		val clipped = TerminalGraphicsPlacement(
			id = "p1",
			imageId = "i1",
			column = 0,
			row = 0,
			columns = 6,
			rows = 4,
			crop = TerminalGraphicsCrop(0, 0, 48, 64),
			clip = TerminalGraphicsClip(leftColumns = 1, topRows = 1, rightColumns = 0, bottomRows = 0),
		)
		val drawable = assertNotNull(TerminalGraphicsGeometry.placement(clipped, 48, 64, geometry))
		assertEquals(PixelRect(8, 16, 24, 32), drawable.destination)
		assertEquals(8f, drawable.sourceLeft)
		assertEquals(16f, drawable.sourceTop)

		val outside = clipped.copy(column = 20, row = 20, clip = TerminalGraphicsClip(0, 0, 0, 0))
		assertNull(TerminalGraphicsGeometry.placement(outside, 48, 64, geometry))
	}

	@Test
	fun graphicsPlacementOffscreenAtOneEdgeCropsTheSourceToWhatIsVisible() {
		val geometry = CellGeometry(originX = 0, originY = 0, cellWidthPx = 8, cellHeightPx = 16, columns = 10, rows = 5)
		val placement = TerminalGraphicsPlacement(
			id = "p1",
			imageId = "i1",
			column = 8,
			row = 3,
			columns = 4,
			rows = 4,
			crop = TerminalGraphicsCrop(0, 0, 40, 64),
			clip = TerminalGraphicsClip(0, 0, 0, 0),
		)
		val drawable = assertNotNull(TerminalGraphicsGeometry.placement(placement, 40, 64, geometry))
		// Two of four columns and two of four rows are on screen...
		assertEquals(PixelRect(64, 48, 80, 80), drawable.destination)
		// ...so exactly half the image is read, rather than the whole image being
		// stretched into the partial box.
		assertEquals(0f, drawable.sourceLeft)
		assertEquals(20f, drawable.sourceWidth)
		assertEquals(0f, drawable.sourceTop)
		assertEquals(32f, drawable.sourceHeight)
	}

	@Test
	fun graphicsPlacementStartingBeforeTheContentReadsTheLaterPartOfTheImage() {
		val geometry = CellGeometry(originX = 0, originY = 0, cellWidthPx = 8, cellHeightPx = 16, columns = 10, rows = 5)
		val placement = TerminalGraphicsPlacement(
			id = "p1",
			imageId = "i1",
			column = -2,
			row = 0,
			columns = 4,
			rows = 4,
			crop = TerminalGraphicsCrop(0, 0, 40, 64),
			clip = TerminalGraphicsClip(0, 0, 0, 0),
		)
		val drawable = assertNotNull(TerminalGraphicsGeometry.placement(placement, 40, 64, geometry))
		assertEquals(PixelRect(0, 0, 16, 64), drawable.destination)
		assertEquals(20f, drawable.sourceLeft)
		assertEquals(20f, drawable.sourceWidth)
		assertEquals(64f, drawable.sourceHeight)
	}

	@Test
	fun graphicsCropIsMeasuredInOriginalImagePixels() {
		val geometry = CellGeometry(originX = 0, originY = 0, cellWidthPx = 10, cellHeightPx = 10, columns = 6, rows = 4)
		val placement = TerminalGraphicsPlacement(
			id = "p1",
			imageId = "i1",
			column = 0,
			row = 0,
			columns = 4,
			rows = 4,
			crop = TerminalGraphicsCrop(x = 20, y = 10, width = 20, height = 30),
			clip = TerminalGraphicsClip(0, 0, 0, 0),
		)
		val drawable = assertNotNull(TerminalGraphicsGeometry.placement(placement, 100, 120, geometry))
		// The crop offsets the source window inside the original PNG; a renderer
		// holding a half-size bitmap scales these by one half.
		assertEquals(20f, drawable.sourceLeft)
		assertEquals(10f, drawable.sourceTop)
		assertEquals(20f, drawable.sourceWidth)
		assertEquals(30f, drawable.sourceHeight)
	}

	@Test
	fun layoutIsDeterministicForEqualInputs() {
		val first = assertNotNull(TerminalCellLayout.layout(frame(6, 2, List(2) { row("1" to "abc") }), 6, 2))
		val second = assertNotNull(TerminalCellLayout.layout(frame(6, 2, List(2) { row("1" to "abc") }), 6, 2))
		assertTrue(first == second)
	}
}
