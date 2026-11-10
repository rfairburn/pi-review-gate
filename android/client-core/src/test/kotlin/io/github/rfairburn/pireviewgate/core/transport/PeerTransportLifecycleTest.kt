package io.github.rfairburn.pireviewgate.core.transport

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.KeyManager
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Ownership and deadline behaviour of [PeerTransport] around acquisition,
 * registration, disposal, and absolute operation deadlines.
 *
 * The transport's connection seam is replaced with scripted connections so
 * these races are reached deterministically instead of by timing luck.
 */
class PeerTransportLifecycleTest {

    private val endpoint = PeerEndpoint("127.0.0.1", 65_001)
    private val serverKey = TestSupport.peerKey()
    private val clientKey = TestSupport.peerKey()

    private val identity = object : PeerClientIdentity {
        override val label: String = "test-phone"
        override val keyId: String = clientKey.keyId
        override val keyManagers: Array<KeyManager> = arrayOf(object : KeyManager {})
    }

    private val trust: PeerTrustSource = PeerTrustSource { serverKey }
    private val approver: PeerKeyApprover = PeerKeyApprover { PeerKeyDecision.ACCEPT }

    @Test
    fun `cancelling during acquisition terminates the acquired connection`() = runBlocking(Dispatchers.IO) {
        val transport = PeerTransport()
        val acquired = AtomicReference<ScriptedConnection?>(null)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        transport.connector = { _, _, _ ->
            val created = ScriptedConnection(serverKey, ScriptedConnection.Mode.PAIRING, clientKey.keyId)
            acquired.set(created)
            entered.countDown()
            // A slow handshake that finishes only after the caller was cancelled.
            release.await()
            created
        }
        val job = async { runCatching { transport.pair(endpoint, identity, trust, approver) } }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        job.cancel()
        release.countDown()
        job.join()

        assertTrue(awaitUntil { acquired.get()?.terminated == true })
        assertEquals(0, transport.activeOperationCount)
        assertEquals(0, transport.trackedChannelCount)
    }

    @Test
    fun `cancelling after acquisition terminates the connection before any request byte`() =
        runBlocking(Dispatchers.IO) {
            val transport = PeerTransport()
            val connection = ScriptedConnection(serverKey, ScriptedConnection.Mode.PAIRING, clientKey.keyId)
            transport.connector = { _, _, _ -> connection }
            val entered = CountDownLatch(1)
            val suspendingApprover = PeerKeyApprover {
                entered.countDown()
                delay(60_000)
                PeerKeyDecision.ACCEPT
            }
            // Nothing is remembered yet, so pairing is the phase that waits here.
            val unremembered = PeerTrustSource { null }
            val job = async { runCatching { transport.pair(endpoint, identity, unremembered, suspendingApprover) } }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            job.cancel()
            job.join()

            assertTrue(awaitUntil { connection.terminated })
            // The pairing request was never written.
            assertEquals(0, connection.writtenBytes().size)
            assertEquals(0, transport.activeOperationCount)
        }

    @Test
    fun `disposing while an upgrade is in flight hands out no channel`() = runBlocking(Dispatchers.IO) {
        val transport = PeerTransport()
        val requested = CountDownLatch(1)
        val hold = CountDownLatch(1)
        val connection = ScriptedConnection(
            serverKey = serverKey,
            mode = ScriptedConnection.Mode.UPGRADE,
            acceptedPeerKey = clientKey.keyId,
            beforeResponse = {
                requested.countDown()
                hold.await()
            },
            // Keeping the already-buffered response readable isolates the
            // registration gate as the thing that refuses the channel.
            closeStreamsOnTerminate = false,
        )
        transport.connector = { _, _, _ -> connection }

        val job = async { runCatching { transport.open(endpoint, PeerAppLane.APP, identity, trust) } }
        assertTrue(requested.await(5, TimeUnit.SECONDS))
        transport.dispose()
        hold.countDown()

        val outcome = withTimeout(10_000) { job.await() }
        assertTrue(outcome.isFailure)
        assertTrue(connection.terminated)
        assertEquals(0, transport.trackedChannelCount)
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `a throwing initial trust lookup releases its lease and slot`() = runBlocking(Dispatchers.IO) {
        val transport = PeerTransport()
        var connections = 0
        transport.connector = { _, _, _ ->
            connections += 1
            ScriptedConnection(serverKey, ScriptedConnection.Mode.PAIRING, clientKey.keyId)
        }

        repeat(5) {
            val failingTrust = PeerTrustSource { throw IllegalStateException("store down") }
            val failure = assertFailsWith<PeerTransportException> {
                transport.pair(endpoint, identity, failingTrust, approver)
            }
            assertEquals(PeerTransportErrorCode.TRUST_STORE_FAILED, failure.code)
        }

        assertEquals(0, connections)
        assertEquals(0, transport.pendingConnectionCount)
        assertEquals(0, transport.trackedChannelCount)
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `a cancelled initial trust lookup releases its lease and slot`() = runBlocking(Dispatchers.IO) {
        val transport = PeerTransport()
        var connections = 0
        transport.connector = { _, _, _ ->
            connections += 1
            ScriptedConnection(serverKey, ScriptedConnection.Mode.PAIRING, clientKey.keyId)
        }

        repeat(5) {
            val cancellingTrust = PeerTrustSource { throw CancellationException("caller gone") }
            val outcome = runCatching { transport.pair(endpoint, identity, cancellingTrust, approver) }
            assertTrue(outcome.exceptionOrNull() is CancellationException)
        }

        assertEquals(0, connections)
        assertEquals(0, transport.pendingConnectionCount)
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `a denied admission terminates the acquired connection and balances slots`() = runBlocking(Dispatchers.IO) {
        val transport = PeerTransport()
        val connection = ScriptedConnection(serverKey, ScriptedConnection.Mode.UPGRADE, clientKey.keyId)
        transport.connector = { _, _, _ -> connection }

        val failure = assertFailsWith<PeerTransportException> {
            transport.open(endpoint, PeerAppLane.APP, identity, trust, PeerAdmissionGate { _, _, _ -> false })
        }
        assertEquals(PeerTransportErrorCode.APP_REFUSED, failure.code)
        assertTrue(connection.terminated)
        assertEquals(0, transport.trackedChannelCount)
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `a refused upgrade terminates the acquired connection and balances slots`() = runBlocking(Dispatchers.IO) {
        val transport = PeerTransport()
        val connection = ScriptedConnection(serverKey, ScriptedConnection.Mode.UPGRADE_REFUSED, clientKey.keyId)
        transport.connector = { _, _, _ -> connection }

        val failure = assertFailsWith<PeerTransportException> {
            transport.open(endpoint, PeerAppLane.APP, identity, trust)
        }
        assertEquals(PeerTransportErrorCode.APP_REFUSED, failure.code)
        assertTrue(connection.terminated)
        assertEquals(0, transport.trackedChannelCount)
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `a malformed upgrade terminates the acquired connection and balances slots`() = runBlocking(Dispatchers.IO) {
        val transport = PeerTransport()
        val connection = ScriptedConnection(serverKey, ScriptedConnection.Mode.UPGRADE_MALFORMED, clientKey.keyId)
        transport.connector = { _, _, _ -> connection }

        val failure = assertFailsWith<PeerTransportException> {
            transport.open(endpoint, PeerAppLane.APP, identity, trust)
        }
        assertEquals(PeerTransportErrorCode.APP_REFUSED, failure.code)
        assertTrue(connection.terminated)
        assertEquals(0, transport.trackedChannelCount)
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `a suspended admission callback is ended at the open deadline`() = runBlocking(Dispatchers.IO) {
        val bounds = PeerTransportBounds.DEFAULT.copy(openTimeoutMs = 300)
        val transport = PeerTransport(bounds)
        val connection = ScriptedConnection(serverKey, ScriptedConnection.Mode.UPGRADE, clientKey.keyId)
        transport.connector = { _, _, _ -> connection }
        val suspendedAdmission = PeerAdmissionGate { _, _, _ ->
            delay(60_000)
            true
        }

        val failure = assertFailsWith<PeerTransportException> {
            transport.open(endpoint, PeerAppLane.APP, identity, trust, suspendedAdmission)
        }
        assertEquals(PeerTransportErrorCode.APP_TIMEOUT, failure.code)
        assertTrue(connection.terminated)
        assertEquals(0, transport.trackedChannelCount)
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `cancelling during the channel handoff tears the channel down`() = runBlocking(Dispatchers.IO) {
        val transport = PeerTransport()
        val openJob = AtomicReference<Job>()
        // The transport clears the read timeout immediately before it builds and
        // registers the channel, so cancellation is pending at the handoff.
        val connection = ScriptedConnection(
            serverKey = serverKey,
            mode = ScriptedConnection.Mode.UPGRADE,
            acceptedPeerKey = clientKey.keyId,
            onReadTimeoutCleared = { openJob.get()?.cancel() },
        )
        transport.connector = { _, _, _ -> connection }

        val job = async(start = CoroutineStart.LAZY) {
            runCatching { transport.open(endpoint, PeerAppLane.APP, identity, trust) }
        }
        openJob.set(job)
        job.start()

        val outcome = withTimeout(5_000) { runCatching { job.await() } }
        assertTrue(outcome.isFailure || outcome.getOrNull()?.isFailure == true)
        assertTrue(awaitUntil { connection.terminated })
        assertEquals(0, transport.trackedChannelCount)
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `disposing during a real blocked handshake closes the socket`() = runBlocking(Dispatchers.IO) {
        val bounds = PeerTransportBounds.DEFAULT.copy(
            tlsHandshakeTimeoutMs = 60_000,
            openTimeoutMs = 60_000,
            pairingResponseTimeoutMs = 60_000,
        )
        val server = ServerSocket(0, 16, InetAddress.getLoopbackAddress())
        val accepted = CountDownLatch(1)
        val serverSawClose = CountDownLatch(1)
        thread(name = "silent-tls-peer") {
            try {
                val peer = server.accept()
                accepted.countDown()
                // Blocks until this side closes: nothing else releases it.
                peer.inputStream.read()
                serverSawClose.countDown()
            } catch (_: Throwable) {
                serverSawClose.countDown()
            }
        }
        val transport = PeerTransport(bounds)
        val job = async {
            runCatching {
                transport.pair(PeerEndpoint("127.0.0.1", server.localPort), identity, trust, approver)
            }
        }
        assertTrue(accepted.await(5, TimeUnit.SECONDS))

        // The peer is never released: disposal alone must end the handshake.
        transport.dispose()

        assertTrue(serverSawClose.await(5, TimeUnit.SECONDS))
        assertTrue(withTimeout(5_000) { job.await() }.isFailure)
        assertEquals(0, transport.activeOperationCount)
        server.close()
    }

    @Test
    fun `a channel that ends immediately is registered and then removed`() = runBlocking(Dispatchers.IO) {
        val transport = PeerTransport()
        val connection = ScriptedConnection(
            serverKey = serverKey,
            mode = ScriptedConnection.Mode.UPGRADE,
            acceptedPeerKey = clientKey.keyId,
            endInputAfterResponse = true,
        )
        transport.connector = { _, _, _ -> connection }

        val channel = transport.open(endpoint, PeerAppLane.APP, identity, trust)
        val close = withTimeout(5_000) { channel.closed.await() }
        assertEquals(WsFrameReader.CLOSE_ABNORMAL, close.code)
        // Registration happened before the reader could observe the end of stream,
        // and finalization removed the channel again.
        assertTrue(awaitUntil { transport.trackedChannelCount == 0 })
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `a pairing that trickles bytes past its absolute deadline is ended`() = runBlocking(Dispatchers.IO) {
        val bounds = PeerTransportBounds.DEFAULT.copy(pairingResponseTimeoutMs = 300)
        val transport = PeerTransport(bounds)
        val connection = ScriptedConnection(
            serverKey = serverKey,
            mode = ScriptedConnection.Mode.PAIRING,
            acceptedPeerKey = clientKey.keyId,
            trickleMs = 20,
        )
        transport.connector = { _, _, _ -> connection }

        val failure = assertFailsWith<PeerTransportException> {
            transport.pair(endpoint, identity, trust, approver)
        }
        assertEquals(PeerTransportErrorCode.PAIRING_TIMEOUT, failure.code)
        assertTrue(connection.terminated)
        assertEquals(0, transport.activeOperationCount)
    }

    @Test
    fun `an upgrade that trickles bytes past its absolute deadline is ended`() = runBlocking(Dispatchers.IO) {
        val bounds = PeerTransportBounds.DEFAULT.copy(openTimeoutMs = 400, tlsHandshakeTimeoutMs = 400)
        val transport = PeerTransport(bounds)
        val connection = ScriptedConnection(
            serverKey = serverKey,
            mode = ScriptedConnection.Mode.UPGRADE,
            acceptedPeerKey = clientKey.keyId,
            trickleMs = 20,
        )
        transport.connector = { _, _, _ -> connection }

        val failure = assertFailsWith<PeerTransportException> {
            transport.open(endpoint, PeerAppLane.APP, identity, trust)
        }
        assertEquals(PeerTransportErrorCode.APP_TIMEOUT, failure.code)
        assertTrue(connection.terminated)
        assertEquals(0, transport.activeOperationCount)
        assertEquals(0, transport.trackedChannelCount)
    }

    private suspend fun awaitUntil(
        timeoutMs: Long = 5_000,
        predicate: () -> Boolean,
    ): Boolean {
        withTimeout(timeoutMs) {
            while (!predicate()) delay(5)
        }
        return true
    }

    /**
     * A scripted peer connection.
     *
     * It waits for the transport's request, then answers it, optionally one byte
     * at a time. It deliberately ignores [applyReadTimeout]: a per-read timeout
     * bounds one blocking read, and these tests exist to prove that the
     * transport's absolute deadline is what ends a trickling exchange.
     */
    private class ScriptedConnection(
        serverKey: PeerKey,
        private val mode: Mode,
        private val acceptedPeerKey: String,
        private val trickleMs: Int = 0,
        private val endInputAfterResponse: Boolean = false,
        private val closeStreamsOnTerminate: Boolean = true,
        private val beforeResponse: () -> Unit = {},
        private val onReadTimeoutCleared: () -> Unit = {},
    ) : PeerByteConnection {
        enum class Mode { PAIRING, UPGRADE, UPGRADE_REFUSED, UPGRADE_MALFORMED }

        override val peerKey: PeerKey = serverKey
        override val peerLabel: String? = "scripted-peer"

        private val feedOut = PipedOutputStream()
        private val feedIn = PipedInputStream(feedOut, 262_144)
        private val sink = TestSupport.RecordingStream()
        private val responder: Thread

        @Volatile
        var terminated: Boolean = false
            private set

        override val input: InputStream = feedIn
        override val output: OutputStream
            get() = sink

        override fun applyReadTimeout(timeoutMs: Int) {
            // Deliberately ignored: only the transport's own deadline may end this.
            if (timeoutMs == 0) onReadTimeoutCleared()
        }

        fun writtenBytes(): ByteArray = sink.bytes()

        init {
            responder = Thread {
                try {
                    val request = awaitRequest()
                    beforeResponse()
                    val response = when (mode) {
                        Mode.PAIRING -> pairingResponse(acceptedPeerKey)
                        Mode.UPGRADE -> upgradeResponse(
                            requireNotNull(request["sec-websocket-key"]),
                            requireNotNull(request["sec-websocket-protocol"]),
                        )
                        Mode.UPGRADE_REFUSED ->
                            "HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n".toByteArray(Charsets.ISO_8859_1)
                        Mode.UPGRADE_MALFORMED ->
                            "not-an-http-response\r\n\r\n".toByteArray(Charsets.ISO_8859_1)
                    }
                    if (trickleMs > 0) {
                        for (byte in response) {
                            feedOut.write(byte.toInt())
                            feedOut.flush()
                            Thread.sleep(trickleMs.toLong())
                        }
                    } else {
                        feedOut.write(response)
                        feedOut.flush()
                    }
                    if (endInputAfterResponse) feedOut.close()
                } catch (_: Throwable) {
                    // The transport ended the pipe; the test asserts on that.
                }
            }
            responder.isDaemon = true
            responder.start()
        }

        override fun terminate() {
            terminated = true
            if (!closeStreamsOnTerminate) return
            try {
                feedOut.close()
            } catch (_: IOException) {
                // Already closed.
            }
            try {
                feedIn.close()
            } catch (_: IOException) {
                // Already closed.
            }
        }

        private fun awaitRequest(): Map<String, String> {
            val deadline = System.currentTimeMillis() + 5_000
            while (System.currentTimeMillis() < deadline) {
                val text = String(sink.bytes(), Charsets.ISO_8859_1)
                val end = text.indexOf("\r\n\r\n")
                if (end >= 0) return parseHeaders(text.substring(0, end))
                try {
                    Thread.sleep(5)
                } catch (_: InterruptedException) {
                    break
                }
            }
            return emptyMap()
        }

        private fun parseHeaders(block: String): Map<String, String> {
            val lines = block.split("\r\n").drop(1)
            val parsed = LinkedHashMap<String, String>()
            for (line in lines) {
                val colon = line.indexOf(':')
                if (colon > 0) parsed[line.substring(0, colon).lowercase()] = line.substring(colon + 1).trim()
            }
            return parsed
        }

        private fun pairingResponse(echoedKey: String): ByteArray {
            val body = "{\"status\":\"accepted\",\"acceptedPeerKey\":\"$echoedKey\"}"
            return render(
                "HTTP/1.1 200 OK",
                listOf("content-type" to "application/json", "content-length" to body.length.toString()),
                body,
            )
        }

        private fun upgradeResponse(key: String, subprotocol: String): ByteArray = render(
            "HTTP/1.1 101 Switching Protocols",
            listOf(
                "upgrade" to "websocket",
                "connection" to "Upgrade",
                "sec-websocket-accept" to WsHandshake.expectedAccept(key),
                "sec-websocket-protocol" to subprotocol,
            ),
            "",
        )

        private fun render(statusLine: String, headers: List<Pair<String, String>>, body: String): ByteArray {
            val head = StringBuilder(statusLine)
            for ((name, value) in headers) head.append("\r\n").append(name).append(": ").append(value)
            head.append("\r\n\r\n")
            return head.toString().toByteArray(Charsets.ISO_8859_1) + body.toByteArray(Charsets.ISO_8859_1)
        }
    }
}
