package io.github.rfairburn.pireviewgate.core.client.ui

/**
 * The decided policy behind one commit-gated dialog or form.
 *
 * The Android adapter owns the platform facts — which view is attached, when the
 * platform reports a commit, where things were actually laid out — and this class
 * owns what those facts mean. Keeping the policy here makes the parts a reviewer
 * needs to check testable without a device: which invalidations retire, when a
 * re-arm is due, whether the required critical content is satisfied, and whether a
 * tap may be spent at all.
 *
 * Threading: every method is called from the UI thread, which is the only thread
 * that knows what is drawn. Reads by a controller on another thread go through the
 * [proof], whose state is an atomic immutable snapshot.
 *
 * The ordering rule is deliberate and is what "invalidate first" means here: an
 * invalidation flips the proof atomically *before* this class computes anything else,
 * so a guard running on another thread between the invalidation and the next commit
 * sees the retired standing, never the old one. A retired proof is never re-armed;
 * only a non-retiring invalidation is followed by a fresh draw generation.
 */
public class PresentationGate(
    public val proof: UiActionProof,
    public val requiredCriticalLines: Int = 0,
) {
    init {
        require(requiredCriticalLines >= 0) { "required critical lines cannot be negative" }
    }

    /**
     * Only the portable state machine can be armed or invalidated. A proof supplied
     * from elsewhere is still consulted honestly through [attempt], but nothing here
     * can make it report a committed frame, so it fails closed.
     */
    private val armable: MutableUiActionProof? = proof as? MutableUiActionProof

    /** UI-thread only: one entry per critical line reported by the layout pass. */
    private val visibility = HashMap<String, Boolean>()

    /** True while another window covers this one. Never the terminal underneath. */
    private var coveredByAnotherWindow = false

    /**
     * Report whether another window, not the screen this control sits on, is on top.
     *
     * A dialog is itself the modal over a terminal: that must not retire the dialog's
     * own standing. Only a further window above this one does, and it does so
     * permanently — a control under another window is not re-armable.
     */
    public fun onCoveredChanged(covering: Boolean) {
        if (covering == coveredByAnotherWindow) return
        coveredByAnotherWindow = covering
        armable?.invalidate(UiProofInvalidationReason.COVERAGE_CHANGE)
    }

    /** True while another window covers this one; a covered control never grants. */
    public val covered: Boolean get() = coveredByAnotherWindow

    /** The presented semantic content changed: the committed frame describes something else. */
    public fun onSemanticPresentationChange(): Long? =
        invalidateThenRearm(UiProofInvalidationReason.SEMANTIC_RECOMPOSE)

    /** The measured layout changed. */
    public fun onLayoutChange(): Long? = invalidateThenRearm(UiProofInvalidationReason.LAYOUT_CHANGE)

    /** This window lost focus. */
    public fun onFocusLost(): Long? = invalidateThenRearm(UiProofInvalidationReason.FOCUS_CHANGE)

    /** The content scrolled: whatever was committed is no longer the whole picture. */
    public fun onScroll(): Long? = invalidateThenRearm(UiProofInvalidationReason.SCROLL_CHANGE)

    /**
     * Begin a fresh draw pass, or return `null` when the proof is retired.
     *
     * The caller must cancel any in-flight registration first, then await a commit
     * for the returned generation.
     *
     * Readability is published as part of re-arming rather than only when a critical
     * line happens to report a change. A gate that requires none has nothing to wait
     * for; a gate that requires some re-publishes what the layout pass last measured.
     * Without this, a fresh proof whose frame commits while the layout pass considers
     * its output unchanged stays unreadable forever, and the control silently emits
     * nothing.
     */
    public fun rearm(): Long? {
        val machine = armable ?: return null
        if (!machine.isCurrent) return null
        val epoch = machine.beginDraw()
        publishReadability()
        return epoch
    }

    /**
     * Record one critical line's visibility as measured by the layout pass.
     *
     * The aggregate is republished every time, including when this line's own verdict
     * is unchanged: the re-arm that raised the epoch may still be waiting for its
     * readability to be stated for the new generation.
     */
    public fun reportCriticalLine(key: String, visible: Boolean): Boolean? {
        visibility[key] = visible
        return publishReadability()
    }

    /**
     * Publish the aggregate readability of the critical content this gate requires.
     *
     * A gate that requires none — an intentionally identity-free confirmation — is
     * satisfied without inventing an identity line. A gate that requires some is
     * satisfied only once at least that many lines have reported, and every one of
     * them is visible.
     */
    public fun publishReadability(): Boolean? {
        val machine = armable ?: return null
        if (!machine.isCurrent) {
            if (machine.criticalIdentityReadable) machine.setCriticalIdentityReadable(false)
            return null
        }
        val satisfied = if (requiredCriticalLines == 0) {
            true
        } else {
            visibility.size >= requiredCriticalLines && visibility.values.all { it }
        }
        machine.setCriticalIdentityReadable(satisfied)
        return satisfied
    }

    /**
     * The only way to spend this gate: every gate must hold at the moment of the
     * check, including that no other window is on top.
     */
    public fun attempt(): Boolean = !coveredByAnotherWindow && proof.grantsFor(proof.target)

    private fun invalidateThenRearm(reason: UiProofInvalidationReason): Long? {
        armable?.invalidate(reason)
        return rearm()
    }
}
