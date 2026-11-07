package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * Which screen issued one committed-action proof.
 *
 * The kind is part of the semantic target so a proof minted for one dialog can
 * never satisfy a destructive intent raised from another.
 */
public enum class UiProofScreen {
    HOST_ADD_FORM,
    HOST_EDIT_ADDRESS,
    HOST_REMOVE,
    HOST_FIRST_CONTACT_CONSENT,
    SESSION_CREATE,
    SESSION_RENAME,
    SESSION_CLOSE,
    SAVED_DELETE,
}

/**
 * Immutable semantic target of one proof: what the drawn control actually addressed.
 *
 * A token is data and grants nothing on its own. A caller that receives an intent
 * carrying a token still has to consult the live [UiActionProof] it came from, and
 * revalidate the owner facts behind the target with its own authority.
 *
 * [generation] is issued by the future controller and increases whenever the same
 * semantic target is presented again as a fresh control, so an intent built from a
 * retired dialog can be distinguished from one built from the current dialog.
 */
public data class UiActionTargetToken(
    public val screen: UiProofScreen,
    public val hostId: HostId,
    public val hostRunId: String? = null,
    public val rowId: String? = null,
    public val catalogId: String? = null,
    public val resultId: String? = null,
    public val entryId: String? = null,
    public val requestId: String? = null,
    public val generation: Long,
) {
    init {
        require(generation > 0L) { "proof generation must be positive" }
    }
}

/** Why one proof stopped being valid. Fixed, display-safe reasons only. */
public enum class UiProofInvalidationReason {
    /** The presented control was recomposed with different content. */
    SEMANTIC_RECOMPOSE,

    /** The control's measured layout changed, so the drawn frame is no longer current. */
    LAYOUT_CHANGE,

    /** Focus moved into or out of the control's window. */
    FOCUS_CHANGE,

    /** The hosting lifecycle moved away from the resumed, visible state. */
    LIFECYCLE_CHANGE,

    /** Another window now covers the window this control belongs to. */
    COVERAGE_CHANGE,

    /** The content was scrolled, so the previously committed frame is no longer current. */
    SCROLL_CHANGE,

    /** The semantic target changed, so this proof addresses a different thing. */
    TARGET_CHANGE,

    /** The control left composition entirely. */
    DISMISSED,
}

/**
 * Portable handle on the proof that one exact control was drawn and that the
 * platform submitted the frame that drew it.
 *
 * The contract is deliberately cheap and thread-safe: four reads, no locks visible
 * to callers, and no clock. Implementations live on the UI side (the Android
 * adapter attaches the real view inside each dialog window and re-arms on every
 * draw pass). The rules this type encodes are:
 *
 * - [isCurrent] is false once the control is retired, superseded, or invalidated
 *   for any [UiProofInvalidationReason]; a retired proof never becomes true again
 *   without becoming a new control instance.
 * - [hasCommittedFrame] is true only after the platform reported a commit for the
 *   frame of the current [epoch]. Where the platform cannot report commits at all,
 *   it stays false and the gated action fails closed.
 * - [criticalIdentityReadable] is true only while every identity line the dialog
 *   declared critical is fully laid out and readable — not clipped, not ellipsized.
 * - [epoch] increases on every re-arm, so a late callback from an older draw pass
 *   cannot satisfy a newer one.
 *
 * Nothing here proves that a physical display is lit; the honest ceiling is the
 * platform's own frame-commit signal, and no caller may claim more.
 */
public interface UiActionProof {
    /** The frozen semantic target this proof was minted for. */
    public val target: UiActionTargetToken

    /** Re-arm counter of the current control instance. */
    public val epoch: Long

    /** True only while this control is the current, non-invalidated control. */
    public val isCurrent: Boolean

    /** True only after the platform confirmed a commit of the current epoch. */
    public val hasCommittedFrame: Boolean

    /** True only while every critical identity line is fully readable. */
    public val criticalIdentityReadable: Boolean
}

/**
 * True only when every gate on this proof is satisfied for one and the same epoch.
 *
 * Each property is an atomic read of one snapshot, but a compound check that simply
 * ANDs three of them is not atomic as a whole: a reader on the controller's thread can
 * take `hasCommittedFrame` from an epoch that was never readable and
 * `criticalIdentityReadable` from a newer epoch that was never committed, and authorise
 * an action that no single generation ever qualified for. Bracketing the reads with the
 * monotonic epoch rejects that mixture — the epoch only ever moves forward, so any
 * generation change during the check makes the verdict refuse rather than guess.
 *
 * This stays a cheap, platform-free guard: no view, no composition, no marshalling.
 */
public fun UiActionProof.grantsAction(): Boolean {
    val observedEpoch = epoch
    val granted = isCurrent && hasCommittedFrame && criticalIdentityReadable
    return granted && epoch == observedEpoch
}

/**
 * True only when this proof is satisfied *and* addresses exactly [expected].
 *
 * Callers use this as the latest-intent guard: an intent whose frozen target no
 * longer equals the live proof's target is dropped rather than retargeted.
 */
public fun UiActionProof.grantsFor(expected: UiActionTargetToken): Boolean =
    target == expected && grantsAction()
