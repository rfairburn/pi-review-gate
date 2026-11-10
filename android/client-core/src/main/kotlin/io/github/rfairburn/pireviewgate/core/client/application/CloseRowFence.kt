package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.ui.CloseSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.SessionActionTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire

/** Why one close-specific target is not admissible against the current owner view. */
enum class CloseRowRefusal {
    HOST_ABSENT,
    DISCONNECTED,
    CAPABILITY_UNSUPPORTED,
    ROSTER_NOT_CURRENT,
    RUN_CHANGED,
    ROW_MISSING,
    STALE,
}

/** Close-specific admission of one exact owner row. */
sealed interface CloseRowAdmission {
    /** The same stable row is current; [row] carries the freshest drawn context. */
    data class Admitted(val row: SessionUiState) : CloseRowAdmission

    data class Refused(val reason: CloseRowRefusal) : CloseRowAdmission
}

/**
 * Close-only row admission.
 *
 * The stable owner identity is ([SessionActionTarget.hostId],
 * [SessionActionTarget.hostRunId], [SessionActionTarget.rowId]). `rosterRevision` and
 * `drawnTitle` freeze what one frame showed, but an ordinary metadata or title
 * refresh must not make the same owner row unclosable. Every other target-sensitive
 * action keeps the existing exact [SessionUiState] match; this fence is used only by
 * Close and never relaxes the shared row lookup.
 */
object CloseRowFence {
    fun current(host: HostUiState?, target: SessionActionTarget): CloseRowAdmission {
        if (host == null || host.host.id != target.hostId) return CloseRowAdmission.Refused(CloseRowRefusal.HOST_ABSENT)
        if (host.connection != HostConnectionState.CONNECTED) {
            return CloseRowAdmission.Refused(CloseRowRefusal.DISCONNECTED)
        }
        if (!host.capabilities.supports(RosterWire.CLOSE_CAPABILITY)) {
            return CloseRowAdmission.Refused(CloseRowRefusal.CAPABILITY_UNSUPPORTED)
        }
        val roster = host.roster
        if (roster == null || roster.freshness != RosterFreshness.CURRENT) {
            return CloseRowAdmission.Refused(CloseRowRefusal.ROSTER_NOT_CURRENT)
        }
        if (roster.hostRunId != target.hostRunId) {
            return CloseRowAdmission.Refused(CloseRowRefusal.RUN_CHANGED)
        }
        val row = roster.rows.firstOrNull {
            it.hostId == target.hostId && it.hostRunId == target.hostRunId && it.rowId == target.rowId
        } ?: return CloseRowAdmission.Refused(CloseRowRefusal.ROW_MISSING)
        if (row.stale) return CloseRowAdmission.Refused(CloseRowRefusal.STALE)
        return CloseRowAdmission.Admitted(row)
    }

    /** The one current row this close target names, or `null` when it is not admissible. */
    fun row(host: HostUiState?, target: SessionActionTarget): SessionUiState? =
        (current(host, target) as? CloseRowAdmission.Admitted)?.row
}

/**
 * Exact matching of an owner close result to the form that submitted it.
 *
 * Nothing here is close authority: admission still happened at the committed dialog,
 * and the owner result remains the only fact that can dismiss that form or report a
 * retained row. The match is deliberately restricted to the same proof object, host,
 * owner run, and row so a replacement dialog or a foreign result can never be acted on.
 */
object CloseResultFence {
    fun matching(form: CloseSessionDialog?, proof: UiActionProof?, host: HostId,
                 eventHostRunId: String): CloseSessionDialog? {
        if (form == null || proof == null || form.proof !== proof) return null
        if (form.target.hostId != host || form.target.hostRunId != eventHostRunId) return null
        val token = proof.target
        if (token.hostId != form.target.hostId || token.hostRunId != form.target.hostRunId ||
            token.rowId != form.target.rowId) return null
        return form
    }
}

/**
 * The connection-attempt lifetime of one close form.
 *
 * A disconnect or reconnect is never papered over by a fresh proof: the same stable
 * host/run/row may be present again, but the old committed consent belongs to the
 * retired attempt and cannot submit against the replacement channel.
 */
object CloseConnectionFence {
    fun admits(form: CloseSessionDialog?, currentGeneration: Long?): Boolean =
        form != null && form.connectionGeneration != null && form.connectionGeneration == currentGeneration

    /** True only while the registry and runtime still describe the form's attempt. */
    fun survives(form: CloseSessionDialog?, registryGeneration: Long?, registryConnected: Boolean,
                 runtimeGeneration: Long?, runtimeAttached: Boolean): Boolean {
        val opening = form?.connectionGeneration ?: return false
        return opening == registryGeneration && registryConnected &&
            runtimeGeneration == opening && runtimeAttached
    }
}
