package io.github.rfairburn.pireviewgate.core.transport

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** How a channel ended: the close code the peer sent, or the local equivalent. */
class PeerChannelClose internal constructor(val code: Int, val reason: String)

/**
 * What actually happened to one send.
 *
 * - [WRITTEN] the bytes were handed to the platform socket writer and that write
 *   returned. It never means the peer read or acknowledged them.
 * - [NOT_SENT] the frame provably never reached the socket. This is only ever
 *   reported while [PeerSendReceipt.wasInvoked] is false.
 * - [SUBMITTED_UNKNOWN] a write was invoked, or the invocation boundary was
 *   crossed and the frame then stopped for a reason this side cannot resolve;
 *   the frame is never replayed.
 */
enum class PeerDelivery { WRITTEN, NOT_SENT, SUBMITTED_UNKNOWN }

/**
 * Caller-owned evidence handle for one [PeerByteChannel.send].
 *
 * A cancelled send cannot return a value, so the outcome is recorded here
 * instead: the receipt is written before the call settles, including on the
 * cancellation paths, and keeps the first recorded outcome.
 *
 * [onInvoked] is the one-shot invocation boundary. The transport calls it on the
 * writer thread exactly once, after this side accepted the frame for dispatch
 * and before the socket-write handoff, so a caller can stop treating the input
 * as provably-not-sent from that instant on. It reports accepted dispatch only:
 * it makes no claim that the peer received anything, or that any physical
 * delivery happened. It is never called for a frame refused before admission,
 * for a frame dropped as stale, or for a frame that was cancelled while still
 * queued. The callback must be cheap and non-blocking, must not touch the
 * socket, and must not re-enter this channel: it runs inline on the writer that
 * is about to write. If it throws, the frame is refused and never written.
 */
class PeerSendReceipt(internal val onInvoked: (() -> Unit)? = null) {
    private val outcome = java.util.concurrent.atomic.AtomicReference<PeerDelivery?>(null)
    private val invoked = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Null while the send is pending; set at most once before the call settles. */
    val delivery: PeerDelivery?
        get() = outcome.get()

    /**
     * True from the moment the transport accepted this frame for dispatch and
     * began the socket-write handoff. Read it before trusting [PeerDelivery]
     * alone: after this point the outcome is never reported as
     * [PeerDelivery.NOT_SENT].
     */
    val wasInvoked: Boolean
        get() = invoked.get()

    internal fun record(value: PeerDelivery) {
        outcome.compareAndSet(null, value)
    }

    /** Claim the single invocation notification. False if it was already claimed. */
    internal fun claimInvoked(): Boolean = invoked.compareAndSet(false, true)
}

/**
 * Bounded byte channel of the inert paired peer transport.
 *
 * A channel carries bytes only. It has no session permission, capability,
 * view-only policy, or controller lease. [lane] is the exact lane negotiated on
 * this connection; it grants nothing and only tells a caller which receiving
 * callback it selected.
 *
 * The outcome vocabulary is deliberately narrow and truthful:
 *
 * - `send` returning normally means the bytes were handed to the platform
 *   socket writer. It never means the remote peer read or acknowledged them.
 * - a [PeerTransportException] whose [PeerTransportException.deliveryIsUnknown]
 *   is false means the bytes provably never left this process.
 * - a [PeerSendReceipt] records the same evidence durably, including when the
 *   call is cancelled and therefore cannot report anything itself.
 * - `receive()` returns null once the channel is closed and drained.
 */
interface PeerByteChannel {
    /** Exact peer identity verified on this connection. */
    val peerKey: PeerKey

    /** Exact lane negotiated for this connection; metadata and content never mix. */
    val lane: PeerAppLane

    /** Bounded display label from the peer certificate, never identity. */
    val label: String?

    /** Queued plus in-flight outbound payload and control bytes. */
    val bufferedAmount: Int

    /** Completes exactly once, when the channel ended. */
    val closed: Deferred<PeerChannelClose>

    /**
     * Queue bytes for delivery, subject to the message and outbound bounds.
     *
     * [writeGuard] is a per-message fence, composed with the channel's own
     * association/lifecycle guard: both are evaluated before the frame is
     * admitted and again, under write ownership, immediately before the socket
     * write, each against the epoch captured for it at admission. A stale
     * per-message guard drops only its own message; losing the channel guard
     * still ends every pending frame.
     *
     * [receipt] is the durable evidence handle. Pass one you keep if you need
     * to distinguish a cancelled-but-never-sent frame from one whose write had
     * already been invoked, or [PeerSendReceipt.onInvoked] if you need to know
     * the instant this side accepted the frame for dispatch. Neither reports a
     * peer receipt: neither claims the peer read anything.
     */
    suspend fun send(
        bytes: ByteArray,
        writeGuard: PeerSendGuard = PeerSendGuard.NONE,
        receipt: PeerSendReceipt = PeerSendReceipt(),
    )

    /**
     * Await the next complete inbound message, or null once the channel is
     * closed and its bounded buffer is drained.
     */
    suspend fun receive(): ByteArray?

    /** Close politely, bounded by the configured close timeout. */
    suspend fun close()
}

/**
 * Channel over one already-negotiated TLS/WebSocket connection.
 *
 * One reader and one writer coroutine own the socket for the channel's
 * lifetime, and both are cancelled when the channel finalizes, so no thread or
 * coroutine outlives a closed channel. Neither coroutine starts in the
 * constructor: [start] begins them only once the owning transport has recorded
 * the channel, so a finalized channel can never be registered after the fact.
 */
internal class DefaultPeerByteChannel(
    private val connection: PeerByteConnection,
    override val peerKey: PeerKey,
    override val lane: PeerAppLane,
    override val label: String?,
    private val bounds: PeerTransportBounds,
    private val sendGuard: PeerSendGuard,
    private val onFinalized: (DefaultPeerByteChannel) -> Unit,
) : PeerByteChannel {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    // Elastic per-channel I/O keeps blocked readers independent of other channels.
    private val blockingIo = Dispatchers.IO.limitedParallelism(2)
    private val outboundSignal = Channel<Unit>(Channel.CONFLATED)
    private val reservation = OutboundReservation(bounds.maxOutboundQueueBytes)
    private val inbound = Channel<ByteArray>(MAX_QUEUED_INBOUND_MESSAGES)
    private val closedDeferred = CompletableDeferred<PeerChannelClose>()
    private val random = SecureRandom()
    private val lock = Any()
    private val writeLock = Any()

    /** Frames waiting for the writer, guarded by [lock]. */
    private val pending = ArrayDeque<OutboundFrame>()

    private val lifecycle = AtomicInteger(LIFECYCLE_OPEN)

    /** True once a polite close has begun; only one close operation exists. */
    private val closeStarted = AtomicBoolean(false)

    @Volatile
    private var finalized = false

    @Volatile
    private var started = false

    /**
     * Begin the reader and writer. Registration in the owning transport happens
     * first, so an immediate end-of-stream can never finalize and remove a
     * channel that has not been recorded yet.
     */
    internal fun start() {
        val begin = synchronized(lock) {
            if (started || finalized || lifecycle.get() == LIFECYCLE_CLOSED) false else {
                started = true
                true
            }
        }
        if (!begin) return
        scope.launch(blockingIo) { readerLoop() }
        scope.launch(blockingIo) { writerLoop() }
    }

    internal val isFinalized: Boolean
        get() = finalized

    override val bufferedAmount: Int
        get() = reservation.usedBytes

    override val closed: Deferred<PeerChannelClose>
        get() = closedDeferred

    override suspend fun send(
        bytes: ByteArray,
        writeGuard: PeerSendGuard,
        receipt: PeerSendReceipt,
    ) {
        if (lifecycle.get() != LIFECYCLE_OPEN) {
            receipt.record(PeerDelivery.NOT_SENT)
            throw PeerTransportException(PeerTransportErrorCode.CHANNEL_NOT_OPEN)
        }
        if (bytes.size > bounds.maxWebSocketMessageBytes) {
            receipt.record(PeerDelivery.NOT_SENT)
            throw PeerTransportException(PeerTransportErrorCode.MESSAGE_TOO_LARGE)
        }
        // Dynamic admission guard. Epochs are captured first and only then is
        // authorization evaluated: a guard that moves afterwards therefore
        // mismatches at dispatch instead of validating a stale authorization and
        // blessing a newer epoch.
        val channelEpoch = sendGuard.epoch()
        val messageEpoch = writeGuard.epoch()
        if (lifecycle.get() != LIFECYCLE_OPEN || !sendGuard.allows() || !writeGuard.allows()) {
            receipt.record(PeerDelivery.NOT_SENT)
            throw PeerTransportException(PeerTransportErrorCode.CHANNEL_NOT_OPEN)
        }
        val frame = OutboundFrame(
            fin = true,
            opcode = WsFrameCodec.OP_BINARY,
            // Defensive copy: the caller may reuse or mutate its array at once.
            payload = bytes.copyOf(),
            // An empty message still occupies a masked frame on the wire, so it is
            // charged its real header and mask rather than entering the queue free.
            cost = if (bytes.isEmpty()) WsFrameCodec.headerSize(0) + 4 else bytes.size,
            admittedEpoch = channelEpoch,
            messageGuard = writeGuard,
            admittedMessageEpoch = messageEpoch,
            completion = CompletableDeferred(),
            receipt = receipt,
        )
        if (!reservation.tryReserve(frame.cost)) {
            receipt.record(PeerDelivery.NOT_SENT)
            throw PeerTransportException(PeerTransportErrorCode.OUTBOUND_QUEUE_FULL)
        }
        if (!enqueue(frame)) {
            frame.releaseReservation(reservation)
            receipt.record(PeerDelivery.NOT_SENT)
            throw PeerTransportException(PeerTransportErrorCode.CHANNEL_CLOSED)
        }
        try {
            frame.completion.await()
            recordDelivery(receipt, PeerDelivery.WRITTEN)
        } catch (failure: PeerTransportException) {
            recordDelivery(
                receipt,
                if (failure.deliveryIsUnknown) PeerDelivery.SUBMITTED_UNKNOWN else PeerDelivery.NOT_SENT,
            )
            throw failure
        } catch (cancellation: CancellationException) {
            if (frame.cancelBeforeDispatch()) {
                // Provably never reached the socket: drop the queued frame and its
                // payload, release the reservation, and report not sent.
                removePending(frame)
                frame.releaseReservation(reservation)
                recordDelivery(receipt, PeerDelivery.NOT_SENT)
            } else {
                // The write was already invoked. Its outcome is unknowable and a
                // frame is never replayed, so the connection is torn down.
                receipt.record(PeerDelivery.SUBMITTED_UNKNOWN)
                finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "")
            }
            throw cancellation
        }
    }

    override suspend fun receive(): ByteArray? = inbound.receiveCatching().getOrNull()

    override suspend fun close() {
        // One close operation only. A second caller, and any caller after the
        // channel already ended, simply waits for the single settled outcome.
        if (!closeStarted.compareAndSet(false, true)) {
            closedDeferred.await()
            return
        }
        lifecycle.compareAndSet(LIFECYCLE_OPEN, LIFECYCLE_CLOSING)
        enqueueControlFrame(WsFrameCodec.OP_CLOSE, EMPTY_PAYLOAD)
        try {
            val settled = withTimeoutOrNull(bounds.closeTimeoutMs.toLong()) { closedDeferred.await() }
            if (settled == null) finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "terminated")
        } catch (cancellation: CancellationException) {
            // The only bound on this path was abandoned: terminate instead of
            // leaving the socket, its reader, and its writer running.
            finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "terminated")
            throw cancellation
        }
    }

    /** Abrupt local teardown used when the owning transport is disposed. */
    internal fun closeNow() {
        finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "")
    }

    // --- reader -----------------------------------------------------------------

    private suspend fun readerLoop() {
        val reader = WsFrameReader(connection.input, bounds.maxWebSocketMessageBytes)
        try {
            while (!finalized) {
                val message = reader.next()
                when (message.opcode) {
                    WsFrameCodec.OP_BINARY -> inbound.send(message.payload)
                    WsFrameCodec.OP_TEXT -> {
                        // Text is refused, never passed through.
                        refuseWith(WsFrameReader.CLOSE_UNSUPPORTED_MESSAGE, "unsupported message")
                        return
                    }
                    WsFrameCodec.OP_PING -> respondToPing(message.payload)
                    WsFrameCodec.OP_PONG -> Unit
                    WsFrameCodec.OP_CLOSE -> {
                        val code = closeCodeOf(message.payload)
                        val reason = closeReasonOf(message.payload)
                        // A peer-initiated close is answered, but a blocked output
                        // never holds the channel: the reply is bounded and the
                        // channel terminates either way.
                        attemptCloseFrame(code, code, reason)
                        finalizeWith(code, reason)
                        return
                    }
                    else -> {
                        refuseWith(WsFrameReader.CLOSE_PROTOCOL_ERROR, "")
                        return
                    }
                }
            }
        } catch (violation: WsProtocolViolation) {
            refuseWith(violation.closeCode, "")
        } catch (_: WsEndOfStream) {
            finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "")
        } catch (_: IOException) {
            finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "")
        } catch (_: Throwable) {
            finalizeWith(WsFrameReader.CLOSE_INTERNAL, "")
        } finally {
            finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "")
        }
    }

    private suspend fun respondToPing(payload: ByteArray) {
        val cost = payload.size + CONTROL_FRAME_OVERHEAD
        if (!reservation.tryReserve(cost)) {
            finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "control queue bound")
            return
        }
        val frame = OutboundFrame(
            fin = true,
            opcode = WsFrameCodec.OP_PONG,
            payload = payload.copyOf(),
            cost = cost,
            admittedEpoch = sendGuard.epoch(),
            messageGuard = PeerSendGuard.NONE,
            admittedMessageEpoch = 0L,
            completion = CompletableDeferred(),
            control = true,
        )
        if (!enqueue(frame)) {
            frame.releaseReservation(reservation)
            finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "control send failed")
        }
    }

    // --- writer -----------------------------------------------------------------

    private suspend fun writerLoop() {
        try {
            while (!finalized) {
                val token = outboundSignal.receiveCatching()
                if (!token.isSuccess) return
                while (true) {
                    val frame = pollPending() ?: break
                    dispatch(frame)
                }
            }
        } finally {
            drainOutbound()
        }
    }

    private fun dispatch(frame: OutboundFrame) {
        try {
            // Cheap pre-check: never encode, report, or write a frame that is
            // already unauthorized, and never fire the invocation boundary for one.
            if (!mayWrite(frame)) {
                reject(frame)
                return
            }
            // Accepted dispatch is claimed atomically against cancellation, and the
            // invocation boundary is marked inside that same step: a cancellation
            // that wins first prevents the observer from ever running, and a frame
            // that got here can never later be reported as provably not sent.
            if (!frame.beginDispatch()) {
                reject(frame)
                return
            }
            // Invocation boundary: reported after accepted dispatch and before any
            // potentially blocking wait or write, exactly once.
            if (!notifyInvoked(frame)) return
            // The callback may have changed this frame's source or the channel
            // lifecycle, so both guards are proved again before any byte.
            if (!mayWrite(frame)) {
                reject(frame)
                return
            }
            val encoded = WsFrameCodec.encode(frame.fin, frame.opcode, frame.payload, freshMaskKey())
            var submitted = false
            synchronized(writeLock) {
                if (!mayWrite(frame)) {
                    reject(frame)
                    return
                }
                // Submission is recorded at the real write boundary, not at queue
                // admission, so "submitted" always means output.write was invoked.
                submitted = true
                try {
                    connection.output.write(encoded)
                    connection.output.flush()
                } catch (_: Throwable) {
                    submitted = false
                    frame.markWriteFailed()
                    recordOutcome(frame, PeerDelivery.SUBMITTED_UNKNOWN)
                    frame.completion.completeExceptionally(
                        PeerTransportException(PeerTransportErrorCode.SEND_FAILED),
                    )
                    finalizeWith(WsFrameReader.CLOSE_ABNORMAL, "")
                    return
                }
                frame.markWritten()
            }
            if (submitted) {
                recordOutcome(frame, PeerDelivery.WRITTEN)
                frame.completion.complete(Unit)
            }
        } catch (unexpected: Throwable) {
            frame.markWriteFailed()
            recordOutcome(frame, PeerDelivery.SUBMITTED_UNKNOWN)
            frame.completion.completeExceptionally(
                PeerTransportException(PeerTransportErrorCode.SEND_FAILED),
            )
            finalizeWith(WsFrameReader.CLOSE_INTERNAL, "")
        } finally {
            frame.releaseReservation(reservation)
        }
    }

    /**
     * Claim and report the invocation boundary for one frame.
     *
     * The boundary is marked before the callback runs, so a callback that itself
     * observes the state cannot see a frame as not-invoked. A throwing callback
     * refuses the frame: no byte is written, the frame is never replayed, the
     * reservation is released by the caller's finally, and the outcome is
     * reported conservatively because the boundary was already crossed.
     *
     * Returns false when the frame must not be written.
     */
    private fun notifyInvoked(frame: OutboundFrame): Boolean {
        val receipt = frame.receipt ?: return true
        // beginDispatch already claimed the boundary atomically against cancellation.
        val callback = receipt.onInvoked ?: return true
        return try {
            callback()
            true
        } catch (_: Throwable) {
            recordOutcome(frame, PeerDelivery.SUBMITTED_UNKNOWN)
            frame.completion.completeExceptionally(
                PeerTransportException(PeerTransportErrorCode.SEND_FAILED),
            )
            false
        }
    }

    /** Record a frame's outcome on its caller's receipt. */
    private fun recordOutcome(frame: OutboundFrame, value: PeerDelivery) {
        frame.receipt?.let { recordDelivery(it, value) }
    }

    /**
     * Once the invocation boundary was crossed, "provably never left this
     * process" is no longer a claim this transport can honestly make, so a
     * not-sent outcome is widened to the conservative unknown.
     */
    private fun recordDelivery(receipt: PeerSendReceipt, value: PeerDelivery) {
        receipt.record(
            if (value == PeerDelivery.NOT_SENT && receipt.wasInvoked) {
                PeerDelivery.SUBMITTED_UNKNOWN
            } else {
                value
            },
        )
    }

    private fun reject(frame: OutboundFrame) {
        recordOutcome(frame, PeerDelivery.NOT_SENT)
        frame.completion.completeExceptionally(
            PeerTransportException(
                PeerTransportErrorCode.CHANNEL_NOT_OPEN,
                invocationBoundaryCrossed = frame.receipt?.wasInvoked == true,
            ),
        )
    }

    /** Authorization for one queued frame, re-evaluated at the write boundary. */
    private fun mayWrite(frame: OutboundFrame): Boolean {
        if (finalized) return false
        val state = lifecycle.get()
        // Data stops the moment closing begins; the close reply and a pong still
        // need to go out while closing is in progress.
        if (if (frame.control) state == LIFECYCLE_CLOSED else state != LIFECYCLE_OPEN) return false
        return sendGuard.allows() && sendGuard.epoch() == frame.admittedEpoch &&
            frame.messageGuard.allows() && frame.messageGuard.epoch() == frame.admittedMessageEpoch
    }

    private fun enqueue(frame: OutboundFrame): Boolean {
        val accepted = synchronized(lock) {
            if (finalized) false else {
                pending.addLast(frame)
                true
            }
        }
        if (accepted) outboundSignal.trySend(Unit)
        return accepted
    }

    private fun removePending(frame: OutboundFrame): Boolean = synchronized(lock) { pending.remove(frame) }

    private fun pollPending(): OutboundFrame? = synchronized(lock) { pending.removeFirstOrNull() }

    private fun drainOutbound() {
        val drained = synchronized(lock) {
            val copy = pending.toList()
            pending.clear()
            copy
        }
        for (frame in drained) {
            frame.releaseReservation(reservation)
            recordOutcome(frame, PeerDelivery.NOT_SENT)
            frame.completion.completeExceptionally(
                PeerTransportException(PeerTransportErrorCode.CHANNEL_CLOSED),
            )
        }
    }

    // --- teardown ---------------------------------------------------------------

    /**
     * Queue one polite close reply through the shared writer, so it is ordered
     * against data frames and bounded by the same outbound accounting.
     */
    private fun enqueueControlFrame(opcode: Int, payload: ByteArray) {
        val cost = payload.size + CONTROL_FRAME_OVERHEAD
        if (!reservation.tryReserve(cost)) return
        val frame = OutboundFrame(
            fin = true,
            opcode = opcode,
            payload = payload,
            cost = cost,
            admittedEpoch = sendGuard.epoch(),
            messageGuard = PeerSendGuard.NONE,
            admittedMessageEpoch = 0L,
            completion = CompletableDeferred(),
            control = true,
        )
        if (!enqueue(frame)) frame.releaseReservation(reservation)
    }

    /**
     * Answer a peer close or a protocol violation directly, because the queued
     * writer may be behind the very frame that is being refused. Entering
     * [LIFECYCLE_CLOSING] first means no queued data can follow the reply, and an
     * independent watchdog ends the channel even when the reply itself cannot
     * make progress: a coroutine timeout cannot interrupt a blocking socket write
     * or monitor acquisition, so only terminating the connection can.
     */
    private fun attemptCloseFrame(
        code: Int,
        finalCode: Int = code,
        finalReason: String = "",
    ) {
        lifecycle.compareAndSet(LIFECYCLE_OPEN, LIFECYCLE_CLOSING)
        val payload = encodeClosePayload(code)
        val cost = payload.size + CONTROL_FRAME_OVERHEAD
        if (!reservation.tryReserve(cost)) {
            finalizeWith(finalCode, finalReason)
            return
        }
        val watchdog = scope.launch {
            try {
                delay(bounds.closeTimeoutMs.toLong())
            } catch (_: CancellationException) {
                return@launch
            }
            finalizeWith(finalCode, finalReason)
        }
        try {
            val encoded = WsFrameCodec.encode(true, WsFrameCodec.OP_CLOSE, payload, freshMaskKey())
            synchronized(writeLock) {
                if (!finalized) {
                    connection.output.write(encoded)
                    connection.output.flush()
                }
            }
        } catch (_: Throwable) {
            // Finalization reports the channel outcome.
        } finally {
            watchdog.cancel()
            reservation.release(cost)
        }
    }

    /** Refuse a frame the protocol forbids: answer, then end the channel. */
    private fun refuseWith(code: Int, reason: String) {
        attemptCloseFrame(code, code, reason)
        finalizeWith(code, reason)
    }

    private fun finalizeWith(code: Int, reason: String) {
        val first: Boolean = synchronized(lock) {
            if (finalized) false else {
                finalized = true
                true
            }
        }
        if (!first) return
        lifecycle.set(LIFECYCLE_CLOSED)
        drainOutbound()
        inbound.close()
        connection.terminate()
        // Ownership bookkeeping settles before an observer is released: waiting on
        // `closed` therefore also means the channel left the transport's tracked
        // set and its operation slot was released.
        try {
            onFinalized(this)
        } catch (_: Throwable) {
            // A caller cleanup failure never changes a transport decision.
        }
        closedDeferred.complete(PeerChannelClose(code, reason))
        scope.cancel()
    }

    private fun freshMaskKey(): ByteArray {
        val key = ByteArray(4)
        random.nextBytes(key)
        return key
    }

    private fun encodeClosePayload(code: Int): ByteArray {
        if (!WsFrameReader.isValidCloseCode(code)) return EMPTY_PAYLOAD
        return byteArrayOf(((code ushr 8) and 0xFF).toByte(), (code and 0xFF).toByte())
    }

    private fun closeCodeOf(payload: ByteArray): Int {
        if (payload.size < 2) return WsFrameReader.CLOSE_ABNORMAL
        return ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF)
    }

    private fun closeReasonOf(payload: ByteArray): String {
        if (payload.size <= 2) return ""
        val reason = ByteArray(payload.size - 2)
        System.arraycopy(payload, 2, reason, 0, reason.size)
        return WsFrameReader.sanitizeCloseReason(reason)
    }

    private companion object {
        val EMPTY_PAYLOAD = ByteArray(0)
        const val LIFECYCLE_OPEN = 0
        const val LIFECYCLE_CLOSING = 1
        const val LIFECYCLE_CLOSED = 2
    }
}
