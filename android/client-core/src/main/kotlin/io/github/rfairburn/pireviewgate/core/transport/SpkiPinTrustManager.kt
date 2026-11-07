package io.github.rfairburn.pireviewgate.core.transport

import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.X509TrustManager

/**
 * What one handshake proved, recorded by [SpkiPinTrustManager] during the
 * handshake itself so the caller can decide before any HTTP byte is written.
 */
internal class HandshakeObservation {
    @Volatile
    var spkiDer: ByteArray? = null
        private set

    @Volatile
    var label: String? = null
        private set

    /** Set when the proved key disagreed with the exact pinned key. */
    @Volatile
    var pinMismatch: Boolean = false
        private set

    /** Completed handshakes on this connection; a connection has at most one. */
    @Volatile
    var completedHandshakes: Int = 0
        private set

    fun record(spki: ByteArray, subjectLabel: String?) {
        spkiDer = spki
        label = subjectLabel
        completedHandshakes += 1
    }

    fun markMismatch() {
        pinMismatch = true
    }
}

/**
 * Client trust gate that pins the exact DER SubjectPublicKeyInfo.
 *
 * The certificate is only a container that carries a public key through TLS.
 * This gate never consults a CA, a DNS name, a certificate hash, a validity
 * window, or a label: it extracts the leaf's SPKI DER and compares those exact
 * bytes with the pinned key.
 *
 * When no key is pinned (an explicit first-use pairing only) the gate still
 * refuses an unusable or unsupported key, records the exact proved key for the
 * caller, and leaves the decision to the caller's bounded confirmation, which
 * runs before the transport writes a single HTTP byte. It never trusts
 * everything: an unrecorded key means the handshake did not prove a usable peer.
 */
internal class SpkiPinTrustManager(
    private val pinnedSpkiDer: ByteArray?,
    private val observation: HandshakeObservation,
) : X509TrustManager {

    override fun checkClientTrusted(chain: Array<X509Certificate?>?, authType: String?) {
        // A client never verifies a peer chain through this entry point.
        throw CertificateException("client certificate verification is not performed here")
    }

    override fun checkServerTrusted(chain: Array<X509Certificate?>?, authType: String?) {
        if (chain == null || chain.isEmpty() || chain.size > MAX_CHAIN_DEPTH) {
            throw CertificateException("peer certificate chain is unusable")
        }
        val leaf = chain[0] ?: throw CertificateException("peer certificate chain is unusable")
        val spki = try {
            leaf.publicKey?.encoded
        } catch (_: Throwable) {
            null
        }
        if (spki == null || spki.isEmpty() || spki.size > MAX_SPKI_DER_BYTES) {
            throw CertificateException("peer public key is unusable")
        }
        if (!isP256Spki(spki)) {
            throw CertificateException("peer key type is not supported")
        }
        observation.record(spki, boundedSubjectLabel(leaf))
        val pinned = pinnedSpkiDer
        if (pinned != null && !pinned.contentEquals(spki)) {
            observation.markMismatch()
            throw CertificateException("peer key does not match the pinned key")
        }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = NO_CERTIFICATES

    companion object {
        private const val MAX_CHAIN_DEPTH = 4
        private val NO_CERTIFICATES = emptyArray<X509Certificate>()

        /**
         * Provider-independent P-256 SPKI test: the fixed DER prefix of an
         * `id-ecPublicKey` key with the `prime256v1` curve, a 66-bit-string, and
         * a 65-byte uncompressed point, with the point neither zero nor infinity.
         */
        internal fun isP256Spki(spki: ByteArray): Boolean {
            if (spki.size != 91) return false
            for (i in P256_SPKI_PREFIX.indices) {
                if (spki[i] != P256_SPKI_PREFIX[i]) return false
            }
            if (spki[26] != 0x04.toByte()) return false
            var nonZero = false
            for (i in 27 until spki.size) {
                if (spki[i] != 0.toByte()) nonZero = true
            }
            return nonZero
        }

        private val P256_SPKI_PREFIX = byteArrayOf(
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A.toByte(), 0x86.toByte(), 0x48, 0xCE.toByte(), 0x3D,
            0x02, 0x01, 0x06, 0x08, 0x2A.toByte(), 0x86.toByte(), 0x48, 0xCE.toByte(), 0x3D, 0x03, 0x01,
            0x07, 0x03, 0x42, 0x00,
        )

        /**
         * Bounded display label from the certificate subject CN. Display only:
         * an absent, unusual, or oversized CN yields null and never affects
         * identity or trust.
         */
        internal fun boundedSubjectLabel(certificate: X509Certificate): String? {
            val subject = try {
                certificate.subjectX500Principal?.name
            } catch (_: Throwable) {
                null
            } ?: return null
            val match = CN_PATTERN.find(subject) ?: return null
            val commonName = match.groupValues[1].trim()
            if (!isPeerLabel(commonName, 64)) return null
            return commonName
        }

        private val CN_PATTERN = Regex("(?:^|,)\\s*(?:CN|2\\.5\\.4\\.3)\\s*=\\s*([^,]+)", RegexOption.IGNORE_CASE)
    }
}
