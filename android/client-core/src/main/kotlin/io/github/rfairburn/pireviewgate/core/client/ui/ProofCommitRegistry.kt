package io.github.rfairburn.pireviewgate.core.client.ui

/**
 * The registration bookkeeping behind a shared per-window commit source.
 *
 * A screen-level control — a list row, a picker entry — has no window of its own, so
 * one commit source serves the whole screen and must decide which controls a given
 * commit may certify. Doing that by "whichever controls are armed right now" is wrong
 * in both directions: a callback for an older frame can certify a control armed since,
 * and a control that changed between registration and delivery can be certified by the
 * frame that preceded its change.
 *
 * So a registration captures immutable `(proof, epoch)` pairs *before* the platform is
 * asked, and a delivery is honoured only when it names the current registration. A
 * proof whose epoch moved in the meantime is not certified by the captured epoch, and a
 * retired proof is not certified at all — which is what makes a disposal or an edit
 * stick even when a callback was already in flight.
 *
 * UI-thread only, like everything that knows what is drawn.
 */
public class ProofCommitRegistry {
    private var registrationId = 0L
    private var registered: List<Pair<MutableUiActionProof, Long>> = emptyList()

    /** True while a registration is outstanding and a delivery could certify something. */
    public val hasPendingRegistration: Boolean get() = registered.isNotEmpty()

    /**
     * Capture the pairs the next commit may certify, and return the identifier to
     * register it under, or `null` when nothing is worth awaiting.
     *
     * [windowHasFocus] is the platform fact that a background window draws nothing
     * meaningful; with it false nothing is captured and no commit is awaited.
     */
    public fun beginRegistration(
        candidates: List<MutableUiActionProof>,
        windowHasFocus: Boolean,
    ): Long? {
        registrationId += 1L
        registered = if (windowHasFocus) {
            candidates.filter { it.isCurrent }.map { it to it.epoch }
        } else {
            emptyList()
        }
        return if (registered.isEmpty()) null else registrationId
    }

    /**
     * Deliver the commit the platform reported for [id].
     *
     * A delivery naming any other registration is a stale frame and certifies nothing.
     * Otherwise each captured pair is published only while its proof is still attached
     * per [stillAttached] and still current, and only at the epoch captured before the
     * platform was asked — so a proof that was re-armed, edited, or retired since
     * registration publishes nothing here.
     *
     * Returns how many proofs the delivery certified.
     */
    public fun deliver(id: Long, stillAttached: (MutableUiActionProof) -> Boolean = { true }): Int {
        if (id != registrationId) return 0
        val batch = registered
        registered = emptyList()
        var certified = 0
        batch.forEach { (proof, epoch) ->
            // Count only a publication that actually satisfied the pass. A proof whose
            // epoch moved, or that was retired, was touched by this frame and proved by
            // it not at all.
            if (stillAttached(proof) && proof.isCurrent && proof.markCommitted(epoch)) {
                certified += 1
            }
        }
        return certified
    }

    /** Withdraw the outstanding registration: cancel, focus loss, or window teardown. */
    public fun discard() {
        registrationId += 1L
        registered = emptyList()
    }
}
