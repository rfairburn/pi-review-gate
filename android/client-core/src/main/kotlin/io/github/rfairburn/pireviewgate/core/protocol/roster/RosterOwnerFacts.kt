package io.github.rfairburn.pireviewgate.core.protocol.roster

/**
 * The fixed fact sets an owner reports back, and the opaque entry shape of one
 * Saved catalog row.
 *
 * Each fact set is only what the owner could positively observe, and none of them
 * is a retry, reconnect, replay, or resubmit instruction. No raw error, payload,
 * path, signal, or exception text is expressible in any of them, and none of them
 * carries authority: an owner outcome never creates, selects, focuses, removes,
 * or renames anything on this side. Only a later complete authoritative roster
 * snapshot changes what this side sees.
 */

/** The fixed facts one owner close established. */
enum class OwnerCloseFacts(val wireName: String) {
    /** This owner's manager confirmed removing the row. */
    REMOVED("removed"),
    /** An actually observed exit on a row the owner cleanly refused to remove. */
    STOPPED_RETAINED("stopped-retained"),
    /** The row is not positively idle, so the owner's stop ladder never started. */
    CONFIRMATION_REQUIRED("confirmation-required"),
    /** The bounded ladder ended without an observed exit; state is unconfirmed. */
    UNCONFIRMED("unconfirmed"),
    /** Nothing was stopped, signalled, or removed, positively established before any stop. */
    REFUSED("refused"),
    /** This row already has an in-flight close; nothing was re-signalled or queued. */
    BUSY("busy"),
    /** Unobservable: neither removal nor retention is established. */
    UNKNOWN("unknown"),
    ;

    companion object {
        fun fromWireName(value: String): OwnerCloseFacts? = entries.firstOrNull { it.wireName == value }
    }
}

/** The fixed facts one owner create established. */
sealed interface OwnerCreateFacts {
    /**
     * This owner's manager created a row in THIS run that is alive with a live
     * process in the owner's own post-create inventory. Nothing is claimed about
     * focus, activation, selection, display, or native conversation state.
     */
    data class Started(val hostRunId: String, val rowId: String) : OwnerCreateFacts

    /** The create was addressed and nothing usable came up. */
    data object Unconfirmed : OwnerCreateFacts

    /** Nothing was created, positively established before any create was invoked. */
    data object Refused : OwnerCreateFacts

    /** Unobservable: neither a child nor its absence is established. */
    data object Unknown : OwnerCreateFacts
}

/** The fixed facts one owner rename established. None carries a name. */
enum class OwnerRenameFacts(val wireName: String) {
    /** The owner's verified rename authority confirmed the stored name for the named tuple. */
    RENAMED("renamed"),
    /** The row's live native conversation is no longer the tuple the request named. */
    STALE_SESSION("stale-session"),
    /** Nothing was renamed, positively established before any rename was addressed. */
    REFUSED("refused"),
    /** The native operation or this channel's rename slot is busy; nothing was queued. */
    BUSY("busy"),
    /** Unobservable: the name may or may not have changed. */
    UNKNOWN("unknown"),
    ;

    companion object {
        fun fromWireName(value: String): OwnerRenameFacts? = entries.firstOrNull { it.wireName == value }
    }
}

/** Fixed reasons a Saved window request was refused before any data was produced. */
enum class SavedWindowRefusalReason(val wireName: String) {
    ADMISSION("admission"),
    DUPLICATE("duplicate"),
    STALE("stale"),
    BUSY("busy"),
    RANGE("range"),
    UNREPRESENTABLE("unrepresentable"),
    ;

    companion object {
        fun fromWireName(value: String): SavedWindowRefusalReason? = entries.firstOrNull { it.wireName == value }
    }
}

/** Fixed reasons a Saved resume was refused before any native resume was invoked. */
enum class SavedResumeRefusalReason(val wireName: String) {
    ADMISSION("admission"),
    DUPLICATE("duplicate"),
    STALE("stale"),
    POLICY("policy"),
    BUSY("busy"),
    ;

    companion object {
        fun fromWireName(value: String): SavedResumeRefusalReason? = entries.firstOrNull { it.wireName == value }
    }
}

/** Fixed reasons a Saved delete was refused before anything was trashed or unlinked. */
enum class SavedDeleteRefusalReason(val wireName: String) {
    ADMISSION("admission"),
    DUPLICATE("duplicate"),
    STALE("stale"),
    POLICY("policy"),
    BUSY("busy"),
    ACTIVE("active"),
    ;

    companion object {
        fun fromWireName(value: String): SavedDeleteRefusalReason? = entries.firstOrNull { it.wireName == value }
    }
}

/** How the owner removed one saved item. */
enum class SavedDeleteMethod(val wireName: String) {
    TRASH("trash"),
    UNLINK("unlink"),
    ;

    companion object {
        fun fromWireName(value: String): SavedDeleteMethod? = entries.firstOrNull { it.wireName == value }
    }
}

/**
 * One non-data answer to a Saved list, search, or window request.
 *
 * `refused` carries an optional fixed reason: the owner may answer a refusal with
 * no reason at all, and that is a different (narrower) statement than naming one.
 */
sealed interface OwnerSavedWindowOutcome {
    data class Refused(val reason: SavedWindowRefusalReason? = null) : OwnerSavedWindowOutcome

    /** The owner has no usable catalog view for this request. */
    data object Unavailable : OwnerSavedWindowOutcome

    /** Unobservable: nothing is established and nothing is replayed. */
    data object Unknown : OwnerSavedWindowOutcome
}

/** Fixed Saved resume facts. */
sealed interface OwnerSavedResumeFacts {
    /** The owner's native resume path started one row in the named owner run. */
    data class Started(val hostRunId: String, val rowId: String) : OwnerSavedResumeFacts

    /** A positive pre-invocation refusal. */
    data class Refused(val reason: SavedResumeRefusalReason) : OwnerSavedResumeFacts

    /** A resume was addressed and nothing usable came up. */
    data object Unconfirmed : OwnerSavedResumeFacts

    /** Unobservable: nothing is established either way. */
    data object Unknown : OwnerSavedResumeFacts
}

/** Fixed Saved delete facts. */
sealed interface OwnerSavedDeleteFacts {
    /** Answers a prepare (or an unconfirmed request) and removes nothing. */
    data object ConfirmationRequired : OwnerSavedDeleteFacts

    /** The owner removed the entry by the named method. */
    data class Deleted(val method: SavedDeleteMethod) : OwnerSavedDeleteFacts

    /** A positive pre-removal decision. */
    data class Refused(val reason: SavedDeleteRefusalReason) : OwnerSavedDeleteFacts

    /** A removal was addressed and its outcome could not be confirmed. */
    data object Unconfirmed : OwnerSavedDeleteFacts

    /** Unobservable: neither removal nor retention is established. */
    data object Unknown : OwnerSavedDeleteFacts
}

/**
 * One Saved catalog entry: the opaque owner-minted operation handle plus exactly
 * the owner's native Saved display strings.
 *
 * [entryId] is the only entry handle a request may name. [sessionId], [file],
 * [caption], and [cwd] are the owner's own row values, preserved exactly: this
 * contract adds no clipping, hiding, or path rule of its own. They are never
 * request authority — a viewer never resolves, opens, or interprets them, and the
 * owner alone maps an entry id back to its own row and file under its own guards.
 */
data class OwnerSavedEntry(
    val entryId: String,
    val sessionId: String,
    val file: String,
    val caption: String,
    val cwd: String,
) {
    companion object {
        /** The closed entry key set, in canonical wire order. */
        val KEYS: List<String> = listOf("entryId", "sessionId", "file", "caption", "cwd")
    }
}
