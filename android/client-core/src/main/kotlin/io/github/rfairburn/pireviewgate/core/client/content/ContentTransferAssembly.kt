package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBeginFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentChunkFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentEndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocolException

/**
 * Atomic client-side assembly of one complete native viewport transfer.
 *
 * The endpoint holds at most ONE in-flight transfer. A declaration is validated
 * before anything is staged, the declared payload budget is enforced before every
 * copy, and a snapshot exists only when the exact begin tuple, sequence, chunk
 * count, and byte length all complete. Anything else — a second begin, a foreign
 * transfer, a missing, duplicated, reordered, overlapping, or oversized chunk, a
 * truncated or over-long payload, or a viewport that disagrees with its own
 * declared geometry — discards the partial transfer whole and reports one fixed
 * failure. Partial data is never published, never merged with a previous view, and
 * never retried.
 *
 * Payload decoding is the landed codec's own [ContentProtocol.decodeTerminalPayload]
 * — no second viewport grammar exists here.
 */
internal class ContentTransferAssembly(private val bounds: ContentBounds) {
	private var staged: Staged? = null

	/** Whether one transfer is currently staged. */
	val isStaged: Boolean get() = staged != null

	/** Stage one validated `content_begin`. Returns false when a transfer is already staged. */
	fun begin(frame: ContentBeginFrame): Boolean {
		if (staged != null) return false
		if (frame.byteLength > bounds.maxTransferBytes) return false
		staged = Staged(
			meta = ContentTransferMeta(
				subscriptionId = frame.subscriptionId,
				transferId = frame.transferId,
				hostRunId = frame.hostRunId,
				rowId = frame.sessionId,
				nativeSession = frame.nativeSession,
				sequence = frame.sequence,
				geometry = frame.geometry,
				inputModes = frame.inputModes,
				inputSource = frame.inputSource,
				byteLength = frame.byteLength,
				chunkCount = frame.chunkCount,
			),
			buffer = ByteArray(frame.byteLength),
		)
		return true
	}

	/** Append one chunk in strict order. Returns false for any out-of-band or over-budget chunk. */
	fun chunk(frame: ContentChunkFrame): Boolean {
		val transfer = staged ?: return false
		if (frame.subscriptionId != transfer.meta.subscriptionId || frame.transferId != transfer.meta.transferId) {
			return false
		}
		if (frame.index != transfer.nextIndex || frame.index >= transfer.meta.chunkCount) return false
		if (transfer.written + frame.data.size > transfer.meta.byteLength) return false
		frame.data.copyInto(transfer.buffer, transfer.written)
		transfer.written += frame.data.size
		transfer.nextIndex += 1
		return true
	}

	/**
	 * Complete one transfer. Returns [Assembled.Failed] for anything that does not
	 * exactly close the staged begin, after discarding that transfer.
	 */
	fun end(frame: ContentEndFrame): Assembled {
		val transfer = staged ?: return Assembled.Failed
		if (frame.subscriptionId != transfer.meta.subscriptionId ||
			frame.transferId != transfer.meta.transferId ||
			frame.sequence != transfer.meta.sequence
		) {
			reset()
			return Assembled.Failed
		}
		if (transfer.nextIndex != transfer.meta.chunkCount.toLong() || transfer.written != transfer.meta.byteLength) {
			reset()
			return Assembled.Failed
		}
		val payload = transfer.buffer.copyOf(transfer.written)
		reset()
		val viewport = try {
			ContentProtocol.decodeTerminalPayload(payload, bounds)
		} catch (error: ContentProtocolException) {
			return Assembled.Failed
		}
		if (viewport.cols != transfer.meta.geometry.cols || viewport.rows != transfer.meta.geometry.rows) {
			return Assembled.Failed
		}
		return Assembled.Completed(ContentSnapshot(meta = transfer.meta, frame = viewport))
	}

	/** Drop any partial transfer. Idempotent; completed snapshots are unaffected. */
	fun reset() {
		staged = null
	}

	private class Staged(
		val meta: ContentTransferMeta,
		val buffer: ByteArray,
	) {
		var written: Int = 0
		var nextIndex: Long = 0L
	}
}

/** Result of one attempted transfer completion. */
internal sealed interface Assembled {
	/** The transfer did not close cleanly; nothing partial survived. */
	data object Failed : Assembled

	/** One complete, validated viewport. */
	data class Completed(val snapshot: ContentSnapshot) : Assembled
}
