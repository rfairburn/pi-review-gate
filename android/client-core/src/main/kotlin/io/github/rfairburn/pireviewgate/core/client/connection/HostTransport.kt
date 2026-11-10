package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.transport.PeerAdmissionGate
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel
import io.github.rfairburn.pireviewgate.core.transport.PeerClientIdentity
import io.github.rfairburn.pireviewgate.core.transport.PeerEndpoint
import io.github.rfairburn.pireviewgate.core.transport.PeerKeyApprover
import io.github.rfairburn.pireviewgate.core.transport.PeerPairOptions
import io.github.rfairburn.pireviewgate.core.transport.PeerPairResult
import io.github.rfairburn.pireviewgate.core.transport.PeerSendGuard
import io.github.rfairburn.pireviewgate.core.transport.PeerTransport
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportBounds
import io.github.rfairburn.pireviewgate.core.transport.PeerTrustSource

/**
 * The transport a single destination owns for one connection lifetime.
 *
 * This is the seam that keeps the client honest about what it does: there is no
 * second HTTP stack, no second WebSocket framing, and no second TLS path in this
 * module. The production implementation below is a thin delegation to the real
 * [PeerTransport]; a test supplies a fake that answers the same two calls.
 *
 * One instance belongs to one destination for one connection lifetime, exactly
 * as the source coordinator owned one client per destination. That is what makes
 * "close this host without disturbing that one" possible: disposal is
 * per-destination by construction, never a shared pool.
 *
 * Note what is deliberately *not* here: no pooling, no resume, no shared
 * connection, and no operation bound that spans destinations. The transport's
 * own `maxClientOperations` counts one destination's outstanding pair/open
 * calls; because each destination has its own instance, it is never a cap on how
 * many hosts this client can hold.
 */
public interface HostTransport {
    /** Pair with the peer at [endpoint]. Never stores anything. */
    public suspend fun pair(
        endpoint: PeerEndpoint,
        identity: PeerClientIdentity,
        trust: PeerTrustSource,
        approver: PeerKeyApprover?,
        admission: PeerAdmissionGate,
        options: PeerPairOptions,
    ): PeerPairResult

    /** Open one lane on the peer at [endpoint]. */
    public suspend fun open(
        endpoint: PeerEndpoint,
        lane: PeerAppLane,
        identity: PeerClientIdentity,
        trust: PeerTrustSource,
        admission: PeerAdmissionGate,
        sendGuard: PeerSendGuard,
    ): PeerByteChannel

    /** End everything this instance still owns. Idempotent. */
    public fun dispose()
}

/**
 * Creates the transport for one destination.
 *
 * [endpoint] is the destination this instance will serve, and [bounds] carries
 * the human-flow windows from [HostConnectionPolicy]; the factory decides
 * nothing else. Production creates one fresh [PeerTransport] per destination.
 * A fixture creates a fake.
 */
public fun interface HostTransportFactory {
    public fun create(endpoint: PeerEndpoint, bounds: PeerTransportBounds): HostTransport

    public companion object {
        /** The production factory: one real [PeerTransport] per destination. */
        public val PRODUCTION: HostTransportFactory = HostTransportFactory { _, bounds ->
            DefaultHostTransport(PeerTransport(bounds))
        }
    }
}

/** The production [HostTransport]: delegation only. */
public class DefaultHostTransport(private val transport: PeerTransport) : HostTransport {
    override suspend fun pair(
        endpoint: PeerEndpoint,
        identity: PeerClientIdentity,
        trust: PeerTrustSource,
        approver: PeerKeyApprover?,
        admission: PeerAdmissionGate,
        options: PeerPairOptions,
    ): PeerPairResult = transport.pair(endpoint, identity, trust, approver, admission, options)

    override suspend fun open(
        endpoint: PeerEndpoint,
        lane: PeerAppLane,
        identity: PeerClientIdentity,
        trust: PeerTrustSource,
        admission: PeerAdmissionGate,
        sendGuard: PeerSendGuard,
    ): PeerByteChannel = transport.open(endpoint, lane, identity, trust, admission, sendGuard)

    override fun dispose(): Unit = transport.dispose()
}

/**
 * The transport bounds the phone client uses.
 *
 * Everything except the two human windows is the shipped transport default. The
 * defaults there are 15 seconds for a local key confirmation and 10 seconds for
 * a pairing response — correct numbers for an automated caller, wrong numbers
 * for a person comparing a fingerprint across two rooms.
 */
public fun humanFlowTransportBounds(policy: HostConnectionPolicy): PeerTransportBounds =
    PeerTransportBounds.DEFAULT.copy(
        consentTimeoutMs = requireBounded(policy.consentWindowMs, "consent window"),
        pairingResponseTimeoutMs = requireBounded(policy.pairingResponseTimeoutMs, "pairing response"),
    )

private fun requireBounded(value: Long, name: String): Int {
    require(value in 1..Int.MAX_VALUE.toLong()) { "$name is out of range" }
    return value.toInt()
}
