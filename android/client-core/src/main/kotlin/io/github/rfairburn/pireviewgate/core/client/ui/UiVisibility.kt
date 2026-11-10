package io.github.rfairburn.pireviewgate.core.client.ui

/**
 * One axis-aligned rectangle in a single coordinate space, as measured by the layout
 * pass. The adapter supplies both rectangles in the same space (window coordinates),
 * so the containment rule below needs no conversion and no platform type.
 */
public data class UiRect(
    public val left: Float,
    public val top: Float,
    public val right: Float,
    public val bottom: Float,
) {
    public val width: Float get() = right - left
    public val height: Float get() = bottom - top

    /** True when the rectangle has a real extent in both directions. */
    public val isDegenerate: Boolean get() = width <= 0f || height <= 0f
}

/**
 * What one layout pass actually measured about one critical line.
 *
 * Two different rectangles come out of a real view tree and comparing the wrong pair is
 * how a half-scrolled fingerprint passes. `clipped` is the node's bounds *after* its
 * ancestors' clipping — a partially scrolled line reports a small, entirely on-screen
 * rectangle, so asking whether that fits in the viewport says "yes" about content that
 * was cut off. `full` is the node's own extent unclipped.
 *
 * So a line is readable only when its full extent survived the clipping that was
 * applied to it — full equals clipped, within rounding — and its full extent also fits
 * inside the viewport. Anything else reports unreadable.
 */
public data class CriticalLineObservation(
    /** The node's own bounds, unclipped. */
    public val full: UiRect,
    /** The same node's bounds as the platform reports them, after ancestor clipping. */
    public val clipped: UiRect,
    /** True when the node was not given the height its own text needs. */
    public val internallyClipped: Boolean,
) {
    /** True when the whole line survived clipping and lies inside [viewport]. */
    public fun isReadable(viewport: UiRect): Boolean =
        !internallyClipped && isFullyVisible(full, clipped) && isFullyVisible(full, viewport)
}

/**
 * True only when [content] lies entirely inside [viewport].
 *
 * This is the rule behind "the critical identity is actually in the committed frame":
 * a line that is measured fully and then clipped by a scroll viewport, a clipping
 * ancestor, or the window edge is not readable, and a gate that requires it must
 * withhold its grant. Anything degenerate fails closed — a zero-size viewport or a
 * zero-size line proves nothing.
 *
 * [tolerancePx] absorbs sub-pixel layout rounding only; it is not slack for a
 * partially visible line, which is a whole-pixel failure.
 */
public fun isFullyVisible(
    content: UiRect,
    viewport: UiRect,
    tolerancePx: Float = 0.5f,
): Boolean {
    if (content.isDegenerate || viewport.isDegenerate) return false
    if (tolerancePx < 0f) return false
    return content.left >= viewport.left - tolerancePx &&
        content.top >= viewport.top - tolerancePx &&
        content.right <= viewport.right + tolerancePx &&
        content.bottom <= viewport.bottom + tolerancePx
}
