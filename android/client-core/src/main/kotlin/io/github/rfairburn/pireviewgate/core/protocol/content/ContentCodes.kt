package io.github.rfairburn.pireviewgate.core.protocol.content

/**
 * Local failure codes for decode, encode, and payload packing. Each carries one
 * fixed message: no raw frame, path, peer text, or exception detail is ever
 * attached.
 */
enum class ContentFailureCode(val message: String) {
	INVALID_BOUNDS("session content bounds are invalid"),
	INVALID_FRAME("session content frame is invalid"),
	FRAME_TOO_LARGE("session content frame exceeds its message bound"),
	BAD_FRAME("session content frame could not be decoded"),
	TRANSFER_TOO_LARGE("session content transfer exceeds a bounded limit"),
	TRANSFER_FAILED("session content transfer could not be assembled"),
}

/** Fixed-code failure for anything this protocol cannot represent. */
class ContentProtocolException(val code: ContentFailureCode) : Exception(code.message) {
	companion object {
		private const val serialVersionUID: Long = 1L
	}
}

/**
 * Fixed wire failure codes. No raw frame, path, peer text, or exception detail.
 */
enum class ContentErrorCode(val wireValue: String) {
	BAD_FRAME("bad_frame"),
	FRAME_TOO_LARGE("frame_too_large"),
	UNSUPPORTED_VERSION("unsupported_version"),
	MISSING_CAPABILITY("missing_capability"),
	NOT_AUTHORIZED("not_authorized"),
	UNAVAILABLE("unavailable"),
	PROTOCOL_VIOLATION("protocol_violation"),
	TOO_MANY_SUBSCRIPTIONS("too_many_subscriptions"),
	TRANSFER_FAILED("transfer_failed"),
	SEND_FAILED("send_failed"),
	;

	companion object {
		/** The one wire code named by [wireValue], or null when it is not a code. */
		fun fromWireValue(value: String): ContentErrorCode? = values().firstOrNull { it.wireValue == value }
	}
}

/** Fixed reasons one subscription may end; no free text is expressible. */
enum class ContentEndCode(val wireValue: String) {
	CLOSED("closed"),
	REPLACED("replaced"),
	STOPPED("stopped"),
	UNAVAILABLE("unavailable"),
	;

	companion object {
		/** The one end code named by [wireValue], or null when it is not a code. */
		fun fromWireValue(value: String): ContentEndCode? = values().firstOrNull { it.wireValue == value }
	}
}

/** Map a local failure onto the fixed wire code sent to the peer. */
fun wireCodeForFailure(code: ContentFailureCode): ContentErrorCode = when (code) {
	ContentFailureCode.FRAME_TOO_LARGE -> ContentErrorCode.FRAME_TOO_LARGE
	ContentFailureCode.TRANSFER_TOO_LARGE, ContentFailureCode.TRANSFER_FAILED -> ContentErrorCode.TRANSFER_FAILED
	ContentFailureCode.INVALID_BOUNDS -> ContentErrorCode.PROTOCOL_VIOLATION
	ContentFailureCode.BAD_FRAME, ContentFailureCode.INVALID_FRAME -> ContentErrorCode.BAD_FRAME
}
