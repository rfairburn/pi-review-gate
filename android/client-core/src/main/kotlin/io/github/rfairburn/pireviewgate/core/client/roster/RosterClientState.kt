package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire

/**
 * The published, immutable view of one roster client endpoint.
 *
 * Nothing here is a live view of owner state. Rows come only from a complete,
 * validated authoritative snapshot, and the projection honestly distinguishes
 * [RosterProjectionState.EMPTY] (no snapshot has ever completed on this channel)
 * from a complete snapshot that carried zero rows ([RosterProjectionState.CURRENT]
 * with an empty list) and from [RosterProjectionState.STALE] (last-observed rows
 * that must never be presented as current). A lost channel, a refused transfer, a
 * run change, or a stop never clears rows to empty, zero, or idle.
 */

/** Where one roster client endpoint stands in its single-channel lifecycle. */
public enum class RosterClientPhase {
    /** The hello is out and its acknowledgement has not been reviewed yet. */
    AWAITING_ACK,

    /** Negotiated, no subscription outstanding. */
    READY,

    /** One subscription outstanding; its snapshots may be staged and published. */
    SUBSCRIBED,

    /** Terminal: handshake refused, timed out, or a protocol failure ended it. */
    FAILED,

    /** Terminal: the channel is gone or this endpoint was stopped and detached. */
    DETACHED,
}

/** Whether the published rows are authoritative now, known to be absent, or merely last seen. */
public enum class RosterProjectionState { EMPTY, CURRENT, STALE }

/**
 * Why the projection is not current. Local diagnostic only; it never carries owner
 * content, a frame, a row, a path, or exception text.
 */
public enum class RosterStalenessReason {
    SUBSCRIBING,
    HANDSHAKE_REFUSED,
    HANDSHAKE_TIMEOUT,
    SOURCE_UNAVAILABLE,
    AUTHORIZATION_REFUSED,
    RUN_CHANGED,
    TRANSFER_FAILED,
    REVISION_REGRESSION,
    PROTOCOL_VIOLATION,
    CHANNEL_CLOSED,
    STOPPED,
    OWNER_ERROR,
}

/**
 * The owner's described delete exposure for one exact run.
 *
 * It is a description, never authority and never delete permission: the owner
 * re-checks its own live policy on every delete. `null` in
 * [RosterClientState.savedPolicy] means unknown — initially, and again whenever a
 * subscription or the channel ends — and unknown keeps delete hidden.
 */
public data class RosterSavedPolicy(
    public val hostRunId: String,
    public val deleteExposed: Boolean,
)

/** The published roster projection of exactly one owner. */
public data class RosterProjection(
    public val state: RosterProjectionState,
    /**
     * Rows of the last complete snapshot. In [RosterProjectionState.STALE] these
     * are last-observed only; in [RosterProjectionState.EMPTY] no snapshot has ever
     * completed, which is a different fact from a complete zero-row snapshot.
     */
    public val rows: List<RemoteSessionMetadata>,
    /** Owner run identity of the published snapshot, or `null` when none was published. */
    public val hostRunId: String?,
    /** Revision of the published snapshot, or `null` when none was published. */
    public val revision: Long?,
    /** Subscription that produced the published snapshot. */
    public val subscriptionId: String?,
    public val reason: RosterStalenessReason?,
) {
    public companion object {
        /** The state before any hello: nothing observed, and honestly so. */
        public val EMPTY: RosterProjection = RosterProjection(
            state = RosterProjectionState.EMPTY,
            rows = emptyList(),
            hostRunId = null,
            revision = null,
            subscriptionId = null,
            reason = null,
        )
    }
}

/** The kind of one submitted remote operation. */
public enum class RosterOperationKind {
    CLOSE,
    CREATE,
    RENAME,
    SAVED_LIST,
    SAVED_SEARCH,
    SAVED_WINDOW,
    SAVED_RESUME,
    SAVED_DELETE,
    ;

    /** True for the three read shapes; a resume or delete is never superseded. */
    public val isSavedRead: Boolean
        get() = this == SAVED_LIST || this == SAVED_SEARCH || this == SAVED_WINDOW

    /** True for every Saved shape. */
    public val isSaved: Boolean
        get() = this == SAVED_LIST || this == SAVED_SEARCH || this == SAVED_WINDOW ||
            this == SAVED_RESUME || this == SAVED_DELETE
}

/**
 * One operation this endpoint has submitted and not yet settled.
 *
 * It exists so a caller can render honest busy state and correlate a settlement
 * event. It is never a queue: a refused mutation is reported as never submitted and
 * is retained nowhere.
 */
public data class RosterPendingOperation(
    public val kind: RosterOperationKind,
    public val requestId: String,
    public val hostRunId: String,
    public val rowId: String? = null,
    public val catalogId: String? = null,
    public val resultId: String? = null,
    public val entryId: String? = null,
    /** The channel's monotonic attempt number this operation owns, when the wire carries one. */
    public val sequence: Long? = null,
    /** Local requester patience only: exceeding it settles `unknown` and never retries. */
    public val deadlineAtMs: Long,
    /** Entries staged so far in one in-flight Saved window; nothing here is published early. */
    public val stagedWindowEntries: Long? = null,
    /** Exact accepting Saved picker revision, including entry mutations. */
    public val savedPickerRevision: Long? = null,
    /** True only for an admitted confirmed delete, false for prepare, otherwise null. */
    public val savedDeleteConfirmed: Boolean? = null,
)

/**
 * A staged, never-published roster snapshot transfer.
 *
 * Exposed for honest "loading" presentation only: a partial transfer is never
 * applied to the projection, and the rows staged inside it are not published here.
 */
public data class RosterInFlightTransfer(
    public val subscriptionId: String,
    public val transferId: String,
    public val hostRunId: String,
    public val revision: Long,
    public val totalRows: Long,
    public val pageCount: Long,
    public val rowsReceived: Long,
    public val pagesReceived: Long,
)

/**
 * One completed Saved window this endpoint owns on behalf of the picker.
 *
 * [entryIds] are the only entry handles this window makes available: a Resume or
 * Delete for an entry no owned window carries is refused here rather than sent on
 * the strength of a string that happens to match a caller-supplied proof. The ids
 * are opaque owner handles; the endpoint never resolves them, and the entry's
 * display strings stay presentation-only.
 */
public data class RosterSavedWindowHandle(
    public val catalogId: String,
    public val resultId: String,
    public val offset: Long,
    public val total: Long,
    public val issueCount: Long,
    /** The picker revision this window was fetched for; a newer picker obsoletes it. */
    public val pickerRevision: Long,
    public val entryIds: List<String>,
)

/**
 * The bounded Saved ownership state for one owner run.
 *
 * At most [MAX_RETAINED_SAVED_WINDOWS] windows are retained, least recently
 * completed first, and they are bound to the current catalog and result: a fresh
 * list replaces the catalog and the result, a search replaces the result only, and
 * either one invalidates the handles that no longer belong to what the picker is
 * actually showing. This is a handle-validity boundary, not a cache of owner
 * content and not offline history: the owner remains authoritative and re-checks
 * every request it does receive.
 */
public data class RosterSavedOwnership(
    public val hostRunId: String,
    public val catalogId: String,
    public val resultId: String,
    /** The picker revision the current catalog/result was last fetched for. */
    public val pickerRevision: Long,
    public val windows: List<RosterSavedWindowHandle>,
) {
    public companion object {
        /** Windows retained at once; the oldest is evicted by the next completed window. */
        public const val MAX_RETAINED_SAVED_WINDOWS: Int = 3
    }
}

/** Exact local ownership reference/intent to withdraw; delayed cleanup cannot clear a replacement. */
public data class RosterSavedPickerScope(
    public val generation: Long,
    public val ownership: RosterSavedOwnership?,
    public val pendingRequestId: String?,
)

/** The complete immutable state of one endpoint, as of the last step. */
public data class RosterClientState(
    /** This side's local presentation and action handle for one configured host. Never a wire value. */
    public val hostId: String,
    /** Monotonic identity of this endpoint's channel attempt; a fresh attempt never inherits. */
    public val generation: Long,
    public val phase: RosterClientPhase,
    public val projection: RosterProjection,
    public val subscriptionId: String?,
    /** Owner run pinned for the live subscription; another run is adoptable only across a fresh subscription. */
    public val subscriptionRunId: String?,
    /** What the owner acknowledged for this channel. Read-only, and never widens this side's assumptions. */
    public val capabilities: List<String>,
    /** Described owner delete policy for the current run; `null` is unknown and keeps delete hidden. */
    public val savedPolicy: RosterSavedPolicy?,
    /** Owned Saved catalog, result, and window handles for the current run; `null` when none. */
    public val savedOwnership: RosterSavedOwnership?,
    public val pending: List<RosterPendingOperation>,
    public val inFlightTransfer: RosterInFlightTransfer?,
    /** Subscription whose `unsubscribe` is outstanding and unconfirmed. */
    public val retiringSubscriptionId: String?,
    /** Terminal stop intent, recorded synchronously so no continuation can resubscribe. */
    public val stopRequested: Boolean,
    /** Channel anti-replay high-water marks. Advanced once per attempt, never rewound or reused. */
    public val createSequence: Long,
    public val renameSequence: Long,
    public val savedSequence: Long,
    /**
     * Rows for which this owner answered `confirmation-required`, so the next
     * deliberate close may be confirmed. It arms nothing: no dialog, no send, and
     * no automatic follow-up happens from this endpoint.
     */
    public val armedCloseConfirmationRows: List<String>,
) {
    /** True only when this owner acknowledged the optional Close exchange. */
    public val supportsClose: Boolean get() = capabilities.contains(RosterWire.CLOSE_CAPABILITY)

    /** True only when this owner acknowledged the optional rowless create exchange. */
    public val supportsCreate: Boolean get() = capabilities.contains(RosterWire.CREATE_CAPABILITY)

    /** True only when this owner acknowledged the optional rename exchange. */
    public val supportsRename: Boolean get() = capabilities.contains(RosterWire.RENAME_CAPABILITY)

    /** True only when this owner acknowledged the optional Saved catalog exchange. */
    public val supportsSaved: Boolean get() = capabilities.contains(RosterWire.SAVED_CAPABILITY)

    /**
     * True only when rows on this channel may carry the optional bounded
     * `rosterSlotId` field. Presentation metadata only: the owner run plus the
     * row's own id stay the only selection, input, and action identity.
     */
    public val supportsRosterSlot: Boolean get() = capabilities.contains(RosterWire.ROSTER_SLOT_CAPABILITY)
}
