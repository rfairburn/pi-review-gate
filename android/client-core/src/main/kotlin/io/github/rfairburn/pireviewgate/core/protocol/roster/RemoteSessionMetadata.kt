package io.github.rfairburn.pireviewgate.core.protocol.roster

/**
 * Inert remote roster row: the display-oriented projection of one owner session
 * that a remote sidebar can render like a local row.
 *
 * Unknown and absent observations stay `null`: they are never coerced to zero,
 * `false`, or idle. Private owner data (agent and account directories,
 * credentials, provider or environment records, prompts, transcripts, question
 * bodies, hidden properties, the native current file, and process or output
 * bytes) is not expressible in this schema, and an unknown key is refused rather
 * than passed through.
 *
 * In this model an absent optional field and a field the owner sent as `null`
 * are the same honest absence, which is exactly how the source decoder treats
 * `exitCode: null`, `error: null`, and `rosterSlotId: null`.
 */

/** Owner-reported lifecycle of one session. */
enum class RosterLifecycle(val wireName: String) {
    STARTING("starting"),
    ALIVE("alive"),
    EXITED("exited"),
    ERROR("error"),
    ;

    companion object {
        fun fromWireName(value: String): RosterLifecycle? = entries.firstOrNull { it.wireName == value }
    }
}

/** How the owner's native conversation is persisted, when the owner knows. */
enum class RemoteNativePersistence(val wireName: String) {
    SAVED("saved"),
    UNSAVED("unsaved"),
    UNKNOWN("unknown"),
    ;

    companion object {
        fun fromWireName(value: String): RemoteNativePersistence? = entries.firstOrNull { it.wireName == value }
    }
}

/** Canonical native conversation identity that may cross the roster boundary. */
data class RemoteNativeSession(
    val sessionId: String,
    /** Positive and monotonic across session changes and reporter reloads. */
    val epoch: Long,
    /** Canonical stored name, otherwise the native first-message fallback. */
    val name: String,
    val persistence: RemoteNativePersistence? = null,
)

/**
 * Display-only roster row for one remote session.
 *
 * @property id Stable row id. Opaque and bounded; data, never a path.
 * @property rosterSlotId The owner's durable sidebar roster slot for this row,
 *   present only when the owner has one for that row and the peer negotiated
 *   [RosterWire.ROSTER_SLOT_CAPABILITY]. Placement metadata only: it never
 *   replaces [id] as the selection, input, or action identity, and it is never
 *   matched against a label, path, or conversation.
 * @property workspace Exact owner-side workspace path; never resolved,
 *   rewritten, filtered, or redacted.
 * @property hasLiveProcess True only while the owner still owns a live native process handle.
 * @property busy `null` means unknown; never rendered as `false` or idle.
 * @property pendingInput `null` means unknown; never rendered as `false`.
 * @property activity Generic top-level activity lines, unchanged from the owner observation.
 * @property nativeSession Canonical native identity, or `null` when the owner
 *   reports no native conversation. Never carries a current file.
 * @property backgroundTasks Observed OWNERSHIP count; `null` means unknown, never zero.
 * @property backgroundShells Observed OWNERSHIP count; `null` means unknown, never zero.
 * @property activeTasks Observed ACTIVITY-INTENT count, independent of the ownership pair.
 * @property activeShells Observed ACTIVITY-INTENT count, independent of the ownership pair.
 * @property exitCode Present only when the owner observed a finite exit code.
 * @property error Bounded, terminal-safe, redacted diagnostic text; absent when none.
 */
data class RemoteSessionMetadata(
    val id: String,
    val label: String,
    val workspace: String,
    val lifecycle: RosterLifecycle,
    val hasLiveProcess: Boolean,
    val inputSurface: Boolean,
    val rosterSlotId: String? = null,
    val busy: Boolean? = null,
    val pendingInput: Boolean? = null,
    val activity: List<String> = emptyList(),
    val nativeSession: RemoteNativeSession? = null,
    val backgroundTasks: Long? = null,
    val backgroundShells: Long? = null,
    val activeTasks: Long? = null,
    val activeShells: Long? = null,
    val exitCode: Double? = null,
    val error: String? = null,
)
