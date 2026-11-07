package io.github.rfairburn.pireviewgate.core.client.ui.placement

/**
 * The three independently movable terminal overlays.
 *
 * The values are display-only identities. Nothing here names a host, session,
 * control action, input target, or coverage state.
 */
public enum class TerminalOverlay {
    CONTROLS,
    STATUS,
    KEYS,
    ;

    /** Stable wire name used only by the private UI placement document. */
    public val wireName: String
        get() = when (this) {
            CONTROLS -> "controls"
            STATUS -> "status"
            KEYS -> "keys"
        }

    public companion object {
        /** Parse a persisted wire name, or `null` for anything else. */
        public fun fromWireName(value: String): TerminalOverlay? = when (value) {
            "controls" -> CONTROLS
            "status" -> STATUS
            "keys" -> KEYS
            else -> null
        }
    }
}

/** The two orientations that own independent overlay positions. */
public enum class TerminalOverlayOrientation {
    PORTRAIT,
    LANDSCAPE,
    ;

    /** Stable wire name used only by the private UI placement document. */
    public val wireName: String
        get() = when (this) {
            PORTRAIT -> "portrait"
            LANDSCAPE -> "landscape"
        }

    public companion object {
        /** Parse a persisted wire name, or `null` for anything else. */
        public fun fromWireName(value: String): TerminalOverlayOrientation? = when (value) {
            "portrait" -> PORTRAIT
            "landscape" -> LANDSCAPE
            else -> null
        }
    }
}

/**
 * One overlay's top-left point in the free space of its available layer.
 *
 * Both components are permille of the free space, so `0` is the leading/top edge,
 * `1000` is the trailing/bottom edge, and `500` is centered. Free space already
 * subtracts the overlay's own measured size, so the whole overlay remains inside the
 * layer at any density, font scale, or orientation. A coordinate is placement data
 * only: it never identifies an input source or grants any action.
 */
public data class TerminalOverlayPosition(
    public val xPermille: Int,
    public val yPermille: Int,
) {
    init {
        require(xPermille in 0..MAX_PERMILLE) { "x permille out of range" }
        require(yPermille in 0..MAX_PERMILLE) { "y permille out of range" }
    }

    public companion object {
        /** Inclusive bound for both permille components. */
        public const val MAX_PERMILLE: Int = 1000

        /** Leading edge. */
        public const val LEADING: Int = 0

        /** Centered. */
        public const val CENTER: Int = 500

        /** Trailing edge. */
        public const val TRAILING: Int = 1000
    }
}

/**
 * The complete six-slot UI placement state: one position or default slot for each
 * overlay in each orientation.
 *
 * `null` means "this slot has never been moved" and therefore keeps its existing
 * layout default. Defaults are deliberately not frozen coordinates: the status
 * notice keeps its existing place directly below the controls slot even when the
 * controls strip is moved somewhere else, and the Keys panel keeps its existing
 * bottom-center slot. An explicit position is remembered across restarts.
 *
 * This type is UI-only cosmetic state. It has no host, trust, identity, session,
 * ordering, viewport, input, or proof field, and no operation here touches any of
 * those documents.
 */
public data class TerminalOverlayPlacement(
    public val controlsPortrait: TerminalOverlayPosition? = null,
    public val controlsLandscape: TerminalOverlayPosition? = null,
    public val statusPortrait: TerminalOverlayPosition? = null,
    public val statusLandscape: TerminalOverlayPosition? = null,
    public val keysPortrait: TerminalOverlayPosition? = null,
    public val keysLandscape: TerminalOverlayPosition? = null,
) {
    /** The explicit position for one overlay/orientation slot, or `null` when it is a default slot. */
    public fun position(
        overlay: TerminalOverlay,
        orientation: TerminalOverlayOrientation,
    ): TerminalOverlayPosition? = when (overlay) {
        TerminalOverlay.CONTROLS -> when (orientation) {
            TerminalOverlayOrientation.PORTRAIT -> controlsPortrait
            TerminalOverlayOrientation.LANDSCAPE -> controlsLandscape
        }
        TerminalOverlay.STATUS -> when (orientation) {
            TerminalOverlayOrientation.PORTRAIT -> statusPortrait
            TerminalOverlayOrientation.LANDSCAPE -> statusLandscape
        }
        TerminalOverlay.KEYS -> when (orientation) {
            TerminalOverlayOrientation.PORTRAIT -> keysPortrait
            TerminalOverlayOrientation.LANDSCAPE -> keysLandscape
        }
    }

    /** Replace exactly one slot, leaving the other five independently untouched. */
    public fun withPosition(
        overlay: TerminalOverlay,
        orientation: TerminalOverlayOrientation,
        position: TerminalOverlayPosition,
    ): TerminalOverlayPlacement = when (overlay) {
        TerminalOverlay.CONTROLS -> when (orientation) {
            TerminalOverlayOrientation.PORTRAIT -> copy(controlsPortrait = position)
            TerminalOverlayOrientation.LANDSCAPE -> copy(controlsLandscape = position)
        }
        TerminalOverlay.STATUS -> when (orientation) {
            TerminalOverlayOrientation.PORTRAIT -> copy(statusPortrait = position)
            TerminalOverlayOrientation.LANDSCAPE -> copy(statusLandscape = position)
        }
        TerminalOverlay.KEYS -> when (orientation) {
            TerminalOverlayOrientation.PORTRAIT -> copy(keysPortrait = position)
            TerminalOverlayOrientation.LANDSCAPE -> copy(keysLandscape = position)
        }
    }

    public companion object {
        /** Every slot still in its existing layout default. */
        public val DEFAULT: TerminalOverlayPlacement = TerminalOverlayPlacement()
    }
}

/** One integer top-left point in layer pixels. */
public data class TerminalOverlayPoint(
    public val x: Int,
    public val y: Int,
)

/**
 * Pure placement math shared by the UI and its off-device checks.
 *
 * Resolution always uses the stable layer (the terminal pane's own bounds), never
 * the transient IME-adjusted layer. The result is then clamped into the visible
 * layer, so the soft keyboard can push an overlay on screen but can never rewrite
 * its remembered position or request a pane reflow.
 */
public object TerminalOverlayGeometry {
    private const val PERMILLE = TerminalOverlayPosition.MAX_PERMILLE

    /** Free horizontal space for [overlayWidth] inside [containerWidth], never negative. */
    public fun freeWidth(containerWidth: Int, overlayWidth: Int): Int =
        (containerWidth - overlayWidth).coerceAtLeast(0)

    /** Free vertical space for [overlayHeight] inside [containerHeight], never negative. */
    public fun freeHeight(containerHeight: Int, overlayHeight: Int): Int =
        (containerHeight - overlayHeight).coerceAtLeast(0)

    /**
     * The existing layout default for one overlay.
     *
     * Controls keep the top-end slot, the notice keeps its top-end slot immediately
     * below the controls slot measured by [controlsSlotHeight] (not its current
     * position), and Keys keeps the bottom-center slot. Moving one overlay therefore
     * never moves another.
     */
    public fun resolveDefault(
        overlay: TerminalOverlay,
        stableWidth: Int,
        stableHeight: Int,
        overlayWidth: Int,
        overlayHeight: Int,
        controlsSlotHeight: Int,
    ): TerminalOverlayPoint {
        val freeWidth = freeWidth(stableWidth, overlayWidth)
        val freeHeight = freeHeight(stableHeight, overlayHeight)
        return when (overlay) {
            TerminalOverlay.CONTROLS -> TerminalOverlayPoint(freeWidth, 0)
            TerminalOverlay.STATUS -> TerminalOverlayPoint(
                x = freeWidth,
                y = controlsSlotHeight.coerceIn(0, freeHeight),
            )
            TerminalOverlay.KEYS -> TerminalOverlayPoint(x = freeWidth / 2, y = freeHeight)
        }
    }

    /** Resolve one remembered position against the stable layer's free space. */
    public fun resolve(
        stableWidth: Int,
        stableHeight: Int,
        overlayWidth: Int,
        overlayHeight: Int,
        position: TerminalOverlayPosition,
    ): TerminalOverlayPoint = TerminalOverlayPoint(
        x = scaleToPixels(freeWidth(stableWidth, overlayWidth), position.xPermille),
        y = scaleToPixels(freeHeight(stableHeight, overlayHeight), position.yPermille),
    )

    /**
     * Clamp one point into the currently visible free space.
     *
     * The IME may reduce this layer; a clamped display point is never written back
     * as a new remembered position by presentation alone. [minimumY] keeps one overlay
     * below a higher-priority visible slot when a short layer would otherwise cover its
     * only usable viewport; it is a display floor, not persisted placement data.
     */
    public fun clampToVisible(
        point: TerminalOverlayPoint,
        visibleWidth: Int,
        visibleHeight: Int,
        overlayWidth: Int,
        overlayHeight: Int,
        minimumY: Int = 0,
    ): TerminalOverlayPoint {
        val maximumY = freeHeight(visibleHeight, overlayHeight)
        val floorY = minimumY.coerceIn(0, maximumY)
        return TerminalOverlayPoint(
            x = point.x.coerceIn(0, freeWidth(visibleWidth, overlayWidth)),
            y = point.y.coerceIn(floorY, maximumY),
        )
    }

    /** Convert one completed drag's visible point back to stable-layer permille. */
    public fun toPosition(
        point: TerminalOverlayPoint,
        stableWidth: Int,
        stableHeight: Int,
        overlayWidth: Int,
        overlayHeight: Int,
    ): TerminalOverlayPosition = TerminalOverlayPosition(
        xPermille = scaleToPermille(freeWidth(stableWidth, overlayWidth), point.x),
        yPermille = scaleToPermille(freeHeight(stableHeight, overlayHeight), point.y),
    )

    private fun scaleToPixels(freeSpace: Int, permille: Int): Int {
        if (freeSpace <= 0) return 0
        val scaled = (freeSpace.toLong() * permille + PERMILLE / 2L) / PERMILLE
        return scaled.toInt().coerceIn(0, freeSpace)
    }

    private fun scaleToPermille(freeSpace: Int, pixels: Int): Int {
        if (freeSpace <= 0) return TerminalOverlayPosition.CENTER
        val scaled = (pixels.toLong() * PERMILLE + freeSpace / 2L) / freeSpace
        return scaled.toInt().coerceIn(0, PERMILLE)
    }
}

/** The only two user-facing placement conditions worth a notice: defaulted load and failed save. */
public enum class TerminalOverlayPlacementWarning {
    /** The saved UI placement could not be read; defaults are in use until a save succeeds. */
    LOADED_DEFAULTS,

    /** A completed drag is on screen, but it was not published and is not claimed as saved. */
    SAVE_FAILED,
}
