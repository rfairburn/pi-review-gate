package io.github.rfairburn.pireviewgate.core.protocol.roster

/**
 * The two negotiation decisions of this lane.
 *
 * Negotiation can only narrow what either side may assume, never widen it. A
 * different service name, a different major version, or a missing required
 * baseline capability is refused outright; a minor version grants no capability
 * and enables no behavior on its own.
 */

/** Owner-side decision on one hello. */
sealed interface RosterNegotiation {
    data class Accepted(
        val major: Long,
        val minor: Long,
        val capabilities: List<String>,
    ) : RosterNegotiation

    /** Refused for [code]: `UNSUPPORTED_VERSION` or `MISSING_CAPABILITY`. */
    data class Refused(val code: RosterWireErrorCode) : RosterNegotiation
}

/** Viewer-side decision on one `hello_ack`. */
sealed interface RosterAckVerdict {
    data class Accepted(
        val minor: Long,
        val capabilities: List<String>,
    ) : RosterAckVerdict

    /** Refused for [code]: `UNSUPPORTED_VERSION`, `MISSING_CAPABILITY`, or `PROTOCOL_VIOLATION`. */
    data class Refused(val code: RosterWireErrorCode) : RosterAckVerdict
}
