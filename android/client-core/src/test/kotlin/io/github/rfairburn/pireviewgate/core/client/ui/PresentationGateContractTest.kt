package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The decided policy behind a commit-gated control.
 *
 * These cases exist because the first pass got three of them wrong in ways a device
 * would only reveal as a button that never works or an approval that fires on content
 * nobody looked at: a dialog treating its own modality as coverage over itself, a form
 * with no identity line being denied a grant it should have, and an invalidation that
 * re-armed before it retired.
 */
class PresentationGateContractTest {

    private fun machine(screen: UiProofScreen = UiProofScreen.HOST_ADD_FORM) =
        MutableUiActionProof(ClientUiFixtures.token(screen))

    /** Bring a gate to a spendable state the way the adapter does: rearm, then commit. */
    private fun spendable(requiredCriticalLines: Int = 0): Pair<PresentationGate, MutableUiActionProof> {
        val proof = machine()
        val gate = PresentationGate(proof, requiredCriticalLines)
        val epoch = gate.rearm()
        assertNotNull(epoch)
        proof.markCommitted(epoch)
        return gate to proof
    }

    // -- a form that can actually be submitted ------------------------------------

    @Test
    fun `an identity-free gate grants after rearming and a real commit`() {
        // No test-side publication: re-arming is what states the readability of a gate
        // that requires no identity line, because there is nothing to wait to be
        // measured. Add host, Saved actions, and terminal selection depend on this.
        val proof = machine()
        val gate = PresentationGate(proof, requiredCriticalLines = 0)
        assertFalse(proof.criticalIdentityReadable)
        val epoch = gate.rearm()
        assertNotNull(epoch)
        assertTrue(proof.criticalIdentityReadable)
        assertFalse(gate.attempt())

        proof.markCommitted(epoch)
        assertTrue(gate.attempt())
        assertTrue(proof.grantsFor(proof.target))
    }

    @Test
    fun `a transient invalidation is restored by the next rearm and commit`() {
        val (gate, proof) = spendable()
        assertTrue(gate.attempt())

        val next = assertNotNull(gate.onScroll())
        assertFalse(gate.attempt())
        assertTrue(proof.criticalIdentityReadable, "readability is restated on re-arm")

        proof.markCommitted(next)
        assertTrue(gate.attempt())
    }

    @Test
    fun `a critical line whose verdict did not change is still published for the new pass`() {
        val (gate, proof) = spendable(requiredCriticalLines = 1)
        assertNotNull(gate.reportCriticalLine("row", visible = true))
        assertTrue(gate.attempt())

        val next = assertNotNull(gate.onLayoutChange())
        assertFalse(gate.attempt())
        // The layout pass reports the same verdict again; skipping publication because
        // it is unchanged would leave the new generation permanently unreadable.
        gate.reportCriticalLine("row", visible = true)
        proof.markCommitted(next)
        assertTrue(gate.attempt())
    }

    @Test
    fun `a required identity line that was never measured withholds the grant`() {
        val proof = machine(UiProofScreen.HOST_FIRST_CONTACT_CONSENT)
        val gate = PresentationGate(proof, requiredCriticalLines = 3)
        val epoch = gate.rearm()
        assertNotNull(epoch)
        proof.markCommitted(epoch)
        // Committed, but nothing has reported being fully visible yet.
        assertFalse(gate.attempt())

        gate.reportCriticalLine("label", visible = true)
        gate.reportCriticalLine("endpoint", visible = true)
        assertFalse(gate.attempt())

        gate.reportCriticalLine("fingerprint", visible = true)
        assertTrue(gate.attempt())
    }

    @Test
    fun `one clipped identity line withholds the whole grant`() {
        val (gate, _) = spendable(requiredCriticalLines = 2)
        gate.reportCriticalLine("label", visible = true)
        gate.reportCriticalLine("endpoint", visible = true)
        assertTrue(gate.attempt())

        // The same line scrolled or clipped out afterwards: the frame the operator
        // compared is gone, so the control stops being spendable.
        gate.reportCriticalLine("endpoint", visible = false)
        assertFalse(gate.attempt())
    }

    @Test
    fun `a line reported visible but short of the required count withholds the grant`() {
        val proof = machine(UiProofScreen.SESSION_RENAME)
        val gate = PresentationGate(proof, requiredCriticalLines = 1)
        val epoch = gate.rearm()
        assertNotNull(epoch)
        proof.markCommitted(epoch)
        assertFalse(gate.attempt())
        gate.reportCriticalLine("row", visible = true)
        assertTrue(gate.attempt())
    }

    // -- coverage: self is not coverage ----------------------------------------

    @Test
    fun `a dialog is not covered by the screen underneath it`() {
        val (gate, proof) = spendable()
        assertFalse(gate.covered)
        assertTrue(gate.attempt())
        assertTrue(proof.isCurrent)
    }

    @Test
    fun `a further window on top retires the standing and never restores it`() {
        val (gate, proof) = spendable()
        gate.onCoveredChanged(covering = true)
        assertTrue(gate.covered)
        assertFalse(gate.attempt())
        assertFalse(proof.isCurrent)
        assertFalse(proof.grantsFor(proof.target))

        // Coverage ending does not resurrect this standing: a control that was under
        // another window has to be drawn again as a new proof.
        gate.onCoveredChanged(covering = false)
        assertFalse(gate.attempt())
        assertNull(gate.rearm())
    }

    @Test
    fun `only a dialog composed above counts as coverage over a dialog`() {
        val none = ClientDialogs.NONE
        assertFalse(none.isCovered(ClientDialogKind.ADD_HOST))

        val single = none.copy(addHost = addHostDialog())
        // The reviewer's regression: the dialog is the modal over the terminal, and
        // treating that as coverage over itself retired its own proof and made the
        // form impossible to submit.
        assertEquals(listOf(ClientDialogKind.ADD_HOST), single.openKinds)
        assertFalse(single.isCovered(ClientDialogKind.ADD_HOST))

        val stacked = single.copy(removeHost = removeHostDialog())
        assertEquals(listOf(ClientDialogKind.ADD_HOST, ClientDialogKind.REMOVE_HOST), stacked.openKinds)
        assertTrue(stacked.isCovered(ClientDialogKind.ADD_HOST))
        assertFalse(stacked.isCovered(ClientDialogKind.REMOVE_HOST))
    }

    // -- invalidate first, then re-arm -----------------------------------------

    @Test
    fun `a layout change retires the standing before a new pass is due`() {
        val (gate, proof) = spendable()
        val staleEpoch = proof.epoch
        assertTrue(gate.attempt())

        val nextEpoch = gate.onLayoutChange()
        assertNotNull(nextEpoch)
        assertTrue(nextEpoch > staleEpoch)
        // The flip happened first and atomically: a reader now sees no committed frame.
        assertFalse(proof.hasCommittedFrame)
        assertFalse(gate.attempt())

        // A commit report for the superseded pass cannot restore it.
        proof.markCommitted(staleEpoch)
        assertFalse(gate.attempt())

        proof.markCommitted(nextEpoch)
        assertTrue(gate.attempt())
    }

    @Test
    fun `scroll focus and semantic changes each retire the standing`() {
        val changes: List<Pair<String, (PresentationGate) -> Long?>> = listOf(
            "scroll" to { gate -> gate.onScroll() },
            "focus" to { gate -> gate.onFocusLost() },
            "semantic" to { gate -> gate.onSemanticPresentationChange() },
        )
        changes.forEach { (name, change) ->
            val (gate, proof) = spendable()
            assertTrue(gate.attempt(), "$name: spendable before the change")
            val next = change(gate)
            assertNotNull(next, "$name: a fresh pass is due")
            assertFalse(proof.hasCommittedFrame, "$name: the old frame proves nothing")
            assertFalse(gate.attempt(), "$name: not spendable after $name")
        }
    }

    @Test
    fun `a retired proof is never re-armed by the gate`() {
        val proof = machine()
        val gate = PresentationGate(proof, requiredCriticalLines = 0)
        assertNotNull(gate.rearm())
        proof.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
        assertNull(gate.rearm())
        assertFalse(gate.attempt())
    }

    @Test
    fun `a proof the gate cannot arm is consulted honestly and fails closed`() {
        val foreign = ClientUiFixtures.FakeProof(
            target = ClientUiFixtures.token(),
            current = true,
            committed = false,
            readable = false,
        )
        val gate = PresentationGate(foreign, requiredCriticalLines = 0)
        assertNull(gate.rearm())
        assertNull(gate.publishReadability())
        assertNull(gate.onLayoutChange())
        assertFalse(gate.attempt())
    }

    @Test
    fun `readability is never restated for a retired proof`() {
        val proof = machine(UiProofScreen.SESSION_CLOSE)
        val gate = PresentationGate(proof, requiredCriticalLines = 1)
        val epoch = gate.rearm()
        assertNotNull(epoch)
        gate.reportCriticalLine("row", visible = true)
        proof.markCommitted(epoch)
        assertTrue(gate.attempt())

        proof.invalidate(UiProofInvalidationReason.DISMISSED)
        assertNull(gate.rearm())
        assertFalse(proof.criticalIdentityReadable)
        assertFalse(gate.attempt())
    }

    // -- dialog-layer coverage projection ---------------------------------------

    @Test
    fun `the client state reports the open dialogs in layer order`() {
        val state = ClientUiState(
            dialogs = ClientDialogs.NONE.copy(createSession = createSessionDialog()),
        )
        assertEquals(listOf(ClientDialogKind.CREATE_SESSION), state.coveredDialogKinds)
        assertFalse(state.dialogs.isCovered(ClientDialogKind.CREATE_SESSION))
    }

    // -- fixtures for the dialog layer ------------------------------------------

    private fun addHostDialog() = AddHostDialog(
        labelDraft = "laptop",
        hostDraft = "10.0.0.5",
        portDraft = "8443",
        proof = machine(UiProofScreen.HOST_ADD_FORM),
    )

    private fun removeHostDialog() = RemoveHostDialog(
        hostId = HostId.parse("a"),
        label = "laptop",
        endpointDisplayText = "10.0.0.5:8443",
        proof = machine(UiProofScreen.HOST_REMOVE),
    )

    private fun createSessionDialog() = CreateSessionDialog(
        owners = emptyList(),
        selectedHostId = null,
        workspaceDraft = "",
        proof = machine(UiProofScreen.SESSION_CREATE),
    )
}
