package io.github.rfairburn.pireviewgate.core.transport

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Channel behaviour that cannot be shown by a pure function: outbound byte
 * accounting, the dynamic guard, truthful cancellation, control handling, and
 * bounded close.
 */
class PeerByteChannelTest {

    private class Fixture(
        val bounds: PeerTransportBounds = PeerTransportBounds.DEFAULT,
        val guard: PeerSendGuard = PeerSendGuard.NONE,
    ) {
        val connection = TestSupport.FakeConnection()
        val key = TestSupport.peerKey()
        var finalized = 0
        val channel: DefaultPeerByteChannel = DefaultPeerByteChannel(
            connection = connection,
            peerKey = key,
            lane = PeerAppLane.APP,
            label = "fixture-peer",
            bounds = bounds,
            sendGuard = guard,
            onFinalized = { finalized += 1 },
        ).also { it.start() }
    }

    private fun payload(size: Int, marker: Int): ByteArray = ByteArray(size) { (marker + it).toByte() }

    /** Unmasked payloads of every frame the transport actually wrote. */
    private fun sentPayloads(bytes: ByteArray): List<ByteArray> = TestSupport.decodeAll(bytes).map { it.payload }

    @Test
    fun `send writes one masked binary frame and resolves on local completion`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        val bytes = payload(64, 1)
        fixture.channel.send(bytes)
        assertTrue(fixture.connection.written.awaitBytes(bytes.size + 6))
        val frame = TestSupport.decodeClientFrame(fixture.connection.written.bytes())
        assertTrue(frame.fin)
        assertEquals(WsFrameCodec.OP_BINARY, frame.opcode)
        assertTrue(frame.masked)
        assertNotNull(frame.maskKey)
        assertTrue(frame.payload.contentEquals(bytes))
        fixture.channel.close()
    }

    @Test
    fun `a message over the bound is refused before anything is queued`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture(bounds = PeerTransportBounds.DEFAULT.copy(maxWebSocketMessageBytes = 32))
        val failure = assertFailsWith<PeerTransportException> { fixture.channel.send(ByteArray(33)) }
        assertEquals(PeerTransportErrorCode.MESSAGE_TOO_LARGE, failure.code)
        assertTrue(!failure.deliveryIsUnknown)
        assertEquals(0, fixture.channel.bufferedAmount)
        assertEquals(0, fixture.connection.written.bytes().size)
        fixture.channel.close()
    }

    @Test
    fun `the outbound bound counts queued and in flight bytes until completion`() = runBlocking(Dispatchers.IO) {
        val bounds = PeerTransportBounds.DEFAULT.copy(maxOutboundQueueBytes = 100)
        val fixture = Fixture(bounds = bounds)
        fixture.connection.blockWrites()
        val first = async { runCatching { fixture.channel.send(payload(40, 0)) } }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        val second = async { runCatching { fixture.channel.send(payload(40, 1)) } }
        awaitUntil { fixture.channel.bufferedAmount == 80 }
        val third = runCatching { fixture.channel.send(payload(40, 2)) }
        val failure = assertNotNull(third.exceptionOrNull()) as PeerTransportException
        assertEquals(PeerTransportErrorCode.OUTBOUND_QUEUE_FULL, failure.code)
        assertTrue(!failure.deliveryIsUnknown)
        // Only the two admitted frames ever reach the socket.
        fixture.connection.unblockWrites()
        first.await().getOrThrow()
        second.await().getOrThrow()
        awaitUntil { fixture.channel.bufferedAmount == 0 }
        val written = fixture.connection.written.bytes()
        assertEquals(2 * (40 + 6), written.size)
        fixture.channel.close()
    }

    @Test
    fun `a guard epoch change drops a pending frame without sending it`() = runBlocking(Dispatchers.IO) {
        val guard = MutableGuard()
        val fixture = Fixture(guard = guard)
        fixture.connection.blockWrites()
        val first = async { runCatching { fixture.channel.send(payload(20, 0)) } }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        val second = async { runCatching { fixture.channel.send(payload(20, 100)) } }
        awaitUntil { fixture.channel.bufferedAmount == 40 }

        guard.epoch.set(1)
        fixture.connection.unblockWrites()

        first.await().getOrThrow()
        val dropped = assertNotNull(second.await().exceptionOrNull()) as PeerTransportException
        assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, dropped.code)
        assertTrue(!dropped.deliveryIsUnknown)

        val written = fixture.connection.written.bytes()
        val sent = sentPayloads(written)
        assertEquals(1, sent.size)
        assertTrue(sent[0].contentEquals(payload(20, 0)))
        assertTrue(sent.none { it.contentEquals(payload(20, 100)) })
        fixture.channel.close()
    }

    @Test
    fun `a guard that no longer allows refuses admission before queueing`() = runBlocking(Dispatchers.IO) {
        val guard = MutableGuard(allowed = false)
        val fixture = Fixture(guard = guard)
        val failure = assertFailsWith<PeerTransportException> { fixture.channel.send(payload(8, 0)) }
        assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, failure.code)
        assertEquals(0, fixture.connection.written.bytes().size)
        assertEquals(0, fixture.channel.bufferedAmount)
        fixture.channel.close()
    }

    @Test
    fun `cancelling a queued send never sends the frame`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.blockWrites()
        val first = async { runCatching { fixture.channel.send(payload(20, 0)) } }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        val second = async { runCatching { fixture.channel.send(payload(20, 100)) } }
        awaitUntil { fixture.channel.bufferedAmount == 40 }

        second.cancel()
        // The dropped frame releases its reservation; waiting for that is what
        // makes the assertion below deterministic rather than racy.
        awaitUntil { fixture.channel.bufferedAmount == 20 }
        fixture.connection.unblockWrites()
        first.await().getOrThrow()
        assertFailsWith<CancellationException> { second.await() }

        val written = fixture.connection.written.bytes()
        val sent = sentPayloads(written)
        assertEquals(1, sent.size)
        assertTrue(sent[0].contentEquals(payload(20, 0)))
        assertTrue(sent.none { it.contentEquals(payload(20, 100)) })
        fixture.channel.close()
    }

    @Test
    fun `cancelling during an invoked write tears down instead of replaying`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.blockWrites()
        val sender = async { runCatching { fixture.channel.send(payload(32, 0)) } }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        sender.cancel()
        fixture.connection.unblockWrites()
        assertFailsWith<CancellationException> { sender.await() }
        // The connection is torn down: the frame is never written a second time.
        withTimeout(2_000) { fixture.channel.closed.await() }
        assertTrue(fixture.connection.terminated)
        assertEquals(1, fixture.connection.written.writeAttempts)
    }

    @Test
    fun `a failed write reports an unknown delivery outcome`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.written.failWrites = true
        val failure = assertFailsWith<PeerTransportException> { fixture.channel.send(payload(16, 0)) }
        assertEquals(PeerTransportErrorCode.SEND_FAILED, failure.code)
        assertTrue(failure.deliveryIsUnknown)
        val close = withTimeout(2_000) { fixture.channel.closed.await() }
        assertEquals(WsFrameReader.CLOSE_ABNORMAL, close.code)
        assertTrue(fixture.connection.terminated)
        assertEquals(1, fixture.finalized)
    }

    @Test
    fun `inbound binary messages are delivered and drained after close`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload(10, 0)))
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload(11, 50)))
        assertEquals(10, assertNotNull(fixture.channel.receive())!!.size)
        assertEquals(11, assertNotNull(fixture.channel.receive())!!.size)
        fixture.connection.endInput()
        assertNull(withTimeout(2_000) { fixture.channel.receive() })
        assertEquals(1, fixture.finalized)
    }

    @Test
    fun `a fragmented inbound message arrives once, atomically`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.feed(
            TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload(100, 0), fin = false) +
                TestSupport.serverFrame(WsFrameCodec.OP_CONTINUATION, payload(100, 10), fin = false) +
                TestSupport.serverFrame(WsFrameCodec.OP_CONTINUATION, payload(50, 20), fin = true),
        )
        val message = withTimeout(2_000) { fixture.channel.receive() }
        assertEquals(250, assertNotNull(message).size)
    }

    @Test
    fun `a text message is refused with 1003 and never passed through`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_TEXT, "hello".toByteArray(Charsets.UTF_8)))
        val close = withTimeout(2_000) { fixture.channel.closed.await() }
        assertEquals(WsFrameReader.CLOSE_UNSUPPORTED_MESSAGE, close.code)
        assertNull(fixture.channel.receive())
        // The refusal is visible on the wire as a close frame carrying 1003.
        val frame = TestSupport.decodeClientFrame(fixture.connection.written.bytes())
        assertEquals(WsFrameCodec.OP_CLOSE, frame.opcode)
        assertTrue(frame.payload.contentEquals(byteArrayOf(0x03.toByte(), 0xEB.toByte())))
    }

    @Test
    fun `a protocol violation closes with the fixed code`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, byteArrayOf(1), masked = true))
        val close = withTimeout(2_000) { fixture.channel.closed.await() }
        assertEquals(WsFrameReader.CLOSE_PROTOCOL_ERROR, close.code)
    }

    @Test
    fun `a ping is answered with a pong carrying the same payload`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        val ping = payload(8, 3)
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_PING, ping))
        assertTrue(fixture.connection.written.awaitBytes(2 + 4 + 8))
        val frame = TestSupport.decodeClientFrame(fixture.connection.written.bytes())
        assertEquals(WsFrameCodec.OP_PONG, frame.opcode)
        assertTrue(frame.fin)
        assertTrue(frame.masked)
        assertTrue(frame.payload.contentEquals(ping))
        fixture.channel.close()
    }

    @Test
    fun `a peer close is reported with its code and sanitised reason`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        val reason = "bye\u0007"
        val body = byteArrayOf(0x03.toByte(), 0xE9.toByte()) + reason.toByteArray(Charsets.UTF_8)
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_CLOSE, body))
        val close = withTimeout(2_000) { fixture.channel.closed.await() }
        assertEquals(1001, close.code)
        assertEquals("bye?", close.reason)
        assertTrue(fixture.connection.terminated)
    }

    @Test
    fun `close sends a close frame and completes within the bound`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        val closing = launch { fixture.channel.close() }
        assertTrue(fixture.connection.written.awaitBytes(6))
        val frame = TestSupport.decodeClientFrame(fixture.connection.written.bytes())
        assertEquals(WsFrameCodec.OP_CLOSE, frame.opcode)
        assertTrue(frame.payload.isEmpty())
        // The peer answers.
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_CLOSE, byteArrayOf(0x03.toByte(), 0xE8.toByte())))
        val close = withTimeout(2_000) { fixture.channel.closed.await() }
        assertEquals(1000, close.code)
        closing.join()
        assertEquals(1, fixture.finalized)
    }

    @Test
    fun `close is bounded when the peer never answers`() = runBlocking(Dispatchers.IO) {
        val bounds = PeerTransportBounds.DEFAULT.copy(closeTimeoutMs = 250)
        val fixture = Fixture(bounds = bounds)
        val started = System.nanoTime()
        fixture.channel.close()
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        val close = fixture.channel.closed.await()
        assertEquals(WsFrameReader.CLOSE_ABNORMAL, close.code)
        assertTrue(elapsedMs >= 200, "close returned early after ${elapsedMs}ms")
        assertTrue(elapsedMs < 5_000, "close was not bounded (${elapsedMs}ms)")
        assertTrue(fixture.connection.terminated)
    }

    @Test
    fun `send after close is refused and resources are released`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.channel.close()
        val failure = assertFailsWith<PeerTransportException> { fixture.channel.send(payload(4, 0)) }
        assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, failure.code)
        assertEquals(0, fixture.channel.bufferedAmount)
        assertEquals(1, fixture.finalized)
        // A second close is a no-op that still resolves.
        fixture.channel.close()
        assertEquals(1, fixture.finalized)
    }

    @Test
    fun `a caller that stops receiving applies backpressure instead of buffering forever`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        // Fill the bounded inbound buffer; every buffered message is still
        // delivered in order, and the transport never grows past the bound.
        repeat(MAX_QUEUED_INBOUND_MESSAGES) {
            fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload(8, it)))
        }
        for (index in 0 until MAX_QUEUED_INBOUND_MESSAGES) {
            val message = withTimeout(2_000) { fixture.channel.receive() }
            assertEquals(8, assertNotNull(message).size)
        }
        fixture.channel.close()
    }

    @Test
    fun `a stale per message guard drops only its own message`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.blockWrites()
        val control = async { runCatching { fixture.channel.send(payload(20, 0)) } }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        val guardA = MutableGuard()
        val guardB = MutableGuard()
        val first = async { runCatching { fixture.channel.send(payload(20, 100), guardA) } }
        val second = async { runCatching { fixture.channel.send(payload(20, 200), guardB) } }
        awaitUntil { fixture.channel.bufferedAmount == 60 }

        guardA.invalidate()
        fixture.connection.unblockWrites()

        control.await().getOrThrow()
        val dropped = assertNotNull(first.await().exceptionOrNull()) as PeerTransportException
        assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, dropped.code)
        assertTrue(!dropped.deliveryIsUnknown)
        second.await().getOrThrow()

        // Only the control frame and the still-valid second message reached the wire.
        val sent = sentPayloads(fixture.connection.written.bytes())
        assertEquals(2, sent.size)
        assertTrue(sent.any { it.contentEquals(payload(20, 0)) })
        assertTrue(sent.any { it.contentEquals(payload(20, 200)) })
        assertTrue(sent.none { it.contentEquals(payload(20, 100)) })
        fixture.channel.close()
    }

    @Test
    fun `losing the channel guard drops every pending frame`() = runBlocking(Dispatchers.IO) {
        val channelGuard = MutableGuard()
        val fixture = Fixture(guard = channelGuard)
        fixture.connection.blockWrites()
        val inFlight = async { runCatching { fixture.channel.send(payload(20, 0)) } }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        val pending = async { runCatching { fixture.channel.send(payload(20, 100), MutableGuard()) } }
        val alsoPending = async { runCatching { fixture.channel.send(payload(20, 200)) } }
        awaitUntil { fixture.channel.bufferedAmount == 60 }

        channelGuard.disallow()
        fixture.connection.unblockWrites()

        // The frame already handed to the socket stays as it was: written.
        inFlight.await().getOrThrow()
        for (job in listOf(pending, alsoPending)) {
            val failure = assertNotNull(job.await().exceptionOrNull()) as PeerTransportException
            assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, failure.code)
            assertTrue(!failure.deliveryIsUnknown)
        }
        val sent = sentPayloads(fixture.connection.written.bytes())
        assertEquals(1, sent.size)
        assertTrue(sent[0].contentEquals(payload(20, 0)))
        assertTrue(sent.none { it.contentEquals(payload(20, 100)) })
        assertTrue(sent.none { it.contentEquals(payload(20, 200)) })
        // And nothing new is admitted afterwards.
        val refused = assertFailsWith<PeerTransportException> { fixture.channel.send(payload(20, 50)) }
        assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, refused.code)
        fixture.channel.close()
    }

    @Test
    fun `repeated cancellation behind a blocked writer never accumulates retained payload`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture(bounds = PeerTransportBounds.DEFAULT.copy(maxOutboundQueueBytes = 4096))
        fixture.connection.blockWrites()
        val inFlight = async { runCatching { fixture.channel.send(payload(64, 0)) } }
        assertTrue(fixture.connection.written.awaitAttempts(1))

        repeat(100) { index ->
            val receipt = PeerSendReceipt()
            val queued = async { runCatching { fixture.channel.send(payload(512, index * 7), PeerSendGuard.NONE, receipt) } }
            awaitUntil { fixture.channel.bufferedAmount == 64 + 512 }
            queued.cancel()
            awaitUntil { receipt.delivery != null }
            awaitUntil { fixture.channel.bufferedAmount == 64 }
            assertEquals(PeerDelivery.NOT_SENT, receipt.delivery)
        }

        // Nothing beyond the one in-flight frame is retained or written.
        assertEquals(64, fixture.channel.bufferedAmount)
        fixture.connection.unblockWrites()
        inFlight.await().getOrThrow()
        assertEquals(64 + 6, fixture.connection.written.bytes().size)
        // A conflated wakeup still delivers the next frame: no notification was
        // lost, and none accumulated behind the blocked writer.
        fixture.channel.send(payload(8, 200))
        assertTrue(fixture.connection.written.awaitBytes(64 + 6 + 8 + 6))
        assertEquals(2, TestSupport.decodeAll(fixture.connection.written.bytes()).size)
        fixture.channel.close()
    }

    @Test
    fun `the invocation observer fires once before a blocked write and never reports not sent`() =
        runBlocking(Dispatchers.IO) {
            val fixture = Fixture()
            fixture.connection.blockWrites()
            val invocations = AtomicInteger()
            val receipt = PeerSendReceipt { invocations.incrementAndGet() }
            val sender = async {
                runCatching { fixture.channel.send(payload(24, 0), PeerSendGuard.NONE, receipt) }
            }
            // The observer has already run by the time the socket write is attempted.
            assertTrue(fixture.connection.written.awaitAttempts(1))
            assertEquals(1, invocations.get())
            assertTrue(receipt.wasInvoked)
            assertNull(receipt.delivery)

            // The write is stuck, and its outcome then fails: an invoked input is
            // never reported as provably not sent.
            fixture.connection.written.failWrites = true
            fixture.connection.unblockWrites()
            val failure = assertNotNull(sender.await().exceptionOrNull()) as PeerTransportException
            assertEquals(PeerTransportErrorCode.SEND_FAILED, failure.code)
            assertEquals(PeerDelivery.SUBMITTED_UNKNOWN, receipt.delivery)
            assertEquals(1, invocations.get())
        }

    @Test
    fun `a stale queued guard never invokes the observer`() = runBlocking(Dispatchers.IO) {
        val guard = MutableGuard()
        val fixture = Fixture(guard = guard)
        fixture.connection.blockWrites()
        val first = async { runCatching { fixture.channel.send(payload(20, 0)) } }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        val invocations = AtomicInteger()
        val queuedReceipt = PeerSendReceipt { invocations.incrementAndGet() }
        val second = async { runCatching { fixture.channel.send(payload(20, 100), guard, queuedReceipt) } }
        awaitUntil { fixture.channel.bufferedAmount == 40 }

        guard.invalidate()
        fixture.connection.unblockWrites()
        first.await().getOrThrow()
        val dropped = assertNotNull(second.await().exceptionOrNull()) as PeerTransportException
        assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, dropped.code)
        // Never dispatched, so this frame really is provably not sent.
        assertTrue(!dropped.deliveryIsUnknown)

        assertEquals(0, invocations.get())
        assertTrue(!queuedReceipt.wasInvoked)
        assertEquals(PeerDelivery.NOT_SENT, queuedReceipt.delivery)
    }

    @Test
    fun `an observer that retires the guard during reentry writes no bytes and stays conservative`() =
        runBlocking(Dispatchers.IO) {
            val guard = MutableGuard()
            val fixture = Fixture(guard = guard)
            val invocations = AtomicInteger()
            val receipt = PeerSendReceipt {
                invocations.incrementAndGet()
                guard.invalidate()
            }

            val failure = assertFailsWith<PeerTransportException> {
                fixture.channel.send(payload(24, 0), guard, receipt)
            }
            assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, failure.code)
            assertEquals(1, invocations.get())
            assertTrue(receipt.wasInvoked)
            // The boundary was crossed, so this side never claims not-sent: both the
            // receipt and the exception surface say the same thing.
            assertEquals(PeerDelivery.SUBMITTED_UNKNOWN, receipt.delivery)
            assertTrue(failure.deliveryIsUnknown)
            assertEquals(0, fixture.connection.written.bytes().size)
            assertEquals(0, fixture.channel.bufferedAmount)
        }

    @Test
    fun `a throwing observer refuses the send without writing or leaking the queue`() =
        runBlocking(Dispatchers.IO) {
            val fixture = Fixture()
            val receipt = PeerSendReceipt { throw IllegalStateException("observer failed") }

            val failure = assertFailsWith<PeerTransportException> {
                fixture.channel.send(payload(24, 0), PeerSendGuard.NONE, receipt)
            }
            assertEquals(PeerTransportErrorCode.SEND_FAILED, failure.code)
            assertTrue(failure.deliveryIsUnknown)
            assertTrue(receipt.wasInvoked)
            assertEquals(PeerDelivery.SUBMITTED_UNKNOWN, receipt.delivery)
            assertEquals(0, fixture.connection.written.bytes().size)
            // The reservation was released and the channel stays usable.
            assertEquals(0, fixture.channel.bufferedAmount)
            fixture.channel.send(payload(8, 50))
            assertTrue(fixture.connection.written.awaitBytes(8 + 6))
            assertEquals(1, TestSupport.decodeAll(fixture.connection.written.bytes()).size)
        }

    @Test
    fun `an incoming close with a blocked output still ends the channel`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture(bounds = PeerTransportBounds.DEFAULT.copy(closeTimeoutMs = 150))
        fixture.connection.blockWrites()
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_CLOSE, byteArrayOf(0x03.toByte(), 0xE8.toByte())))
        // The reply can never leave, so the independent watchdog must end the
        // channel and report the peer's close code.
        val close = withTimeout(5_000) { fixture.channel.closed.await() }
        assertEquals(1000, close.code)
        assertTrue(fixture.connection.terminated)
    }

    @Test
    fun `a protocol violation with a blocked output still ends the channel`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture(bounds = PeerTransportBounds.DEFAULT.copy(closeTimeoutMs = 150))
        fixture.connection.blockWrites()
        // A masked server frame is forbidden.
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload(4, 0), masked = true))
        val close = withTimeout(5_000) { fixture.channel.closed.await() }
        assertEquals(WsFrameReader.CLOSE_PROTOCOL_ERROR, close.code)
        assertTrue(fixture.connection.terminated)
    }

    @Test
    fun `an incoming close behind a data write holding the write lock still ends the channel`(): Unit =
        runBlocking(Dispatchers.IO) {
            val fixture = Fixture(bounds = PeerTransportBounds.DEFAULT.copy(closeTimeoutMs = 150))
            fixture.connection.blockWrites()
            val sender = async { runCatching { fixture.channel.send(payload(32, 0)) } }
            // The writer owns the serialization lock and is stuck in the socket.
            assertTrue(fixture.connection.written.awaitAttempts(1))
            fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_CLOSE, byteArrayOf(0x03.toByte(), 0xE8.toByte())))

            val close = withTimeout(5_000) { fixture.channel.closed.await() }
            assertEquals(1000, close.code)
            assertTrue(fixture.connection.terminated)
            sender.await()
        }

    @Test
    fun `a guard that turns stale at the write boundary is never written`() = runBlocking(Dispatchers.IO) {
        // Admission and the cheap pre-check pass; the decision taken under write
        // ownership is the authoritative one, and it refuses this frame.
        val fixture = Fixture(guard = CountingGuard(allowedCalls = 2))
        val failure = assertFailsWith<PeerTransportException> { fixture.channel.send(payload(24, 0)) }
        assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, failure.code)
        // Accepted dispatch was already claimed, so this side never claims not-sent.
        assertTrue(failure.deliveryIsUnknown)
        assertEquals(0, fixture.connection.written.bytes().size)
        assertEquals(0, fixture.channel.bufferedAmount)
        fixture.channel.close()
    }

    @Test
    fun `a send after close begins is refused and never follows the close frame`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture(bounds = PeerTransportBounds.DEFAULT.copy(closeTimeoutMs = 200))
        fixture.connection.blockWrites()
        val closing = async { runCatching { fixture.channel.close() } }
        assertTrue(fixture.connection.written.awaitAttempts(1))

        val refused = assertFailsWith<PeerTransportException> { fixture.channel.send(payload(16, 0)) }
        assertEquals(PeerTransportErrorCode.CHANNEL_NOT_OPEN, refused.code)

        fixture.connection.unblockWrites()
        closing.await().getOrThrow()
        val sent = sentPayloads(fixture.connection.written.bytes())
        assertEquals(1, sent.size)
        assertEquals(WsFrameCodec.OP_CLOSE, TestSupport.decodeAll(fixture.connection.written.bytes())[0].opcode)
        assertTrue(sent[0].isEmpty())
    }

    @Test
    fun `a close against a blocked output still terminates the channel`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture(bounds = PeerTransportBounds.DEFAULT.copy(closeTimeoutMs = 150))
        fixture.connection.blockWrites()
        val closing = async { runCatching { fixture.channel.close() } }
        // The close frame can never leave, so the bound must end the channel.
        val close = withTimeout(5_000) { fixture.channel.closed.await() }
        assertEquals(WsFrameReader.CLOSE_ABNORMAL, close.code)
        assertTrue(fixture.connection.terminated)
        closing.await().getOrThrow()
    }

    @Test
    fun `a cancelled close still finalizes the channel`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture(bounds = PeerTransportBounds.DEFAULT.copy(closeTimeoutMs = 30_000))
        val closing = async { runCatching { fixture.channel.close() } }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        closing.cancel()
        // Abandoning the only timeout must not leave the socket and reader alive.
        val close = withTimeout(5_000) { fixture.channel.closed.await() }
        assertEquals(WsFrameReader.CLOSE_ABNORMAL, close.code)
        assertTrue(fixture.connection.terminated)
    }

    @Test
    fun `receipts distinguish a cancelled queued frame from one whose write began`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.blockWrites()
        val inFlightReceipt = PeerSendReceipt()
        val inFlight = async {
            runCatching { fixture.channel.send(payload(20, 0), PeerSendGuard.NONE, inFlightReceipt) }
        }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        val queuedReceipt = PeerSendReceipt()
        val queued = async {
            runCatching { fixture.channel.send(payload(20, 100), PeerSendGuard.NONE, queuedReceipt) }
        }
        awaitUntil { fixture.channel.bufferedAmount == 40 }

        queued.cancel()
        awaitUntil { queuedReceipt.delivery != null }
        assertEquals(PeerDelivery.NOT_SENT, queuedReceipt.delivery)

        inFlight.cancel()
        awaitUntil { inFlightReceipt.delivery != null }
        assertEquals(PeerDelivery.SUBMITTED_UNKNOWN, inFlightReceipt.delivery)
        withTimeout(2_000) { fixture.channel.closed.await() }
        assertTrue(fixture.connection.terminated)
        // A cancelled frame is never replayed.
        assertEquals(1, fixture.connection.written.writeAttempts)
    }

    @Test
    fun `cancelling while dispatch is claimed never notifies the observer`() = runBlocking(Dispatchers.IO) {
        val paused = CountDownLatch(1)
        val resume = CountDownLatch(1)
        // The guard stalls the writer inside its first dispatch check, before the
        // frame claims accepted dispatch.
        val guard = PausingGuard(pauseOnCall = 2) { paused.countDown(); resume.await() }
        val fixture = Fixture()
        val invocations = AtomicInteger()
        val receipt = PeerSendReceipt { invocations.incrementAndGet() }
        val sender = async { runCatching { fixture.channel.send(payload(20, 0), guard, receipt) } }
        assertTrue(paused.await(5, TimeUnit.SECONDS))

        sender.cancel()
        awaitUntil { receipt.delivery != null }
        resume.countDown()
        awaitUntil { fixture.channel.bufferedAmount == 0 }

        // The cancellation won the claim, so the boundary was never crossed.
        assertEquals(0, invocations.get())
        assertTrue(!receipt.wasInvoked)
        assertEquals(PeerDelivery.NOT_SENT, receipt.delivery)
        assertEquals(0, fixture.connection.written.bytes().size)
    }

    @Test
    fun `an empty binary message is delivered as a zero-length frame`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.channel.send(ByteArray(0))
        assertTrue(fixture.connection.written.awaitBytes(WsFrameCodec.headerSize(0) + 4))
        val frame = TestSupport.decodeClientFrame(fixture.connection.written.bytes())
        assertTrue(frame.fin)
        assertEquals(WsFrameCodec.OP_BINARY, frame.opcode)
        assertEquals(0, frame.payload.size)
        assertEquals(0, fixture.channel.bufferedAmount)
        fixture.channel.close()
    }

    @Test
    fun `an empty inbound binary message is delivered`() = runBlocking(Dispatchers.IO) {
        val fixture = Fixture()
        fixture.connection.feed(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, ByteArray(0)))
        assertEquals(0, assertNotNull(fixture.channel.receive())!!.size)
        fixture.connection.endInput()
        assertNull(withTimeout(2_000) { fixture.channel.receive() })
    }

    @Test
    fun `empty messages are accounted for and refused at the bound`() = runBlocking(Dispatchers.IO) {
        val bounds = PeerTransportBounds.DEFAULT.copy(maxOutboundQueueBytes = 2 * (WsFrameCodec.headerSize(0) + 4))
        val fixture = Fixture(bounds = bounds)
        fixture.connection.blockWrites()
        val first = async { runCatching { fixture.channel.send(ByteArray(0)) } }
        assertTrue(fixture.connection.written.awaitAttempts(1))
        val second = async { runCatching { fixture.channel.send(ByteArray(0)) } }
        awaitUntil { fixture.channel.bufferedAmount == 2 * (WsFrameCodec.headerSize(0) + 4) }

        val refused = assertFailsWith<PeerTransportException> { fixture.channel.send(ByteArray(0)) }
        assertEquals(PeerTransportErrorCode.OUTBOUND_QUEUE_FULL, refused.code)

        fixture.connection.unblockWrites()
        first.await().getOrThrow()
        second.await().getOrThrow()
        awaitUntil { fixture.channel.bufferedAmount == 0 }
        assertEquals(2, TestSupport.decodeAll(fixture.connection.written.bytes()).size)
        fixture.channel.close()
    }

    private class PausingGuard(private val pauseOnCall: Int, private val pause: () -> Unit) : PeerSendGuard {
        private val calls = AtomicInteger()

        override fun allows(): Boolean {
            if (calls.incrementAndGet() == pauseOnCall) pause()
            return true
        }

        override fun epoch(): Long = 0
    }

    private class CountingGuard(private val allowedCalls: Int) : PeerSendGuard {
        private val calls = AtomicInteger()

        override fun allows(): Boolean = calls.incrementAndGet() <= allowedCalls

        override fun epoch(): Long = 0
    }

    private class MutableGuard(allowed: Boolean = true, epochValue: Long = 0) : PeerSendGuard {
        private val allowedFlag = AtomicBoolean(allowed)
        val epoch = AtomicLong(epochValue)

        override fun allows(): Boolean = allowedFlag.get()

        override fun epoch(): Long = epoch.get()

        /** Simulate this message's own source changing while it was queued. */
        fun invalidate() {
            epoch.incrementAndGet()
        }

        /** Simulate the channel association or lifecycle going away. */
        fun disallow() {
            allowedFlag.set(false)
        }
    }

    private suspend fun awaitUntil(
        timeoutMs: Long = 2_000,
        predicate: () -> Boolean,
    ) {
        withTimeout(timeoutMs) {
            while (!predicate()) delay(5)
        }
    }
}
