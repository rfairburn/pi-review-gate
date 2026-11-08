package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterOwnerOutcome
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRequestResult
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RenameSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.RenameTarget
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.SessionActionTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerRenameFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire

/** Why one rename target is not admissible against the current owner view. */
enum class RenameRowRefusal {
    HOST_ABSENT,
    DISCONNECTED,
    CAPABILITY_UNSUPPORTED,
    ROSTER_NOT_CURRENT,
    RUN_CHANGED,
    ROW_MISSING,
    STALE,
    /** The live row states no native conversation, so there is nothing to fence a rename to. */
    NO_NATIVE_CONVERSATION,
    /** The row's native conversation moved, so the operator's tuple names a different conversation. */
    NATIVE_TUPLE_CHANGED,
}

/** Rename-specific admission of one exact owner row. */
sealed interface RenameRowAdmission {
    /** The same stable row is current; [row] carries the freshest drawn context. */
    data class Admitted(val row: SessionUiState) : RenameRowAdmission

    data class Refused(val reason: RenameRowRefusal) : RenameRowAdmission
}

/**
 * Rename-only row admission.
 *
 * The stable owner identity is ([RenameTarget.base]'s [SessionActionTarget.hostId],
 * [SessionActionTarget.hostRunId], [SessionActionTarget.rowId]), and the rename's real
 * fence is the row's native conversation tuple: the request may only be addressed while
 * this side still observes that exact [RenameTarget.expectedSessionId] and
 * [RenameTarget.expectedSessionEpoch].
 *
 * `rosterRevision` and [SessionActionTarget.drawnTitle] freeze what one frame showed.
 * They are deliberately NOT part of this admission: a rename form is open long enough
 * for the owner to republish its roster — and a rename is precisely the operation whose
 * row title moves — so requiring the whole drawn context to still match made the
 * operator's deliberate Rename silently unsubmitable. Every other fence stays: the
 * connection, the acknowledged rename capability, the current roster, the exact owner
 * run, the row's presence and liveness, and the native tuple.
 *
 * Nothing here grants anything. The committed dialog still owns the click, and the
 * endpoint re-checks the tuple and the drawn proof at the last instant before writing.
 */
object RenameRowFence {
    fun current(host: HostUiState?, target: RenameTarget): RenameRowAdmission {
        val base = target.base
        if (host == null || host.host.id != base.hostId) return RenameRowAdmission.Refused(RenameRowRefusal.HOST_ABSENT)
        if (host.connection != HostConnectionState.CONNECTED) {
            return RenameRowAdmission.Refused(RenameRowRefusal.DISCONNECTED)
        }
        if (!host.capabilities.supports(RosterWire.RENAME_CAPABILITY)) {
            return RenameRowAdmission.Refused(RenameRowRefusal.CAPABILITY_UNSUPPORTED)
        }
        val roster = host.roster
        if (roster == null || roster.freshness != RosterFreshness.CURRENT) {
            return RenameRowAdmission.Refused(RenameRowRefusal.ROSTER_NOT_CURRENT)
        }
        if (roster.hostRunId != base.hostRunId) return RenameRowAdmission.Refused(RenameRowRefusal.RUN_CHANGED)
        val row = roster.rows.firstOrNull {
            it.hostId == base.hostId && it.hostRunId == base.hostRunId && it.rowId == base.rowId
        } ?: return RenameRowAdmission.Refused(RenameRowRefusal.ROW_MISSING)
        if (row.stale) return RenameRowAdmission.Refused(RenameRowRefusal.STALE)
        val observed = row.metadata.nativeSession ?: return RenameRowAdmission.Refused(RenameRowRefusal.NO_NATIVE_CONVERSATION)
        if (observed.sessionId != target.expectedSessionId || observed.epoch != target.expectedSessionEpoch) {
            return RenameRowAdmission.Refused(RenameRowRefusal.NATIVE_TUPLE_CHANGED)
        }
        return RenameRowAdmission.Admitted(row)
    }

    /** The one current row this rename target names, or `null` when it is not admissible. */
    fun row(host: HostUiState?, target: RenameTarget): SessionUiState? =
        (current(host, target) as? RenameRowAdmission.Admitted)?.row
}

/**
 * Whether one settled rename closes exactly [form].
 *
 * The match is deliberately restricted to the same proof object, host, owner run, and
 * row, so a replacement form or a foreign result can never be acted on, and it closes
 * only on the owner's positive [OwnerRenameFacts.RENAMED]. A refusal, a busy or
 * stale-session answer, an unobservable outcome, a never-sent request, or a result for
 * another operation leaves the form and every row exactly as they were; nothing here
 * retries, falls back, or renames anything locally.
 */
object RenameResultFence {
    fun closesOn(form: RenameSessionDialog?, proof: UiActionProof?, host: HostId,
                 eventHostRunId: String, result: RosterRequestResult): Boolean {
        if (form == null || proof == null || form.proof !== proof) return false
        val target = form.target.base
        if (target.hostId != host || target.hostRunId != eventHostRunId) return false
        val token = proof.target
        if (token.hostId != target.hostId || token.hostRunId != target.hostRunId || token.rowId != target.rowId) {
            return false
        }
        val outcome = (result as? RosterRequestResult.OwnerResult)?.outcome as? RosterOwnerOutcome.Rename
            ?: return false
        return outcome.facts == OwnerRenameFacts.RENAMED
    }
}
