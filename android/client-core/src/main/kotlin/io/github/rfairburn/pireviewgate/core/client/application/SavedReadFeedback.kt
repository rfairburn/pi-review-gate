package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterOperationKind
import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.client.ui.SavedRequestStatus
import io.github.rfairburn.pireviewgate.core.client.ui.SavedUiState
import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * Status-only pending feedback for one admitted, still-current user Saved LIST or SEARCH.
 *
 * It changes [SavedUiState.status] and [SavedUiState.readFeedbackBaseStatus] and nothing
 * else: proofs, entries, handles, the query and owner facts pass through untouched, so a
 * queued writer still holding the actual committed Search proof keeps it. The base status
 * keeps every control and layout decision exactly as drawn before the request, so showing
 * pending never swaps, moves or re-arms a control. It never sends, retries, filters or
 * fabricates data. Only the exact correlated read ([OperationKey]) that was accepted
 * fresh for the current picker, and NOT settled inside its own admission step, may show
 * [SavedRequestStatus.Requesting]; its own settlement (projected by the caller) or the
 * replacement of its picker view ends it. Other admissions — older, delayed, for another
 * picker or channel, windows, the post-delete continuation — never touch it. That
 * continuation's own pre-admission display is retired by [SavedRefreshFeedback].
 * Main-confined, like the controller that owns it.
 */
class SavedReadFeedback {
    /** The facts that make one drawn Saved picker the view a read was raised from. */
    data class View(
        val hostId: HostId?,
        val hostRunId: String?,
        val query: String,
        val pickerEpoch: Long,
        val generation: Long?,
        val savedRoute: Boolean,
    )

    private class Tracked(val key: OperationKey, val sequence: Long?, val view: View, val prior: SavedRequestStatus)
    private var tracked: Tracked? = null

    /** The exact read whose pending status is displayed, if any. */
    val pending: OperationKey? get() = tracked?.key

    /**
     * After an ACCEPTED Saved read admission and its correlation lookup. [sequence] is the
     * endpoint's own attempt sequence from the accepting step. [intake] is the picker the
     * user's committed LIST/SEARCH was raised from; `null` for any read this helper does not
     * present. [settledInSameStep] means the real outcome is already in hand and must not
     * be overwritten by pending.
     */
    fun accepted(key: OperationKey, sequence: Long?, intake: View?, settledInSameStep: Boolean,
                 current: View, display: SavedUiState): SavedUiState {
        val next = observe(current, display)
        if (settledInSameStep || intake == null) return next
        if (key.kind != RosterOperationKind.SAVED_LIST && key.kind != RosterOperationKind.SAVED_SEARCH) return next
        // Admission continuations may resume out of endpoint order: only a fresh admission
        // for exactly the current picker and channel is a candidate at all.
        if (intake != current || !current.savedRoute || current.hostRunId == null ||
            key.hostId != current.hostId || key.channelGeneration != current.generation) return next
        val previous = tracked
        if (previous != null && (sequence == null || previous.sequence == null || sequence <= previous.sequence)) return next
        val baseline = next.readFeedbackBaseStatus ?: next.status
        val prior = baseline.takeUnless { it == SavedRequestStatus.Requesting } ?: SavedRequestStatus.Unknown
        tracked = Tracked(key, sequence, current, prior)
        return next.copy(status = SavedRequestStatus.Requesting, readFeedbackBaseStatus = baseline)
    }

    /** Whether a settled read may project into the current picker. Older reads may not. */
    fun projects(key: OperationKey): Boolean {
        val read = tracked ?: return true
        return read.key == key || read.key.hostId != key.hostId
    }

    /** Synchronously retire the pending display when its picker view is no longer current. */
    fun observe(current: View, display: SavedUiState): SavedUiState {
        val read = tracked ?: return display
        if (current == read.view) return display
        tracked = null
        return retire(display, fallback(read, current))
    }

    /** After the caller projected one settled read: its own settlement always ends pending. */
    fun settled(key: OperationKey, current: View, display: SavedUiState): SavedUiState {
        val read = tracked
        if (read == null || read.key != key) return observe(current, display)
        tracked = null
        return retire(display, fallback(read, current))
    }

    /**
     * The same picker that lost only its connection generation, or whose own settlement
     * could not be projected, has an unobservable outcome. A replaced view (query, owner,
     * run, route or reopen) gets back exactly what it displayed before this read.
     */
    private fun fallback(read: Tracked, current: View): SavedRequestStatus =
        if (current.copy(generation = read.view.generation) == read.view) SavedRequestStatus.Unknown else read.prior

    /** End feedback: a pending display falls back; a projected outcome only drops the base. */
    private fun retire(display: SavedUiState, status: SavedRequestStatus): SavedUiState = when {
        display.status == SavedRequestStatus.Requesting -> display.copy(status = status, readFeedbackBaseStatus = null)
        display.readFeedbackBaseStatus != null -> display.copy(readFeedbackBaseStatus = null)
        else -> display
    }

    companion object {
        /**
         * True when one settled read is older than the result the picker already adopted on
         * the same channel. Attempt sequences are per channel generation, so a read on another
         * generation is never compared, and a read without an accepting sequence is not fenced.
         */
        fun olderThanAdopted(sequence: Long?, generation: Long, display: SavedUiState, adoptedGeneration: Long?): Boolean =
            sequence != null && adoptedGeneration == generation && sequence < display.sequence
    }
}

/**
 * Status-only ownership of the one pending display a confirmed post-delete Saved LIST
 * sets synchronously, before that read is admitted.
 *
 * The post-delete continuation deliberately does not go through [SavedReadFeedback]:
 * its display is raised with the continuation, not by a picker-intake admission. When
 * that continuation is canceled — by a query edit, another dialog, leaving the picker,
 * or loss of its owner/window — no request remains current. [observe] then retires only
 * this exact untracked [SavedRequestStatus.Requesting] to [SavedRequestStatus.Unknown] and
 * clears any base status that belonged to it. It never sends, retries, filters, adopts,
 * or fabricates a result, never removes the displayed entries or handles, and never
 * changes a read tracked by [SavedReadFeedback] or any settled status. A replacement
 * read that shows its own pending status always has a non-null [SavedReadFeedback.pending]
 * and keeps it until its own settlement. Main-confined, like the controller that owns it.
 */
class SavedRefreshFeedback {
    private var continuation: RosterUiProof? = null

    /** Register the exact continuation whose one-shot LIST produced its refresh display. */
    fun shown(continuation: RosterUiProof) {
        this.continuation = continuation
    }

    /** The exact read's own live settlement ends this display ownership. */
    fun settled(continuation: RosterUiProof) {
        if (this.continuation === continuation) this.continuation = null
    }

    /**
     * Synchronously retire the pending display when its continuation is no longer
     * current. [trackedRead] is true while [SavedReadFeedback] presents any current
     * read; that read's Requesting is never this helper's to end. A live continuation
     * and every non-Requesting status pass through unchanged.
     */
    fun observe(display: SavedUiState, trackedRead: Boolean): SavedUiState {
        val pending = continuation ?: return display
        if (pending.isStillCurrent()) return display
        continuation = null
        if (trackedRead || display.status != SavedRequestStatus.Requesting) return display
        return display.copy(status = SavedRequestStatus.Unknown, readFeedbackBaseStatus = null)
    }
}

/**
 * Host/channel-scoped ordering watermark for projected Saved read settlements, including
 * non-data outcomes (Unavailable, Refused, Unknown) that leave the displayed result's
 * sequence untouched. A delayed older read's settlement cannot overwrite a newer read's
 * actual answer. Sequences restart per channel generation, so other channels never compare.
 * Main-confined; call only after the current-picker/channel fences, and only for a
 * settlement that will otherwise project: accepting records the new watermark.
 */
class SavedReadSettlementFence {
    private var latest: Pair<OperationKey, Long>? = null

    fun projects(key: OperationKey, sequence: Long?): Boolean {
        if (sequence == null) return true
        val previous = latest
        if (previous != null && previous.first.hostId == key.hostId &&
            previous.first.channelGeneration == key.channelGeneration && sequence < previous.second) return false
        latest = key to sequence
        return true
    }
}
