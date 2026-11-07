package io.github.rfairburn.pireviewgate.core.client.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Which controls a shared per-window commit may certify.
 *
 * A screen-level control has no window of its own, so one commit source serves many of
 * them. The whole safety of that arrangement rests on a registration capturing the
 * exact `(proof, epoch)` pairs before the platform is asked, and honouring a delivery
 * only when it names that registration. These are the cases where a looser rule — "the
 * controls that happen to be armed when the callback arrives" — would certify a frame
 * that never contained the control, or a control that changed after the frame was drawn.
 */
class ProofCommitRegistryContractTest {

    private fun proof(screen: UiProofScreen = UiProofScreen.SESSION_CLOSE, hostId: String = "a") =
        MutableUiActionProof(ClientUiFixtures.token(screen, hostId = hostId))

    /** Arm one control the way the adapter does: begin its pass, state readability, register. */
    private fun armed(vararg machines: MutableUiActionProof): Pair<ProofCommitRegistry, Long> {
        val registry = ProofCommitRegistry()
        val token = registry.beginRegistration(machines.toList(), windowHasFocus = true)
        assertNotNull(token)
        return registry to token
    }

    /**
     * The adapter's arm sequence for one identity-free control: begin the draw pass the
     * commit will be captured against, and state the readability that a control with no
     * critical identity line requires.
     */
    private fun armControl(machine: MutableUiActionProof): Long {
        val epoch = machine.beginDraw()
        machine.setCriticalIdentityReadable(true)
        return epoch
    }

    @Test
    fun `a delivery certifies exactly the captured epochs`() {
        val first = proof(hostId = "a")
        val second = proof(hostId = "b")
        val firstEpoch = armControl(first)
        val secondEpoch = armControl(second)
        val (registry, token) = armed(first, second)

        assertEquals(2, registry.deliver(token) { p -> true })
        assertTrue(first.hasCommittedFrame)
        assertTrue(second.hasCommittedFrame)
        assertTrue(first.grantsFor(first.target))
        assertTrue(second.grantsFor(second.target))
        assertEquals(firstEpoch, first.epoch)
        assertEquals(secondEpoch, second.epoch)
    }

    @Test
    fun `a callback for an older frame certifies nothing after a newer control was armed`() {
        val first = proof(hostId = "a")
        val later = proof(hostId = "b")
        val registry = ProofCommitRegistry()

        // A control appears, a new registration is taken, and the *old* frame's callback
        // is the one that finally arrives. It must publish nothing at all.
        first.beginDraw()
        val oldToken = assertNotNull(registry.beginRegistration(listOf(first), windowHasFocus = true))
        later.beginDraw()
        val newToken = assertNotNull(registry.beginRegistration(listOf(first, later), windowHasFocus = true))
        assertTrue(newToken > oldToken, "the newer registration owns the next delivery")

        assertEquals(0, registry.deliver(oldToken) { p -> true })
        assertFalse(first.hasCommittedFrame)
        assertFalse(later.hasCommittedFrame)

        assertEquals(2, registry.deliver(newToken) { p -> true })
        assertTrue(first.hasCommittedFrame)
        assertTrue(later.hasCommittedFrame)
        assertEquals(0, registry.deliver(newToken) { p -> true })
    }

    @Test
    fun `a control that changed between registration and delivery is not certified`() {
        val subject = proof()
        subject.beginDraw()
        val (registry, token) = armed(subject)

        // A real change — the row relaid out — moved the epoch after registration.
        subject.invalidate(UiProofInvalidationReason.LAYOUT_CHANGE)
        val nextEpoch = subject.beginDraw()

        assertEquals(0, registry.deliver(token) { p -> true })
        assertFalse(subject.hasCommittedFrame, "the frame drawn before the change proves nothing")
        assertEquals(nextEpoch, subject.epoch)

        // Only a registration taken after the change can certify the new pass.
        val (again, freshToken) = armed(subject)
        assertEquals(1, again.deliver(freshToken) { true })
        assertTrue(subject.hasCommittedFrame)
    }

    @Test
    fun `a control disposed after emitting an intent cannot be revived by an old callback`() {
        val subject = proof()
        val epoch = armControl(subject)
        assertTrue(subject.markCommitted(epoch))
        assertTrue(subject.grantsAction())

        val (registry, token) = armed(subject)
        // The control leaves composition while a commit is still in flight.
        subject.invalidate(UiProofInvalidationReason.DISMISSED)
        assertFalse(subject.isCurrent)

        assertEquals(0, registry.deliver(token) { p -> true })
        assertFalse(subject.isCurrent)
        assertFalse(subject.hasCommittedFrame)
        assertFalse(subject.grantsAction())
    }

    @Test
    fun `a control no longer attached to the window is not certified`() {
        val attached = proof(hostId = "a")
        val detached = proof(hostId = "b")
        attached.beginDraw()
        detached.beginDraw()
        val (registry, token) = armed(attached, detached)

        assertEquals(1, registry.deliver(token) { p -> p === attached })
        assertTrue(attached.hasCommittedFrame)
        assertFalse(detached.hasCommittedFrame)
    }

    @Test
    fun `an unfocused window captures nothing and awaits nothing`() {
        val registry = ProofCommitRegistry()
        val subject = proof()
        subject.beginDraw()
        assertNull(registry.beginRegistration(listOf(subject), windowHasFocus = false))
        assertFalse(registry.hasPendingRegistration)
    }

    @Test
    fun `discarding a registration makes its token inert`() {
        val subject = proof()
        subject.beginDraw()
        val (registry, token) = armed(subject)
        registry.discard()
        assertFalse(registry.hasPendingRegistration)
        assertEquals(0, registry.deliver(token) { p -> true })
        assertFalse(subject.hasCommittedFrame)
    }

    @Test
    fun `one control changing does not disturb the standing captured for another`() {
        val stable = proof(hostId = "a")
        val volatile = proof(hostId = "b")
        armControl(stable)
        armControl(volatile)
        val (registry, token) = armed(stable, volatile)

        // Another owner's control churns while this frame is in flight.
        volatile.invalidate(UiProofInvalidationReason.LAYOUT_CHANGE)
        volatile.beginDraw()

        assertEquals(1, registry.deliver(token) { p -> true })
        assertTrue(stable.hasCommittedFrame)
        assertTrue(stable.grantsFor(stable.target))
        assertFalse(volatile.hasCommittedFrame)
    }
}
