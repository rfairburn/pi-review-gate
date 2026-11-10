package io.github.rfairburn.pireviewgate.core.client.ui

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The containment rule behind "the critical identity was in the committed frame".
 *
 * A line can be measured at full height and still never reach the screen: clipped by a
 * scroll viewport, clipped by an ancestor, or hanging off the window edge. Measuring
 * height alone said "readable" for every one of those, which is how an approval could
 * end up standing for a fingerprint nobody had fully looked at.
 */
class UiVisibilityContractTest {

    private val viewport = UiRect(left = 0f, top = 0f, right = 360f, bottom = 640f)

    @Test
    fun `content fully inside the viewport is visible`() {
        assertTrue(isFullyVisible(UiRect(12f, 40f, 300f, 64f), viewport))
    }

    @Test
    fun `content exactly on the viewport edges is visible`() {
        assertTrue(isFullyVisible(UiRect(0f, 0f, 360f, 640f), viewport))
    }

    @Test
    fun `a line scrolled above the viewport is not visible`() {
        // The usual case for a long consent sheet: the text is laid out in full, the
        // scroll container has simply carried it out of sight.
        assertFalse(isFullyVisible(UiRect(12f, -60f, 300f, -36f), viewport))
        assertFalse(isFullyVisible(UiRect(12f, -20f, 300f, 24f), viewport))
    }

    @Test
    fun `a line clipped at the bottom of the viewport is not visible`() {
        assertFalse(isFullyVisible(UiRect(12f, 600f, 300f, 660f), viewport))
    }

    @Test
    fun `a line clipped at either side is not visible`() {
        assertFalse(isFullyVisible(UiRect(-8f, 40f, 300f, 64f), viewport))
        assertFalse(isFullyVisible(UiRect(12f, 40f, 372f, 64f), viewport))
    }

    @Test
    fun `content taller than the viewport is never visible`() {
        assertFalse(isFullyVisible(UiRect(12f, 0f, 300f, 900f), viewport))
    }

    @Test
    fun `tolerance absorbs sub-pixel rounding but not a partially visible line`() {
        // 0.4f px of overhang is layout rounding.
        assertTrue(isFullyVisible(UiRect(12f, -0.4f, 300f, 64f), viewport))
        // Two pixels of a real line is a line the operator cannot read.
        assertFalse(isFullyVisible(UiRect(12f, -2f, 300f, 64f), viewport))
    }

    @Test
    fun `a degenerate viewport proves nothing`() {
        val flat = UiRect(0f, 0f, 360f, 0f)
        val empty = UiRect(0f, 0f, 0f, 0f)
        assertFalse(isFullyVisible(UiRect(12f, 40f, 300f, 64f), flat))
        assertFalse(isFullyVisible(UiRect(12f, 40f, 300f, 64f), empty))
    }

    @Test
    fun `a degenerate line proves nothing`() {
        assertFalse(isFullyVisible(UiRect(12f, 40f, 12f, 64f), viewport))
        assertFalse(isFullyVisible(UiRect(12f, 40f, 300f, 40f), viewport))
    }

    @Test
    fun `a negative tolerance is refused rather than treated as slack`() {
        assertFalse(isFullyVisible(UiRect(12f, 40f, 300f, 64f), viewport, tolerancePx = -1f))
    }

    // -- what the adapter actually measures ---------------------------------------

    @Test
    fun `a full-height line partially clipped by its scroll ancestor is not readable`() {
        // The node is 80f tall and laid out fully. Its scroll ancestor clips away the
        // top 40f, so the platform reports only the lower half — a small rectangle that
        // sits entirely inside the viewport. Comparing that fragment with the viewport
        // is the error this pins: it would call a half-scrolled fingerprint readable.
        val full = UiRect(12f, -40f, 300f, 40f)
        val clipped = UiRect(12f, 0f, 300f, 40f)
        val observation = CriticalLineObservation(full = full, clipped = clipped, internallyClipped = false)

        assertFalse(observation.isReadable(viewport))
        // The old rule, for contrast: the clipped fragment alone does fit the viewport.
        assertTrue(isFullyVisible(clipped, viewport))
    }

    @Test
    fun `a line whose full extent survived clipping and lies in the viewport is readable`() {
        val rect = UiRect(12f, 100f, 300f, 180f)
        assertTrue(
            CriticalLineObservation(full = rect, clipped = rect, internallyClipped = false).isReadable(viewport),
        )
    }

    @Test
    fun `a line scrolled entirely out reports nothing readable`() {
        val full = UiRect(12f, -120f, 300f, -40f)
        // Fully clipped away: the reported bounds collapse to no extent.
        val clipped = UiRect(12f, 0f, 300f, 0f)
        assertFalse(
            CriticalLineObservation(full = full, clipped = clipped, internallyClipped = false).isReadable(viewport),
        )
    }

    @Test
    fun `a line the box did not give its required height is not readable`() {
        val squeezed = UiRect(12f, 100f, 300f, 120f)
        assertFalse(
            CriticalLineObservation(full = squeezed, clipped = squeezed, internallyClipped = true)
                .isReadable(viewport),
        )
    }

    @Test
    fun `a line outside the viewport is not readable even when nothing clipped it`() {
        val full = UiRect(12f, 700f, 300f, 780f)
        assertFalse(
            CriticalLineObservation(full = full, clipped = full, internallyClipped = false).isReadable(viewport),
        )
    }
}
