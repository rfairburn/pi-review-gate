package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.connection.ConnectionRegistrySnapshot
import io.github.rfairburn.pireviewgate.core.client.connection.HostConnectionPhase
import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.runtime.ClientRuntimeState
import io.github.rfairburn.pireviewgate.core.client.runtime.HostLanePhase
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedDeleteFacts
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * One read continuation of an actual committed, admitted confirmed delete. It is
 * not another UI action receipt and cannot authorize a mutation. Main owns intake,
 * observation and settlement; transport/transfer guards read only the atomic latch
 * and the frozen window/owner lifetime. Cancellation is permanent.
 */
class AcceptedSavedDeletion private constructor(
    val entry: SavedEntryTarget,
    val result: SavedResultTarget,
    val pickerEpoch: Long,
    val query: String,
    private val send: RosterSendProof.PickerEntry,
    private val dialogProof: UiActionProof,
    private val lifetime: RosterUiProof,
) : RosterUiProof {
    private val live = AtomicBoolean(true)
    private val transferGuard = AtomicReference<RosterUiProof?>(this)
    // Detach the completed result from this transaction (and its window) on adoption.
    private val resultLifetime = transferGuard.let { guard -> RosterUiProof { guard.get()?.isStillCurrent() ?: true } }
    private var accepted: RosterPendingOperation? = null
    private var settled = false
    private val closingCompletedDialog = AtomicBoolean(false)

    fun cancel() { live.set(false) }
    override fun isStillCurrent(): Boolean {
        if (!live.get()) return false
        if (!runCatching { lifetime.isStillCurrent() &&
                (closingCompletedDialog.get() || send.ui.isStillCurrent()) }.getOrDefault(false)) cancel()
        return live.get()
    }

    /** Metadata must come from the accepting step, never a later sequence high-water mark. */
    fun admitted(pending: RosterPendingOperation?) {
        if (accepted != null || pending == null || pending.kind != RosterOperationKind.SAVED_DELETE ||
            pending.savedDeleteConfirmed != true || pending.sequence == null ||
            pending.hostRunId != entry.hostRunId || pending.catalogId != entry.catalogId ||
            pending.resultId != entry.resultId || pending.entryId != entry.entryId ||
            pending.savedPickerRevision != send.pickerRevision) {
            cancel()
            return
        }
        accepted = pending
    }

    /** Call synchronously on UI changes, including external dismissal/replacement. */
    fun observe(display: SavedUiState, epoch: Long, dialog: UiActionProof?, otherDialog: Boolean = false) {
        if (epoch != pickerEpoch || SavedResultTarget.of(display) != result || display.query != query ||
            otherDialog || (!closingCompletedDialog.get() && dialog !== dialogProof) ||
            (closingCompletedDialog.get() && dialog != null)) cancel()
    }

    /** After exact read correlation and projection, normal manual-read ownership resumes. */
    fun adoptResult(): Boolean {
        if (!closingCompletedDialog.get() || !isStillCurrent()) return false
        transferGuard.set(null)
        return true
    }

    data class Refresh(val command: RosterSavedListCommand, val display: SavedUiState)

    /** Only exact Deleted consumes this one-shot. Self-closing its own dialog is intentional. */
    fun refresh(event: RosterClientEvent.OperationSettled, display: SavedUiState, epoch: Long,
                dialog: UiActionProof?): Refresh? {
        if (settled) return null
        observe(display, epoch, dialog)
        settled = true
        val pending = accepted
        val facts = ((event.result as? RosterRequestResult.OwnerResult)?.outcome as? RosterOwnerOutcome.SavedDelete)?.facts
        if (!isStillCurrent() || pending == null || event.kind != pending.kind ||
            event.requestId != pending.requestId || event.hostRunId != pending.hostRunId ||
            facts !is OwnerSavedDeleteFacts.Deleted) {
            cancel()
            return null
        }
        closingCompletedDialog.set(true)
        // Match the existing List query/window policy, not Search on the retired catalog.
        val command = RosterSavedListCommand(entry.hostRunId, query, 0, 50,
            RosterSendProof.PickerRead(send.channelGeneration, entry.hostRunId,
                queryRevision = send.pickerRevision, ui = this), resultLifetime = resultLifetime)
        return Refresh(command, display.copy(status = SavedRequestStatus.Requesting, deletePreparation = null,
            listProof = null, windowProof = null, entryProofs = emptyMap()))
    }

    companion object {
        /**
         * Read published immutable facts only: endpoint state/snapshot access here
         * would re-enter this guard while validating the completed Saved ownership.
         * Publication can lag an endpoint step; its own request, run and generation
         * fences still govern dispatch and transfer independently of this lifetime.
         */
        fun ownerLifetime(entry: SavedEntryTarget, generation: Long, window: RosterUiProof,
                          registry: StateFlow<ConnectionRegistrySnapshot>,
                          runtime: StateFlow<ClientRuntimeState>): RosterUiProof = RosterUiProof {
            val host = registry.value.hosts.firstOrNull { it.hostId == entry.hostId }
            val runtimeHost = runtime.value.hosts.firstOrNull { it.hostId == entry.hostId }
            window.isStillCurrent() && host != null && host.generation == generation &&
                host.phase == HostConnectionPhase.CONNECTED && runtimeHost != null &&
                runtimeHost.connectionGeneration == generation && runtimeHost.lane == HostLanePhase.ATTACHED &&
                runtimeHost.roster.projection.state == RosterProjectionState.CURRENT &&
                runtimeHost.roster.projection.hostRunId == entry.hostRunId
        }

        fun capture(entry: SavedEntryTarget, result: SavedResultTarget, pickerEpoch: Long, query: String,
                    send: RosterSendProof.PickerEntry, dialog: UiActionProof,
                    click: FrozenAction, lifetime: RosterUiProof): AcceptedSavedDeletion? {
            val token = click.target
            if (!click.isStillCurrent() || send.ui !== click || send.confirmation !== click ||
                token != dialog.target || token.hostId != entry.hostId || token.hostRunId != entry.hostRunId ||
                token.catalogId != entry.catalogId || token.resultId != entry.resultId || token.entryId != entry.entryId ||
                send.hostRunId != entry.hostRunId || send.catalogId != entry.catalogId ||
                send.resultId != entry.resultId || send.entryId != entry.entryId ||
                result.hostId != entry.hostId || result.hostRunId != entry.hostRunId ||
                result.catalogId != entry.catalogId || result.resultId != entry.resultId) return null
            return AcceptedSavedDeletion(entry, result, pickerEpoch, query, send, dialog, lifetime)
                .takeIf { it.isStillCurrent() }
        }
    }
}
