package io.github.rfairburn.pireviewgate.core.transport

import java.security.Provider
import java.security.PublicKey
import java.security.cert.Certificate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * The handshake must prove which client key was actually presented, not merely
 * that some key material was available.
 */
class PeerClientProofTest {

    @Test
    fun `a handshake that sent no client certificate is refused`() {
        val expected = TestSupport.p256Spki()
        val failure = assertFailsWith<PeerTransportException> {
            PeerTlsConnection.verifySelectedClientKey(null, expected)
        }
        assertEquals(PeerTransportErrorCode.CLIENT_KEY_NOT_PROVED, failure.code)
    }

    @Test
    fun `an empty client chain is refused`() {
        val expected = TestSupport.p256Spki()
        val failure = assertFailsWith<PeerTransportException> {
            PeerTlsConnection.verifySelectedClientKey(emptyArray(), expected)
        }
        assertEquals(PeerTransportErrorCode.CLIENT_KEY_NOT_PROVED, failure.code)
    }

    @Test
    fun `a different key selected by the handshake is refused`() {
        val expected = TestSupport.p256Spki()
        val other = TestSupport.p256Spki()
        val failure = assertFailsWith<PeerTransportException> {
            PeerTlsConnection.verifySelectedClientKey(arrayOf(StubCertificate(keyWithSpki(other))), expected)
        }
        assertEquals(PeerTransportErrorCode.CLIENT_KEY_MISMATCH, failure.code)
    }

    @Test
    fun `a chain whose leaf proves the claimed key is accepted`() {
        val claimed = TestSupport.p256Spki()
        val leaf = StubCertificate(keyWithSpki(claimed))
        // A matching selection proves nothing to report: it simply does not throw.
        PeerTlsConnection.verifySelectedClientKey(arrayOf(leaf), claimed)
    }

    /** A public key whose encoding is the exact SPKI the handshake presented. */
    private fun keyWithSpki(spki: ByteArray): PublicKey = object : PublicKey {
        override fun getAlgorithm(): String = "EC"
        override fun getFormat(): String = "X.509"
        override fun getEncoded(): ByteArray = spki
    }

    /** A certificate object that only carries the key the handshake selected. */
    private class StubCertificate(private val key: PublicKey) : Certificate("X.509") {
        override fun getEncoded(): ByteArray = ByteArray(0)
        override fun getPublicKey(): PublicKey = key
        override fun verify(key: PublicKey) = Unit
        override fun verify(key: PublicKey, provider: Provider) = Unit
        override fun verify(key: PublicKey, signatureAlgorithm: String) = Unit
        override fun toString(): String = "StubCertificate"
    }
}
