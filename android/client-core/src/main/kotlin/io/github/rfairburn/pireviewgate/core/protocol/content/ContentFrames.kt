package io.github.rfairburn.pireviewgate.core.protocol.content

/**
 * One complete content-lane frame.
 *
 * A frame is the whole payload of exactly one channel message. Every variant is
 * a closed shape: keys outside these models cannot ride along, an absent
 * optional key never becomes a fabricated default, and a nullable key is only
 * null where the wire is allowed to say null.
 */
sealed interface ContentFrame {
	/** The exact `type` discriminator carried on the wire. */
	val wireType: String

	/** Control frames of the endpoint handshake and subscription lifecycle. */
	sealed interface ControlFrame : ContentFrame

	/** The three frames of one bounded native viewport transfer. */
	sealed interface TransferFrame : ContentFrame

	/**
	 * Optional native input and text-copy frames. Recognizing them is feature
	 * negotiation support only: nothing here writes input or clipboard data, and
	 * a decoded native IO frame is a well-formed message and nothing more.
	 */
	sealed interface NativeIoFrame : ContentFrame
}

/** The closed set of frame type discriminators this codec admits. */
enum class ContentFrameType(val wireValue: String) {
	HELLO("hello"),
	HELLO_ACK("hello_ack"),
	SUBSCRIBE("subscribe"),
	SUBSCRIBED("subscribed"),
	RESIZE("resize"),
	UNSUBSCRIBE("unsubscribe"),
	UNSUBSCRIBED("unsubscribed"),
	END("end"),
	ERROR("error"),
	CONTENT_BEGIN("content_begin"),
	CONTENT_CHUNK("content_chunk"),
	CONTENT_END("content_end"),
	INPUT("input"),
	INPUT_BEGIN("input_begin"),
	INPUT_CHUNK("input_chunk"),
	INPUT_END("input_end"),
	COPY("copy"),
	COPY_BEGIN("copy_begin"),
	COPY_CHUNK("copy_chunk"),
	COPY_END("copy_end"),
	;

	companion object {
		/** The one frame type named by [wireValue], or null when it is not a frame type. */
		fun fromWireValue(value: String): ContentFrameType? = values().firstOrNull { it.wireValue == value }
	}
}

/** Opening handshake of one content channel. */
data class HelloFrame(
	val service: String,
	val major: Long,
	val minor: Long,
	val capabilities: List<String>,
) : ContentFrame.ControlFrame {
	override val wireType: String get() = ContentFrameType.HELLO.wireValue
}

/** Owner-side answer to one hello. */
data class HelloAckFrame(
	val service: String,
	val major: Long,
	val minor: Long,
	val capabilities: List<String>,
) : ContentFrame.ControlFrame {
	override val wireType: String get() = ContentFrameType.HELLO_ACK.wireValue
}

/** Request for one native viewport of one owner row. */
data class SubscribeFrame(
	val subscriptionId: String,
	val hostRunId: String,
	/** Owner row id of the session whose native viewport is requested. */
	val sessionId: String,
	val cols: Int,
	val rows: Int,
) : ContentFrame.ControlFrame {
	override val wireType: String get() = ContentFrameType.SUBSCRIBE.wireValue
}

/** Confirmation that one subscription is registered. */
data class SubscribedFrame(
	val subscriptionId: String,
	val sessionId: String,
	val hostRunId: String,
) : ContentFrame.ControlFrame {
	override val wireType: String get() = ContentFrameType.SUBSCRIBED.wireValue
}

/** Viewer geometry change for one subscription. */
data class ResizeFrame(
	val subscriptionId: String,
	val cols: Int,
	val rows: Int,
) : ContentFrame.ControlFrame {
	override val wireType: String get() = ContentFrameType.RESIZE.wireValue
}

/** Viewer-side end of one subscription. */
data class UnsubscribeFrame(
	val subscriptionId: String,
) : ContentFrame.ControlFrame {
	override val wireType: String get() = ContentFrameType.UNSUBSCRIBE.wireValue
}

/** Owner-side confirmation that one subscription ended by request. */
data class UnsubscribedFrame(
	val subscriptionId: String,
) : ContentFrame.ControlFrame {
	override val wireType: String get() = ContentFrameType.UNSUBSCRIBED.wireValue
}

/** One subscription ended for one fixed reason. */
data class EndFrame(
	val subscriptionId: String,
	val code: ContentEndCode,
) : ContentFrame.ControlFrame {
	override val wireType: String get() = ContentFrameType.END.wireValue
}

/** One fixed wire failure, optionally belonging to one subscription. */
data class ErrorFrame(
	val code: ContentErrorCode,
	/** Present only when the failure belongs to one subscription. */
	val subscriptionId: String? = null,
) : ContentFrame.ControlFrame {
	override val wireType: String get() = ContentFrameType.ERROR.wireValue
}

/** Declaration of one complete native viewport transfer. */
data class ContentBeginFrame(
	val subscriptionId: String,
	val transferId: String,
	val hostRunId: String,
	/** Owner row id; the same value the subscription named. */
	val sessionId: String,
	val nativeSession: NativeSessionRef?,
	/** Positive, never wrapping, per-subscription publish sequence. */
	val sequence: Long,
	val geometry: SessionGeometry,
	val inputModes: TerminalInputModes,
	/** Exact decoded payload bytes of the canonical viewport JSON. */
	val byteLength: Int,
	val chunkCount: Int,
	/** Optional host-written native IO source; absent on every legacy publish. */
	val inputSource: OptionalNativeIoSource = OptionalNativeIoSource.Absent,
) : ContentFrame.TransferFrame {
	override val wireType: String get() = ContentFrameType.CONTENT_BEGIN.wireValue
}

/** One sequential slice of one viewport payload. */
class ContentChunkFrame(
	val subscriptionId: String,
	val transferId: String,
	val index: Long,
	/** Decoded payload slice; re-encodes as canonical base64. */
	val data: ByteArray,
) : ContentFrame.TransferFrame {
	override val wireType: String get() = ContentFrameType.CONTENT_CHUNK.wireValue

	override fun equals(other: Any?): Boolean = other is ContentChunkFrame &&
		subscriptionId == other.subscriptionId &&
		transferId == other.transferId &&
		index == other.index &&
		data.contentEquals(other.data)

	override fun hashCode(): Int {
		var result = subscriptionId.hashCode()
		result = 31 * result + transferId.hashCode()
		result = 31 * result + index.hashCode()
		return 31 * result + data.contentHashCode()
	}

	override fun toString(): String =
		"ContentChunkFrame(subscriptionId=$subscriptionId, transferId=$transferId, index=$index, byteLength=${data.size})"
}

/** Completion of one viewport transfer; repeats the begin sequence. */
data class ContentEndFrame(
	val subscriptionId: String,
	val transferId: String,
	/** Repeats the begin sequence so an end cannot belong to another publish. */
	val sequence: Long,
) : ContentFrame.TransferFrame {
	override val wireType: String get() = ContentFrameType.CONTENT_END.wireValue
}

/** One inline native input packet; only payloads that fit one message use it. */
class InputFrame(
	val subscriptionId: String,
	val inputId: String,
	/** Positive per-binding dispatch ordinal; never a u32-limited counter. */
	val ordinal: Long,
	val source: NativeIoInputSource,
	val inputModes: TerminalInputModes,
	val kind: NativeIoInputKind,
	/** Decoded payload bytes; re-encodes as canonical base64. */
	val data: ByteArray,
) : ContentFrame.NativeIoFrame {
	override val wireType: String get() = ContentFrameType.INPUT.wireValue

	override fun equals(other: Any?): Boolean = other is InputFrame &&
		subscriptionId == other.subscriptionId &&
		inputId == other.inputId &&
		ordinal == other.ordinal &&
		source == other.source &&
		inputModes == other.inputModes &&
		kind == other.kind &&
		data.contentEquals(other.data)

	override fun hashCode(): Int {
		var result = subscriptionId.hashCode()
		result = 31 * result + inputId.hashCode()
		result = 31 * result + ordinal.hashCode()
		result = 31 * result + source.hashCode()
		result = 31 * result + inputModes.hashCode()
		result = 31 * result + kind.hashCode()
		return 31 * result + data.contentHashCode()
	}

	override fun toString(): String =
		"InputFrame(subscriptionId=$subscriptionId, inputId=$inputId, ordinal=$ordinal, kind=${kind.wireValue}, byteLength=${data.size})"
}

/** Begin of one atomic paged native text paste. */
data class InputBeginFrame(
	val subscriptionId: String,
	val inputId: String,
	val ordinal: Long,
	val source: NativeIoInputSource,
	val inputModes: TerminalInputModes,
	/** Only text pastes page; keyboard and mouse packets stay inline. */
	val kind: NativeIoInputKind = NativeIoInputKind.PASTE,
	val byteLength: Int,
	val chunkCount: Int,
) : ContentFrame.NativeIoFrame {
	override val wireType: String get() = ContentFrameType.INPUT_BEGIN.wireValue
}

/** One sequential slice of one native text paste. */
class InputChunkFrame(
	val subscriptionId: String,
	val inputId: String,
	val index: Long,
	/** Decoded payload slice; re-encodes as canonical base64. */
	val data: ByteArray,
) : ContentFrame.NativeIoFrame {
	override val wireType: String get() = ContentFrameType.INPUT_CHUNK.wireValue

	override fun equals(other: Any?): Boolean = other is InputChunkFrame &&
		subscriptionId == other.subscriptionId &&
		inputId == other.inputId &&
		index == other.index &&
		data.contentEquals(other.data)

	override fun hashCode(): Int {
		var result = subscriptionId.hashCode()
		result = 31 * result + inputId.hashCode()
		result = 31 * result + index.hashCode()
		return 31 * result + data.contentHashCode()
	}

	override fun toString(): String =
		"InputChunkFrame(subscriptionId=$subscriptionId, inputId=$inputId, index=$index, byteLength=${data.size})"
}

/** Completion of one paged native text paste; repeats the begin ordinal. */
data class InputEndFrame(
	val subscriptionId: String,
	val inputId: String,
	val ordinal: Long,
) : ContentFrame.NativeIoFrame {
	override val wireType: String get() = ContentFrameType.INPUT_END.wireValue
}

/** One inline native text copy that fits a single message. */
data class CopyFrame(
	val subscriptionId: String,
	val copyId: String,
	/** Positive emission order per binding; independent of `dispatchId`. */
	val sequence: Long,
	val source: NativeIoSource,
	/**
	 * Native input dispatch that caused this copy. Informational only: it may
	 * arrive out of order, so it never orders, fences, or drops a copy.
	 */
	val dispatchId: Long,
	/** Producer event; its tuple must equal the source's native tuple. */
	val event: NativeIoCopyEvent,
) : ContentFrame.NativeIoFrame {
	override val wireType: String get() = ContentFrameType.COPY.wireValue
}

/** Begin of one atomic paged native text copy; never carries the payload. */
data class CopyBeginFrame(
	val subscriptionId: String,
	val copyId: String,
	val sequence: Long,
	val source: NativeIoSource,
	val dispatchId: Long,
	/** Encoded characters of the whole copy payload. */
	val byteLength: Int,
	val chunkCount: Int,
) : ContentFrame.NativeIoFrame {
	override val wireType: String get() = ContentFrameType.COPY_BEGIN.wireValue
}

/** One sequential slice of the ASCII encoded copy payload. */
class CopyChunkFrame(
	val subscriptionId: String,
	val copyId: String,
	val index: Long,
	/** Decoded slice of the canonical encoded payload; re-encodes canonically. */
	val data: ByteArray,
) : ContentFrame.NativeIoFrame {
	override val wireType: String get() = ContentFrameType.COPY_CHUNK.wireValue

	override fun equals(other: Any?): Boolean = other is CopyChunkFrame &&
		subscriptionId == other.subscriptionId &&
		copyId == other.copyId &&
		index == other.index &&
		data.contentEquals(other.data)

	override fun hashCode(): Int {
		var result = subscriptionId.hashCode()
		result = 31 * result + copyId.hashCode()
		result = 31 * result + index.hashCode()
		return 31 * result + data.contentHashCode()
	}

	override fun toString(): String =
		"CopyChunkFrame(subscriptionId=$subscriptionId, copyId=$copyId, index=$index, byteLength=${data.size})"
}

/** Completion of one paged native copy; repeats the begin sequence. */
data class CopyEndFrame(
	val subscriptionId: String,
	val copyId: String,
	/** Repeats the begin sequence so an end cannot belong to another emission. */
	val sequence: Long,
) : ContentFrame.NativeIoFrame {
	override val wireType: String get() = ContentFrameType.COPY_END.wireValue
}
