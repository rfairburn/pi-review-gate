package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry
import io.github.rfairburn.pireviewgate.core.protocol.roster.SavedDeleteRefusalReason
import io.github.rfairburn.pireviewgate.core.protocol.roster.SavedWindowRefusalReason

/**
 * One owner this client can address for a Saved or Create request.
 *
 * It is a projection of the saved association plus the live connection facts, so the
 * picker can say truthfully what choosing it means — including whether that owner
 * can actually take the operation now. [createEligible] is the controller's own
 * answer: connected on this connection *and* create positively acknowledged. An
 * unknown capability is never eligible, and eligibility is never inferred from a
 * label, a history flag, or another host.
 *
 * Choosing a disconnected owner is allowed and stays chosen: the UI never silently
 * falls back to another host, and it never dials anything on the operator's behalf.
 */
public data class OwnerChoice(
    public val hostId: HostId,
    public val label: String,
    public val endpointDisplayText: String,
    public val connection: HostConnectionState,
    public val createEligible: Boolean = false,
)

/**
 * One frozen Saved owner address for a request that has no result yet.
 *
 * It names the exact owner run the drawn screen was showing, so a later change of
 * selection cannot retarget a request that was already raised.
 */
public data class SavedOwnerTarget(
    public val hostId: HostId,
    public val hostRunId: String,
)

/**
 * One frozen Saved result the drawn window belongs to.
 *
 * Every handle the drawn screen was showing is carried, together with the request id
 * and sequence the owner answered, so a "load more" raised from one result can never
 * be resolved against a replacement result that arrived on the same host in the
 * meantime. A mismatch is refused, not re-resolved.
 */
public data class SavedResultTarget(
    public val hostId: HostId,
    public val hostRunId: String,
    public val catalogId: String,
    public val resultId: String,
    public val requestId: String? = null,
    public val sequence: Long,
) {
    public companion object {
        /**
         * Freeze the result the drawn view belongs to, or `null` when any handle is
         * missing. No fallback is invented: a window the view cannot fully address
         * gets no request rather than a request guessed from the latest selection.
         */
        public fun of(state: SavedUiState): SavedResultTarget? {
            val hostId = state.selectedHostId ?: return null
            val hostRunId = state.hostRunId ?: return null
            val catalogId = state.catalogId ?: return null
            val resultId = state.resultId ?: return null
            return SavedResultTarget(
                hostId = hostId,
                hostRunId = hostRunId,
                catalogId = catalogId,
                resultId = resultId,
                requestId = state.requestId,
                sequence = state.sequence,
            )
        }
    }
}

/** Status of the Saved list, search, or window request the screen is showing. */
public sealed interface SavedRequestStatus {
    /** Nothing has been asked for yet. */
    public data object Idle : SavedRequestStatus

    /** A request is in flight. Never implies a result. */
    public data object Requesting : SavedRequestStatus

    /** The owner answered with a result. */
    public data object Ready : SavedRequestStatus

    /** The owner refused before producing data. [reason] may itself be absent. */
    public data class Refused(public val reason: SavedWindowRefusalReason? = null) : SavedRequestStatus

    /** The owner has no usable catalog view for this request. */
    public data object Unavailable : SavedRequestStatus

    /** Unobservable: nothing is established, and nothing is replayed. */
    public data object Unknown : SavedRequestStatus
}

/** Status of one Saved delete prepare, which removes nothing. */
public sealed interface SavedDeletePreparationStatus {
    /** A prepare is in flight. */
    public data object Preparing : SavedDeletePreparationStatus

    /** The owner is asking for a deliberate confirmation before it would remove anything. */
    public data object ConfirmationRequired : SavedDeletePreparationStatus

    /** The owner refused before any removal. */
    public data class Refused(public val reason: SavedDeleteRefusalReason) : SavedDeletePreparationStatus

    /** The owner could not answer. */
    public data object Unavailable : SavedDeletePreparationStatus

    /** Unobservable: nothing is established either way. */
    public data object Unknown : SavedDeletePreparationStatus
}

/**
 * One Saved catalog browser view.
 *
 * The only request authority here is the owner's own opaque handles: [hostRunId],
 * [catalogId], [resultId], and the per-entry id inside [entries]. [OwnerSavedEntry.file]
 * and [OwnerSavedEntry.cwd] are the owner's display strings and are display-only —
 * this client never resolves, opens, lists, or completes a path, and it never turns
 * a displayed path into a request.
 *
 * [total] is the FULL result total the owner stated, and [offset] is the actual
 * offset of the first entry on screen. Both stay `null` when the owner did not say,
 * which is why [hasMore] is three-valued: an unknown total never becomes a
 * first-page-only list that silently clips the rest.
 *
 * [query] is the operator's search draft. It is UI-owned text, not an owner fact.
 */
public data class SavedUiState(
    public val selectedHostId: HostId? = null,
    public val status: SavedRequestStatus = SavedRequestStatus.Idle,
    public val hostRunId: String? = null,
    public val catalogId: String? = null,
    public val resultId: String? = null,
    public val requestId: String? = null,
    public val sequence: Long = 0L,
    public val total: Long? = null,
    public val issueCount: Long? = null,
    public val offset: Long = 0L,
    public val entries: List<OwnerSavedEntry> = emptyList(),
    public val transferComplete: Boolean = false,
    public val query: String = "",
    public val deletePreparation: SavedDeletePreparation? = null,
    /**
     * Commit proof for requesting a fresh listing of [selectedHostId] with [query].
     *
     * Saved reads are owner operations, so every one of them — listing, searching,
     * the next window, a resume, a delete preparation — is attributed to a proof the
     * controller minted for that exact target and frame, not to a token the screen
     * could invent. `null` means none was minted and the control stays disabled.
     */
    public val listProof: UiActionProof? = null,
    /** Commit proof for requesting another window of the exact result shown. */
    public val windowProof: UiActionProof? = null,
    /** Commit proofs for the controls of individual entries, keyed by entry handle. */
    public val entryProofs: Map<SavedEntryKey, SavedEntryControlProofs> = emptyMap(),
    /**
     * The status drawn before an admitted user read began showing [SavedRequestStatus.Requesting],
     * kept only while that feedback is shown. Control and layout presentation keep following it,
     * so pending feedback alone never swaps, moves or re-arms a drawn control. `null` otherwise.
     */
    public val readFeedbackBaseStatus: SavedRequestStatus? = null,
) {
    /** True when the owner stated a total and more rows exist beyond what is shown. */
    public val hasMore: Boolean?
        get() = total?.let { offset + entries.size.toLong() < it }

    /** Rows shown so far, as the owner's own offset plus what is on screen. */
    public val shownThrough: Long get() = offset + entries.size.toLong()

    /** True when the opaque handles needed for another window or a resume exist. */
    public val canAddressOwnerResult: Boolean
        get() = selectedHostId != null && hostRunId != null && catalogId != null && resultId != null

    /** The proofs minted for one entry's controls, or none. */
    public fun proofsFor(key: SavedEntryKey): SavedEntryControlProofs =
        entryProofs[key] ?: SavedEntryControlProofs()

    public companion object {
        /** Nothing selected and nothing asked. */
        public val EMPTY: SavedUiState = SavedUiState()
    }
}

/**
 * The four owner handles naming one Saved entry, without its display caption.
 *
 * It is the key for per-entry proofs: a caption is display text and must not decide
 * which proof a control uses, while these handles are exactly the scope an entry
 * action is bounded to.
 */
public data class SavedEntryKey(
    public val hostRunId: String,
    public val catalogId: String,
    public val resultId: String,
    public val entryId: String,
) {
    public companion object {
        /** The key of one frozen entry target, or `null` when a handle is missing. */
        public fun of(target: SavedEntryTarget): SavedEntryKey =
            SavedEntryKey(target.hostRunId, target.catalogId, target.resultId, target.entryId)
    }
}

/**
 * The proofs minted for one entry's controls.
 *
 * Resume and delete preparation are separate actions on the same entry, so they carry
 * separate proofs: retiring one confirmation must not silently retire the operator's
 * standing to resume, and vice versa.
 */
public data class SavedEntryControlProofs(
    public val resume: UiActionProof? = null,
    public val deletePrepare: UiActionProof? = null,
)

/**
 * One frozen Saved entry a resume or delete addresses.
 *
 * [entryId] is the owner's opaque handle and the only entry authority. [caption] is
 * the owner's own display string, frozen when the control was drawn, so a
 * confirmation names the entry the operator looked at instead of whatever a later
 * transfer moved into that position.
 */
public data class SavedEntryTarget(
    public val hostId: HostId,
    public val hostRunId: String,
    public val catalogId: String,
    public val resultId: String,
    public val entryId: String,
    public val caption: String,
) {
    public companion object {
        /**
         * Freeze one entry, or `null` when the surrounding view does not carry the
         * owner handles this request needs. No fallback is invented: an entry with
         * no addressable result cannot be resumed or deleted from here.
         */
        public fun of(state: SavedUiState, entry: OwnerSavedEntry): SavedEntryTarget? {
            val result = SavedResultTarget.of(state) ?: return null
            return SavedEntryTarget(
                hostId = result.hostId,
                hostRunId = result.hostRunId,
                catalogId = result.catalogId,
                resultId = result.resultId,
                entryId = entry.entryId,
                caption = entry.caption,
            )
        }
    }
}

/**
 * One in-flight delete prepare for one frozen entry.
 *
 * A prepare removes nothing; it is how the owner says whether a deliberate
 * confirmation would even be entertained. The confirmation that follows is a second,
 * separately committed control.
 */
public data class SavedDeletePreparation(
    public val target: SavedEntryTarget,
    public val status: SavedDeletePreparationStatus,
)

/**
 * Whether another Saved window may be requested.
 *
 * Unknown means the owner did not state a total, so the UI must not claim there is
 * nothing more; it simply has no basis to ask. A request already in flight also
 * blocks, because this lane carries one transfer at a time.
 */
public enum class SavedMoreDecision {
    MAY_REQUEST,
    NOTHING_MORE,
    UNKNOWN_TOTAL,
    REQUEST_IN_FLIGHT,
}

/** The honest decision for the "load more" control. */
public fun SavedUiState.moreDecision(): SavedMoreDecision = when {
    (readFeedbackBaseStatus ?: status) == SavedRequestStatus.Requesting -> SavedMoreDecision.REQUEST_IN_FLIGHT
    hasMore == null -> SavedMoreDecision.UNKNOWN_TOTAL
    hasMore == true -> SavedMoreDecision.MAY_REQUEST
    else -> SavedMoreDecision.NOTHING_MORE
}
