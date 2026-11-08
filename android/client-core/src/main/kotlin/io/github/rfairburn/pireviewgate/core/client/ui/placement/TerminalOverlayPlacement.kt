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
 * One Keys panel's remembered floating size, as permille of its stable layer extent.
 *
 * Unlike [TerminalOverlayPosition], each component is permille of the stable layer's
 * own width or height, never of the free space left after subtracting the overlay: a
 * size is what the panel measured while floating, so `1000` means "as wide or as tall
 * as the layer itself" and `500` means half of it. Both components are at least
 * [MIN_PERMILLE], so a remembered size can never collapse to an invisible panel. A
 * size is cosmetic placement data only: it names no host, session, input target, or
 * action, and nothing here converts it into pixels.
 */
public data class TerminalKeysFloatingSize(
    public val widthPermille: Int,
    public val heightPermille: Int,
) {
    init {
        require(widthPermille in MIN_PERMILLE..MAX_PERMILLE) { "width permille out of range" }
        require(heightPermille in MIN_PERMILLE..MAX_PERMILLE) { "height permille out of range" }
    }

    public companion object {
        /** Inclusive upper bound for both permille components. */
        public const val MAX_PERMILLE: Int = 1000

        /** Inclusive lower bound for both permille components: a remembered size never collapses. */
        public const val MIN_PERMILLE: Int = 1
    }
}

/**
 * The Keys panel's remembered cosmetic layout in one orientation.
 *
 * `docked` is the two-state layout: docked Keys keeps its existing bottom slot,
 * floating Keys is movable and resizable. `floatingSize` is the last remembered
 * floating size, or `null` for the natural measured size. Both survive docking, so
 * popping Keys back out returns it at its remembered size, and docking never clears
 * the remembered [TerminalOverlayPosition] either. The default is today's behavior:
 * docked with no remembered size.
 *
 * This is the only Keys layout state. There is no second mode flag and no second
 * store, and nothing here carries open/close, modifier, or dismissed state.
 */
public data class TerminalKeysLayout(
    public val docked: Boolean = true,
    public val floatingSize: TerminalKeysFloatingSize? = null,
) {
    public companion object {
        /** Docked, with the natural floating size. */
        public val DEFAULT: TerminalKeysLayout = TerminalKeysLayout()
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
 * The two Keys layouts are the docking state and remembered floating size in each
 * orientation, remembered per orientation alongside their own positions. They are
 * appended rather than becoming a seventh position slot: an untouched Keys layout is
 * [TerminalKeysLayout.DEFAULT], which is exactly today's docked behavior.
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
    public val keysPortraitLayout: TerminalKeysLayout = TerminalKeysLayout.DEFAULT,
    public val keysLandscapeLayout: TerminalKeysLayout = TerminalKeysLayout.DEFAULT,
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

    /** The remembered Keys layout for one orientation. Keys is the only overlay that has one. */
    public fun keysLayout(orientation: TerminalOverlayOrientation): TerminalKeysLayout =
        when (orientation) {
            TerminalOverlayOrientation.PORTRAIT -> keysPortraitLayout
            TerminalOverlayOrientation.LANDSCAPE -> keysLandscapeLayout
        }

    /**
     * Replace exactly one orientation's Keys layout.
     *
     * All six remembered positions are preserved: a docking toggle or a resize never
     * rewrites or clears a remembered position, and the other orientation's Keys
     * layout stays independently untouched.
     */
    public fun withKeysLayout(
        orientation: TerminalOverlayOrientation,
        layout: TerminalKeysLayout,
    ): TerminalOverlayPlacement = when (orientation) {
        TerminalOverlayOrientation.PORTRAIT -> copy(keysPortraitLayout = layout)
        TerminalOverlayOrientation.LANDSCAPE -> copy(keysLandscapeLayout = layout)
    }

    public companion object {
        /** Every slot still in its existing layout default, Keys docked in both orientations. */
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
 * Resolution always uses the stable layer, never a transient one. The result is then
 * clamped into the extent the caller reports as actually visible, so a real docked
 * reservation — a reported occluding keyboard inset or a bottom-docked panel band — can
 * move an overlay on screen but can never rewrite its remembered position or request a
 * pane reflow.
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
     * The caller passes the extent the platform actually leaves visible: the stable
     * layer minus whatever is really docked inside it, such as a reported occluding
     * keyboard inset or a bottom-docked panel band. A clamped display point is never
     * written back as a new remembered position by presentation alone, and nothing here
     * keeps history or imposes a floor beyond that measured extent.
     */
    public fun clampToVisible(
        point: TerminalOverlayPoint,
        visibleWidth: Int,
        visibleHeight: Int,
        overlayWidth: Int,
        overlayHeight: Int,
    ): TerminalOverlayPoint = TerminalOverlayPoint(
        x = point.x.coerceIn(0, freeWidth(visibleWidth, overlayWidth)),
        y = point.y.coerceIn(0, freeHeight(visibleHeight, overlayHeight)),
    )

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
