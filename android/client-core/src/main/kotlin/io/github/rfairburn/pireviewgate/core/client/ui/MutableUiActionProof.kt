package io.github.rfairburn.pireviewgate.core.client.ui

import java.util.concurrent.atomic.AtomicReference

/**
 * The portable, thread-safe standing of one drawn control.
 *
 * This is the only mutable part of the proof contract, and it is deliberately free
 * of platform types so its rules can be checked off-device. The Android side owns
 * *when* to call these methods (a real view, a real draw pass, a real frame-commit
 * report, verified on the main thread); this class owns *what they mean*, and it
 * guarantees the reads a controller performs from its own thread:
 *
 * - Every property is a single atomic read of one immutable [Snapshot]. A reader
 *  therefore never sees a mixture of two generations — for example a retired
 *  [isCurrent] next to a [hasCommittedFrame] that was set before the retirement.
 * - No read touches a view, a composition, or a plain mutable field, so a controller
 *  on an IO thread can consult a proof it received inside an intent without
 *  marshalling anything.
 * - [invalidate] flips the state atomically and first: once it returns, no later read
 *  can still see the retired standing, and a commit report that was already in
 *  flight for the previous epoch can never re-satisfy it.
 *
 * Construction and every mutation are expected on the UI thread, which is the only
 * place that knows what is actually drawn. Reads are safe from anywhere.
 */
public open class MutableUiActionProof(
    override val target: UiActionTargetToken,
) : UiActionProof {

    /** One indivisible generation of this proof's standing. */
    private data class Snapshot(
        val current: Boolean,
        val committed: Boolean,
        val readable: Boolean,
        val epoch: Long,
    )

    private val state = AtomicReference(Snapshot(current = true, committed = false, readable = false, epoch = 0L))

    override val epoch: Long get() = state.get().epoch
    override val isCurrent: Boolean get() = state.get().current
    override val hasCommittedFrame: Boolean get() = state.get().committed
    override val criticalIdentityReadable: Boolean get() = state.get().readable

    /**
     * Begin a new draw pass and return its epoch.
     *
     * The pass starts uncommitted, so only a report naming this exact epoch can
     * satisfy it — a callback captured by a retired pass is inert.
     */
    public fun beginDraw(): Long {
        var result = 0L
        state.updateAndGet { current ->
            val next = current.copy(committed = false, epoch = current.epoch + 1L)
            result = next.epoch
            next
        }
        return result
    }

    /**
     * Record that the platform submitted the frame of [drawEpoch].
     *
     * A report for any other epoch — an older pass, or a pass that was invalidated
     * while it was in flight — is dropped. The return value says whether this call is
     * what satisfied the current pass, which a shared commit source needs in order to
     * report honestly how many controls a frame certified rather than how many it
     * touched.
     */
    public fun markCommitted(drawEpoch: Long): Boolean {
        while (true) {
            val before = state.get()
            if (!before.current || drawEpoch != before.epoch || before.committed) return false
            if (state.compareAndSet(before, before.copy(committed = true))) return true
        }
    }

    /** Report whether every critical identity line is fully laid out and readable. */
    public fun setCriticalIdentityReadable(readable: Boolean) {
        state.updateAndGet { current ->
            val value = readable && current.current
            if (current.readable == value) current else current.copy(readable = value)
        }
    }

    /**
     * Drop this proof's standing.
     *
     * Transient reasons (semantic recompose, layout, focus, lifecycle) clear the
     * committed frame and readable report and raise the epoch, so the control has to
     * be drawn, measured, and committed again. Retiring reasons (coverage by another
     * modal, a target change, dismissal) additionally mark the control as no longer
     * current, which no re-arm can undo: a fresh control has to mint a fresh proof.
     *
     * The flip is atomic and happens before the caller does anything else, which is
     * what makes "invalidate first" observable to a concurrent reader.
     */
    public fun invalidate(reason: UiProofInvalidationReason) {
        val retiring = reason == UiProofInvalidationReason.COVERAGE_CHANGE ||
            reason == UiProofInvalidationReason.TARGET_CHANGE ||
            reason == UiProofInvalidationReason.DISMISSED
        state.updateAndGet { current ->
            if (retiring) {
                Snapshot(current = false, committed = false, readable = false, epoch = current.epoch + 1L)
            } else {
                current.copy(committed = false, readable = false, epoch = current.epoch + 1L)
            }
        }
    }
}
