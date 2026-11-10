package io.github.rfairburn.pireviewgate.core.transport

/**
 * Byte accounting for the outbound path.
 *
 * A reservation is taken before a frame is admitted to the queue and is only
 * released once the platform write for that frame completed or the connection
 * terminated. Releasing at enqueue time would be a fiction: it would let a
 * caller keep queueing while the socket never drained, which is exactly the
 * unbounded behaviour this transport must not have.
 */
internal class OutboundReservation(private val maxBytes: Int) {
    private val lock = Any()

    private var used: Int = 0

    val usedBytes: Int
        get() = synchronized(lock) { used }

    fun tryReserve(cost: Int): Boolean {
        if (cost <= 0) throw invalidArgument()
        synchronized(lock) {
            if (used.toLong() + cost.toLong() > maxBytes.toLong()) return false
            used += cost
            return true
        }
    }

    fun release(cost: Int) {
        if (cost <= 0) return
        synchronized(lock) {
            used = if (used - cost < 0) 0 else used - cost
        }
    }
}

/**
 * One queued outbound frame with an explicit state machine, so "never sent" and
 * "write invoked, outcome unknown" stay distinguishable and a reservation is
 * released exactly once.
 */
internal class OutboundFrame(
    val fin: Boolean,
    val opcode: Int,
    val payload: ByteArray,
    val cost: Int,
    val admittedEpoch: Long,
    val messageGuard: PeerSendGuard,
    val admittedMessageEpoch: Long,
    val completion: kotlinx.coroutines.CompletableDeferred<Unit>,
    /** Control frames may still go out while the channel is closing. */
    val control: Boolean = false,
    /** Durable evidence handle for the caller that queued this frame. */
    val receipt: PeerSendReceipt? = null,
) {
    private val lock = Any()

    private var state = STATE_QUEUED
    private var reservationReleased = false

    /**
     * Claim accepted dispatch atomically against cancellation, and mark the
     * invocation boundary in the same step so a concurrent cancellation can never
     * settle this frame as not-sent and then have it notified anyway.
     */
    fun beginDispatch(): Boolean = synchronized(lock) {
        if (state != STATE_QUEUED) false else {
            state = STATE_DISPATCHING
            receipt?.claimInvoked()
            true
        }
    }

    /**
     * Cancel a frame that has not been dispatched. True means the frame provably
     * never reached accepted dispatch; false means that boundary was crossed.
     */
    fun cancelBeforeDispatch(): Boolean = synchronized(lock) {
        if (state != STATE_QUEUED) false else {
            state = STATE_CANCELLED
            true
        }
    }

    fun markWritten() = synchronized(lock) {
        if (state == STATE_DISPATCHING) state = STATE_WRITTEN
    }

    fun markWriteFailed() = synchronized(lock) {
        if (state == STATE_DISPATCHING) state = STATE_FAILED
    }

    /** Release the reservation at most once, no matter which path gets there first. */
    fun releaseReservation(reservation: OutboundReservation): Boolean {
        val shouldRelease = synchronized(lock) {
            if (reservationReleased) false else {
                reservationReleased = true
                true
            }
        }
        if (shouldRelease) reservation.release(cost)
        return shouldRelease
    }

    companion object {
        private const val STATE_QUEUED = 0
        private const val STATE_DISPATCHING = 1
        private const val STATE_WRITTEN = 2
        private const val STATE_FAILED = 3
        private const val STATE_CANCELLED = 4
    }
}
