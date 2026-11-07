package io.github.rfairburn.pireviewgate.core.transport

import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Identity is the exact SPKI, so these checks pin the canonical form, the
 * bounded encodings, and the refusal of anything that is not a usable key.
 */
class PeerKeyTest {

    private fun p256Spki(): ByteArray {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        return generator.generateKeyPair().public.encoded
    }

    @Test
    fun `key id and fingerprint are derived from the exact spki`() {
        val der = p256Spki()
        val key = PeerKey.fromSpkiDer(der)
        assertEquals(Base64.getEncoder().encodeToString(der), key.keyId)
        assertEquals(43, key.fingerprint.length)
        assertTrue(key.fingerprint.matches(Regex("^[A-Za-z0-9_-]{43}$")))
        // Rebuilding from the same bytes is stable and equal.
        assertEquals(key, PeerKey.fromSpkiDer(der))
        assertEquals(key.keyId, PeerKey.fromKeyId(key.keyId).keyId)
    }

    @Test
    fun `a different key is never equal`() {
        assertNotEquals(PeerKey.fromSpkiDer(p256Spki()), PeerKey.fromSpkiDer(p256Spki()))
    }

    @Test
    fun `empty and oversized spki are refused`() {
        assertFailsWith<PeerTransportException> { PeerKey.fromSpkiDer(ByteArray(0)) }
        assertFailsWith<PeerTransportException> { PeerKey.fromSpkiDer(ByteArray(MAX_SPKI_DER_BYTES + 1)) }
    }

    @Test
    fun `malformed and oversized key ids are refused`() {
        for (bad in listOf("", "not base64!!", "AAAA=", "A".repeat(MAX_PEER_KEY_ID_CHARS + 1))) {
            val failure = assertFailsWith<PeerTransportException> { PeerKey.fromKeyId(bad) }
            assertEquals(PeerTransportErrorCode.IDENTITY_ENCODING_INVALID, failure.code)
        }
    }

    @Test
    fun `a stored key id rebuilds the same identity that produced it`() {
        val der = p256Spki()
        val original = PeerKey.fromSpkiDer(der)
        val rebuilt = PeerKey.fromKeyId(original.keyId)
        assertEquals(original, rebuilt)
        assertEquals(original.fingerprint, rebuilt.fingerprint)
    }

    @Test
    fun `toString never prints the key material`() {
        val key = PeerKey.fromSpkiDer(p256Spki())
        assertTrue(!key.toString().contains(key.keyId))
        assertTrue(key.toString().contains(key.fingerprint))
    }

    @Test
    fun `p256 detection accepts p256 and rejects other keys`() {
        assertTrue(SpkiPinTrustManager.isP256Spki(p256Spki()))
        val rsa = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair().public.encoded
        assertTrue(!SpkiPinTrustManager.isP256Spki(rsa))
        assertTrue(!SpkiPinTrustManager.isP256Spki(ByteArray(91)))
    }

    @Test
    fun `endpoint validation refuses ambiguous or out of range targets`() {
        PeerEndpoint("127.0.0.1", 443)
        PeerEndpoint("::1", 65_535)
        for (host in listOf("", "a b", "a/b", "a\\b", "a?b", "a#b", "u@a")) {
            assertFailsWith<PeerTransportException> { PeerEndpoint(host, 443) }
        }
        for (port in listOf(0, -1, 65_536)) {
            assertFailsWith<PeerTransportException> { PeerEndpoint("127.0.0.1", port) }
        }
    }

    @Test
    fun `endpoint host header uses the bracket form only for ipv6 literals`() {
        assertEquals("[::1]:8443", PeerEndpoint("::1", 8443).hostHeaderValue())
        assertEquals("peer.invalid:8443", PeerEndpoint("peer.invalid", 8443).hostHeaderValue())
    }
}
