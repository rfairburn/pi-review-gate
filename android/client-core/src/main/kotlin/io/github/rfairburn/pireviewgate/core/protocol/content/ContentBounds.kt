package io.github.rfairburn.pireviewgate.core.protocol.content

/**
 * Explicit, finite content bounds for one native viewport content lane.
 *
 * Every value is a finite positive integer, a chunk must be able to fit one
 * message once base64 encoded, and a chunk must fit one transfer. An unusable
 * combination fails closed at construction instead of being ignored. There is
 * deliberately no deadline field: hello and transfer deadlines belong to the
 * endpoint state machines and reuse the existing protocol bounds rather than
 * being invented here.
 *
 * These bounds bound ONE channel message, one payload chunk, and one whole
 * viewport transfer. None of them is a text-only limit, and none of them grants
 * permission to clip, trim, filter, or silently drop native content.
 */
data class ContentBounds(
	/** Complete encoded channel message (also the transport message bound). */
	val maxFrameBytes: Int,
	/** Decoded payload ceiling for one complete native viewport; defensive only. */
	val maxTransferBytes: Int,
	/** Decoded payload bytes in one `content_chunk` before base64 encoding. */
	val maxChunkPayloadBytes: Int,
	/** Bytes in one subscription, transfer, host-run, or owner row identifier. */
	val maxIdentifierBytes: Int,
	/** Capability identifiers in one hello. */
	val maxCapabilities: Int,
	/** Bytes in one capability identifier. */
	val maxCapabilityIdBytes: Int,
	/** Viewport columns; matches the existing terminal surface dimension bound. */
	val maxCols: Int,
	/** Viewport rows; matches the existing terminal surface dimension bound. */
	val maxRows: Int,
) {
	init {
		val values = intArrayOf(
			maxFrameBytes,
			maxTransferBytes,
			maxChunkPayloadBytes,
			maxIdentifierBytes,
			maxCapabilities,
			maxCapabilityIdBytes,
			maxCols,
			maxRows,
		)
		for (value in values) {
			if (value <= 0) throw ContentProtocolException(ContentFailureCode.INVALID_BOUNDS)
		}
		// Base64 of a full chunk must still fit one message with its envelope.
		if (maxChunkPayloadBytes.toLong() >= maxFrameBytes.toLong()) {
			throw ContentProtocolException(ContentFailureCode.INVALID_BOUNDS)
		}
		if (4L * ((maxChunkPayloadBytes.toLong() + 2L) / 3L) >= maxFrameBytes.toLong()) {
			throw ContentProtocolException(ContentFailureCode.INVALID_BOUNDS)
		}
		if (maxTransferBytes.toLong() < maxChunkPayloadBytes.toLong()) {
			throw ContentProtocolException(ContentFailureCode.INVALID_BOUNDS)
		}
	}

	companion object {
		/** The fixed defaults this lane is built with. */
		val DEFAULT: ContentBounds = ContentBounds(
			maxFrameBytes = 65_536,
			maxTransferBytes = 64 * 1024 * 1024,
			maxChunkPayloadBytes = 32 * 1024,
			maxIdentifierBytes = 64,
			maxCapabilities = 16,
			maxCapabilityIdBytes = 64,
			maxCols = 1_000,
			maxRows = 1_000,
		)
	}
}
