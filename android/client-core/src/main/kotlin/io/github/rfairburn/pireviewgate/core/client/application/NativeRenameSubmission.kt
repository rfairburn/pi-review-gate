package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterNativeRenameCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOwnerOutcome
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRequestResult
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSendProof
import io.github.rfairburn.pireviewgate.core.client.ui.ClientDialogs
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.NativeRenameSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.NativeRenameTarget
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerNativeRenameFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire

/** Why one native host-caption target is not admissible against the current owner view. */
enum class NativeRenameRowRefusal {
    HOST_ABSENT,
    DISCONNECTED,
    CAPABILITY_UNSUPPORTED,
    ROSTER_NOT_CURRENT,
    RUN_CHANGED,
    ROW_MISSING,
    STALE,
    NO_NATIVE_BACKEND,
    NATIVE_BACKEND_CHANGED,
}

/** Native-caption admission of one exact owner row and the backend it reported. */
sealed interface NativeRenameRowAdmission {
    data class Admitted(val row: SessionUiState) : NativeRenameRowAdmission
    data class Refused(val reason: NativeRenameRowRefusal) : NativeRenameRowAdmission
}

/**
 * Native HOST ROW NAME admission.
 *
 * The fence is the stable owner triple plus the native backend the owner itself
 * reported on that row. It requires the SEPARATE native-name capability, a CURRENT
 * snapshot of the exact owner run, and the same backend on the same row. A Pi native
 * conversation tuple is never consulted, and a backend is never inferred from a
 * caption, a label, or a missing status.
 */
object NativeRenameRowFence {
    fun current(host: HostUiState?, target: NativeRenameTarget): NativeRenameRowAdmission {
        val base = target.base
        if (host == null || host.host.id != base.hostId) return NativeRenameRowAdmission.Refused(NativeRenameRowRefusal.HOST_ABSENT)
        if (host.connection != HostConnectionState.CONNECTED) {
            return NativeRenameRowAdmission.Refused(NativeRenameRowRefusal.DISCONNECTED)
        }
        if (!host.capabilities.supports(RosterWire.NATIVE_NAME_CAPABILITY)) {
            return NativeRenameRowAdmission.Refused(NativeRenameRowRefusal.CAPABILITY_UNSUPPORTED)
        }
        val roster = host.roster
        if (roster == null || roster.freshness != RosterFreshness.CURRENT) {
            return NativeRenameRowAdmission.Refused(NativeRenameRowRefusal.ROSTER_NOT_CURRENT)
        }
        if (roster.hostRunId != base.hostRunId) return NativeRenameRowAdmission.Refused(NativeRenameRowRefusal.RUN_CHANGED)
        val row = roster.rows.firstOrNull {
            it.hostId == base.hostId && it.hostRunId == base.hostRunId && it.rowId == base.rowId
        } ?: return NativeRenameRowAdmission.Refused(NativeRenameRowRefusal.ROW_MISSING)
        if (row.stale) return NativeRenameRowAdmission.Refused(NativeRenameRowRefusal.STALE)
        val observed = row.nativeBackend ?: return NativeRenameRowAdmission.Refused(NativeRenameRowRefusal.NO_NATIVE_BACKEND)
        if (observed != target.backend) {
            return NativeRenameRowAdmission.Refused(NativeRenameRowRefusal.NATIVE_BACKEND_CHANGED)
        }
        return NativeRenameRowAdmission.Admitted(row)
    }

    fun row(host: HostUiState?, target: NativeRenameTarget): SessionUiState? =
        (current(host, target) as? NativeRenameRowAdmission.Admitted)?.row
}

/**
 * One deliberate native caption, from the committed click to the settlement that may
 * close it. It builds the one wire command, and only the owner's own two success
 * truths (`renamed-durable`, `renamed-in-memory`) close that exact form. A refusal,
 * an unknown outcome, a never-sent request, a replacement form, or a foreign result
 * leaves every row and form untouched; nothing is renamed locally or retried.
 */
class NativeRenameSubmission private constructor(
    val host: HostId,
    val generation: Long,
    val command: RosterNativeRenameCommand,
    val proof: UiActionProof,
    private val form: NativeRenameSessionDialog,
) {
    fun closeIfConfirmed(
        current: ClientDialogs,
        eventHostRunId: String,
        result: RosterRequestResult,
    ): ClientDialogs {
        // A refresh may copy the pending form while retaining the exact same receipt
        // object, so identity of the containing dialog is not this form's marker.
        if (current.nativeRenameSession != form) return current
        val target = form.target.base
        if (form.proof !== proof || target.hostId != host || target.hostRunId != eventHostRunId) return current
        val token = proof.target
        if (token.hostId != target.hostId || token.hostRunId != target.hostRunId || token.rowId != target.rowId) {
            return current
        }
        val outcome = (result as? RosterRequestResult.OwnerResult)?.outcome as? RosterOwnerOutcome.NativeRename
            ?: return current
        return when (outcome.facts) {
            OwnerNativeRenameFacts.RENAMED_DURABLE,
            OwnerNativeRenameFacts.RENAMED_IN_MEMORY,
            -> current.copy(nativeRenameSession = null)
            OwnerNativeRenameFacts.REFUSED,
            OwnerNativeRenameFacts.UNKNOWN,
            -> current
        }
    }

    companion object {
        fun begin(
            host: HostUiState?,
            generation: Long,
            form: NativeRenameSessionDialog,
            proof: UiActionProof,
        ): NativeRenameSubmission? {
            if (form.proof !== proof) return null
            val target = form.target
            val row = NativeRenameRowFence.row(host, target) ?: return null
            val frozen = FrozenAction.capture(proof) ?: return null
            val command = RosterNativeRenameCommand(
                hostRunId = target.base.hostRunId,
                rowId = target.base.rowId,
                backend = row.nativeBackend ?: return null,
                name = form.nameDraft,
                proof = RosterSendProof.NativeRowAction(
                    channelGeneration = generation,
                    hostRunId = target.base.hostRunId,
                    rowId = target.base.rowId,
                    backend = target.backend,
                    ui = frozen,
                ),
            )
            return NativeRenameSubmission(target.base.hostId, generation, command, proof, form)
        }
    }
}
