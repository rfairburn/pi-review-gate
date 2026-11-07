package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The proof contract a destructive intent is gated on.
 *
 * These cases pin the fail-closed shape: a token alone is inert, every gate has to
 * hold at the moment of the check, and a proof addressed at one target can never
 * satisfy an intent addressed at another.
 */
class UiActionProofContractTest {

    @Test
    fun `a satisfied proof grants its own target`() {
        val token = ClientUiFixtures.token()
        val proof = ClientUiFixtures.FakeProof(token)
        assertTrue(proof.grantsAction())
        assertTrue(proof.grantsFor(token))
    }

    @Test
    fun `an uncommitted frame never grants`() {
        val proof = ClientUiFixtures.FakeProof(ClientUiFixtures.token(), committed = false)
        assertFalse(proof.grantsAction())
        assertFalse(proof.grantsFor(proof.target))
    }

    @Test
    fun `a retired control never grants`() {
        val proof = ClientUiFixtures.FakeProof(ClientUiFixtures.token(), current = false)
        assertFalse(proof.grantsAction())
    }

    @Test
    fun `clipped or unreadable critical identity never grants`() {
        val proof = ClientUiFixtures.FakeProof(ClientUiFixtures.token(), readable = false)
        assertFalse(proof.grantsAction())
        assertFalse(proof.grantsFor(proof.target))
    }

    @Test
    fun `a raw token grants nothing without the live proof behind it`() {
        val token = ClientUiFixtures.token()
        val retired = ClientUiFixtures.FakeProof(token, current = false, committed = false)
        // The token is the only shared value between an intent and a controller; the
        // controller has to consult the proof, and this one refuses.
        assertFalse(retired.grantsFor(token))
        assertEquals(token, retired.target)
    }

    @Test
    fun `a proof cannot satisfy a different semantic target`() {
        val close = ClientUiFixtures.token(UiProofScreen.SESSION_CLOSE, rowId = "row-1")
        val otherRow = ClientUiFixtures.token(UiProofScreen.SESSION_CLOSE, rowId = "row-2")
        val remove = ClientUiFixtures.token(UiProofScreen.HOST_REMOVE, rowId = "row-1")
        val proof = ClientUiFixtures.FakeProof(close)

        assertTrue(proof.grantsFor(close))
        assertFalse(proof.grantsFor(otherRow))
        assertFalse(proof.grantsFor(remove))
    }

    @Test
    fun `a proof for another host never crosses hosts`() {
        val a = ClientUiFixtures.token(hostId = "a")
        val b = ClientUiFixtures.token(hostId = "b")
        val proof = ClientUiFixtures.FakeProof(a)
        assertFalse(proof.grantsFor(b))
    }

    @Test
    fun `generation distinguishes a fresh presentation of the same target`() {
        val stale = ClientUiFixtures.token(generation = 1L)
        val fresh = ClientUiFixtures.token(generation = 2L)
        val proof = ClientUiFixtures.FakeProof(fresh)
        assertTrue(proof.grantsFor(fresh))
        assertFalse(proof.grantsFor(stale))
    }

    @Test
    fun `a non-positive generation is refused at construction`() {
        runCatching { UiActionTargetToken(UiProofScreen.SESSION_CLOSE, HostId.parse("a"), generation = 0L) }
            .onSuccess { kotlin.test.fail("a non-positive proof generation must be refused") }
    }
}
