package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationIdentity
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationMovePosition
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationOwnerKind
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata

// ---- Background line ------------------------------------------------------------

/**
 * The background line one normal session card shows.
 *
 * It mirrors the desktop card's background text and reads only the owner's
 * ACTIVITY-INTENT counts (`activeTasks`/`activeShells`). The ownership counts
 * (`backgroundTasks`/`backgroundShells`) are a different fact and stay in the card
 * details. A missing or invalid count is unknown and is never rendered as zero or
 * as idle, and nothing here is derived from terminal output.
 */
public sealed interface SessionCardBackground {
    /** Neither activity-intent count was reported: the whole line is unknown. */
    public data object Unknown : SessionCardBackground

    /** At least one count was reported; a `null` member is still unknown, never zero. */
    public data class Counts(
        public val activeTasks: Long?,
        public val activeShells: Long?,
    ) : SessionCardBackground
}

/** The background line for one row, from its activity-intent counts only. */
public fun sessionCardBackground(metadata: RemoteSessionMetadata): SessionCardBackground {
    val tasks = reportedCount(metadata.activeTasks)
    val shells = reportedCount(metadata.activeShells)
    return if (tasks == null && shells == null) {
        SessionCardBackground.Unknown
    } else {
        SessionCardBackground.Counts(tasks, shells)
    }
}

/** Only a nonnegative count is an observation; everything else is unknown. */
private fun reportedCount(value: Long?): Long? = value?.takeIf { it >= 0L }

// ---- Presentation identity, fail closed -----------------------------------------

/**
 * The presentation identity one rendered row may be reordered by, or `null`.
 *
 * The row's own [SessionUiState.presentationIdentity] is used unchanged, and the
 * answer is refused when it cannot be trusted to name exactly this row in [rows]:
 * the row's qualifying key is absent or repeated, no identity derives, a reported
 * durable slot did not yield a slot identity, or another current row derives the
 * same identity. Ambiguity therefore drops a move instead of guessing one.
 */
public fun uniqueSessionPresentationIdentity(
    rows: List<SessionUiState>,
    key: SessionRowKey,
): RemotePresentationIdentity? = SessionIdentityIndex(rows)[key]

/**
 * [uniqueSessionPresentationIdentity] for every row of one rendered list, derived
 * once, so a screen of many cards does not re-derive every identity per card.
 */
public class SessionIdentityIndex(rows: List<SessionUiState>) {
    private val unique: Map<SessionRowKey, RemotePresentationIdentity>

    init {
        val keyCounts = HashMap<SessionRowKey, Int>()
        val identityCounts = HashMap<RemotePresentationIdentity, Int>()
        val derived = ArrayList<Pair<SessionUiState, RemotePresentationIdentity?>>(rows.size)
        for (row in rows) {
            val key = SessionRowKey.of(row)
            keyCounts[key] = (keyCounts[key] ?: 0) + 1
            val identity = row.presentationIdentity
            if (identity != null) identityCounts[identity] = (identityCounts[identity] ?: 0) + 1
            derived += row to identity
        }
        val result = HashMap<SessionRowKey, RemotePresentationIdentity>()
        for ((row, identity) in derived) {
            val key = SessionRowKey.of(row)
            if (identity == null || keyCounts[key] != 1 || identityCounts[identity] != 1) continue
            // A reported durable slot that did not yield a slot identity is refused.
            if (row.metadata.rosterSlotId != null && identity.ownerKind != RemotePresentationOwnerKind.SLOT) continue
            result[key] = identity
        }
        unique = result
    }

    /** The unique identity of [key], or `null` when it is absent, repeated, or ambiguous. */
    public operator fun get(key: SessionRowKey): RemotePresentationIdentity? = unique[key]
}

/**
 * The accessible "move up"/"move down" requests for one row.
 *
 * These are the same [ClientIntent.MoveSessionRow] the visible menu used to send —
 * BEFORE the rendered neighbour above, AFTER the rendered neighbour below — kept as
 * non-visual actions after drag replaced the menu items. Each is `null` when the
 * row or that neighbour cannot be named uniquely.
 */
public data class SessionCardAccessibleMoves(
    public val moveUp: ClientIntent.MoveSessionRow?,
    public val moveDown: ClientIntent.MoveSessionRow?,
)

/** Accessible neighbour moves for [row] in the rendered order [rows]. */
public fun sessionCardAccessibleMoves(
    rows: List<SessionUiState>,
    row: SessionUiState,
    index: SessionIdentityIndex = SessionIdentityIndex(rows),
): SessionCardAccessibleMoves {
    val key = SessionRowKey.of(row)
    val mine = index[key] ?: return SessionCardAccessibleMoves(null, null)
    val (above, below) = sessionRowNeighbours(rows, row)
    val up = above?.let { index[SessionRowKey.of(it)] }
        ?.let { ClientIntent.MoveSessionRow(mine, RemotePresentationMovePosition.BEFORE, it) }
    val down = below?.let { index[SessionRowKey.of(it)] }
        ?.let { ClientIntent.MoveSessionRow(mine, RemotePresentationMovePosition.AFTER, it) }
    return SessionCardAccessibleMoves(up, down)
}

// ---- Drag ordering ----------------------------------------------------------------

/**
 * One member of the drag membership fence: a row's qualifying key with the identity
 * it derived. A changed owner run, row, or slot is a different member.
 */
public data class SessionDragMember(
    public val key: SessionRowKey,
    public val identity: RemotePresentationIdentity?,
)

/** The membership fence of [rows]; ordinary status and count updates leave it unchanged. */
public fun sessionDragMembership(rows: List<SessionUiState>): Set<SessionDragMember> =
    rows.mapTo(LinkedHashSet()) { SessionDragMember(SessionRowKey.of(it), it.presentationIdentity) }

/**
 * Where a drag currently points: one row and the side of it, both frozen as the
 * identity that was resolvable when the target was chosen.
 */
public data class SessionDropTarget(
    public val key: SessionRowKey,
    public val identity: RemotePresentationIdentity,
    public val position: RemotePresentationMovePosition,
    /** True when chosen by the blank space below the last session card. */
    public val endDrop: Boolean = false,
)

/**
 * What lies under the pointer, resolved against the drawn list.
 *
 * Mirrors the desktop pointer rules: a session card chooses BEFORE/AFTER by the
 * half the pointer is in, blank space below the last drawn session card appends
 * after it, host rows are no-drop, and leaving the list drops the preview. A gap
 * between cards keeps whatever is already previewed.
 */
public sealed interface SessionDragHover {
    /** Over one session card; [upperHalf] chooses BEFORE, else AFTER. */
    public data class OverRow(public val key: SessionRowKey, public val upperHalf: Boolean) : SessionDragHover

    /** Blank space below the list's last session card. */
    public data object EndBlank : SessionDragHover

    /** Between cards: nothing to retarget, keep the current preview. */
    public data object Gap : SessionDragHover

    /** Over a non-session row (a host without sessions): no drop here. */
    public data object NoDrop : SessionDragHover

    /** Outside the list viewport: no drop here. */
    public data object Outside : SessionDragHover
}

/**
 * One in-flight local drag of a session card.
 *
 * Nothing here is an owner operation. The preview is a local reordering of the
 * rendered rows only; [dropIntent] yields at most one existing
 * [ClientIntent.MoveSessionRow], which the controller applies to this viewer's
 * persisted local presentation order.
 */
public data class SessionCardDrag(
    public val source: SessionRowKey,
    public val sourceIdentity: RemotePresentationIdentity,
    public val membership: Set<SessionDragMember>,
    public val target: SessionDropTarget? = null,
) {
    /**
     * Whether [rows] still match the rows this drag started on.
     *
     * Busy, input, activity, and count updates keep the drag; a row joining or
     * leaving, a new owner run, or a changed identity ends it.
     */
    public fun stillValidFor(rows: List<SessionUiState>): Boolean =
        sessionDragMembership(rows) == membership &&
            uniqueSessionPresentationIdentity(rows, source) == sourceIdentity

    /** This drag retargeted to [hover] over the real (committed) order [rows]. */
    public fun retarget(rows: List<SessionUiState>, hover: SessionDragHover): SessionCardDrag {
        val next: SessionDropTarget? = when (hover) {
            SessionDragHover.Gap -> return this
            SessionDragHover.NoDrop, SessionDragHover.Outside -> null
            // The preview already moved the source under the pointer: keep the
            // established target instead of cancelling on that redraw.
            is SessionDragHover.OverRow -> if (hover.key == source) {
                return this
            } else {
                uniqueSessionPresentationIdentity(rows, hover.key)?.let { identity ->
                    SessionDropTarget(
                        key = hover.key,
                        identity = identity,
                        position = if (hover.upperHalf) {
                            RemotePresentationMovePosition.BEFORE
                        } else {
                            RemotePresentationMovePosition.AFTER
                        },
                    )
                }
            }
            SessionDragHover.EndBlank -> rows.lastOrNull()
                ?.let { SessionRowKey.of(it) }
                ?.takeIf { it != source }
                ?.let { last ->
                    uniqueSessionPresentationIdentity(rows, last)?.let { identity ->
                        SessionDropTarget(last, identity, RemotePresentationMovePosition.AFTER, endDrop = true)
                    }
                } ?: if (target?.endDrop == true) return this else null
        }
        // A target that would leave the order unchanged is not an intent.
        val effective = next?.takeIf { movedOrder(rows, source, it) != null }
        return copy(target = effective)
    }

    /** The rows as this viewer should preview them now; the real order when nothing moves. */
    public fun previewRows(rows: List<SessionUiState>): List<SessionUiState> {
        val current = target ?: return rows
        if (!stillValidFor(rows)) return rows
        return movedOrder(rows, source, current) ?: rows
    }

    /**
     * The single move to send on a release, or `null`.
     *
     * Re-resolves both ends against the latest [rows]: the source and the target must
     * each still be uniquely present with the identity frozen at drag time, distinct,
     * and the move must change the order. Anything else drops nothing.
     */
    public fun dropIntent(rows: List<SessionUiState>): ClientIntent.MoveSessionRow? {
        val current = target ?: return null
        if (!stillValidFor(rows)) return null
        if (current.key == source) return null
        if (uniqueSessionPresentationIdentity(rows, current.key) != current.identity) return null
        if (current.identity == sourceIdentity) return null
        if (movedOrder(rows, source, current) == null) return null
        return ClientIntent.MoveSessionRow(sourceIdentity, current.position, current.identity)
    }

    public companion object {
        /**
         * Start a drag of [source], or `null` when it may not move.
         *
         * [eligible] is the caller's existing move eligibility (a connected host with
         * a current roster, no covering UI); this never widens it. The source must be
         * uniquely resolvable in [rows].
         */
        public fun begin(
            rows: List<SessionUiState>,
            source: SessionRowKey,
            eligible: Boolean,
        ): SessionCardDrag? {
            if (!eligible) return null
            val identity = uniqueSessionPresentationIdentity(rows, source) ?: return null
            return SessionCardDrag(source, identity, sessionDragMembership(rows))
        }
    }
}

/** [rows] with [source] moved to [target], or `null` when that changes nothing or cannot apply. */
private fun movedOrder(
    rows: List<SessionUiState>,
    source: SessionRowKey,
    target: SessionDropTarget,
): List<SessionUiState>? {
    if (target.key == source) return null
    val sourceRow = rows.singleOrNull { SessionRowKey.of(it) == source } ?: return null
    val without = rows.filterNot { SessionRowKey.of(it) == source }
    val targetIndex = without.indexOfFirst { SessionRowKey.of(it) == target.key }
    if (targetIndex < 0) return null
    val insertAt = when (target.position) {
        RemotePresentationMovePosition.BEFORE -> targetIndex
        RemotePresentationMovePosition.AFTER -> targetIndex + 1
    }
    val moved = without.toMutableList().apply { add(insertAt, sourceRow) }
    return moved.takeIf { it != rows }
}

// ---- Geometry ---------------------------------------------------------------------

/**
 * One drawn list item, in the list container's own coordinates.
 *
 * [key] is the session row the item draws, or `null` for a non-session item such
 * as a host that contributes no rows.
 */
public data class SessionDragItemSpan(
    public val key: SessionRowKey?,
    public val top: Float,
    public val bottom: Float,
)

/**
 * Whether a pointer at ([pointerX], [pointerY]) is inside a list viewport of
 * [viewportWidth] by [viewportHeight]. Leaving through any side is outside.
 */
public fun sessionDragInsideViewport(
    pointerX: Float,
    pointerY: Float,
    viewportWidth: Float,
    viewportHeight: Float,
): Boolean = pointerX.isFinite() && pointerY.isFinite() &&
    pointerX >= 0f && pointerX <= viewportWidth &&
    pointerY >= 0f && pointerY <= viewportHeight

/**
 * Resolve what lies under ([pointerX], [pointerY]) in a list whose viewport is
 * `[0, viewportWidth] x [0, viewportHeight]`. Leaving the viewport through any side,
 * including left or right, is [SessionDragHover.Outside].
 *
 * [items] are the drawn items in order. [lastSessionKey] is the final session row of
 * the list as drawn; blank space below it appends only when that card is actually
 * drawn, so a scrolled window can never append past cards it does not show.
 */
public fun sessionDragHover(
    pointerX: Float,
    pointerY: Float,
    viewportWidth: Float,
    viewportHeight: Float,
    items: List<SessionDragItemSpan>,
    lastSessionKey: SessionRowKey?,
): SessionDragHover {
    if (!sessionDragInsideViewport(pointerX, pointerY, viewportWidth, viewportHeight)) {
        return SessionDragHover.Outside
    }
    val hit = items.firstOrNull { pointerY >= it.top && pointerY < it.bottom }
    if (hit != null) {
        val key = hit.key ?: return SessionDragHover.NoDrop
        return SessionDragHover.OverRow(key, pointerY < hit.top + (hit.bottom - hit.top) / 2f)
    }
    val last = lastSessionKey?.let { k -> items.firstOrNull { it.key == k } }
    return if (last != null && pointerY >= last.bottom) SessionDragHover.EndBlank else SessionDragHover.Gap
}

/**
 * Edge auto-scroll step for a drag at ([pointerX], [pointerY]) in a viewport of
 * [viewportWidth] by [viewportHeight].
 *
 * Negative scrolls toward the start, positive toward the end, zero outside the edge
 * bands or outside the viewport on any side. The step grows as the pointer nears the edge and
 * never exceeds [maxStep], so offscreen rows of a long list can be reached.
 */
public fun sessionDragEdgeScroll(
    pointerX: Float,
    pointerY: Float,
    viewportWidth: Float,
    viewportHeight: Float,
    edge: Float,
    maxStep: Float,
): Float {
    if (viewportHeight <= 0f || edge <= 0f || maxStep <= 0f) return 0f
    if (!sessionDragInsideViewport(pointerX, pointerY, viewportWidth, viewportHeight)) return 0f
    val band = minOf(edge, viewportHeight / 2f)
    return when {
        pointerY < band -> -maxStep * ((band - pointerY) / band)
        pointerY > viewportHeight - band -> maxStep * ((pointerY - (viewportHeight - band)) / band)
        else -> 0f
    }
}
