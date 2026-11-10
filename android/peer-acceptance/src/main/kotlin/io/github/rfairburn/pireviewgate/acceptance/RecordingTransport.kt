package io.github.rfairburn.pireviewgate.acceptance

import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.transport.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first

/** Records attempts/real channel closure, never bytes, keys, receipts, or fake IO. */
class RecordingTransport(private val firstContact: () -> Unit) : HostTransportFactory {
    private val monitor = Any()
    private val delegates = ArrayList<HostTransport>()
    private val channels = ArrayList<PeerByteChannel>()
    private var sealed = false
    private var count = 0
    private var pending = 0
    private val inFlight = MutableStateFlow(0)
    val attempts: Int get() = synchronized(monitor) { count }

    override fun create(endpoint: PeerEndpoint, bounds: PeerTransportBounds): HostTransport = synchronized(monitor) {
        check(!sealed)
        count++
        val delegate = HostTransportFactory.PRODUCTION.create(endpoint, bounds)
        delegates.add(delegate)
        object : HostTransport by delegate {
            override suspend fun pair(
                endpoint: PeerEndpoint, identity: PeerClientIdentity, trust: PeerTrustSource,
                approver: PeerKeyApprover?, admission: PeerAdmissionGate, options: PeerPairOptions,
            ): PeerPairResult {
                begin()
                try {
                    return delegate.pair(endpoint, identity, trust, PeerKeyApprover {
                        firstContact()
                        PeerKeyDecision.REJECT
                    }, admission, options)
                }
                finally { end() }
            }
            override suspend fun open(
                endpoint: PeerEndpoint, lane: PeerAppLane, identity: PeerClientIdentity,
                trust: PeerTrustSource, admission: PeerAdmissionGate, sendGuard: PeerSendGuard,
            ): PeerByteChannel {
                begin()
                try {
                    val channel = delegate.open(endpoint, lane, identity, trust, admission, sendGuard)
                    val late = synchronized(monitor) { channels.add(channel); sealed }
                    if (late) { channel.close(); error("fixture transport sealed") }
                    return channel // Original production channel; retains all guards/receipts.
                } finally { end() }
            }
        }
    }

    private fun begin() = synchronized(monitor) {
        check(!sealed)
        count++; pending++; inFlight.value = pending
    }
    private fun end() = synchronized(monitor) { pending--; inFlight.value = pending }

    fun sealAndDispose() {
        val owned = synchronized(monitor) { sealed = true; delegates.toList() }
        owned.forEach { it.dispose() }
    }

    suspend fun awaitClosed() {
        check(synchronized(monitor) { sealed })
        inFlight.first { it == 0 }
        val owned = synchronized(monitor) { channels.toList() }
        for (channel in owned) channel.closed.await()
        check(owned.all { it.closed.isCompleted })
    }
}
