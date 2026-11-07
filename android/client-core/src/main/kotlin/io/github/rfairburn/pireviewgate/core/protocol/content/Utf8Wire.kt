package io.github.rfairburn.pireviewgate.core.protocol.content

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/**
 * Strict UTF-8 with exact text preservation.
 *
 * Invalid, overlong, or lone-surrogate encodings are refused: a payload is text
 * or it is not transportable at all, never silently repaired, and never silently
 * rewritten. A leading byte-order mark is kept, because U+FEFF is ordinary user
 * text in an input or clipboard payload and stripping it would change what the
 * peer typed or copied.
 */
internal object Utf8Wire {
	/** The decoded text, or null when [bytes] is not well-formed UTF-8. */
	fun decodeStrict(bytes: ByteArray): String? {
		val decoder = StandardCharsets.UTF_8.newDecoder()
			.onMalformedInput(CodingErrorAction.REPORT)
			.onUnmappableCharacter(CodingErrorAction.REPORT)
		return try {
			decoder.decode(ByteBuffer.wrap(bytes)).toString()
		} catch (error: CharacterCodingException) {
			null
		}
	}

	/** The UTF-8 bytes of [text]; text reaching here never holds an unpaired surrogate. */
	fun encode(text: String): ByteArray = text.toByteArray(StandardCharsets.UTF_8)

	/** The UTF-8 byte length of [text]. */
	fun byteLength(text: String): Int = text.toByteArray(StandardCharsets.UTF_8).size
}
