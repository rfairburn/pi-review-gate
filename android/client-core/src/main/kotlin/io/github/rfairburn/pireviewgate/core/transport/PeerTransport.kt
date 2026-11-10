package io.github.rfairburn.pireviewgate.core.transport

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.IOException
import java.net.SocketTimeoutException
import java.security.SecureRandom
import kotlin.coroutines.coroutineContext

/** Outcome of one pairing attempt, as observed by this side. */
enum class PeerPairStatus {
    ACCEPTED,
    ALREADY_ACCEPTED,
    DENIED,
    TIMEOUT,
    ABORTED,
    HTTP_ERROR,
    ;
}

/**
 * Result of [PeerTransport.pair].
 *
 * [serverKey] is the exact identity this side verified on the connection, and
 * it is returned only when the peer echoed this side's own key back. The
 * transport never persists it: committing trust is the caller's decision, made
 * after the echo is seen.
 */
class PeerPairResult internal constructor(
    val ok: Boolean,
    val status: PeerPairStatus,
    val httpStatus: Int,
    val serverKey: PeerKey?,
    val wireError: PeerWireErrorCode?,
)

/** Optional pairing metadata. The label is display metadata, never identity. */
data class PeerPairOptions(
    val label: String? = null,
    val claimKey: Boolean = true,
)

/**
 * Client half of the inert paired peer transport.
 *
 * One instance can drive many concurrent peers: every `pair` and `open` builds
 * its own TLS context and its own connection, so nothing is pooled, resumed,
 * or shared, and no automatic retry happens anywhere.
 *
 * The gate is always the same: the TLS handshake completes, the exact SPKI the
 * peer proved is compared with the caller's remembered key, and only then may a
 * single HTTP byte be written. For an explicit first-use pairing the observed
 * key is confirmed by a bounded foreground callback in that same pre-request
 * window. An application channel open requires a remembered key and never
 * prompts.
 */
class PeerTransport(private val bounds: PeerTransportBounds = PeerTransportBounds.DEFAULT) {

    private val lock = Any()
    private val channels = HashSet<DefaultPeerByteChannel>()

    /** Connections that exist but have not been handed to a channel yet. */
    private val pendingConnections = HashSet<ConnectionLease>()
    private val random = SecureRandom()

    /** Hosts the absolute-deadline watchdogs that forcibly end stalled I/O. */
    private val deadlineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * Connection seam. Production performs one fresh pinned TLS connection per
     * call; the transport owns whatever this returns the instant it exists.
     */
    internal var connector: (suspend (PeerEndpoint, PeerClientIdentity, ByteArray?) -> PeerByteConnection)? = null

    private var activeOperations = 0
    private var pendingConsents = 0
    private var disposed = false

    /** Outstanding pair/open operations, including live channels. */
    val activeOperationCount: Int
        get() = synchronized(lock) { activeOperations }

    /** Local key confirmations currently awaiting a decision. */
    val pendingConsentCount: Int
        get() = synchronized(lock) { pendingConsents }

    /**
     * Pair with one peer over `POST /pair`.
     *
     * [trust] supplies the currently remembered server key, or null when none
     * is remembered. Only in that unremembered case is [approver] consulted,
     * after the handshake proved a valid key and before any request byte. The
     * verified server key is returned for the caller to commit; this transport
     * stores nothing.
     */
    suspend fun pair(
        endpoint: PeerEndpoint,
        identity: PeerClientIdentity,
        trust: PeerTrustSource,
        approver: PeerKeyApprover? = null,
        admission: PeerAdmissionGate = PeerAdmissionGate.ALWAYS,
        options: PeerPairOptions = PeerPairOptions(),
    ): PeerPairResult {
        requireUsableIdentity(identity)
        val label = options.label ?: identity.label
        if (!isPeerLabel(label, bounds.maxLabelBytes)) throw invalidArgument()
        val claim = if (options.claimKey) identity.keyId else null
        if (claim != null && !isBoundedPeerKeyId(claim)) throw invalidArgument()
        coroutineContext.ensureActive()

        reserveOperation().let { ticket ->
            val lease = ConnectionLease()
            try {
                val expected = readTrust(trust)
                val connection = acquireConnection(lease, endpoint, identity, expected)
                try {
                    if (expected === null) {
                        confirmFirstUse(endpoint, connection.peerKey, connection.peerLabel, approver)
                    }
                    reproveBeforeRequest(
                        trust,
                        admission,
                        endpoint,
                        PeerOperation.PAIRING,
                        connection.peerKey,
                        expected,
                    )
                    val response = awaitBounded(
                        bounds.pairingResponseTimeoutMs,
                        PeerTransportErrorCode.PAIRING_TIMEOUT,
                        terminate = { lease.terminate() },
                    ) {
                        withContext(Dispatchers.IO) { exchangePairing(connection, endpoint, label, claim) }
                    }
                    return interpretPairing(response, connection, identity)
                } finally {
                    // Every pairing exit ends the connection this side owns.
                    lease.terminate()
                }
            } finally {
                // The lease registers itself at construction, so it is released here
                // too: a trust lookup that throws or is cancelled never reached the
                // inner cleanup path. Termination is idempotent.
                lease.terminate()
                ticket.release()
            }
        }
    }

    /**
     * Open one application channel on the exact [lane] requested.
     *
     * A remembered key is required: an unremembered peer is refused rather than
     * prompted, because a channel is not a pairing. The caller's [admission]
     * proof and [sendGuard] keep the association and lifecycle honest after the
     * channel exists.
     */
    suspend fun open(
        endpoint: PeerEndpoint,
        lane: PeerAppLane,
        identity: PeerClientIdentity,
        trust: PeerTrustSource,
        admission: PeerAdmissionGate = PeerAdmissionGate.ALWAYS,
        sendGuard: PeerSendGuard = PeerSendGuard.NONE,
    ): PeerByteChannel {
        requireUsableIdentity(identity)
        coroutineContext.ensureActive()

        val ticket = reserveOperation()
        // The lease exists before anything is acquired, so disposal can reach a
        // handshake that is still in progress.
        val lease = ConnectionLease()
        var handedOff = false
        var created: DefaultPeerByteChannel? = null
        try {
            // The whole open, acquisition included, runs inside one deadline.
            val opened = awaitBounded(
                bounds.openTimeoutMs,
                PeerTransportErrorCode.APP_TIMEOUT,
                terminate = { lease.terminate() },
            ) {
                val expected = readTrust(trust)
                    ?: throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_MISMATCH)
                val connection = acquireConnection(lease, endpoint, identity, expected)
                reproveBeforeRequest(
                    trust,
                    admission,
                    endpoint,
                    PeerOperation.forLane(lane),
                    connection.peerKey,
                    expected,
                )
                val key = WsHandshake.newKey(random)
                val negotiated = withContext(Dispatchers.IO) {
                    exchangeUpgrade(connection, endpoint, lane, key)
                }
                if (negotiated != lane) {
                    throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
                }
                val built = DefaultPeerByteChannel(
                    connection = connection,
                    peerKey = connection.peerKey,
                    lane = lane,
                    label = connection.peerLabel,
                    bounds = bounds,
                    sendGuard = sendGuard,
                    onFinalized = { finished ->
                        // Finalized channels leave the tracked set, so the
                        // set never grows past the live connections, and the
                        // operation slot is released exactly once.
                        synchronized(lock) { channels.remove(finished) }
                        ticket.release()
                    },
                )
                // Recorded at once, so any later cancellation or deadline can tear
                // this exact channel down instead of orphaning a live socket.
                created = built
                // Atomic ownership handoff: the channel is recorded or refused, and
                // a transport disposed while the upgrade was in flight never hands
                // out a live channel.
                val accepted = synchronized(lock) {
                    if (disposed) false else {
                        channels.add(built)
                        true
                    }
                }
                if (!accepted) {
                    built.closeNow()
                    throw PeerTransportException(PeerTransportErrorCode.HOST_CLOSED)
                }
                // The channel owns the socket from here; the lease stops tracking it.
                lease.disown()
                // Reader and writer begin only after registration, so an immediate
                // end-of-stream cannot finalize a channel that was never recorded.
                built.start()
                built
            }
            // Handoff is only complete once the bounded operation returned and this
            // caller is still alive; otherwise the cleanup below owns the channel.
            coroutineContext.ensureActive()
            handedOff = true
            return opened
        } catch (timeout: kotlinx.coroutines.TimeoutCancellationException) {
            // A channel that was built just before the deadline is not orphaned:
            // tearing it down removes it from the tracked set and releases the
            // operation slot through the same single-shot ticket.
            created?.closeNow()
            throw PeerTransportException(PeerTransportErrorCode.APP_TIMEOUT)
        } catch (cancellation: CancellationException) {
            created?.closeNow()
            throw cancellation
        } finally {
            if (!handedOff) {
                // Every unsuccessful exit ends the channel it built, the connection
                // it owns, and the operation slot it reserved.
                created?.closeNow()
                lease.terminate()
                ticket.release()
            }
        }
    }

    /** Close every channel and connection this transport still owns. Idempotent. */
    fun dispose() {
        val owned = synchronized(lock) {
            disposed = true
            val snapshot = channels.toList()
            channels.clear()
            val leases = pendingConnections.toList()
            pendingConnections.clear()
            snapshot to leases
        }
        for (channel in owned.first) channel.closeNow()
        // A handshake that completed but was never handed to a caller is still
        // owned here and never leaks past disposal.
        for (lease in owned.second) lease.terminate()
        deadlineScope.cancel()
    }

    // --- internals --------------------------------------------------------------

    /** Live channels this transport still owns; finalized ones are removed. */
    internal val trackedChannelCount: Int
        get() = synchronized(lock) { channels.size }

    /** Connections owned but not yet handed to a channel. */
    internal val pendingConnectionCount: Int
        get() = synchronized(lock) { pendingConnections.size }

    /**
     * Ownership of one acquired connection.
     *
     * The lease is registered before the connection is created and records the
     * socket the instant the factory returns it, so a connection that completes
     * while the caller is being cancelled is still owned and terminated, and
     * [dispose] can reach a connection that was never handed to anyone.
     */
    private inner class ConnectionLease {
        private val reference = java.util.concurrent.atomic.AtomicReference<PeerByteConnection?>(null)
        private var rawSocket: javax.net.ssl.SSLSocket? = null
        private var terminated = false

        init {
            // Registered before any blocking acquisition work starts, so disposal
            // can reach a connection that does not exist yet.
            synchronized(lock) {
                terminated = disposed
                if (!terminated) pendingConnections.add(this)
            }
        }

        /** Publish the raw socket before the blocking handshake begins. */
        fun adoptSocket(socket: javax.net.ssl.SSLSocket) {
            val accepted = synchronized(lock) {
                if (disposed || terminated) {
                    false
                } else {
                    rawSocket = socket
                    true
                }
            }
            if (!accepted) {
                try {
                    socket.close()
                } catch (_: Throwable) {
                    // Already gone.
                }
                throw PeerTransportException(PeerTransportErrorCode.HOST_CLOSED)
            }
        }

        /** Record the connection. False once the transport is disposed or ended. */
        fun adopt(connection: PeerByteConnection): Boolean = synchronized(lock) {
            if (disposed || terminated) {
                false
            } else {
                reference.set(connection)
                rawSocket = null
                pendingConnections.add(this)
                true
            }
        }

        /** Stop tracking: the channel that took over now owns the socket. */
        fun disown() {
            synchronized(lock) { pendingConnections.remove(this) }
        }

        fun terminate() {
            val owned = synchronized(lock) {
                terminated = true
                pendingConnections.remove(this)
                val socket = rawSocket
                rawSocket = null
                reference.getAndSet(null) to socket
            }
            try {
                owned.first?.terminate()
            } catch (_: Throwable) {
                // Teardown is best-effort; the socket is unusable either way.
            }
            // A handshake that has not produced a connection object yet is still
            // ended at the socket, which unblocks the pending handshake.
            try {
                owned.second?.close()
            } catch (_: Throwable) {
                // Already gone.
            }
        }
    }

    /**
     * Acquire one connection with cancellation-safe ownership.
     *
     * Acquisition runs under [NonCancellable] so a caller cancelled mid-handshake
     * still delivers the completed connection here, where it is recorded in the
     * lease and torn down, instead of being discarded during the dispatcher
     * handoff. Cancellation is honoured only after ownership exists.
     */
    private suspend fun acquireConnection(
        lease: ConnectionLease,
        endpoint: PeerEndpoint,
        identity: PeerClientIdentity,
        expected: PeerKey?,
    ): PeerByteConnection {
        val connection = try {
            withContext(Dispatchers.IO + kotlinx.coroutines.NonCancellable) {
                val created = try {
                    connector?.invoke(endpoint, identity, expected?.pinnedDer())
                        ?: connectPinned(endpoint, identity, expected?.pinnedDer(), lease)
                } catch (failure: PeerTransportException) {
                    throw failure
                } catch (failure: Throwable) {
                    throw PeerTransportException(PeerTransportErrorCode.TLS_HANDSHAKE_FAILED)
                }
                if (!lease.adopt(created)) {
                    created.terminate()
                    throw PeerTransportException(PeerTransportErrorCode.HOST_CLOSED)
                }
                created
            }
        } catch (failure: Throwable) {
            lease.terminate()
            throw failure
        }
        try {
            coroutineContext.ensureActive()
        } catch (cancellation: CancellationException) {
            lease.terminate()
            throw cancellation
        }
        return connection
    }

    /**
     * Run [block] under one absolute deadline.
     *
     * Two mechanisms cooperate, because neither alone is enough: a coroutine
     * timeout cancels a suspended callback and rejects a completion that arrives
     * after expiry, while a watchdog ends the owned connection because no
     * coroutine timeout can interrupt a blocking socket read or write.
     */
    private suspend fun <T> awaitBounded(
        timeoutMs: Int,
        timeoutCode: PeerTransportErrorCode,
        terminate: () -> Unit,
        block: suspend () -> T,
    ): T {
        val expired = java.util.concurrent.atomic.AtomicBoolean(false)
        val guard = deadlineScope.launch {
            try {
                delay(timeoutMs.toLong())
            } catch (_: CancellationException) {
                return@launch
            }
            expired.set(true)
            try {
                terminate()
            } catch (_: Throwable) {
                // The block's own failure reports the outcome.
            }
        }
        val result = try {
            withTimeoutOrNull(timeoutMs.toLong()) { BoundedValue(block()) }
        } catch (failure: Throwable) {
            if (expired.get() && failure !is CancellationException) {
                throw PeerTransportException(timeoutCode)
            }
            throw failure
        } finally {
            guard.cancel()
        }
        if (result == null || expired.get()) {
            // Nothing that finished past the deadline is accepted, and the owned
            // connection is ended rather than left for a later caller.
            try {
                terminate()
            } catch (_: Throwable) {
                // Teardown is best-effort.
            }
            throw PeerTransportException(timeoutCode)
        }
        return result.value
    }

    private class BoundedValue<T>(val value: T)

    /** Production connector: one fresh pinned TLS connection, deadline-guarded. */
    private suspend fun connectPinned(
        endpoint: PeerEndpoint,
        identity: PeerClientIdentity,
        pinnedSpkiDer: ByteArray?,
        lease: ConnectionLease,
    ): PeerTlsConnection {
        val socketRef = java.util.concurrent.atomic.AtomicReference<javax.net.ssl.SSLSocket?>(null)
        val expired = java.util.concurrent.atomic.AtomicBoolean(false)
        val guard = deadlineScope.launch {
            try {
                delay(bounds.tlsHandshakeTimeoutMs.toLong())
            } catch (_: CancellationException) {
                return@launch
            }
            expired.set(true)
            try {
                socketRef.getAndSet(null)?.close()
            } catch (_: Throwable) {
                // A stalled handshake is over either way.
            }
        }
        try {
            return PeerTlsConnection.connect(
                endpoint,
                identity,
                pinnedSpkiDer,
                bounds.tlsHandshakeTimeoutMs,
                onSocket = { socket ->
                    // Published into the lease before any blocking handshake work,
                    // so disposal can end a handshake that is still in progress.
                    lease.adoptSocket(socket)
                    socketRef.set(socket)
                    if (expired.get()) {
                        socketRef.getAndSet(null)?.close()
                        throw PeerTransportException(PeerTransportErrorCode.TLS_HANDSHAKE_TIMEOUT)
                    }
                },
            )
        } catch (failure: PeerTransportException) {
            if (expired.get()) {
                throw PeerTransportException(PeerTransportErrorCode.TLS_HANDSHAKE_TIMEOUT)
            }
            throw failure
        } finally {
            guard.cancel()
            socketRef.set(null)
        }
    }

    /**
     * One reserved client operation slot. Release is single-shot so the open
     * path, the channel's own finalization, and a deadline or cancellation race
     * can never double-decrement or strand a slot.
     */
    private inner class OperationTicket {
        private val released = java.util.concurrent.atomic.AtomicBoolean(false)

        fun release() {
            if (released.compareAndSet(false, true)) {
                synchronized(lock) {
                    if (activeOperations > 0) activeOperations -= 1
                }
            }
        }
    }

    private fun reserveOperation(): OperationTicket {
        synchronized(lock) {
            if (disposed) throw PeerTransportException(PeerTransportErrorCode.HOST_CLOSED)
            if (activeOperations >= bounds.maxClientOperations) {
                throw PeerTransportException(PeerTransportErrorCode.CLIENT_LIMIT_REACHED)
            }
            activeOperations += 1
        }
        return OperationTicket()
    }

    private suspend fun readTrust(trust: PeerTrustSource): PeerKey? = try {
        trust.expectedPeerKey()
    } catch (cancellation: CancellationException) {
        // A cancelled caller is never reported as a failing trust store.
        throw cancellation
    } catch (failure: PeerTransportException) {
        throw failure
    } catch (_: Throwable) {
        throw PeerTransportException(PeerTransportErrorCode.TRUST_STORE_FAILED)
    }

    /**
     * Bounded foreground confirmation of an observed key, called only inside
     * the pre-request window of an explicit pairing.
     */
    private suspend fun confirmFirstUse(
        endpoint: PeerEndpoint,
        observedKey: PeerKey,
        observedLabel: String?,
        approver: PeerKeyApprover?,
    ) {
        if (approver == null) throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_REJECTED)
        val slot = synchronized(lock) {
            if (disposed) {
                null
            } else if (pendingConsents >= bounds.maxPendingConsents) {
                null
            } else {
                pendingConsents += 1
                true
            }
        } ?: throw if (disposed) {
            PeerTransportException(PeerTransportErrorCode.HOST_CLOSED)
        } else {
            PeerTransportException(PeerTransportErrorCode.CONSENT_LIMIT_REACHED)
        }
        try {
            coroutineContext.ensureActive()
            val decision = try {
                withTimeout(bounds.consentTimeoutMs.toLong()) {
                    approver.decide(PeerServerKeyPrompt(observedKey, observedLabel, endpoint))
                }
            } catch (timeout: kotlinx.coroutines.TimeoutCancellationException) {
                throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_PROMPT_TIMEOUT)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: PeerTransportException) {
                throw failure
            } catch (_: Throwable) {
                throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_APPROVER_FAILED)
            }
            when (decision) {
                PeerKeyDecision.ACCEPT -> Unit
                PeerKeyDecision.CANCEL -> throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_CANCELLED)
                PeerKeyDecision.REJECT -> throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_REJECTED)
            }
        } finally {
            synchronized(lock) {
                if (pendingConsents > 0) pendingConsents -= 1
            }
        }
    }

    /**
     * Re-prove key, endpoint association, and lifecycle immediately before the
     * first HTTP byte. A trust source that changed while the handshake and any
     * confirmation were pending fails the connection closed.
     */
    private suspend fun reproveBeforeRequest(
        trust: PeerTrustSource,
        admission: PeerAdmissionGate,
        endpoint: PeerEndpoint,
        operation: PeerOperation,
        observedKey: PeerKey,
        expectedAtStart: PeerKey?,
    ) {
        if (disposed) throw PeerTransportException(PeerTransportErrorCode.HOST_CLOSED)
        coroutineContext.ensureActive()
        val current = readTrust(trust)
        if (expectedAtStart != null) {
            if (current == null || current != expectedAtStart) {
                throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_CHANGED)
            }
            if (current != observedKey) {
                throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_MISMATCH)
            }
        } else if (current != null && current != observedKey) {
            throw PeerTransportException(PeerTransportErrorCode.PEER_KEY_CHANGED)
        }
        val admitted = try {
            admission.authorize(endpoint, operation, observedKey)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: PeerTransportException) {
            throw failure
        } catch (_: Throwable) {
            throw PeerTransportException(PeerTransportErrorCode.TRUST_STORE_FAILED)
        }
        if (!admitted) {
            throw PeerTransportException(
                if (operation == PeerOperation.PAIRING) {
                    PeerTransportErrorCode.PAIRING_DENIED
                } else {
                    PeerTransportErrorCode.APP_REFUSED
                },
            )
        }
        if (disposed) throw PeerTransportException(PeerTransportErrorCode.HOST_CLOSED)
        coroutineContext.ensureActive()
    }

    private class PairingResponse(val statusCode: Int, val body: ByteArray)

    private fun exchangePairing(
        connection: PeerByteConnection,
        endpoint: PeerEndpoint,
        label: String,
        claim: String?,
    ): PairingResponse {
        val headers = ArrayList<Pair<String, String>>(5)
        headers.add("Host" to endpoint.hostHeaderValue())
        headers.add(PEER_LABEL_HEADER to label)
        if (claim != null) headers.add(PEER_KEY_HEADER to claim)
        headers.add("content-length" to "0")
        headers.add("connection" to "close")
        val request = HttpExchange.renderRequest("POST $PAIRING_PATH HTTP/1.1", headers, bounds)
        connection.applyReadTimeout(bounds.pairingResponseTimeoutMs)
        try {
            HttpExchange.writeAll(connection.output, request)
            val head = HttpHeadReader(connection.input, bounds.maxHttpHeaderBytes, bounds.maxHttpHeaders).read()
            val body = HttpExchange.readBoundedBody(connection.input, head, bounds.maxPairResponseBytes)
            return PairingResponse(head.statusCode, body)
        } catch (failure: HttpExchange.BodyTooLargeException) {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_RESPONSE_TOO_LARGE)
        } catch (failure: HttpHeadTooLargeException) {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_RESPONSE_TOO_LARGE)
        } catch (failure: HttpHeadInvalidException) {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_RESPONSE_INVALID)
        } catch (failure: SocketTimeoutException) {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_TIMEOUT)
        } catch (_: IOException) {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_FAILED)
        }
    }

    private fun exchangeUpgrade(
        connection: PeerByteConnection,
        endpoint: PeerEndpoint,
        lane: PeerAppLane,
        key: String,
    ): PeerAppLane {
        val request = WsHandshake.buildRequest(endpoint, lane.subprotocol, key, bounds)
        connection.applyReadTimeout(bounds.openTimeoutMs)
        try {
            HttpExchange.writeAll(connection.output, request)
            val head = HttpHeadReader(connection.input, bounds.maxHttpHeaderBytes, bounds.maxHttpHeaders).read()
            WsHandshake.validateResponse(head, key, lane.subprotocol)
            val negotiated = PeerAppLane.fromSubprotocol(head.singleValue("sec-websocket-protocol"))
            if (negotiated == null) throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
            // The channel owns the socket from here and must never expire an idle
            // frame: the reader runs without a read timeout.
            connection.applyReadTimeout(0)
            return negotiated
        } catch (failure: PeerTransportException) {
            throw failure
        } catch (failure: HttpHeadTooLargeException) {
            throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
        } catch (failure: HttpHeadInvalidException) {
            throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
        } catch (failure: SocketTimeoutException) {
            throw PeerTransportException(PeerTransportErrorCode.APP_TIMEOUT)
        } catch (_: IOException) {
            throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
        }
    }

    private fun interpretPairing(
        response: PairingResponse,
        connection: PeerByteConnection,
        identity: PeerClientIdentity,
    ): PeerPairResult {
        val body = parseJsonObject(response.body)
        val wireError = PeerWireErrorCode.fromWire(body?.stringField("error"))
        if (response.statusCode != 200) {
            val status = when (response.statusCode) {
                408 -> PeerPairStatus.TIMEOUT
                403 -> PeerPairStatus.DENIED
                else -> PeerPairStatus.HTTP_ERROR
            }
            return PeerPairResult(ok = false, status = status, httpStatus = response.statusCode, serverKey = null, wireError = wireError)
        }
        val reported = body?.stringField("status")
        if (reported != "accepted" && reported != "already_accepted") {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_RESPONSE_INVALID)
        }
        val echoed = body?.stringField("acceptedPeerKey")
            ?: throw PeerTransportException(PeerTransportErrorCode.PAIRING_RESPONSE_INVALID)
        val ownKey = try {
            PeerKey.fromKeyId(identity.keyId)
        } catch (_: PeerTransportException) {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_KEY_ECHO_MISMATCH)
        }
        val accepted = try {
            PeerKey.fromKeyId(echoed)
        } catch (_: PeerTransportException) {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_KEY_ECHO_MISMATCH)
        }
        if (accepted != ownKey) {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_KEY_ECHO_MISMATCH)
        }
        // A TLS connection always proves its decision on exactly one completed
        // handshake; the requirement is enforced in PeerTlsConnection.connect.
        if (connection is PeerTlsConnection && connection.handshakeCount != 1) {
            throw PeerTransportException(PeerTransportErrorCode.PAIRING_HANDSHAKE_COUNT_MISMATCH)
        }
        return PeerPairResult(
            ok = true,
            status = if (reported == "accepted") PeerPairStatus.ACCEPTED else PeerPairStatus.ALREADY_ACCEPTED,
            httpStatus = response.statusCode,
            serverKey = connection.peerKey,
            wireError = null,
        )
    }

    private companion object {
        val JSON = Json { ignoreUnknownKeys = true; isLenient = false }

        fun parseJsonObject(body: ByteArray): JsonObject? = try {
            JSON.parseToJsonElement(String(body, Charsets.UTF_8)) as? JsonObject
        } catch (_: Throwable) {
            null
        }

        fun JsonObject.stringField(name: String): String? {
            val element = this[name] as? JsonPrimitive ?: return null
            if (!element.isString) return null
            return element.content
        }
    }
}
