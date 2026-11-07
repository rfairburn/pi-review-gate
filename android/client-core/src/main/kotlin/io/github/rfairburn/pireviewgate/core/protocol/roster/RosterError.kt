package io.github.rfairburn.pireviewgate.core.protocol.roster

/**
 * Fixed, sanitized failure surface of the roster wire contract.
 *
 * A failure carries one code and one fixed message. It never carries a raw
 * frame, a field value, peer text, a path, or an exception chain from a deeper
 * parser, so a refusal can be logged or reported without exposing anything the
 * other side sent.
 */

/** Local failure codes for decode, encode, and bound resolution. */
enum class RosterFailureCode {
    INVALID_BOUNDS,
    INVALID_FRAME,
    FRAME_TOO_LARGE,
    BAD_FRAME,
    ROW_UNREPRESENTABLE,
    SNAPSHOT_TOO_LARGE,
}

/** Fixed wire failure codes. No raw frame, path, peer text, or exception detail. */
enum class RosterWireErrorCode(val wireName: String) {
    BAD_FRAME("bad_frame"),
    UNSUPPORTED_VERSION("unsupported_version"),
    MISSING_CAPABILITY("missing_capability"),
    NOT_AUTHORIZED("not_authorized"),
    UNAVAILABLE("unavailable"),
    ROW_UNREPRESENTABLE("row_unrepresentable"),
    SNAPSHOT_TOO_LARGE("snapshot_too_large"),
    RUN_CHANGED("run_changed"),
    PROTOCOL_VIOLATION("protocol_violation"),
    TOO_MANY_SUBSCRIPTIONS("too_many_subscriptions"),
    SEND_FAILED("send_failed"),
    ;

    companion object {
        /** Exact-spelling lookup only; an unrecognized code is not a wire code. */
        fun fromWireName(value: String): RosterWireErrorCode? = entries.firstOrNull { it.wireName == value }
    }
}

/** Fixed-code failure for anything this contract cannot represent. */
class RosterProtocolException(val code: RosterFailureCode) : Exception(messageFor(code)) {

    companion object {
        private fun messageFor(code: RosterFailureCode): String = when (code) {
            RosterFailureCode.INVALID_BOUNDS -> "roster metadata bounds are invalid"
            RosterFailureCode.INVALID_FRAME -> "roster metadata frame is invalid"
            RosterFailureCode.FRAME_TOO_LARGE -> "roster metadata frame exceeds its bound"
            RosterFailureCode.BAD_FRAME -> "roster metadata frame could not be decoded"
            RosterFailureCode.ROW_UNREPRESENTABLE -> "a roster metadata row cannot be represented on the wire"
            RosterFailureCode.SNAPSHOT_TOO_LARGE -> "roster metadata snapshot exceeds a bounded limit"
        }
    }
}

/** Map a local failure onto the fixed wire code sent to the peer. */
fun RosterFailureCode.wireCode(): RosterWireErrorCode = when (this) {
    RosterFailureCode.ROW_UNREPRESENTABLE -> RosterWireErrorCode.ROW_UNREPRESENTABLE
    RosterFailureCode.SNAPSHOT_TOO_LARGE -> RosterWireErrorCode.SNAPSHOT_TOO_LARGE
    RosterFailureCode.INVALID_BOUNDS -> RosterWireErrorCode.PROTOCOL_VIOLATION
    else -> RosterWireErrorCode.BAD_FRAME
}

internal fun fail(code: RosterFailureCode): Nothing = throw RosterProtocolException(code)
