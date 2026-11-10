package io.github.rfairburn.pireviewgate.core.client.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The wrapper bookkeeping a commit source keeps around its registrations.
 *
 * The registry rejects obsolete identifiers correctly, and that alone is not enough: the
 * platform callback can be reposted to the main thread, so an obsolete delivery can run
 * after a newer registration was installed. A wrapper that tracked "awaiting" in its own
 * flag and cleared it on arrival would then silence the newer registration, and the
 * controls captured by it would never be proven. These cases pin the wrapper's behaviour,
 * not just the registry's.
 */
class CommitDeliveryLedgerContractTest {

    private fun proof(row: String) = MutableUiActionProof(ClientUiFixtures.token(rowId = row))

    @Test
    fun `a delayed delivery for an obsolete registration leaves the newer one pending`() {
        val ledger = CommitDeliveryLedger()
        val first = proof("row-1")
        val second = proof("row-2")
        first.beginDraw()
        val tokenA = assertNotNull(ledger.install(listOf(first), windowHasFocus = true))
        assertTrue(ledger.isAwaitingDelivery)

        // The callback for A is queued and has not run yet. Meanwhile a control changes,
        // and a newer registration is installed.
        second.beginDraw()
        val tokenB = assertNotNull(ledger.install(listOf(first, second), windowHasFocus = true))
        assertTrue(tokenB > tokenA)

        // A arrives late. It certifies nothing and must not clear what is pending.
        assertEquals(0, ledger.deliver(tokenA) { p -> true })
        assertTrue(ledger.isAwaitingDelivery, "the newer registration is still owed its delivery")
        assertFalse(first.hasCommittedFrame)
        assertFalse(second.hasCommittedFrame)

        // B arrives and certifies what it captured.
        assertEquals(2, ledger.deliver(tokenB) { p -> true })
        assertTrue(first.hasCommittedFrame)
        assertTrue(second.hasCommittedFrame)
        assertFalse(ledger.isAwaitingDelivery)
    }

    @Test
    fun `a delivery for the current registration ends the wait`() {
        val ledger = CommitDeliveryLedger()
        val subject = proof("row-1")
        subject.beginDraw()
        val token = assertNotNull(ledger.install(listOf(subject), windowHasFocus = true))
        assertTrue(ledger.isAwaitingDelivery)
        assertEquals(1, ledger.deliver(token) { p -> true })
        assertFalse(ledger.isAwaitingDelivery)
    }

    @Test
    fun `installing with nothing eligible awaits nothing`() {
        val ledger = CommitDeliveryLedger()
        val retired = proof("row-1")
        retired.invalidate(UiProofInvalidationReason.DISMISSED)
        val token = ledger.install(listOf(retired), windowHasFocus = true)
        assertNull(token)
        assertFalse(ledger.isAwaitingDelivery)
    }

    @Test
    fun `cancelling withdraws the wait and makes the token inert`() {
        val ledger = CommitDeliveryLedger()
        val subject = proof("row-1")
        subject.beginDraw()
        val token = assertNotNull(ledger.install(listOf(subject), windowHasFocus = true))
        ledger.cancel()
        assertFalse(ledger.isAwaitingDelivery)
        assertEquals(0, ledger.deliver(token) { p -> true })
        assertFalse(subject.hasCommittedFrame)
    }
}
