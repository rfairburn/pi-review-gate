package io.github.rfairburn.pireviewgate.core.protocol.content

import java.util.Base64

/**
 * Canonical base64 for wire payloads.
 *
 * A payload is accepted only when it decodes AND re-encodes to exactly the same
 * characters, so padded, unpadded-variant, alphabet-substituted, whitespace, and
 * non-canonical trailing-bit encodings are all refused rather than normalized
 * into a different byte string than the peer sent.
 */
internal object Base64Wire {
	/** The loose character set a wire payload must stay inside before decoding. */
	private val BASE64_PATTERN = Regex("[A-Za-z0-9+/]*={0,2}")

	/** The decoded bytes, or null when [value] is empty or not canonical base64. */
	fun decodeCanonical(value: String): ByteArray? {
		if (value.isEmpty()) return null
		if (!isLooseBase64(value)) return null
		val bytes = try {
			Base64.getDecoder().decode(value)
		} catch (error: IllegalArgumentException) {
			return null
		}
		if (bytes.isEmpty()) return null
		if (Base64.getEncoder().encodeToString(bytes) != value) return null
		return bytes
	}

	/** Whether [value] stays inside the base64 character set (no decoding yet). */
	fun isLooseBase64(value: String): Boolean = BASE64_PATTERN.matches(value)

	/** Canonical base64 of [bytes]; never empty for a non-empty input. */
	fun encodeCanonical(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
}
