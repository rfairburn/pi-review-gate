package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostCatalog
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.identity.HostPin
import io.github.rfairburn.pireviewgate.core.identity.IdentityException
import io.github.rfairburn.pireviewgate.core.identity.IdentityFailureReason
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityHandle
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStore
import io.github.rfairburn.pireviewgate.core.identity.PeerKey
import io.github.rfairburn.pireviewgate.core.transport.PeerAdmissionGate
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel
import io.github.rfairburn.pireviewgate.core.transport.PeerChannelClose
import io.github.rfairburn.pireviewgate.core.transport.PeerClientIdentity
import io.github.rfairburn.pireviewgate.core.transport.PeerDelivery
import io.github.rfairburn.pireviewgate.core.transport.PeerEndpoint
import io.github.rfairburn.pireviewgate.core.transport.PeerKeyApprover
import io.github.rfairburn.pireviewgate.core.transport.PeerKeyDecision
import io.github.rfairburn.pireviewgate.core.transport.PeerOperation
import io.github.rfairburn.pireviewgate.core.transport.PeerPairOptions
import io.github.rfairburn.pireviewgate.core.transport.PeerPairResult
import io.github.rfairburn.pireviewgate.core.transport.PeerPairStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerSendGuard
import io.github.rfairburn.pireviewgate.core.transport.PeerSendReceipt
import io.github.rfairburn.pireviewgate.core.transport.PeerServerKeyPrompt
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportErrorCode
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportException
import io.github.rfairburn.pireviewgate.core.transport.PeerTrustSource
import java.security.KeyPairGenerator
import java.security.Principal
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import javax.net.ssl.X509ExtendedKeyManager
import kotlinx.coroutines.CompletableDeferred

/**
 * Shared fixtures for the connection-registry checks.
 *
 * The fake transport exists so a test can drive pair/open/dispose per
 * destination without a socket. It is verification only: production wiring uses
 * [HostTransportFactory.PRODUCTION], which delegates to the real peer transport.
 * Nothing in this file is reachable from a product default.
 */
internal object RegistryFixtures {

    fun spki(): ByteArray {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        return generator.generateKeyPair().public.encoded
    }

    fun storedKey(): PeerKey = PeerKey.fromSpki(spki())

    fun transportKey(): io.github.rfairburn.pireviewgate.core.transport.PeerKey =
        io.github.rfairburn.pireviewgate.core.transport.PeerKey.fromSpkiDer(spki())

    fun endpoint(seed: Int): Endpoint = Endpoint("10.0.0.$seed", 8_300 + seed)

    fun host(seed: Int, previouslyConnected: Boolean = false, suppressed: Boolean = false): ConfiguredHost =
        ConfiguredHost(
            id = HostId.parse("host-$seed"),
            label = HostLabel.parse("Host $seed"),
            endpoint = endpoint(seed),
            previouslyConnected = previouslyConnected,
            reconnectSuppressed = suppressed,
        )

    fun catalog(size: Int): HostCatalog = HostCatalog.of((1..size).map { host(it) })

    fun settings(vararg hosts: ConfiguredHost, autoReconnect: Boolean = false): NetworkSettings =
        NetworkSettings(
            autoReconnect = autoReconnect,
            viewerRemoteInputEnabled = NetworkSettings.DEFAULT_VIEWER_REMOTE_INPUT_ENABLED,
            hosts = HostCatalog.of(hosts.toList()),
        )

    /** A policy fast enough that a whole finite schedule fits inside a test. */
    fun fastPolicy(delays: List<Long> = listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 30_000L)) =
        HostConnectionPolicy(
            consentWindowMs = 120_000,
            pairingResponseOverheadMs = 30_000,
            autoReconnectDelaysMs = delays,
        )
}

/** One channel a test controls: it records sends and can be ended on demand. */
internal class FakeChannel(
    override val peerKey: io.github.rfairburn.pireviewgate.core.transport.PeerKey,
    override val lane: PeerAppLane,
    private val guard: PeerSendGuard,
    private val guardEpoch: Long,
) : PeerByteChannel {
    private val closedDeferred = CompletableDeferred<PeerChannelClose>()

    override val closed = closedDeferred
    override val label: String? = "fake-peer"
    override val bufferedAmount: Int = 0

    val sends = mutableListOf<ByteArray>()

    /** How many times anyone read this channel. The registry must never. */
    var receiveCalls: Int = 0
        private set

    /** How many frames this channel refused because their guard went stale. */
    var dropped: Int = 0
        private set

    override suspend fun send(
        bytes: ByteArray,
        writeGuard: PeerSendGuard,
        receipt: PeerSendReceipt,
    ) {
        // The real transport evaluates the guard at admission and again before
        // the write; a fake that skipped this would hide a lifecycle bug.
        if (!guard.allows() || !writeGuard.allows() || guard.epoch() != guardEpoch) {
            dropped += 1
            receipt.record(PeerDelivery.NOT_SENT)
            throw PeerTransportException(PeerTransportErrorCode.CHANNEL_NOT_OPEN)
        }
        sends += bytes
        receipt.record(PeerDelivery.WRITTEN)
    }

    override suspend fun receive(): ByteArray? {
        receiveCalls += 1
        return null
    }

    override suspend fun close() {
        endWith(1000, "local")
    }

    /** End the channel and report it, exactly as an abrupt peer close would. */
    fun endWith(code: Int = 1006, reason: String = "ended") {
        closedDeferred.complete(PeerChannelClose(code, reason))
    }

    val isClosed: Boolean get() = closedDeferred.isCompleted
}

/** One destination's fake transport. Every instance belongs to one destination. */
internal class FakeTransport(
    val serverKey: io.github.rfairburn.pireviewgate.core.transport.PeerKey,
    val endpoint: PeerEndpoint? = null,
) : HostTransport {
    var disposed: Boolean = false
        private set

    var pairCalls: Int = 0
        private set

    val openedLanes = mutableListOf<PeerAppLane>()
    val channels = mutableListOf<FakeChannel>()

    /** When set, the next pairing reports this status instead of succeeding. */
    var pairOutcome: PeerPairStatus? = null

    /** When set, pairing reports this HTTP status alongside [pairOutcome]. */
    var pairHttpStatus: Int = 0

    /** When set, an application open fails with this fixed code. */
    var openFailure: PeerTransportErrorCode? = null

    /**
     * When set, an open suspends here first. A test uses this to hold an attempt
     * inside the dial while another command retires it.
     */
    var openGate: CompletableDeferred<Unit>? = null

    /** Records the last approver decision, so a test can prove who prompted. */
    var lastApproverUsed: Boolean = false
        private set

    var lastPrompt: PeerServerKeyPrompt? = null
        private set

    /** The trust the transport last read, or `null` when nothing was remembered. */
    var lastReadTrust: io.github.rfairburn.pireviewgate.core.transport.PeerKey? = null
        private set

    /** True when a trust read threw, which is how the client fails closed. */
    var trustReadFailed: Boolean = false
        private set

    override suspend fun pair(
        endpoint: PeerEndpoint,
        identity: PeerClientIdentity,
        trust: PeerTrustSource,
        approver: PeerKeyApprover?,
        admission: PeerAdmissionGate,
        options: PeerPairOptions,
    ): PeerPairResult {
        pairCalls += 1
        readTrust(trust)
        if (!admission.authorize(endpoint, PeerOperation.PAIRING, serverKey)) {
            return refused(PeerPairStatus.DENIED, 403)
        }
        pairOutcome?.let { return refused(it, pairHttpStatus) }
        if (lastReadTrust == null) {
            lastApproverUsed = true
            val prompt = PeerServerKeyPrompt(serverKey, "fake-peer", endpoint)
            lastPrompt = prompt
            // Mirrors the real transport's consent contract exactly: a refusal is
            // a fixed error code, never a soft "aborted" result the caller could
            // mistake for a transient failure.
            if (approver == null) throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_REJECTED)
            when (approver.decide(prompt)) {
                PeerKeyDecision.ACCEPT -> Unit
                PeerKeyDecision.CANCEL -> throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_CANCELLED)
                PeerKeyDecision.REJECT -> throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_REJECTED)
            }
        }
        return PeerPairResult(true, PeerPairStatus.ACCEPTED, 200, serverKey, null)
    }

    override suspend fun open(
        endpoint: PeerEndpoint,
        lane: PeerAppLane,
        identity: PeerClientIdentity,
        trust: PeerTrustSource,
        admission: PeerAdmissionGate,
        sendGuard: PeerSendGuard,
    ): PeerByteChannel {
        openGate?.await()
        val remembered = readTrust(trust)
        if (!admission.authorize(endpoint, PeerOperation.forLane(lane), serverKey)) {
            throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
        }
        openFailure?.let { throw PeerTransportException(it) }
        // An application channel requires a remembered key: the real transport
        // refuses rather than prompting, and the fake keeps that rule.
        if (remembered == null) throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_MISMATCH)
        if (remembered != serverKey) throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_MISMATCH)
        val channel = FakeChannel(serverKey, lane, sendGuard, sendGuard.epoch())
        channels += channel
        openedLanes += lane
        return channel
    }

    override fun dispose() {
        disposed = true
        channels.toList().forEach { it.endWith(1000, "transport disposed") }
    }

    private fun refused(status: PeerPairStatus, httpStatus: Int): PeerPairResult =
        PeerPairResult(false, status, httpStatus, null, null)

    private suspend fun readTrust(trust: PeerTrustSource): io.github.rfairburn.pireviewgate.core.transport.PeerKey? {
        val read = try {
            trust.expectedPeerKey()
        } catch (_: Throwable) {
            trustReadFailed = true
            throw PeerTransportException(PeerTransportErrorCode.TRUST_STORE_FAILED)
        }
        lastReadTrust = read
        return read
    }
}

/**
 * A fake identity store with the same refusal vocabulary as the real lifecycle.
 *
 * It counts generations so a test can prove that startup and observation create
 * nothing, and that only an explicit Connect generates once.
 */
internal class FakeIdentityStore(
    initial: PeerIdentityStatus = PeerIdentityStatus.NeverInitialized,
) : PeerIdentityStore {
    var status: PeerIdentityStatus = initial
    var generations: Int = 0
        private set
    var observations: Int = 0
        private set
    var key: PeerKey = RegistryFixtures.storedKey()
        private set

    override fun status(): PeerIdentityStatus {
        observations += 1
        return status
    }

    override fun current(): PeerIdentityHandle = when (val observed = status()) {
        is PeerIdentityStatus.Ready -> FakeHandle(key)
        is PeerIdentityStatus.Refused -> throw IdentityException(observed.reason)
        PeerIdentityStatus.NeverInitialized -> throw IdentityException(IdentityFailureReason.MISSING_INITIALIZED)
    }

    override fun initialize(label: HostLabel): PeerIdentityHandle {
        when (status) {
            is PeerIdentityStatus.Ready -> throw IdentityException(IdentityFailureReason.ALREADY_INITIALIZED)
            is PeerIdentityStatus.Refused -> throw IdentityException((status as PeerIdentityStatus.Refused).reason)
            PeerIdentityStatus.NeverInitialized -> {
                generations += 1
                status = PeerIdentityStatus.Ready
            }
        }
        return FakeHandle(key)
    }

    override fun close() {
        // Nothing to release.
    }
}

/** A public-only identity handle. Its key manager signs nothing; no test dials. */
internal class FakeHandle(override val key: PeerKey) : PeerIdentityHandle {
    override val certificateChain: List<X509Certificate> = emptyList()
    override fun newKeyManager(): X509ExtendedKeyManager = NoOpKeyManager
}

private object NoOpKeyManager : X509ExtendedKeyManager() {
    override fun chooseEngineClientAlias(
        keyType: Array<out String>?,
        issuers: Array<out Principal>?,
        engine: javax.net.ssl.SSLEngine?,
    ): String? = null

    override fun chooseEngineServerAlias(
        keyType: String?,
        issuers: Array<out Principal>?,
        engine: javax.net.ssl.SSLEngine?,
    ): String? = null

    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> = emptyArray()

    override fun chooseClientAlias(
        keyType: Array<out String>?,
        issuers: Array<out Principal>?,
        socket: java.net.Socket?,
    ): String? = null

    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> = emptyArray()

    override fun chooseServerAlias(
        keyType: String?,
        issuers: Array<out Principal>?,
        socket: java.net.Socket?,
    ): String? = null

    override fun getCertificateChain(alias: String?): Array<X509Certificate>? = null
    override fun getPrivateKey(alias: String?): java.security.PrivateKey? = null
}
