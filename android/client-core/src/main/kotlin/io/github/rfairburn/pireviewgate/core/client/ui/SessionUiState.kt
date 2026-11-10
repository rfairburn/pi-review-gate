package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationIdentity
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle

/**
 * Observed agent activity of one ALIVE row.
 *
 * The four values are exhaustive and [UNKNOWN] is a real answer: it means the
 * observations this client holds do not settle the question, and it is never
 * rendered as idle. Activity is derived only from owner-reported facts, never from
 * terminal traffic.
 */
public enum class AgentActivity {
    /** `busy` is true, or a positive activity-intent count was observed. */
    RUNNING,

    /** Not running, but input is pending or an input surface is open. */
    WAITING,

    /** Positively idle: not busy, no pending input, and both activity-intent counts are zero. */
    IDLE,

    /** The observations do not settle it. Never collapsed into [IDLE]. */
    UNKNOWN,
}

/** Observed input state of one row, kept separate from [AgentActivity]. */
public enum class InputObservation {
    /** Input is pending, or the owner reports an open input surface. */
    PENDING,

    /** The owner positively reported no pending input. */
    NONE,

    /** The owner did not report this fact. */
    UNKNOWN,
}

/**
 * One remote session row in the client's own view, qualified by the host it came from.
 *
 * [metadata] is the owner's row unchanged — the same [RemoteSessionMetadata] the
 * roster lane decoded, so every current field (label, workspace, lifecycle, live
 * process, busy, pending input, input surface, activity lines, native identity and
 * its persistence, ownership counts, activity-intent counts, exit code, error, and
 * roster slot) stays accessible to the native details expansion. This type adds no
 * field of its own and rewrites nothing.
 *
 * [hostId] and [hostRunId] qualify the row: two owners may report the same
 * [RemoteSessionMetadata.id], and they stay distinct rows because their host and
 * run differ. Nothing here is ever keyed by label or workspace.
 *
 * [stale] is true when this row came from a view the client is no longer being fed.
 * A stale row is still drawn, and it is always labelled stale: its activity is
 * never re-derived, guessed, or refreshed from terminal output.
 *
 * [rosterRevision] is the owner revision of the snapshot this row came from, so a
 * frozen action target can record what was on screen without consulting a live
 * store later.
 */
public data class SessionUiState(
    public val hostId: HostId,
    public val hostLabel: String,
    public val hostRunId: String,
    public val stale: Boolean,
    public val rosterRevision: Long,
    public val metadata: RemoteSessionMetadata,
    /**
     * The written row's own commit proof, or `null` when none was minted.
     *
     * Selecting this row for the terminal is an operation the controller must be able
     * to attribute to a frame the operator saw, so the proof travels with the row
     * rather than being manufactured from the decoded roster or from where the UI
     * happens to be. Withholding it simply disables the action.
     */
    public val selectProof: UiActionProof? = null,
) {
    /** The owner's row id. Never a path, and never unique across hosts on its own. */
    public val rowId: String get() = metadata.id

    /** Canonical title: the owner's native conversation name, else the row label. */
    public val displayTitle: String get() = metadata.nativeSession?.name ?: metadata.label

    /** Agent activity for an ALIVE row; `null` for any other lifecycle. */
    public val agentActivity: AgentActivity? get() = classifyAgentActivity(metadata)

    /** Observed input state, independent of [agentActivity]. */
    public val inputObservation: InputObservation get() = classifyInputObservation(metadata)

    /**
     * This row's presentation-order identity, or `null` when it cannot be named.
     *
     * The source precedence rule applies unchanged: a reported durable roster slot is
     * authoritative and a malformed slot is refused rather than quietly replaced by a
     * guessed runtime identity; only a row with no slot at all takes the legacy
     * `[hostRunId, rowId]` runtime identity. Reordering is addressed by this identity
     * and never by a label, a position in a list, or a row id alone.
     */
    public val presentationIdentity: RemotePresentationIdentity?
        get() = metadata.rosterSlotId?.let { RemotePresentationIdentity.slot(hostId, it) }
            ?: RemotePresentationIdentity.legacyRuntime(hostId, hostRunId, rowId)
}

/**
 * Truthful activity classification of one ALIVE row.
 *
 * `busy == true`, or a positive activity-intent count, means running. Otherwise a
 * pending input or an open input surface means waiting. Otherwise idle requires the
 * complete positive observation: `busy == false`, `pendingInput == false`, and both
 * activity-intent counts present and zero. Anything else is unknown, which includes
 * a missing count: an absent count is never read as zero.
 *
 * Returns `null` for a row whose lifecycle is not ALIVE: lifecycle and activity are
 * different facts and a starting, exited, or errored row has no agent activity to
 * classify.
 */
public fun classifyAgentActivity(metadata: RemoteSessionMetadata): AgentActivity? {
    if (metadata.lifecycle != RosterLifecycle.ALIVE) return null
    val activeTasks = positiveCount(metadata.activeTasks)
    val activeShells = positiveCount(metadata.activeShells)
    if (metadata.busy == true || (metadata.activeTasks ?: 0L) > 0L || (metadata.activeShells ?: 0L) > 0L) {
        return AgentActivity.RUNNING
    }
    if (metadata.pendingInput == true || metadata.inputSurface) return AgentActivity.WAITING
    return if (
        metadata.busy == false &&
        metadata.pendingInput == false &&
        activeTasks == 0L &&
        activeShells == 0L
    ) {
        AgentActivity.IDLE
    } else {
        AgentActivity.UNKNOWN
    }
}

/**
 * Truthful input observation of one row.
 *
 * Lifecycle and input are reported separately by the owner, so this stays
 * independent of [classifyAgentActivity]: an ALIVE row can be running and still
 * have input pending, and a row with no live process has no input observation to
 * make.
 */
public fun classifyInputObservation(metadata: RemoteSessionMetadata): InputObservation = when {
    metadata.pendingInput == true || metadata.inputSurface -> InputObservation.PENDING
    metadata.pendingInput == false -> InputObservation.NONE
    else -> InputObservation.UNKNOWN
}

/** A count the owner positively reported; a missing or negative count is `null`. */
private fun positiveCount(value: Long?): Long? = value?.takeIf { it >= 0L }

/**
 * One frozen action target: the exact row one drawn control addressed.
 *
 * The triple ([hostId], [hostRunId], [rowId]) is the only row authority, and
 * [rosterRevision] records the snapshot the control was drawn from. A later
 * metadata change never retargets a target that is already on screen: the UI keeps
 * drawing the frozen values and the future controller refuses a target that no
 * longer matches its own facts.
 */
public data class SessionActionTarget(
    public val hostId: HostId,
    public val hostRunId: String,
    public val rowId: String,
    public val rosterRevision: Long,
    public val drawnTitle: String,
) {
    public companion object {
        /** Freeze the target for one row as it is currently drawn. */
        public fun of(row: SessionUiState): SessionActionTarget = SessionActionTarget(
            hostId = row.hostId,
            hostRunId = row.hostRunId,
            rowId = row.rowId,
            rosterRevision = row.rosterRevision,
            drawnTitle = row.displayTitle,
        )
    }
}

/**
 * One frozen rename target, additionally fenced to the row's native conversation
 * tuple.
 *
 * [expectedSessionId] and [expectedSessionEpoch] are the owner's own identity for
 * the conversation the operator was looking at, so a rename cannot land on a later
 * conversation that reused the row id. [currentName] is the name that was on screen;
 * it is display context for the confirmation only, and nothing here renames a row
 * optimistically.
 */
public data class RenameTarget(
    public val base: SessionActionTarget,
    public val expectedSessionId: String,
    public val expectedSessionEpoch: Long,
    public val currentName: String,
) {
    public companion object {
        /**
         * Freeze a rename target, or `null` when the row reports no native
         * conversation: without the owner's tuple there is nothing to fence a rename
         * to, so no rename affordance is offered rather than guessing one.
         */
        public fun of(row: SessionUiState): RenameTarget? {
            val native = row.metadata.nativeSession ?: return null
            return RenameTarget(
                base = SessionActionTarget.of(row),
                expectedSessionId = native.sessionId,
                expectedSessionEpoch = native.epoch,
                currentName = native.name,
            )
        }
    }
}

/**
 * A row of the unified, globally ordered session list.
 *
 * Rows are ordered by saved host order first, then by the owner's own order inside
 * that host. No sorting by status, no grouping by label, and no re-ordering of the
 * owner's rows: the owner's snapshot order is preserved so a row stays where the
 * operator saw it.
 */
public fun unifiedSessionRows(hostStates: List<HostUiState>): List<SessionUiState> =
    hostStates.flatMap { it.rows }

/**
 * The controller's ordering key for one row: the same qualifying triple the rows
 * themselves carry, with no second identity and no rank.
 *
 * A controller that has a canonical global order — the existing presentation-order
 * owner's sequence, for instance — states it as a list of these keys. That is a
 * projection of an order that already exists elsewhere, not another row store: the
 * rows still arrive only from [HostUiState.roster].
 */
public data class SessionRowKey(
    public val hostId: HostId,
    public val hostRunId: String,
    public val rowId: String,
) {
    public companion object {
        /** The key one row answers to. */
        public fun of(row: SessionUiState): SessionRowKey = SessionRowKey(row.hostId, row.hostRunId, row.rowId)
    }
}

/**
 * Unified session rows in the order the client renders them.
 *
 * When [rowOrder] is empty there is no stated global order and rows fall back to
 * saved host order, then each owner's own order inside that host. When it is present
 * it is honoured verbatim, so one host's rows may legitimately be interleaved with
 * another's. Keys naming a row that is not currently present are skipped, and rows
 * the order does not name are appended in fallback order rather than dropped, so an
 * incomplete order never hides a live row.
 */
public fun orderedSessionRows(
    hostStates: List<HostUiState>,
    rowOrder: List<SessionRowKey> = emptyList(),
): List<SessionUiState> {
    val fallback = unifiedSessionRows(hostStates)
    if (rowOrder.isEmpty()) return fallback
    val remaining = LinkedHashMap<SessionRowKey, SessionUiState>()
    fallback.forEach { remaining.putIfAbsent(SessionRowKey.of(it), it) }
    val ordered = ArrayList<SessionUiState>(fallback.size)
    rowOrder.forEach { key -> remaining.remove(key)?.let { ordered.add(it) } }
    ordered.addAll(remaining.values)
    return ordered
}

/**
 * The neighbours one row may be moved against, in the rendered order.
 *
 * Neighbours come from the same global projection that is rendered, so a move can
 * cross a host boundary: the presentation order is host-independent, and a row's
 * neighbour above may well belong to another host. Returns `null` entries for the
 * ends of the list.
 */
public fun sessionRowNeighbours(
    orderedRows: List<SessionUiState>,
    row: SessionUiState,
): Pair<SessionUiState?, SessionUiState?> {
    val index = orderedRows.indexOfFirst {
        it.hostId == row.hostId && it.hostRunId == row.hostRunId && it.rowId == row.rowId
    }
    if (index < 0) return null to null
    return orderedRows.getOrNull(index - 1) to orderedRows.getOrNull(index + 1)
}

/**
 * Hosts that contribute no rows, with why.
 *
 * A host that never produced a snapshot is unknown, not empty; a host with a
 * zero-row snapshot is empty. The native list labels these differently instead of
 * silently dropping either.
 */
public sealed interface EmptyHostRow {
    /** The host this row explains. */
    public val host: HostUiState

    /** Saved, but no roster has ever been observed on this connection. */
    public data class NeverReported(override val host: HostUiState) : EmptyHostRow

    /** The owner positively reported zero sessions. */
    public data class ReportedEmpty(override val host: HostUiState) : EmptyHostRow

    /** A snapshot is on screen but is no longer live. */
    public data class Stale(override val host: HostUiState) : EmptyHostRow
}

/** The hosts that currently contribute no rows, in saved order. */
public fun emptyHostRows(hostStates: List<HostUiState>): List<EmptyHostRow> = hostStates.mapNotNull { host ->
    when {
        host.roster == null -> EmptyHostRow.NeverReported(host)
        host.isStale && host.rows.isEmpty() -> EmptyHostRow.Stale(host)
        host.rows.isEmpty() -> EmptyHostRow.ReportedEmpty(host)
        else -> null
    }
}
