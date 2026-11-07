package io.github.rfairburn.pireviewgate.core.identity

import java.security.MessageDigest
import java.util.Base64

/**
 * Canonical exact peer identity of one remote host.
 *
 * Trust in this client is the exact public key proved over the current handshake:
 * [keyId] is the base64 of the exact DER SubjectPublicKeyInfo, and [fingerprint] is
 * a display-only SHA-256 digest of that same key material, shown to a human for
 * comparison. Every accept/reject decision uses [keyId]; nothing compares labels,
 * addresses, certificate serial numbers, or validity dates.
 *
 * Certificates are only containers that carry a key through TLS. A certificate
 * re-issued around the same key does not change identity — which is exactly why the
 * pin is the SPKI and not a certificate hash.
 *
 * Instances are validated at construction: a fingerprint that is not the digest of
 * [keyId] is refused rather than compared partially.
 */
public data class PeerKey(
    /** Authoritative canonical id: base64 of the exact SPKI DER. */
    val keyId: String,
    /** Display-only base64url SHA-256 of the same SPKI DER. */
    val fingerprint: String,
) {
    init {
        require(isValidKeyPair(keyId, fingerprint)) { "peer key is not well formed" }
    }

    /** The exact SPKI DER this identity was derived from. */
    public val spkiDer: ByteArray
        get() = decodeSpki(keyId)

    /** True only when both values describe the exact same key. */
    public fun contentEquals(other: PeerKey): Boolean =
        MessageDigest.isEqual(decodeSpki(keyId), decodeSpki(other.keyId))

    public companion object {
        /** Bound on a canonical key id (base64 SPKI DER). */
        public const val MAX_KEY_ID_CHARS: Int = 512

        /** Bound on the SPKI DER a canonical id may encode. */
        public const val MAX_SPKI_DER_BYTES: Int = 2048

        /** A base64url SHA-256 digest is exactly this many unpadded characters. */
        public const val FINGERPRINT_CHARS: Int = 43

        private val KEY_ID_PATTERN = Regex("^[A-Za-z0-9+/]+={0,2}$")
        private val FINGERPRINT_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")

        /** Build the one canonical identity representation from exact SPKI DER. */
        public fun fromSpki(spkiDer: ByteArray): PeerKey {
            require(spkiDer.isNotEmpty() && spkiDer.size <= MAX_SPKI_DER_BYTES) { "spki is out of bounds" }
            return PeerKey(
                keyId = Base64.getEncoder().encodeToString(spkiDer),
                fingerprint = base64Url(sha256(spkiDer)),
            )
        }

        /** Structural admission of one candidate identity, including digest consistency. */
        public fun isValidKeyPair(keyId: String, fingerprint: String): Boolean {
            if (!isValidKeyId(keyId)) return false
            if (!FINGERPRINT_PATTERN.matches(fingerprint)) return false
            val der = runCatching { decodeSpki(keyId) }.getOrNull() ?: return false
            return base64Url(sha256(der)) == fingerprint
        }

        /** Structural bound for a canonical key id, without any digest check. */
        public fun isValidKeyId(value: String): Boolean =
            value.isNotEmpty() &&
                value.length <= MAX_KEY_ID_CHARS &&
                KEY_ID_PATTERN.matches(value) &&
                runCatching { decodeSpki(value).size in 1..MAX_SPKI_DER_BYTES }.getOrDefault(false)

        /** Parsed identity, or `null` when the pair is malformed or inconsistent. */
        public fun parseOrNull(keyId: String, fingerprint: String): PeerKey? =
            if (isValidKeyPair(keyId, fingerprint)) PeerKey(keyId, fingerprint) else null

        private fun decodeSpki(keyId: String): ByteArray = Base64.getDecoder().decode(keyId)

        private fun sha256(bytes: ByteArray): ByteArray =
            MessageDigest.getInstance("SHA-256").digest(bytes)

        private fun base64Url(bytes: ByteArray): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
