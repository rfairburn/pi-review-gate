package io.github.rfairburn.pireviewgate.core.transport

/**
 * Caller-supplied trust, admission, and lifecycle seams.
 *
 * The transport owns no persistence and no lifecycle of its own. The app layer
 * maps these callbacks onto its storage and view lifecycle, so the transport can
 * re-prove the current decision immediately before the first HTTP byte and
 * again before each queued frame is written.
 */

/**
 * The currently remembered server identity for the peer being contacted, or
 * null when nothing is remembered yet.
 *
 * Implementations must return the exact canonical [PeerKey] or null; they must
 * never throw for a "not remembered" answer. A throwing store is reported as
 * [PeerTransportErrorCode.TRUST_STORE_FAILED] and the connection fails closed.
 */
fun interface PeerTrustSource {
    suspend fun expectedPeerKey(): PeerKey?
}

/** Local decision about an observed server key that is not remembered yet. */
enum class PeerKeyDecision {
    ACCEPT,
    REJECT,
    CANCEL,
    ;
}

/**
 * Everything the transport can honestly show a human about one observed key:
 * the exact key proved on the completed handshake, its bounded certificate
 * label if any, and the endpoint it came from.
 */
class PeerServerKeyPrompt internal constructor(
    val key: PeerKey,
    val label: String?,
    val endpoint: PeerEndpoint,
)

/**
 * Foreground confirmation for a first-use pairing.
 *
 * The transport calls this only after a complete TLS handshake proved a valid
 * P-256 key and only before any HTTP byte is written. It is never called for an
 * application channel open, and never called to replace a remembered key.
 */
fun interface PeerKeyApprover {
    suspend fun decide(prompt: PeerServerKeyPrompt): PeerKeyDecision
}

/** What a connection is about to be used for, as re-proved before any byte. */
enum class PeerOperation {
    PAIRING,
    APP_CHANNEL,
    CONTENT_CHANNEL,
    ;

    internal companion object {
        internal fun forLane(lane: PeerAppLane): PeerOperation = when (lane) {
            PeerAppLane.APP -> APP_CHANNEL
            PeerAppLane.CONTENT -> CONTENT_CHANNEL
        }
    }
}

/**
 * Dynamic authorization and association proof.
 *
 * The transport cannot know whether an accepted pairing and its directional
 * grant are still current; the caller does. It is asked immediately before the
 * first HTTP byte, and a false answer refuses the connection without writing.
 */
fun interface PeerAdmissionGate {
    suspend fun authorize(endpoint: PeerEndpoint, operation: PeerOperation, peerKey: PeerKey): Boolean

    companion object {
        /** Default: the caller has no extra association proof to add. */
        val ALWAYS: PeerAdmissionGate = PeerAdmissionGate { _, _, _ -> true }
    }
}

/**
 * Non-blocking lifecycle and source guard evaluated over the outbound queue.
 *
 * It is checked before a frame is admitted and again immediately before the
 * frame is handed to the socket writer. A frame whose epoch changed, or which
 * is no longer allowed, is dropped without being sent and its send call fails
 * with [PeerTransportErrorCode.CHANNEL_NOT_OPEN].
 */
interface PeerSendGuard {
    /** Cheap, thread-safe, non-blocking check. */
    fun allows(): Boolean

    /**
     * Source or lifecycle epoch. A frame admitted under one epoch is dropped if
     * the epoch changed before dispatch, so a pending frame can never be sent
     * for a source that changed while it waited.
     */
    fun epoch(): Long = 0L

    companion object {
        /** Default: the channel's own state is the only guard. */
        val NONE: PeerSendGuard = object : PeerSendGuard {
            override fun allows(): Boolean = true
        }
    }
}
