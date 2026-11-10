package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentFailureCode
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocolException
import io.github.rfairburn.pireviewgate.core.protocol.content.InputFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.InputBeginFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.InputChunkFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.InputEndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import io.github.rfairburn.pireviewgate.core.protocol.content.Utf8Wire

/** One packed logical input: its frames in wire order, or one fixed refusal. */
internal sealed interface PackedInput {
	/** The frames of this logical operation, contiguous and in wire order. */
	data class Ready(val frames: List<ContentFrame>) : PackedInput

	/** One fixed reason this input cannot be represented. Nothing was staged. */
	data class Refused(val reason: ContentNotSentReason) : PackedInput
}

/**
 * Pack one logical native input into the exact frames this endpoint would send.
 *
 * Everything is validated before a single frame exists: lossless UTF-8 (the encoded
 * bytes must decode back to exactly the supplied text, so malformed input such as an
 * unpaired surrogate is refused rather than transmitted as a replacement character),
 * the fixed 1 MiB decoded paste bound, and the per-message bound of every produced
 * frame. Only a text paste pages, and it pages with the SAME input id and ordinal
 * across begin, every chunk, and end; a keyboard or mouse packet always stays inline.
 * A payload that cannot be represented is refused whole — never truncated, never
 * mutated, never auto-retried, and never cancelled out of band.
 *
 * Every frame is encoded through the landed [ContentProtocol.encode], which
 * validates it through the same reader that decodes it (including the canonical
 * content-space SGR mouse grammar), so no second input grammar exists here.
 */
internal object ContentInputPacking {
	/**
	 * Pack one already-normalized input.
	 *
	 * [maxInlineBytes] is the decoded payload bound for one inline packet, which is
	 * also the page size of a paged paste.
	 */
	fun pack(
		subscriptionId: String,
		inputId: String,
		ordinal: Long,
		source: NativeIoInputSource,
		inputModes: TerminalInputModes,
		kind: NativeIoInputKind,
		text: String,
		bounds: ContentBounds,
	): PackedInput {
		if (text.isEmpty()) return PackedInput.Refused(ContentNotSentReason.INVALID_INPUT)
		val bytes = Utf8Wire.encode(text)
		// Encoding replaces malformed UTF-16 rather than rejecting it, so the only honest
		// check is that the bytes decode back to exactly the supplied text. An unpaired
		// surrogate is an invalid packet, never a replacement-mutated one, and it is
		// refused here — before any bound check or frame exists.
		if (Utf8Wire.decodeStrict(bytes) != text) return PackedInput.Refused(ContentNotSentReason.INVALID_INPUT)
		if (bytes.isEmpty()) return PackedInput.Refused(ContentNotSentReason.INVALID_INPUT)
		if (kind == NativeIoInputKind.PASTE && bytes.size > ContentProtocol.NATIVE_TEXT_PASTE_MAX_BYTES) {
			return PackedInput.Refused(ContentNotSentReason.TOO_LARGE)
		}
		if (kind != NativeIoInputKind.PASTE) {
			if (bytes.size > bounds.maxChunkPayloadBytes) return PackedInput.Refused(ContentNotSentReason.TOO_LARGE)
			return encodeAll(listOf(inlineFrame(subscriptionId, inputId, ordinal, source, inputModes, kind, bytes)), bounds)
		}
		if (bytes.size <= bounds.maxChunkPayloadBytes) {
			return encodeAll(
				listOf(inlineFrame(subscriptionId, inputId, ordinal, source, inputModes, kind, bytes)),
				bounds,
			)
		}
		if (bytes.size > bounds.maxTransferBytes) return PackedInput.Refused(ContentNotSentReason.TOO_LARGE)
		val pageBytes = bounds.maxChunkPayloadBytes
		val chunkCount = (bytes.size + pageBytes - 1) / pageBytes
		val frames = ArrayList<ContentFrame>(chunkCount + 2)
		frames.add(
			InputBeginFrame(
				subscriptionId = subscriptionId,
				inputId = inputId,
				ordinal = ordinal,
				source = source,
				inputModes = inputModes,
				kind = NativeIoInputKind.PASTE,
				byteLength = bytes.size,
				chunkCount = chunkCount,
			),
		)
		for (index in 0 until chunkCount) {
			frames.add(
				InputChunkFrame(
					subscriptionId = subscriptionId,
					inputId = inputId,
					index = index.toLong(),
					data = bytes.copyOfRange(index * pageBytes, minOf((index + 1) * pageBytes, bytes.size)),
				),
			)
		}
		frames.add(
			InputEndFrame(
				subscriptionId = subscriptionId,
				inputId = inputId,
				ordinal = ordinal,
			),
		)
		return encodeAll(frames, bounds)
	}

	private fun inlineFrame(
		subscriptionId: String,
		inputId: String,
		ordinal: Long,
		source: NativeIoInputSource,
		inputModes: TerminalInputModes,
		kind: NativeIoInputKind,
		bytes: ByteArray,
	): InputFrame = InputFrame(
		subscriptionId = subscriptionId,
		inputId = inputId,
		ordinal = ordinal,
		source = source,
		inputModes = inputModes,
		kind = kind,
		data = bytes,
	)

	/**
	 * Encode every frame up front so the caller can re-check its guards immediately
	 * before each write. An oversized message is a whole refusal, never a trimmed or
	 * split one.
	 */
	private fun encodeAll(frames: List<ContentFrame>, bounds: ContentBounds): PackedInput {
		return try {
			frames.forEach { frame -> ContentProtocol.encode(frame, bounds) }
			PackedInput.Ready(frames)
		} catch (error: ContentProtocolException) {
			when (error.code) {
				ContentFailureCode.FRAME_TOO_LARGE,
				ContentFailureCode.TRANSFER_TOO_LARGE,
				-> PackedInput.Refused(ContentNotSentReason.TOO_LARGE)

				else -> PackedInput.Refused(ContentNotSentReason.INVALID_INPUT)
			}
		}
	}
}
