package io.github.rfairburn.pireviewgate.core.input

/** Actual integer pixel metrics of the chosen monospace paint, not a stretched cell. */
data class TerminalFontMetrics(val widthPx: Int, val heightPx: Int)

data class MeasuredTerminalGrid(
    val textSizePx: Float,
    val cell: TerminalFontMetrics,
    val columns: Int,
    val rows: Int,
)

/**
 * Prefer the caller's desktop-like font size; reduce only enough to fit 80x25.
 * Every candidate is measured by the real font implementation (including integer
 * pixel rounding). No startup grid, orientation preset, or preferred grid ceiling.
 * The only cell-count ceiling is the existing protocol/layout dimension bound.
 * Unpaintable measurements return null, never a fabricated minimum viewport.
 */
object AdaptiveTerminalGrid {
    const val MIN_COLUMNS = 80
    const val MIN_ROWS = 25
    const val MIN_TEXT_SIZE_PX = 1f
    const val MAX_TEXT_SIZE_PX = 160f
    private const val SEARCH_STEPS = 24

    fun measure(
        widthPx: Int,
        heightPx: Int,
        preferredTextSizePx: Float,
        fontMetrics: (Float) -> TerminalFontMetrics,
    ): MeasuredTerminalGrid? {
        if (widthPx <= 0 || heightPx <= 0 || !preferredTextSizePx.isFinite() ||
            preferredTextSizePx !in MIN_TEXT_SIZE_PX..MAX_TEXT_SIZE_PX) return null
        fun candidate(size: Float): MeasuredTerminalGrid? {
            val cell = fontMetrics(size)
            if (cell.widthPx <= 0 || cell.heightPx <= 0) return null
            val cols = (widthPx / cell.widthPx).coerceAtMost(TerminalCellLayout.MAX_DIMENSION)
            val rows = (heightPx / cell.heightPx).coerceAtMost(TerminalCellLayout.MAX_DIMENSION)
            if (cols < MIN_COLUMNS || rows < MIN_ROWS) return null
            return MeasuredTerminalGrid(size, cell, cols, rows)
        }
        candidate(preferredTextSizePx)?.let { return it }
        var best = candidate(MIN_TEXT_SIZE_PX) ?: return null
        var low = MIN_TEXT_SIZE_PX
        var high = preferredTextSizePx
        // Bounded bisection over monotonic, rounded monospace metrics. Return the
        // last measured fitting candidate, never the unmeasured boundary.
        repeat(SEARCH_STEPS) {
            val middle = low + (high - low) / 2f
            val fit = candidate(middle)
            if (fit == null) high = middle else { low = middle; best = fit }
        }
        return best
    }
}
