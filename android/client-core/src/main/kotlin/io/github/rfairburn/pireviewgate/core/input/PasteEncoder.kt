package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import java.nio.charset.StandardCharsets

/**
 * Encoder for one atomic native text paste.
 *
 * A paste is whole or nothing: the decoded UTF-8 body must fit the owner's
 * 1 MiB bound, and a body above it is refused rather than clipped, chunked
 * locally, or sent partially. Bracketed paste marks wrap the body only when the
 * child has `CSI ?2004 h` on, exactly as the owner's translator does, and the
 * body itself stays byte-for-byte opaque — a paste is data the child asked to
 * receive, so no control byte inside it is rewritten or dropped.
 */
object PasteEncoder {
	/** Decoded UTF-8 bytes one atomic native text paste body may carry. */
	const val MAX_PASTE_BYTES: Int = ContentProtocol.NATIVE_TEXT_PASTE_MAX_BYTES

	private const val BEGIN = "\u001b[200~"
	private const val END = "\u001b[201~"

	/**
	 * Encode [text] as one paste packet for a child with [bracketedPaste], or
	 * null when the text is empty or its UTF-8 body exceeds [MAX_PASTE_BYTES].
	 */
	fun encode(text: String, bracketedPaste: Boolean): ByteArray? {
		if (text.isEmpty()) return null
		val body = text.toByteArray(StandardCharsets.UTF_8)
		if (body.size > MAX_PASTE_BYTES) return null
		if (!bracketedPaste) return body
		return (BEGIN + text + END).toByteArray(StandardCharsets.UTF_8)
	}

	/** True when [text] fits the whole-paste bound. */
	fun fits(text: String): Boolean {
		if (text.isEmpty()) return false
		return text.toByteArray(StandardCharsets.UTF_8).size <= MAX_PASTE_BYTES
	}
}
