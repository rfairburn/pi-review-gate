package io.github.rfairburn.pireviewgate.core.input

import kotlin.math.ceil
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AdaptiveTerminalGridTest {
    // Rounded platform-like metrics, deliberately not a preselected grid.
    private fun font(size: Float) = TerminalFontMetrics(ceil(size * .6f).toInt(), ceil(size * 1.2f).toInt() + 1)
    private fun measured(width: Int, height: Int, preferred: Float = 24f) =
        AdaptiveTerminalGrid.measure(width, height, preferred, ::font)

    @Test fun ampleViewportKeepsPreferenceAndDoesNotCapAtExampleGrid() {
        val fit = assertNotNull(measured(3200, 1800))
        assertEquals(24f, fit.textSizePx)
        assertEquals(3200 / font(24f).widthPx, fit.columns)
        assertEquals(1800 / font(24f).heightPx, fit.rows)
        assertTrue(fit.columns > 160 && fit.rows > 50)
    }

    @Test fun narrowPortraitFitsActualWidthWithoutStretchingFontOrInventingRows() {
        val fit = assertNotNull(measured(1080, 1200, 42f))
        assertTrue(fit.textSizePx < 42f)
        assertEquals(font(fit.textSizePx), fit.cell)
        assertEquals(1080 / fit.cell.widthPx, fit.columns)
        assertEquals(1200 / fit.cell.heightPx, fit.rows)
        assertTrue(fit.columns >= 80 && fit.rows >= 25)
        // The chosen font is within the bounded search tolerance of the rounded
        // fitting boundary, not simply half the old font or a fixed grid preset.
        val larger = font(fit.textSizePx + .001f)
        assertTrue(1080 / larger.widthPx < 80 || 1200 / larger.heightPx < 25)
    }

    @Test fun shortLandscapeFitsHeightAndOrientationProducesNewMeasuredCounts() {
        val portrait = assertNotNull(measured(1080, 1200, 42f))
        val landscape = assertNotNull(measured(2200, 280, 42f))
        assertTrue(landscape.textSizePx < portrait.textSizePx)
        assertTrue(landscape.columns >= 80 && landscape.rows >= 25)
        assertEquals(2200 / landscape.cell.widthPx, landscape.columns)
        assertEquals(280 / landscape.cell.heightPx, landscape.rows)
        assertTrue(landscape.columns != portrait.columns || landscape.rows != portrait.rows)
    }

    @Test fun unusableViewportNeverPublishesFabricatedFloorOrZeroSizeGlyphs() {
        for ((width, height) in listOf(0 to 1000, 1000 to 0, -1 to 1000, 79 to 1000, 1000 to 74)) {
            assertNull(measured(width, height))
        }
        val floor = assertNotNull(measured(80, 75))
        assertEquals(80, floor.columns)
        assertEquals(25, floor.rows)
        assertTrue(floor.textSizePx >= AdaptiveTerminalGrid.MIN_TEXT_SIZE_PX)
        assertTrue(floor.cell.widthPx > 0 && floor.cell.heightPx > 0)
    }

    @Test fun protocolCeilingAndSearchCostStayBoundedForExtremeGeometry() {
        var calls = 0
        val fit = assertNotNull(AdaptiveTerminalGrid.measure(Int.MAX_VALUE, Int.MAX_VALUE, 24f) {
            calls++
            font(it)
        })
        assertEquals(TerminalCellLayout.MAX_DIMENSION, fit.columns)
        assertEquals(TerminalCellLayout.MAX_DIMENSION, fit.rows)
        assertEquals(1, calls)
        calls = 0
        assertNotNull(AdaptiveTerminalGrid.measure(80, 75, 160f) { calls++; font(it) })
        assertTrue(calls <= 26)
    }

    @Test fun invalidPreferencesOrMetricsFailClosed() {
        for (size in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, 0f, 161f)) {
            assertNull(measured(1000, 1000, size))
        }
        for (cell in listOf(TerminalFontMetrics(0, 1), TerminalFontMetrics(1, 0), TerminalFontMetrics(-1, 1))) {
            assertNull(AdaptiveTerminalGrid.measure(1000, 1000, 24f) { cell })
        }
    }
}
