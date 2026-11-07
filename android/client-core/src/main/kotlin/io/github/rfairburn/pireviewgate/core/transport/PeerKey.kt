package io.github.rfairburn.pireviewgate.core.transport

import java.security.MessageDigest
import java.util.Base64

/**
 * Canonical exact peer identity.
 *
 * Trust in this transport is exact public-key identity, not a public CA, DNS
 * name, label, or certificate lifetime. `keyId` is the standard base64 of the
 * exact DER SubjectPublicKeyInfo (SPKI) proved over the current TLS handshake;
 * `fingerprint` is a display-only base64url SHA-256 digest of the same bytes.
 * Every comparison uses the exact decoded SPKI, never the digest, a label, or a
 * certificate hash.
 *
 * Instances are only produced by [fromSpkiDer] or [fromKeyId], so a value that
 * exists is already well-formed and bounded. `toString()` never prints the key.
 */
class PeerKey private constructor(
    val keyId: String,
    val fingerprint: String,
) {
    /** Decoded SPKI DER, the only material identity comparisons use. */
    private val spki: ByteArray = Base64.getDecoder().decode(keyId)

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PeerKey) return false
        return MessageDigest.isEqual(spki, other.spki)
    }

    override fun hashCode(): Int = spki.contentHashCode()

    override fun toString(): String = "PeerKey(fingerprint=$fingerprint)"

    /** Exact DER used to pin the handshake. Callers must not mutate it. */
    internal fun pinnedDer(): ByteArray = spki

    companion object {
        /** Build the one canonical identity representation from exact SPKI DER. */
        fun fromSpkiDer(spkiDer: ByteArray): PeerKey {
            if (spkiDer.isEmpty() || spkiDer.size > MAX_SPKI_DER_BYTES) {
                throw PeerTransportException(PeerTransportErrorCode.IDENTITY_ENCODING_INVALID)
            }
            val keyId = Base64.getEncoder().encodeToString(spkiDer)
            val fingerprint = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(MessageDigest.getInstance("SHA-256").digest(spkiDer))
            return PeerKey(keyId, fingerprint)
        }

        /**
         * Rebuild a canonical identity from a stored key id. The fingerprint is
         * recomputed from the key bytes rather than trusted, so a corrupt or
         * hand-edited record cannot pass as a valid identity.
         */
        fun fromKeyId(keyId: String): PeerKey {
            if (!isBoundedPeerKeyId(keyId)) {
                throw PeerTransportException(PeerTransportErrorCode.IDENTITY_ENCODING_INVALID)
            }
            val decoded = try {
                Base64.getDecoder().decode(keyId)
            } catch (_: IllegalArgumentException) {
                throw PeerTransportException(PeerTransportErrorCode.IDENTITY_ENCODING_INVALID)
            }
            return fromSpkiDer(decoded)
        }
    }
}
