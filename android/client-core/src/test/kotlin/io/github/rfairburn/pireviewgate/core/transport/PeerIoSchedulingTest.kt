package io.github.rfairburn.pireviewgate.core.transport

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Real transport scheduling under a constrained test-only I/O pool. */
class PeerIoSchedulingTest {
    @Before
    fun constrainedIoFork() {
        assertEquals("4", System.getProperty("kotlinx.coroutines.io.parallelism"))
    }

    @Test
    fun fourIdleAppReadersMustNotStarveBinarySendOrFifthContent() = runBlocking {
        val fixtures = mutableListOf<Fixture>()
        var sender: kotlinx.coroutines.Deferred<Result<Unit>>? = null
        var ordinaryIo: kotlinx.coroutines.Deferred<Boolean>? = null
        try {
            repeat(4) { fixtures += Fixture() }
            fixtures.forEach { assertTrue(it.connection.idleEntered.await(5, TimeUnit.SECONDS), "reader did not enter blocking read") }
            assertEquals(4, fixtures.sumOf { it.connection.activeReads.get() })
            val payload = "HELLO-sized binary test payload".toByteArray()
            val receipt = PeerSendReceipt()
            // UNDISPATCHED proves send() admitted the actual frame before we wait.
            sender = async(start = CoroutineStart.UNDISPATCHED) { runCatching { fixtures[0].channel.send(payload, receipt = receipt) } }
            ordinaryIo = async(Dispatchers.IO) { true }
            val progressed = withTimeoutOrNull(2_000) { sender.await().getOrThrow(); true } ?: false
            val idleCount = fixtures.sumOf { it.connection.activeReads.get() }
            println("WRITER progressed=$progressed idleEntered=${fixtures.count { it.connection.idleEntered.count == 0L }} active=$idleCount invoked=${receipt.wasInvoked} delivery=${receipt.delivery} buffered=${fixtures[0].channel.bufferedAmount} ordinaryIoCompleted=${ordinaryIo.isCompleted}")
            assertEquals(4, idleCount, "all four APP readers must remain blocked during writer assertion")
            assertFalse(fixtures.any { it.connection.terminated.get() }, "no connection may be released to make writer progress")
            assertTrue(progressed, "WRITER_STARVED: four entered idle APP readers, binary send could not finish under IO=4")
            assertTrue(receipt.wasInvoked)
            assertEquals(PeerDelivery.WRITTEN, receipt.delivery)
            val frame = TestSupport.decodeClientFrame(fixtures[0].connection.bytes())
            assertEquals(WsFrameCodec.OP_BINARY, frame.opcode)
            assertTrue(frame.masked)
            assertTrue(frame.payload.contentEquals(payload))
            assertTrue(withTimeout(2_000) { ordinaryIo.await() }, "independent default IO must remain usable")
            fixtures += Fixture(lane = PeerAppLane.CONTENT)
            val content = fixtures.last()
            assertTrue(content.connection.idleEntered.await(5, TimeUnit.SECONDS), "fifth CONTENT reader could not enter")
            val contentReceipt = PeerSendReceipt()
            withTimeout(2_000) { content.channel.send(payload, receipt = contentReceipt) }
            assertEquals(PeerDelivery.WRITTEN, contentReceipt.delivery)
            assertTrue(contentReceipt.wasInvoked)
            val contentFrame = TestSupport.decodeClientFrame(content.connection.bytes())
            assertEquals(WsFrameCodec.OP_BINARY, contentFrame.opcode)
            assertTrue(contentFrame.payload.contentEquals(payload))
            assertEquals(5, fixtures.sumOf { it.connection.activeReads.get() })
            assertFalse(fixtures.any { it.connection.terminated.get() })
            println("CONTENT fifthReaderEntered=true binaryWritten=true allFiveBlocked=true ordinaryIO=true")
        } finally {
            cleanup(fixtures)
            sender?.cancelAndJoin()
            ordinaryIo?.cancelAndJoin()
        }
    }

    @Test
    fun closeWatchdogMustTerminateBlockedReplyWithOtherIoSlotsOccupied() = runBlocking {
        val fixtures = mutableListOf<Fixture>()
        try {
            repeat(3) { fixtures += Fixture() }
            fixtures.forEach { assertTrue(it.connection.idleEntered.await(5, TimeUnit.SECONDS)) }
            // A real unsupported text frame drives readerLoop -> refuseWith ->
            // attemptCloseFrame. Its close reply blocks in the output stream.
            val target = Fixture(prefix = TestSupport.serverFrame(WsFrameCodec.OP_TEXT, byteArrayOf(65)), blockOutput = true)
            fixtures += target
            assertTrue(target.connection.writeEntered.await(5, TimeUnit.SECONDS), "real close reply did not reach output")
            assertEquals(3, fixtures.sumOf { it.connection.activeReads.get() })
            assertEquals(1, target.connection.activeWrites.get())
            val close = withTimeoutOrNull(PeerTransportBounds.DEFAULT.closeTimeoutMs.toLong() + 1_000) { target.channel.closed.await() }
            println("WATCHDOG progressed=${close != null} idleEntered=3 activeIdle=${fixtures.take(3).sumOf { it.connection.activeReads.get() }} targetTerminated=${target.connection.terminated.get()} finalizations=${target.finalized.get()}")
            assertTrue(close != null, "WATCHDOG_STARVED: three idle readers plus blocked close reply occupied IO=4; default 2000ms watchdog did not terminate connection")
            assertEquals(WsFrameReader.CLOSE_UNSUPPORTED_MESSAGE, close.code)
            assertTrue(target.connection.terminated.get())
            assertEquals(1, target.finalized.get())
            assertFalse(fixtures.take(3).any { it.connection.terminated.get() })
            assertEquals(3, fixtures.take(3).sumOf { it.connection.activeReads.get() })
        } finally {
            cleanup(fixtures)
        }
    }

    @Test
    fun fourOwnedOpenReadsMustNotStarveTheirAbsoluteDeadlines() = runBlocking {
        val transport = PeerTransport()
        val connections = List(4) { BlockingConnection(byteArrayOf(), false) }
        val nextConnection = AtomicInteger()
        val identity = object : PeerClientIdentity {
            override val label = "test-no-keypair"
            override val keyId = connections.first().peerKey.keyId
            override val keyManagers = arrayOf<javax.net.ssl.KeyManager>(object : javax.net.ssl.KeyManager {})
        }
        transport.connector = { _, _, _ -> connections[nextConnection.getAndIncrement()] }
        val operations = mutableListOf<kotlinx.coroutines.Deferred<Result<PeerByteChannel>>>()
        try {
            // All four operation coordinators are Default, never IO or the
            // latch-waiting runBlocking event loop. Only real HTTP upgrade reads
            // occupy IO. This also remains independent of the channel candidate.
            repeat(4) {
                operations += async(Dispatchers.Default) {
                    runCatching { transport.open(PeerEndpoint("no-network.invalid", 443), PeerAppLane.APP, identity, PeerTrustSource { connections.first().peerKey }) }
                }
            }
            connections.forEach {
                assertTrue(it.idleEntered.await(5, TimeUnit.SECONDS), "owned upgrade response read did not block")
                assertTrue(it.writeEntered.await(5, TimeUnit.SECONDS), "real upgrade request was not written")
            }
            assertEquals(4, connections.sumOf { it.activeReads.get() })
            assertEquals(4, transport.pendingConnectionCount)
            assertEquals(4, transport.activeOperationCount)
            val results = withTimeoutOrNull(PeerTransportBounds.DEFAULT.openTimeoutMs.toLong() + 1_000) { operations.map { it.await() } }
            println("OPEN_DEADLINE progressed=${results != null} enteredOwnedReads=4 activeOwnedReads=${connections.sumOf { it.activeReads.get() }} terminated=${connections.count { it.terminated.get() }} completedOperations=${operations.count { it.isCompleted }}")
            assertTrue(results != null, "OPEN_DEADLINE_STARVED: four owned upgrade reads occupied IO=4; default 5000ms absolute deadlines did not terminate connections")
            results.forEach {
                assertTrue(it.isFailure)
                assertEquals(PeerTransportErrorCode.APP_TIMEOUT, (it.exceptionOrNull() as PeerTransportException).code)
            }
            assertTrue(connections.all { it.terminated.get() })
        } finally {
            withContext(NonCancellable) {
                transport.dispose()
                connections.forEach { it.terminate() }
                withTimeout(5_000) {
                    operations.forEach { it.join() }
                    val scope = PeerTransport::class.java.getDeclaredField("deadlineScope").also { it.isAccessible = true }.get(transport) as CoroutineScope
                    scope.coroutineContext[Job]!!.join()
                }
                assertEquals(0, transport.activeOperationCount)
                assertEquals(0, transport.pendingConnectionCount)
                assertEquals(0, transport.trackedChannelCount)
                assertEquals(0, connections.sumOf { it.activeReads.get() })
                assertEquals(0, connections.sumOf { it.activeWrites.get() })
                println("OPEN_CLEANUP completed=true joinedOperations=4 joinedDeadlineScope=true activeOperations=0 pending=0 tracked=0 activeReads=0 activeWrites=0")
            }
        }
    }

    private suspend fun cleanup(fixtures: List<Fixture>) = withContext(NonCancellable) {
        // terminate() releases every latch, even for a failed assertion. Joining
        // the actual scope job proves both transport children have exited.
        fixtures.forEach { it.channel.closeNow() }
        withTimeout(5_000) {
            fixtures.forEach {
                it.channel.closed.await()
                it.scopeJob.join()
                assertTrue(it.connection.terminated.get())
                assertEquals(0, it.connection.activeReads.get())
                assertEquals(0, it.connection.activeWrites.get())
                assertEquals(1, it.finalized.get())
                assertEquals(0, it.channel.bufferedAmount)
            }
        }
        println("CLEANUP completed=true channels=${fixtures.size} joinedScopes=${fixtures.size} activeReads=0 activeWrites=0 finalizationsOnce=true")
    }

    private class Fixture(
        lane: PeerAppLane = PeerAppLane.APP,
        prefix: ByteArray = byteArrayOf(),
        blockOutput: Boolean = false,
    ) {
        val connection = BlockingConnection(prefix, blockOutput)
        val finalized = AtomicInteger()
        val channel = DefaultPeerByteChannel(connection, connection.peerKey, lane, "test-channel", PeerTransportBounds.DEFAULT, PeerSendGuard.NONE) { finalized.incrementAndGet() }
        // Read-only test introspection solely to join the existing owner job;
        // no production hook, cancellation change, or synthetic finalization.
        val scopeJob: Job = (DefaultPeerByteChannel::class.java.getDeclaredField("scope").also { it.isAccessible = true }.get(channel) as CoroutineScope).coroutineContext[Job]!!
        init { channel.start() }
    }

    private class BlockingConnection(private val prefix: ByteArray, private val blockOutput: Boolean) : PeerByteConnection {
        override val peerKey = PeerKey.fromSpkiDer(byteArrayOf(0x30, 0x01, 0x00))
        override val peerLabel = "synthetic-no-keypair"
        val terminated = AtomicBoolean()
        val idleEntered = CountDownLatch(1)
        val writeEntered = CountDownLatch(1)
        val activeReads = AtomicInteger()
        val activeWrites = AtomicInteger()
        private val release = CountDownLatch(1)
        private val sink = ByteArrayOutputStream()
        private var cursor = 0
        override val input = object : InputStream() {
            override fun read(): Int {
                if (cursor < prefix.size) return prefix[cursor++].toInt() and 0xff
                if (terminated.get()) return -1
                activeReads.incrementAndGet()
                idleEntered.countDown()
                return try { release.await(); -1 } finally { activeReads.decrementAndGet() }
            }
        }
        override val output = object : OutputStream() {
            override fun write(value: Int) = write(byteArrayOf(value.toByte()), 0, 1)
            override fun write(bytes: ByteArray, off: Int, len: Int) {
                activeWrites.incrementAndGet()
                writeEntered.countDown()
                try {
                    if (blockOutput) release.await()
                    if (terminated.get()) throw java.io.IOException("test connection terminated")
                    synchronized(sink) { sink.write(bytes, off, len) }
                } finally { activeWrites.decrementAndGet() }
            }
        }
        fun bytes(): ByteArray = synchronized(sink) { sink.toByteArray() }
        override fun terminate() {
            terminated.set(true)
            release.countDown()
        }
    }
}
