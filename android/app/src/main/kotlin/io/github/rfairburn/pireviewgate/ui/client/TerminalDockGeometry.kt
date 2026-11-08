package io.github.rfairburn.pireviewgate.ui.client

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalKeysFloatingSize
import kotlin.math.roundToInt

/**
 * The dock-aware terminal's pure pixel arithmetic.
 *
 * Every value here comes from what the platform reports or what the current layout pass
 * measured: the reported ime inset, the safety band the layout root already consumed,
 * the stable layer extent, and a completed resize's size. Nothing remembers a previous
 * frame, a keyboard-visibility flag, or a history-dependent mode, so there is nothing
 * to clear or normalize when a panel docks, undocks, or the IME changes.
 */
internal object TerminalDockGeometry {
    private const val PERMILLE = TerminalKeysFloatingSize.MAX_PERMILLE

    /**
     * The bottom pane area a docked on-screen keyboard actually occludes, once.
     *
     * [imeBottomPx] is the platform's own reported ime bottom inset and
     * [safetyBottomPx] is the bottom safety band the layout root already consumed, so
     * the band the two share is never subtracted twice. A floating IME reports no
     * occluding bottom magnitude and therefore reserves nothing: being visible is not
     * the same as occluding, and visibility is never an input to this function.
     */
    fun imeReservePx(imeBottomPx: Int, safetyBottomPx: Int): Int =
        (imeBottomPx - safetyBottomPx).coerceAtLeast(0)

    /**
     * A remembered floating size in pixels, or `null` for the natural measured size.
     *
     * Each component is permille of the stable layer's own width or height, matching
     * [TerminalKeysFloatingSize], never permille of the space left after subtracting the
     * panel itself.
     */
    fun floatingSizePx(
        size: TerminalKeysFloatingSize?,
        stableWidth: Int,
        stableHeight: Int,
    ): IntSize? = size?.let {
        IntSize(
            width = scaleToPixels(it.widthPermille, stableWidth),
            height = scaleToPixels(it.heightPermille, stableHeight),
        )
    }

    /**
     * Keep one floating size inside the available layer and never below the panel's own
     * logical footprint, which is where a scaled panel stops shrinking so every logical
     * touch target keeps its real physical size. This is a display clamp only: it never
     * rewrites a remembered size, and the floor it applies is the footprint the panel
     * measured, not a constant.
     */
    fun clampFloatingSize(size: IntSize, maximum: IntSize, minimum: IntSize): IntSize {
        val widthFloor = minimum.width.coerceAtMost(maximum.width)
        val heightFloor = minimum.height.coerceAtMost(maximum.height)
        return IntSize(
            width = size.width.coerceIn(widthFloor, maximum.width.coerceAtLeast(widthFloor)),
            height = size.height.coerceIn(heightFloor, maximum.height.coerceAtLeast(heightFloor)),
        )
    }

    /** Apply one in-flight resize delta to the size the gesture actually started from. */
    fun resizeFloatingSize(from: IntSize, drag: Offset, maximum: IntSize, minimum: IntSize): IntSize =
        clampFloatingSize(
            IntSize(
                width = (from.width + drag.x).roundToInt(),
                height = (from.height + drag.y).roundToInt(),
            ),
            maximum = maximum,
            minimum = minimum,
        )

    /** Convert one completed resize back to permille of the stable layer extent. */
    fun toFloatingSize(sizePx: IntSize, stableWidth: Int, stableHeight: Int): TerminalKeysFloatingSize =
        TerminalKeysFloatingSize(
            widthPermille = scaleToPermille(sizePx.width, stableWidth),
            heightPermille = scaleToPermille(sizePx.height, stableHeight),
        )

    private fun scaleToPixels(permille: Int, extent: Int): Int {
        if (extent <= 0) return 0
        return ((extent.toLong() * permille + PERMILLE / 2L) / PERMILLE).toInt().coerceIn(0, extent)
    }

    private fun scaleToPermille(pixels: Int, extent: Int): Int {
        if (extent <= 0) return PERMILLE / 2
        return ((pixels.toLong() * PERMILLE + extent / 2L) / extent).toInt()
            .coerceIn(TerminalKeysFloatingSize.MIN_PERMILLE, PERMILLE)
    }
}
