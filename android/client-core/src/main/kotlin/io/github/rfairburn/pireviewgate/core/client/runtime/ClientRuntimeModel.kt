package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointEvent
import io.github.rfairburn.pireviewgate.core.client.content.ContentCopyReceipt
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointObservation
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy
import io.github.rfairburn.pireviewgate.core.client.content.ContentViewportRequest
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEvent
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientState
import io.github.rfairburn.pireviewgate.core.client.roster.RosterNotSentReason
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOperationKind
import io.github.rfairburn.pireviewgate.core.client.roster.RosterPendingOperation
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSubscriptionRefusal
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane

/**
 * The exact target of one deliberate terminal selection.
 *
 * Every field is a fact this runtime observed, never something it derived: [hostId]
 * is the local saved-destination handle, and [ownerRunId] and [rowId] are the exact
 * owner run and owner row of a row present in that host's CURRENT roster. Nothing
 * here is matched by caption, label, workspace path, or name, and a target is never
 * retargeted onto a different run or row — a different tuple is a different
 * selection.
 */
data class TerminalTarget(
    val hostId: HostId,
    val ownerRunId: String,
    val rowId: String,
)

/** Where one host APP lane stands. Only [ATTACHED] lanes count against the ceiling. */
enum class HostLanePhase {
    /** The lane consumes its channel and may carry roster traffic. */
    ATTACHED,

    /** Retirement is outstanding: no new request is admitted, controls still drain. */
    RETIRING,

    /** Terminal. The immutable last observation is retained; no job is. */
    DETACHED,
}

/**
 * The published state of one host APP lane.
 *
 * [roster] is the endpoint's own immutable state, carried unchanged: full
 * [io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata]
 * rows, the owner's acknowledged capabilities, the described Saved policy, pending
 * operations, and the projection's honest freshness. This runtime never rewrites,
 * trims, merges, or re-sorts any of it, so a later presentation layer can order and
 * project it without recovering facts that were already observed.
 */
data class HostRuntimeState(
    val hostId: HostId,
    val connectionGeneration: Long,
    val lane: HostLanePhase,
    val roster: RosterClientState,
)

/**
 * The one currently selected CONTENT stream, with the endpoint's own observation
 * carried unchanged.
 *
 * [selectionGeneration] is this runtime's monotonic selection identity: it is what
 * lets a later bridge tell an old frame, receipt, or input lifetime from the current
 * one, and it never travels on the wire.
 */
data class SelectedContent(
    val selectionGeneration: Long,
    val target: TerminalTarget,
    val observation: ContentEndpointObservation,
)

/**
 * The two independent native facts about what is on screen.
 *
 * They are deliberately separate because they retire different things:
 *
 *  - [appForeground] is the whole application's lifecycle. Losing it withdraws the
 *    selected content stream (bounded unsubscribe) and stops input and copy, while
 *    every host APP lane keeps running and no owner session is touched.
 *  - [terminalInputCovered] is the terminal pane's own visibility, focus, and
 *    freedom from a modal or chooser. Losing it retires input and copy proofs only:
 *    display continues, and the content channel's hello, subscribe, resize,
 *    unsubscribe, and protocol-refusal traffic stay dispatchable.
 */
data class VisibilitySnapshot(
    val appForeground: Boolean,
    val terminalInputCovered: Boolean,
) {
    /** True only while a native input or copy proof could possibly hold. */
    val allowsTerminalInput: Boolean get() = appForeground && terminalInputCovered
}

/**
 * The complete immutable runtime state published on every change.
 *
 * [terminalInputAdmissionOpen] is the effective synchronous input-admission gate for
 * the current selection — the cheap atomic the runtime flips before any asynchronous
 * teardown, so a caller can read exactly what an input attempt would see right now.
 * [rememberedTarget] and [restoreArmed] are separate on purpose: a withdrawn
 * selection stays remembered for honest display, while only an explicitly armed
 * intent may be restored automatically, and only from a fresh positive roster.
 */
data class ClientRuntimeState(
    val hosts: List<HostRuntimeState>,
    val selection: SelectedContent?,
    /**
     * A deliberately selected target whose channel is still opening, or `null`.
     *
     * It exists so a bridge can show an honest "opening" without inventing a frame,
     * and so a late-opening channel can be recognized as no longer wanted.
     */
    val pendingSelection: TerminalTarget?,
    val rememberedTarget: TerminalTarget?,
    val restoreArmed: Boolean,
    val visibility: VisibilitySnapshot,
    val viewport: ContentViewportRequest?,
    val inputPolicy: ContentInputPolicy,
    val terminalInputAdmissionOpen: Boolean,
    val closed: Boolean,
) {
    /** The current selection's observation, or `null` when no terminal is selected. */
    val content: ContentEndpointObservation? get() = selection?.observation

    /** All attached hosts, in no significant order. */
    val attachedHosts: List<HostRuntimeState> get() = hosts.filter { it.lane == HostLanePhase.ATTACHED }
}

/** The verdict for one host lane attachment. */
sealed interface HostAttachResult {
    /** The lane was installed and is the only consumer of that channel. */
    data object Accepted : HostAttachResult

    /** No lane was installed, nothing was written, and the channel stays the parent's. */
    data class Refused(val reason: HostAttachRefusal) : HostAttachResult
}

/** Why a host lane was not attached. No lane exists, and nothing was written. */
enum class HostAttachRefusal {
    /** The runtime is closed. */
    CLOSED,

    /** This host already has a live lane; a fresh attempt detaches first. */
    ALREADY_ATTACHED,

    /** The runtime's own concurrent-host ceiling is reached. */
    HOST_LIMIT,

    /** The binding's generation does not follow the last attempt for this host. */
    STALE_GENERATION,

    /** The channel is not an APP lane; lanes are never mixed. */
    WRONG_LANE,
}

/** Why a live host lane ended. */
enum class HostDetachReason {
    /** The parent registry retired the connection. */
    PARENT_DETACHED,

    /** The whole runtime was disposed. */
    RUNTIME_CLOSED,

    /** The channel ended on its own; the lane settled from the observed closure. */
    CHANNEL_CLOSED,
}

/** Why one deliberate selection never produced a content stream. */
enum class SelectionRefusal {
    CLOSED,
    HOST_NOT_ATTACHED,
    HOST_DETACHED,

    /** The host's roster is not a current authoritative snapshot right now. */
    ROSTER_NOT_CURRENT,

    /** The exact run and row tuple is not in that current snapshot. */
    ROW_NOT_IN_CURRENT_ROSTER,

    /** No native measurement has been supplied, so no honest size exists. */
    NO_VIEWPORT,

    /** The caller's own dynamic selection proof refused. */
    PROOF_UNAVAILABLE,

    /** This exact target is already the live selection. */
    ALREADY_SELECTED,
}

/** Why an opened content channel was abandoned rather than used. */
enum class ContentOpenFailure {
    /** The parent's opener failed. */
    CHANNEL_OPEN_FAILED,

    /** The selection was withdrawn or replaced while the channel was opening. */
    SUPERSEDED,

    /** The host lane is gone or is no longer the same attempt. */
    HOST_LOST,

    /** The runtime was disposed. */
    RUNTIME_CLOSED,
}

/** Why a completed native copy was not routed to the caller. */
enum class CopySuppressionReason {
    SELECTION_WITHDRAWN,
    TERMINAL_NOT_COVERED,
    APP_NOT_FOREGROUND,
    RUNTIME_CLOSED,

    /** The live remote input and copy preference is off. */
    POLICY_DISABLED,

    /** Coverage or preference returned, and no frame has actually been committed since. */
    FRESH_COMMIT_REQUIRED,

    /** The caller's own current-view proof no longer answers true. */
    PROOF_UNAVAILABLE,

    /** This exact copy is no longer the claimable one: claimed, replaced, or its stream ended. */
    COPY_SUPERSEDED,
}

/**
 * Why a command never reached the model it forwards to.
 *
 * It is separate from the model's own refusal reasons on purpose: a command refused
 * here produced no request id, no pending slot, and no wire effect of any kind, and
 * the caller must be able to tell that apart from the model's own verdict.
 */
enum class RuntimeIntake {
    CLOSED,
    HOST_NOT_ATTACHED,
    HOST_DETACHED,

    /** The lane's bounded outbound queue was full, so the write was never offered. */
    OUTBOUND_QUEUE_FULL,
}

/** The admission verdict for one submitted remote roster operation. */
sealed interface RosterOperationAdmission {
    /** Accepted by the endpoint with this correlation id. Its outcome arrives later as an event. */
    data class Accepted(
        val kind: RosterOperationKind,
        val requestId: String,
        /**
         * The immutable pending record this acceptance created, read from the very step
         * that accepted it — never from a later observation, which a fast settlement would
         * already have cleared.
         *
         * It carries the exact owner facts and the channel's own attempt sequence an
         * adapter needs to bind an owner result or query revision without guessing. It is
         * `null` only when the operation settled inside that same step. Nothing here keeps
         * a history: this is the caller's own copy of a record the endpoint handed over.
         */
        val pending: RosterPendingOperation?,
    ) : RosterOperationAdmission

    /** The endpoint's own refusal. Nothing left this side. */
    data class Refused(val kind: RosterOperationKind, val reason: RosterNotSentReason) : RosterOperationAdmission

    /** The command never reached the endpoint. */
    data class NotReached(val kind: RosterOperationKind, val reason: RuntimeIntake) : RosterOperationAdmission
}

/** The admission verdict for one roster subscription control. */
sealed interface RosterSubscriptionAdmission {
    /** A fresh subscription is outstanding on this channel. */
    data class Started(val subscriptionId: String) : RosterSubscriptionAdmission

    /** The endpoint refused to start or join anything. */
    data class Refused(val reason: RosterSubscriptionRefusal) : RosterSubscriptionAdmission

    /** The live subscription began retiring; the next attempt is the caller's. */
    data class RetirementRequested(val subscriptionId: String?) : RosterSubscriptionAdmission

    /** This request joined the one retirement already outstanding. */
    data class RetirementJoined(val subscriptionId: String) : RosterSubscriptionAdmission

    /** The endpoint was stopped. Last-observed rows stay visible as not current. */
    data object Stopped : RosterSubscriptionAdmission

    /** The command never reached the endpoint. */
    data class NotReached(val reason: RuntimeIntake) : RosterSubscriptionAdmission
}

/** The verdict for one deliberate terminal selection. */
sealed interface SelectionResult {
    /** Accepted. The content stream opens asynchronously; its state arrives on [ClientRuntimeState]. */
    data class Selected(val selectionGeneration: Long, val target: TerminalTarget) : SelectionResult

    /** Refused synchronously, with no state change and no write. */
    data class Refused(val reason: SelectionRefusal) : SelectionResult
}

/** The verdict for withdrawing the current terminal selection. */
sealed interface TerminalLeaveResult {
    /** The stream was withdrawn. The remembered target, if any, is untouched. */
    data class Left(val target: TerminalTarget) : TerminalLeaveResult

    /** Nothing was selected. */
    data object NoSelection : TerminalLeaveResult
}

/** The verdict for one remembered-terminal intent. */
sealed interface RememberTerminalResult {
    /** The intent is recorded and armed for automatic restoration. */
    data class Remembered(val target: TerminalTarget) : RememberTerminalResult

    /** The intent was not recorded. */
    data class Refused(val reason: SelectionRefusal) : RememberTerminalResult
}

/** The verdict for one native viewport measurement. */
sealed interface ViewportResult {
    /** Recorded, and forwarded as a resize when a content stream is live. */
    data class Applied(val cols: Int, val rows: Int) : ViewportResult

    /** Refused. The previous measurement, if any, stays in force. */
    data class Rejected(val reason: ViewportRefusal) : ViewportResult
}

/** Why one viewport measurement was refused. */
enum class ViewportRefusal {
    CLOSED,

    /** The measurement is not a real pane size. */
    INVALID_DIMENSIONS,
}

/**
 * Everything the caller observes from one runtime, in order.
 *
 * Events are delivered through a bounded channel and are never dropped, replayed, or
 * reordered within one lane: a producer suspends rather than discarding a settlement.
 * Nothing here carries a path, a key, an exception, or owner text — the payload types
 * are the landed models' own, which already keep that promise.
 */
sealed interface ClientRuntimeEvent {
    /** A host APP lane began consuming one channel attempt. */
    data class HostAttached(val hostId: HostId, val connectionGeneration: Long) : ClientRuntimeEvent

    /** A host lane was refused. No consumer was installed. */
    data class HostAttachRefused(
        val hostId: HostId,
        val connectionGeneration: Long,
        val reason: HostAttachRefusal,
    ) : ClientRuntimeEvent

    /** A host lane finished retiring. Its last observation is retained; no job is. */
    data class HostDetached(
        val hostId: HostId,
        val connectionGeneration: Long,
        val reason: HostDetachReason,
    ) : ClientRuntimeEvent

    /**
     * The roster endpoint asked for its channel to end.
     *
     * The registry owns connections, so the runtime reports the request instead of
     * closing a channel it does not own. The lane keeps consuming until the parent
     * actually closes it.
     */
    data class RosterChannelRetirementRequested(
        val hostId: HostId,
        val connectionGeneration: Long,
        val lane: PeerAppLane,
    ) : ClientRuntimeEvent

    /** One roster endpoint event, exactly as the endpoint reported it. */
    data class Roster(
        val hostId: HostId,
        val connectionGeneration: Long,
        val event: RosterClientEvent,
    ) : ClientRuntimeEvent

    /** One content endpoint event for one selection, exactly as the endpoint reported it. */
    data class Content(
        val selectionGeneration: Long,
        val hostId: HostId,
        val event: ContentEndpointEvent,
    ) : ClientRuntimeEvent

    /** The selected stream changed, including to `null` when it was withdrawn. */
    data class SelectionChanged(val selection: SelectedContent?) : ClientRuntimeEvent

    /** A selection never produced a stream, or its channel was abandoned. */
    data class ContentOpenFailed(
        val selectionGeneration: Long,
        val hostId: HostId,
        val reason: ContentOpenFailure,
    ) : ClientRuntimeEvent

    /**
     * A completed native copy is available to the caller's clipboard adapter.
     *
     * This is an offer, never permission to write a clipboard. The copy stays claimable
     * only while the stream that produced it, its live policy generation, the app's
     * foreground state, the pane's coverage, a real committed frame, and the caller's own
     * current-view proof all still hold, and it is claimed exactly once. Delivery happens
     * through [ClientRuntime.claimTerminalCopy] immediately before the native write, so a
     * copy that sat in this queue across a navigation, a background, or a policy change
     * cannot reach a clipboard nobody is looking at.
     */
    data class TerminalCopyOffered(
        val selectionGeneration: Long,
        val hostId: HostId,
        val copy: ContentCopyReceipt,
        /** The live input-policy generation this copy was offered under. */
        val policyGeneration: Long,
    ) : ClientRuntimeEvent

    /**
     * A completed native copy was not routed, with the fixed reason.
     *
     * The copy's bytes are never buffered here for later delivery: a suppressed copy
     * is over, and a deferred foreground never replays it.
     */
    data class TerminalCopySuppressed(
        val selectionGeneration: Long,
        val hostId: HostId,
        val copyId: String,
        val reason: CopySuppressionReason,
    ) : ClientRuntimeEvent
}

/** The verdict of one delivery-time copy claim. */
sealed interface TerminalCopyClaim {
    /** Every fence still holds for this exact copy. Deliver it, once. */
    data class Granted(val copy: ContentCopyReceipt) : TerminalCopyClaim

    /** This copy never reaches a clipboard. The reason is fixed and permanent. */
    data class Suppressed(val copyId: String, val reason: CopySuppressionReason) : TerminalCopyClaim
}
