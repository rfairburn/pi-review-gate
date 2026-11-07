package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.protocol.content.Base64Wire
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyBeginFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyChunkFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyEndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoCopyEvent
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.Utf8Wire

/** One atomically assembled native copy, before it is bound to an endpoint. */
internal data class AssembledCopy(
	val subscriptionId: String,
	val copyId: String,
	val sequence: Long,
	val source: NativeIoSource,
	val dispatchId: Long,
	val event: NativeIoCopyEvent,
)

/**
 * Atomic receive-side assembly of ONE native text copy at a time.
 *
 * Ordering is the copy emission sequence and nothing else: the native input
 * dispatch id is carried, never consulted, because an asynchronous copy caused by
 * an earlier input may legitimately arrive after a later one's. A sequence already
 * completed is refused as a replay, and [reset] releases only buffered bytes while
 * the committed sequence stays — so a replayed emission order can never publish
 * twice.
 *
 * The assembled paged payload must be the producer's canonical base64 of strict
 * UTF-8 text, validated whole, and it inherits the header source's authenticated
 * native tuple, which is re-checked against the event. A partial, over-long,
 * reordered, or non-canonical payload yields no event at all, and no raw OSC 52
 * byte is ever produced or forwarded here.
 */
internal class ContentCopyAssembly(private val bounds: ContentBounds) {
	private var staged: Staged? = null
	private var completedSequence: Long = 0L

	/** Whether one paged copy is currently staged. */
	val isStaged: Boolean get() = staged != null

	/** Consume one inline copy frame, or report a replay / in-flight conflict. */
	fun inline(frame: CopyFrame): AssembledCopy? {
		if (staged != null) return null
		if (frame.sequence <= completedSequence) return null
		if (!tuplesAgree(frame.source, frame.event)) return null
		completedSequence = frame.sequence
		return AssembledCopy(
			subscriptionId = frame.subscriptionId,
			copyId = frame.copyId,
			sequence = frame.sequence,
			source = frame.source,
			dispatchId = frame.dispatchId,
			event = frame.event,
		)
	}

	/** Stage one paged copy header, or refuse a replay / in-flight conflict. */
	fun begin(frame: CopyBeginFrame): Boolean {
		if (staged != null) return false
		if (frame.sequence <= completedSequence) return false
		staged = Staged(
			subscriptionId = frame.subscriptionId,
			copyId = frame.copyId,
			sequence = frame.sequence,
			source = frame.source,
			dispatchId = frame.dispatchId,
			byteLength = frame.byteLength,
			chunkCount = frame.chunkCount,
			buffer = ByteArray(frame.byteLength),
		)
		return true
	}

	/** Append one page in strict order. Returns false for any out-of-band page. */
	fun chunk(frame: CopyChunkFrame): Boolean {
		val transfer = staged ?: return false
		if (frame.subscriptionId != transfer.subscriptionId || frame.copyId != transfer.copyId) return false
		if (frame.index != transfer.nextIndex || frame.index >= transfer.chunkCount) return false
		if (transfer.written + frame.data.size > transfer.byteLength) return false
		frame.data.copyInto(transfer.buffer, transfer.written)
		transfer.written += frame.data.size
		transfer.nextIndex += 1
		return true
	}

	/**
	 * Complete one paged copy. Any mismatch discards the assembly whole and returns
	 * null; nothing partial survives and nothing is retried.
	 */
	fun end(frame: CopyEndFrame): AssembledCopy? {
		val transfer = staged ?: return null
		if (frame.subscriptionId != transfer.subscriptionId ||
			frame.copyId != transfer.copyId ||
			frame.sequence != transfer.sequence
		) {
			staged = null
			return null
		}
		if (transfer.nextIndex != transfer.chunkCount.toLong() || transfer.written != transfer.byteLength) {
			staged = null
			return null
		}
		staged = null
		val encoded = canonicalCopyPayload(transfer.buffer.copyOf(transfer.written)) ?: return null
		val event = NativeIoCopyEvent.Copy(
			encoded = encoded,
			sessionId = transfer.source.nativeSession.sessionId,
			sessionEpoch = transfer.source.nativeSession.epoch,
		)
		if (!tuplesAgree(transfer.source, event)) return null
		completedSequence = transfer.sequence
		return AssembledCopy(
			subscriptionId = transfer.subscriptionId,
			copyId = transfer.copyId,
			sequence = transfer.sequence,
			source = transfer.source,
			dispatchId = transfer.dispatchId,
			event = event,
		)
	}

	/**
	 * Drop any partial assembly. Idempotent, and the committed emission sequence is
	 * deliberately retained so a replay can never publish twice.
	 */
	fun reset() {
		staged = null
	}

	/** The whole payload must be canonical base64 of strict UTF-8, within the producer bound. */
	private fun canonicalCopyPayload(bytes: ByteArray): String? {
		if (bytes.isEmpty()) return null
		if (bytes.size > ContentProtocol.NATIVE_COPY_MAX_ENCODED_CHARS) return null
		val encoded = Utf8Wire.decodeStrict(bytes) ?: return null
		val decoded = Base64Wire.decodeCanonical(encoded) ?: return null
		Utf8Wire.decodeStrict(decoded) ?: return null
		return encoded
	}

	private fun tuplesAgree(source: NativeIoSource, event: NativeIoCopyEvent): Boolean =
		event.sessionId == source.nativeSession.sessionId && event.sessionEpoch == source.nativeSession.epoch

	private class Staged(
		val subscriptionId: String,
		val copyId: String,
		val sequence: Long,
		val source: NativeIoSource,
		val dispatchId: Long,
		val byteLength: Int,
		val chunkCount: Int,
		val buffer: ByteArray,
	) {
		var written: Int = 0
		var nextIndex: Long = 0L
	}
}
