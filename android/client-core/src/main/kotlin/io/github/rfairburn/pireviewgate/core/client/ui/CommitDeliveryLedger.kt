package io.github.rfairburn.pireviewgate.core.client.ui

/**
 * The adapter bookkeeping around [ProofCommitRegistry]: what the platform may still
 * deliver for, and what a delivery does to that.
 *
 * Kept separate from the platform wrapper on purpose. The wrapper's own state is the
 * one thing a registration-aware registry cannot protect: a commit callback dispatched
 * late — a platform callback reposted to the main thread, say — can arrive after a
 * newer registration was installed. A wrapper that tracked "awaiting" in its own flag
 * and cleared it on arrival would then silence the newer registration, so a control
 * that was legitimately drawn would never be proven and its control would sit inert.
 *
 * So pending status is derived from the registry and nowhere else. An obsolete delivery
 * certifies nothing and changes nothing that is pending.
 */
public class CommitDeliveryLedger(private val registry: ProofCommitRegistry = ProofCommitRegistry()) {
    /** True while a registration is outstanding and a delivery could still certify. */
    public val isAwaitingDelivery: Boolean get() = registry.hasPendingRegistration

    /**
     * Capture the pairs the next commit may certify and return the token to register it
     * under, or `null` when nothing is worth awaiting. Any earlier registration is
     * superseded, not cancelled-and-forgotten: a callback for it may still arrive.
     */
    public fun install(candidates: List<MutableUiActionProof>, windowHasFocus: Boolean): Long? =
        registry.beginRegistration(candidates, windowHasFocus)

    /**
     * Deliver the commit the platform reported for [id].
     *
     * Pending status is re-derived afterwards, never assumed: a delivery naming an
     * obsolete registration leaves the current one awaiting.
     */
    public fun deliver(id: Long, stillAttached: (MutableUiActionProof) -> Boolean = { true }): Int =
        registry.deliver(id, stillAttached)

    /** Withdraw the outstanding registration: cancel, focus loss, or window teardown. */
    public fun cancel(): Unit = registry.discard()
}
