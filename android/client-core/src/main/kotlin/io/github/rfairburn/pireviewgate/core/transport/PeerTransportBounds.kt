package io.github.rfairburn.pireviewgate.core.transport

/**
 * Explicit, finite client transport bounds.
 *
 * Every value and default is taken from the host contract's
 * `DEFAULT_PEER_TRANSPORT_BOUNDS`; nothing here is unbounded and there is no
 * "0 means unlimited" mode. Values a phone client cannot observe (listener bind
 * limits, per-listener connection admission) belong to the receiving half and
 * are deliberately absent.
 *
 * Constructing an invalid bound set fails with
 * [PeerTransportErrorCode.INVALID_ARGUMENT] rather than silently clamping.
 */
data class PeerTransportBounds(
    /** Bound on a friendly display label carried in `x-peer-label`. */
    val maxLabelBytes: Int,
    /** Bound on the total bytes of one written or read HTTP header block. */
    val maxHttpHeaderBytes: Int,
    /** Bound on the number of header lines in one HTTP header block. */
    val maxHttpHeaders: Int,
    /** Bound on a pairing response body, read before it is parsed. */
    val maxPairResponseBytes: Int,
    /** Bound on one complete inbound or outbound WebSocket message. */
    val maxWebSocketMessageBytes: Int,
    /** Bound on simultaneously pending local key confirmations. */
    val maxPendingConsents: Int,
    /** Bound on simultaneously outstanding pair/open operations. */
    val maxClientOperations: Int,
    /** Bound across queued plus in-flight outbound payload and control bytes. */
    val maxOutboundQueueBytes: Int,
    val tlsHandshakeTimeoutMs: Int,
    val consentTimeoutMs: Int,
    val pairingResponseTimeoutMs: Int,
    val closeTimeoutMs: Int,
    val openTimeoutMs: Int,
) {
    init {
        positive(maxLabelBytes)
        positive(maxHttpHeaderBytes)
        positive(maxHttpHeaders)
        positive(maxPairResponseBytes)
        positive(maxWebSocketMessageBytes)
        positive(maxPendingConsents)
        positive(maxClientOperations)
        positive(maxOutboundQueueBytes)
        positive(tlsHandshakeTimeoutMs)
        positive(consentTimeoutMs)
        positive(pairingResponseTimeoutMs)
        positive(closeTimeoutMs)
        positive(openTimeoutMs)
    }

    companion object {
        /** The shared defaults, identical to the host-side transport bounds. */
        val DEFAULT: PeerTransportBounds = PeerTransportBounds(
            maxLabelBytes = 64,
            maxHttpHeaderBytes = 4096,
            maxHttpHeaders = 20,
            maxPairResponseBytes = 2048,
            maxWebSocketMessageBytes = 65_536,
            maxPendingConsents = 8,
            maxClientOperations = 16,
            maxOutboundQueueBytes = 262_144,
            tlsHandshakeTimeoutMs = 5_000,
            consentTimeoutMs = 15_000,
            pairingResponseTimeoutMs = 10_000,
            closeTimeoutMs = 2_000,
            openTimeoutMs = 5_000,
        )

        private fun positive(value: Int) {
            if (value <= 0) throw invalidArgument()
        }
    }
}
