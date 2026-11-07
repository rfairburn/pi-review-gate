package io.github.rfairburn.pireviewgate.core.client.ui

/**
 * What one control's layout pass measured about where it is.
 *
 * [clipped] is the bounds the platform reports for the node, with its ancestors'
 * clipping already applied; [full] is the node's own extent, unclipped. A control that
 * scrolled out of a clipping container reports a smaller, entirely on-screen fragment,
 * so requiring the full extent to survive the clipping applied to it is what rejects it.
 * Any change to either rectangle means the frame that was committed no longer shows the
 * control where the operator is looking at it now.
 */
public data class UiControlBounds(
    public val full: UiRect,
    public val clipped: UiRect,
) {
    /** True when the control reported bounds that survived clipping in both extents. */
    public val readable: Boolean get() = isFullyVisible(full, clipped)
}

/**
 * Which of a window's controls have actually been placed where a commit can show them.
 *
 * A screen-level control has no window of its own, so a commit source that certified
 * every composed control would certify one that was never drawn, and would keep
 * certifying one that scrolled, translated, or was clipped out of the frame it was
 * proven in. Observing size does not catch that: a row moving out of view is the same
 * size.
 *
 * So eligibility here comes only from a layout report. Nothing is eligible before its
 * first report, an unchanged report changes nothing, and any changed report retires that
 * one control's standing — leaving the rest of the screen's proofs alone, which is what
 * keeps unrelated owners from starving each other's actions.
 *
 * UI-thread only, like everything that knows what is drawn.
 */
public class ControlPlacementLedger {
    private val placements = HashMap<MutableUiActionProof, UiControlBounds>()

    /**
     * Record one control's measured bounds.
     *
     * Returns `true` when the control's standing was retired because its placement
     * changed — the caller must then re-arm it and await a fresh frame — and `false` when
     * the report matched what was already recorded.
     */
    public fun report(machine: MutableUiActionProof, bounds: UiControlBounds): Boolean {
        if (placements[machine] == bounds) return false
        machine.invalidate(UiProofInvalidationReason.LAYOUT_CHANGE)
        placements[machine] = bounds
        return true
    }

    /** True when this control has been placed and is not clipped out of what drew it. */
    public fun isPlaced(machine: MutableUiActionProof): Boolean = placements[machine]?.readable == true

    /** The subset of [candidates] a commit may legitimately certify. */
    public fun eligibleFrom(candidates: List<MutableUiActionProof>): List<MutableUiActionProof> =
        candidates.filter { isPlaced(it) }

    /**
     * State this control's readability from its own placement.
     *
     * Every control this ledger serves is identity-free — it has no critical line to be
     * measured — so being placed and unclipped is the whole requirement, and an
     * unplaced or clipped control states `false` rather than being skipped.
     */
    public fun publishReadability(machine: MutableUiActionProof) {
        machine.setCriticalIdentityReadable(isPlaced(machine))
    }

    /** Forget one control: it left composition, so its placement proves nothing. */
    public fun forget(machine: MutableUiActionProof?) {
        placements.remove(machine)
    }

    /** Forget everything: the window is going away. */
    public fun clear() {
        placements.clear()
    }
}
