package io.github.rfairburn.pireviewgate.core.client.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Which controls a shared per-window commit may certify, by where they were measured.
 *
 * A screen-level control has no window of its own, so the only honest floor for it is
 * its own placement report. These cases are the ones a size-only observer misses: a row
 * that scrolled out of view is exactly as large as it was, and a control that composed
 * but was never laid out has never appeared in any frame at all.
 */
class ControlPlacementContractTest {

    private val visible = UiRect(12f, 100f, 300f, 148f)
    private val moved = UiRect(12f, 620f, 300f, 668f) // same size, different place
    private val clipped = UiRect(12f, 100f, 300f, 120f) // top of the same control cut off

    private fun proof(row: String) = MutableUiActionProof(ClientUiFixtures.token(rowId = row))

    /** The adapter's arm sequence for one identity-free control. */
    private fun arm(machine: MutableUiActionProof, placements: ControlPlacementLedger): Long {
        val epoch = machine.beginDraw()
        placements.publishReadability(machine)
        return epoch
    }

    /**
     * The adapter's placement sequence: a changed report retires the control, and its
     * re-arm restates readability and begins the pass the next commit will certify.
     */
    private fun positioned(
        placements: ControlPlacementLedger,
        machine: MutableUiActionProof,
        bounds: UiControlBounds,
    ): Long? {
        if (!placements.report(machine, bounds)) return null
        return arm(machine, placements)
    }

    /** Bring one control to a proven state: placed, armed, committed. */
    private fun proven(
        placements: ControlPlacementLedger,
        machine: MutableUiActionProof,
        bounds: UiControlBounds = UiControlBounds(full = visible, clipped = visible),
    ): Long = assertNotNull(positioned(placements, machine, bounds)).also { machine.markCommitted(it) }

    @Test
    fun `a control that has not been placed is never eligible and never grants`() {
        val placements = ControlPlacementLedger()
        val machine = proof("row-1")
        val gate = PresentationGate(machine, requiredCriticalLines = 0)
        arm(machine, placements)

        assertFalse(placements.isPlaced(machine))
        assertEquals(emptyList(), placements.eligibleFrom(listOf(machine)))
        assertFalse(machine.criticalIdentityReadable)
        // Even a commit cannot rescue it: nothing drew this control, so nothing was proven.
        machine.markCommitted(machine.epoch)
        assertFalse(gate.attempt())
    }

    @Test
    fun `a placed control becomes eligible and grants on the next commit`() {
        val placements = ControlPlacementLedger()
        val machine = proof("row-1")
        val gate = PresentationGate(machine, requiredCriticalLines = 0)
        arm(machine, placements)

        assertTrue(placements.report(machine, UiControlBounds(visible, visible)))
        assertTrue(placements.isPlaced(machine))
        assertEquals(listOf(machine), placements.eligibleFrom(listOf(machine)))
        // Re-arming after the report is what restates readability for the new pass.
        arm(machine, placements)
        assertTrue(machine.criticalIdentityReadable)

        val epoch = assertNotNull(gate.rearm())
        assertFalse(gate.attempt())
        assertTrue(machine.markCommitted(epoch))
        assertTrue(gate.attempt())
    }

    @Test
    fun `a same-sized move retires the control immediately`() {
        val placements = ControlPlacementLedger()
        val machine = proof("row-1")
        val gate = PresentationGate(machine, requiredCriticalLines = 0)
        proven(placements, machine)
        assertTrue(gate.attempt())

        // Same width and height, different place: scrolling or translation. Size alone
        // would see nothing, and the old standing would keep proving a frame that no
        // longer shows the control.
        assertNotNull(positioned(placements, machine, UiControlBounds(moved, moved)))
        assertFalse(machine.hasCommittedFrame)
        assertFalse(gate.attempt())
    }

    @Test
    fun `an unchanged report does not disturb a proven control`() {
        val placements = ControlPlacementLedger()
        val machine = proof("row-1")
        val gate = PresentationGate(machine, requiredCriticalLines = 0)
        proven(placements, machine)

        assertFalse(placements.report(machine, UiControlBounds(visible, visible)))
        assertTrue(gate.attempt())
    }

    @Test
    fun `a clipped control is not eligible and cannot grant`() {
        val placements = ControlPlacementLedger()
        val machine = proof("row-1")
        val gate = PresentationGate(machine, requiredCriticalLines = 0)
        proven(placements, machine)
        assertTrue(gate.attempt())

        // The control's own extent is unchanged; what reached the screen was cut short.
        assertNotNull(positioned(placements, machine, UiControlBounds(full = visible, clipped = clipped)))
        assertFalse(placements.isPlaced(machine))
        assertEquals(emptyList(), placements.eligibleFrom(listOf(machine)))
        assertFalse(machine.criticalIdentityReadable)
        machine.markCommitted(machine.epoch)
        assertFalse(gate.attempt())
    }

    @Test
    fun `a control that becomes visible again is restored by the next commit`() {
        val placements = ControlPlacementLedger()
        val machine = proof("row-1")
        val gate = PresentationGate(machine, requiredCriticalLines = 0)
        proven(placements, machine)
        assertNotNull(positioned(placements, machine, UiControlBounds(full = visible, clipped = clipped)))
        assertFalse(gate.attempt())

        assertNotNull(positioned(placements, machine, UiControlBounds(visible, visible)))
        assertTrue(placements.isPlaced(machine))
        val epoch = assertNotNull(gate.rearm())
        assertTrue(machine.markCommitted(epoch))
        assertTrue(gate.attempt())
    }

    @Test
    fun `one control moving does not disturb another control's standing`() {
        val placements = ControlPlacementLedger()
        val stable = proof("row-stable")
        val shifting = proof("row-shifting")
        val stableGate = PresentationGate(stable, requiredCriticalLines = 0)
        proven(placements, stable)
        proven(placements, shifting)

        assertNotNull(positioned(placements, shifting, UiControlBounds(moved, moved)))

        assertTrue(stable.hasCommittedFrame)
        assertTrue(stableGate.attempt())
        assertTrue(placements.isPlaced(stable))
        assertFalse(shifting.hasCommittedFrame)
    }

    @Test
    fun `a control leaving composition stops being eligible`() {
        val placements = ControlPlacementLedger()
        val machine = proof("row-1")
        proven(placements, machine)
        assertTrue(placements.isPlaced(machine))

        placements.forget(machine)
        assertFalse(placements.isPlaced(machine))
        assertEquals(emptyList(), placements.eligibleFrom(listOf(machine)))

        placements.clear()
    }
}
