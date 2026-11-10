package io.github.rfairburn.pireviewgate.core.protocol.roster

/**
 * Every frame the roster metadata lane can carry, as one closed set.
 *
 * One binary channel message carries exactly one complete UTF-8 JSON frame: there
 * is no newline-delimited stream, no partial-frame assembler, and no custom
 * framing layer. A frame that cannot be decoded or encoded within its bound fails
 * closed; it is never split, trimmed, or partially applied.
 *
 * Every transfer of rows is a complete authoritative snapshot of the owner's
 * roster, never a delta: [SnapshotBegin] announces one transfer, sequential
 * [SnapshotPage] frames carry the rows, and [SnapshotEnd] completes it. A revision
 * may jump; only a regression against the same run is invalid.
 *
 * The optional owner exchanges (Close, Create, Rename, Saved) ride the same lane,
 * direction, and authentication, and only when both sides acknowledged their
 * capability. Each is a closed frame set: no payload, error, signal, path, native
 * current file, or owner text can ride along beside them.
 */
sealed interface RosterFrame {

    /** Exact wire spelling of this frame's `type`. */
    val type: String

    /** Viewer's opening offer of service, version, and capabilities. */
    data class Hello(
        val service: String,
        val major: Long,
        val minor: Long,
        val capabilities: List<String>,
    ) : RosterFrame {
        override val type: String get() = "hello"
    }

    /** Owner's narrowed acknowledgement of service, version, and capabilities. */
    data class HelloAck(
        val service: String,
        val major: Long,
        val minor: Long,
        val capabilities: List<String>,
    ) : RosterFrame {
        override val type: String get() = "hello_ack"
    }

    /** Viewer registers the one subscription this channel allows. */
    data class Subscribe(val subscriptionId: String) : RosterFrame {
        override val type: String get() = "subscribe"
    }

    /** Announces one complete snapshot transfer. */
    data class SnapshotBegin(
        val subscriptionId: String,
        val transferId: String,
        val hostRunId: String,
        val revision: Long,
        val totalRows: Long,
        val pageCount: Long,
    ) : RosterFrame {
        override val type: String get() = "snapshot_begin"
    }

    /** One sequential page of the announced transfer. */
    data class SnapshotPage(
        val subscriptionId: String,
        val transferId: String,
        val pageIndex: Long,
        val rows: List<RemoteSessionMetadata>,
    ) : RosterFrame {
        override val type: String get() = "snapshot_page"
    }

    /** Completes one transfer with the revision and honest total it states. */
    data class SnapshotEnd(
        val subscriptionId: String,
        val transferId: String,
        val revision: Long,
        val totalRows: Long,
    ) : RosterFrame {
        override val type: String get() = "snapshot_end"
    }

    /** Viewer stops one subscription. */
    data class Unsubscribe(val subscriptionId: String) : RosterFrame {
        override val type: String get() = "unsubscribe"
    }

    /** Owner confirms one subscription is retired. */
    data class Unsubscribed(val subscriptionId: String) : RosterFrame {
        override val type: String get() = "unsubscribed"
    }

    /**
     * One owner-routed Close request. Every identifier is opaque and bounded and
     * the confirmation is a strict boolean: nothing else is expressible.
     */
    data class CloseRequest(
        val requestId: String,
        val hostRunId: String,
        val rowId: String,
        val confirmed: Boolean,
    ) : RosterFrame {
        override val type: String get() = "close_request"
    }

    /** One fixed owner answer for exactly one request id. */
    data class CloseResult(val requestId: String, val outcome: OwnerCloseFacts) : RosterFrame {
        override val type: String get() = "close_result"
    }

    /**
     * One rowless owner-create request: this owner's exact run, one canonical
     * workspace, and this channel's strictly increasing attempt number. Nothing
     * in it is a row id, a native conversation tuple, a display fact, or a path
     * decision.
     */
    data class CreateRequest(
        val requestId: String,
        val hostRunId: String,
        val workspace: String,
        val sequence: Long,
    ) : RosterFrame {
        override val type: String get() = "create_request"
    }

    /** One fixed owner answer for exactly one request id. */
    data class CreateResult(val requestId: String, val outcome: OwnerCreateFacts) : RosterFrame {
        override val type: String get() = "create_result"
    }

    /**
     * One owner-routed rename of exactly one row of one run, fenced to that row's
     * native conversation tuple. No workspace, path, saved-session file, native
     * current file, agent directory, alias, host, endpoint, selection, viewer,
     * payload, or error can ride along, and no frame here carries or mirrors a
     * previous name.
     */
    data class RenameRequest(
        val requestId: String,
        val hostRunId: String,
        val rowId: String,
        val expectedSessionId: String,
        val expectedSessionEpoch: Long,
        val name: String,
        val sequence: Long,
    ) : RosterFrame {
        override val type: String get() = "rename_request"
    }

    /**
     * One fixed owner answer for exactly one request id. The fact set never
     * carries a name, an id, an epoch, or owner text: a renamed row becomes
     * visible through the owner's next complete authoritative snapshot only.
     */
    data class RenameResult(val requestId: String, val outcome: OwnerRenameFacts) : RosterFrame {
        override val type: String get() = "rename_result"
    }

    /** Fresh Saved catalog listing request. */
    data class SavedListRequest(
        val requestId: String,
        val hostRunId: String,
        val query: String,
        val offset: Long,
        val count: Long,
        val sequence: Long,
    ) : RosterFrame {
        override val type: String get() = "saved_list_request"
    }

    /** Search within one exact owner catalog; replaces the owner's result only. */
    data class SavedSearchRequest(
        val requestId: String,
        val hostRunId: String,
        val catalogId: String,
        val query: String,
        val offset: Long,
        val count: Long,
        val sequence: Long,
    ) : RosterFrame {
        override val type: String get() = "saved_search_request"
    }

    /** Another bounded window of one exact owner result. Never relists. */
    data class SavedWindowRequest(
        val requestId: String,
        val hostRunId: String,
        val catalogId: String,
        val resultId: String,
        val offset: Long,
        val count: Long,
        val sequence: Long,
    ) : RosterFrame {
        override val type: String get() = "saved_window_request"
    }

    /** Resume one entry of one exact owner result. */
    data class SavedResumeRequest(
        val requestId: String,
        val hostRunId: String,
        val catalogId: String,
        val resultId: String,
        val entryId: String,
        val sequence: Long,
    ) : RosterFrame {
        override val type: String get() = "saved_resume_request"
    }

    /** Prepare (`confirmed = false`) or confirm deletion of one exact entry. */
    data class SavedDeleteRequest(
        val requestId: String,
        val hostRunId: String,
        val catalogId: String,
        val resultId: String,
        val entryId: String,
        val confirmed: Boolean,
        val sequence: Long,
    ) : RosterFrame {
        override val type: String get() = "saved_delete_request"
    }

    /** One fixed non-data answer to a list, search, or window request. */
    data class SavedWindowResult(
        val requestId: String,
        val outcome: OwnerSavedWindowOutcome,
    ) : RosterFrame {
        override val type: String get() = "saved_window_result"
    }

    /**
     * Announces one successful window transfer: the exact run, catalog, and
     * result, the FULL result total, the actual offset, the honest number of rows
     * this transfer carries, its page count, and the owner's issue scalar.
     */
    data class SavedWindowBegin(
        val requestId: String,
        val hostRunId: String,
        val catalogId: String,
        val resultId: String,
        val total: Long,
        val issueCount: Long,
        val offset: Long,
        val rows: Long,
        val pageCount: Long,
    ) : RosterFrame {
        override val type: String get() = "saved_window_begin"
    }

    /** One page of entries inside one Saved window transfer. */
    data class SavedWindowPage(
        val requestId: String,
        val pageIndex: Long,
        val entries: List<OwnerSavedEntry>,
    ) : RosterFrame {
        override val type: String get() = "saved_window_page"
    }

    /**
     * One part of ONE entry too large for a single page frame. The concatenated
     * `text` of parts `0 until parts`, sent as consecutive frames, is exactly the
     * canonical JSON encoding of one entry. Each fragment occupies one page index.
     */
    data class SavedWindowFragment(
        val requestId: String,
        val pageIndex: Long,
        val part: Long,
        val parts: Long,
        val text: String,
    ) : RosterFrame {
        override val type: String get() = "saved_window_fragment"
    }

    /** Completes one Saved window transfer with its honest row and page counts. */
    data class SavedWindowEnd(
        val requestId: String,
        val rows: Long,
        val pageCount: Long,
    ) : RosterFrame {
        override val type: String get() = "saved_window_end"
    }

    /** One fixed owner answer to a Saved resume request. */
    data class SavedResumeResult(
        val requestId: String,
        val outcome: OwnerSavedResumeFacts,
    ) : RosterFrame {
        override val type: String get() = "saved_resume_result"
    }

    /** One fixed owner answer to a Saved delete or prepare request. */
    data class SavedDeleteResult(
        val requestId: String,
        val outcome: OwnerSavedDeleteFacts,
    ) : RosterFrame {
        override val type: String get() = "saved_delete_result"
    }

    /**
     * Descriptive owner delete exposure for one exact run. It is never authority
     * and never delete permission.
     */
    data class SavedPolicy(val hostRunId: String, val deleteExposed: Boolean) : RosterFrame {
        override val type: String get() = "saved_policy"
    }

    /**
     * One fixed refusal. [subscriptionId] is present only when the failure belongs
     * to one subscription.
     */
    data class Failure(
        val code: RosterWireErrorCode,
        val subscriptionId: String? = null,
    ) : RosterFrame {
        override val type: String get() = "error"
    }
}
