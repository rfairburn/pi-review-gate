package io.github.rfairburn.pireviewgate.core.transport

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** Bounds are explicit and finite; defaults match the shared host contract. */
class PeerTransportBoundsTest {

    @Test
    fun `defaults match the host transport bounds`() {
        val defaults = PeerTransportBounds.DEFAULT
        assertEquals(64, defaults.maxLabelBytes)
        assertEquals(4096, defaults.maxHttpHeaderBytes)
        assertEquals(20, defaults.maxHttpHeaders)
        assertEquals(2048, defaults.maxPairResponseBytes)
        assertEquals(65_536, defaults.maxWebSocketMessageBytes)
        assertEquals(8, defaults.maxPendingConsents)
        assertEquals(16, defaults.maxClientOperations)
        assertEquals(262_144, defaults.maxOutboundQueueBytes)
        assertEquals(5_000, defaults.tlsHandshakeTimeoutMs)
        assertEquals(15_000, defaults.consentTimeoutMs)
        assertEquals(10_000, defaults.pairingResponseTimeoutMs)
        assertEquals(2_000, defaults.closeTimeoutMs)
        assertEquals(5_000, defaults.openTimeoutMs)
    }

    @Test
    fun `no bound may be zero or negative`() {
        val base = PeerTransportBounds.DEFAULT
        assertFailsWith<PeerTransportException> { base.copy(maxWebSocketMessageBytes = 0) }
        assertFailsWith<PeerTransportException> { base.copy(closeTimeoutMs = -1) }
        assertFailsWith<PeerTransportException> { base.copy(maxOutboundQueueBytes = 0) }
    }

    @Test
    fun `lanes map to exactly one subprotocol each and nothing else`() {
        assertEquals(APP_SUBPROTOCOL, PeerAppLane.APP.subprotocol)
        assertEquals(CONTENT_SUBPROTOCOL, PeerAppLane.CONTENT.subprotocol)
        assertEquals(PeerAppLane.APP, PeerAppLane.fromSubprotocol(APP_SUBPROTOCOL))
        assertEquals(PeerAppLane.CONTENT, PeerAppLane.fromSubprotocol(CONTENT_SUBPROTOCOL))
        // A missing, empty, or unknown protocol has no lane and fails closed.
        assertEquals(null, PeerAppLane.fromSubprotocol(null))
        assertEquals(null, PeerAppLane.fromSubprotocol(""))
        assertEquals(null, PeerAppLane.fromSubprotocol("pi-peer-app-v2"))
        assertEquals(
            "pi-peer-app-v1, pi-peer-content-v1",
            listOf(APP_SUBPROTOCOL, CONTENT_SUBPROTOCOL).joinToString(),
        )
    }

    @Test
    fun `label validation is bounded line safe and charset limited`() {
        val bounds = PeerTransportBounds.DEFAULT
        assertTrue(isPeerLabel("Pixel 7a", bounds.maxLabelBytes))
        assertTrue(isPeerLabel("a.b_c:d(e)-f@g", bounds.maxLabelBytes))
        assertTrue(!isPeerLabel("", bounds.maxLabelBytes))
        assertTrue(!isPeerLabel("has space and\ttab", bounds.maxLabelBytes))
        assertTrue(!isPeerLabel("emoji 😀", bounds.maxLabelBytes))
        assertTrue(!isPeerLabel("x".repeat(bounds.maxLabelBytes + 1), bounds.maxLabelBytes))
        // Multibyte characters are outside the accepted charset at all, so a
        // label can never smuggle bytes past the bound.
        assertTrue(!isPeerLabel("é", bounds.maxLabelBytes))
        assertTrue(!isPeerLabel("é".repeat(bounds.maxLabelBytes), bounds.maxLabelBytes))
    }

    @Test
    fun `key id validation is bounded base64`() {
        assertTrue(isBoundedPeerKeyId("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgA="))
        assertTrue(!isBoundedPeerKeyId(""))
        assertTrue(!isBoundedPeerKeyId("has space"))
        assertTrue(!isBoundedPeerKeyId("url-safe-_"))
        assertTrue(!isBoundedPeerKeyId("A".repeat(MAX_PEER_KEY_ID_CHARS + 1)))
    }
}

private fun assertTrue(value: Boolean) = kotlin.test.assertTrue(value)
private fun assertFalse(value: Boolean) = kotlin.test.assertTrue(!value)
