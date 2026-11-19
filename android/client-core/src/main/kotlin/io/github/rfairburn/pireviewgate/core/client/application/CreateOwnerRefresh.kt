package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEvent
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientPhase
import io.github.rfairburn.pireviewgate.core.client.runtime.ClientRuntime
import io.github.rfairburn.pireviewgate.core.client.runtime.ClientRuntimeEvent
import io.github.rfairburn.pireviewgate.core.client.runtime.HostLanePhase
import io.github.rfairburn.pireviewgate.core.client.runtime.RosterSubscriptionAdmission
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The one-shot New-form refresh of one selected owner's native availability (#493).
 *
 * An owner that acknowledged [RosterWire.NATIVE_AVAILABILITY_CAPABILITY] publishes a
 * freshly probed native catalog with every snapshot, so a fresher catalog is earned
 * only by the existing explicit roster resync followed by a fresh subscription. The
 * runtime never re-subscribes on its own after a resync; this is the one caller that
 * does, and only to finish the exact retirement its own request started.
 *
 * It never connects, pairs, re-grants, falls back, retries, or polls, and it holds no
 * catalog, availability, or authority of its own: the refreshed catalog lands through
 * the ordinary roster projection, and the form reconciles it with its existing rules
 * (a withdrawn native choice becomes "choose again", never Pi). It is scoped to the
 * exact host channel generation it started on, so a completion from an older channel
 * or an older form can only restore that channel's subscription — it never touches a
 * form, a provider choice, a focus, or a selection.
 *
 * A refresh is started only for a connected owner whose CURRENT subscription is idle:
 * no owner operation pending or being admitted, no snapshot transfer in flight, no
 * owned Saved handles, no armed Close confirmation, and no retirement or stop
 * outstanding — each of those would be disturbed by ending the subscription. The
 * owner's passive Saved policy description is not such work: it returns to unknown
 * while retired and the owner publishes it again after the fresh first snapshot.
 */
class CreateOwnerRefresh(
    private val runtime: ClientRuntime,
    private val scope: CoroutineScope,
) {
    /** Why a request did or did not start a refresh. */
    enum class Outcome {
        /** The selected owner's subscription is being retired for a fresh one. */
        STARTED,

        /** Not connected, not current, or no described native availability: nothing to refresh. */
        NOT_ELIGIBLE,

        /** Something on that owner's channel would be disturbed: no refresh now. */
        BUSY,

        /** That owner's refresh is already outstanding; it is joined, never repeated. */
        ALREADY_REFRESHING,
    }

    /** One outstanding refresh, keyed by host and fenced to one channel generation. */
    private class Pending(val generation: Long) {
        /** The subscription our resync retired, once its admission said so. */
        var retiringId: String? = null

        /** A retirement observed before the admission answered: its id and acknowledgement. */
        var observed: Pair<String, Boolean>? = null
    }

    private val pending = mutableMapOf<HostId, Pending>()

    /**
     * Start at most one refresh for [host], the owner the form just selected.
     *
     * [connectionGeneration] is the caller's own current channel generation for that
     * host; a lane on any other generation is never touched. [callerBusy] carries the
     * caller's own in-flight facts (a submitted create, an admitting operation, a
     * pending navigation) that this helper cannot see.
     */
    @Synchronized
    fun request(host: HostUiState?, connectionGeneration: Long?, callerBusy: Boolean): Outcome {
        if (host == null || connectionGeneration == null) return Outcome.NOT_ELIGIBLE
        val hostId = host.host.id
        if (host.connection != HostConnectionState.CONNECTED ||
            host.roster?.freshness != RosterFreshness.CURRENT ||
            !host.capabilities.supports(RosterWire.NATIVE_CAPABILITY) ||
            !host.capabilities.supports(RosterWire.NATIVE_AVAILABILITY_CAPABILITY)) {
            return Outcome.NOT_ELIGIBLE
        }
        val lane = runtime.hostState(hostId) ?: return Outcome.NOT_ELIGIBLE
        val roster = lane.roster
        if (lane.connectionGeneration != connectionGeneration || lane.lane != HostLanePhase.ATTACHED ||
            roster.phase != RosterClientPhase.SUBSCRIBED || roster.subscriptionId == null ||
            !roster.supportsNativeAvailability) {
            return Outcome.NOT_ELIGIBLE
        }
        val outstanding = pending[hostId]
        if (outstanding != null) {
            if (outstanding.generation == connectionGeneration) return Outcome.ALREADY_REFRESHING
            pending.remove(hostId) // An older channel's refresh can never finish here.
        }
        // A passive Saved policy description is NOT a fence: a Saved-capable owner
        // publishes one after every subscription's first snapshot, so it would block
        // every refresh, and the fresh subscription re-earns it from the owner anyway.
        if (callerBusy || roster.pending.isNotEmpty() || roster.inFlightTransfer != null ||
            roster.retiringSubscriptionId != null || roster.stopRequested ||
            roster.savedOwnership != null || roster.armedCloseConfirmationRows.isNotEmpty()) {
            return Outcome.BUSY
        }
        val record = Pending(connectionGeneration)
        pending[hostId] = record
        scope.launch { admitted(hostId, record, runtime.resyncRoster(hostId)) }
        return Outcome.STARTED
    }

    /** Feed every runtime event; only this helper's own retirements are acted on. */
    @Synchronized
    fun observe(event: ClientRuntimeEvent) {
        when (event) {
            is ClientRuntimeEvent.Roster -> {
                val record = pending[event.hostId] ?: return
                if (record.generation != event.connectionGeneration) {
                    if (event.connectionGeneration > record.generation) pending.remove(event.hostId)
                    return
                }
                val retired = event.event as? RosterClientEvent.SubscriptionRetired ?: return
                when (record.retiringId) {
                    retired.subscriptionId -> finish(event.hostId, record, retired.acknowledged)
                    null -> record.observed = retired.subscriptionId to retired.acknowledged
                    else -> Unit // Another subscription's end; not ours to follow up.
                }
            }
            is ClientRuntimeEvent.HostDetached -> {
                if (pending[event.hostId]?.generation == event.connectionGeneration) pending.remove(event.hostId)
            }
            is ClientRuntimeEvent.HostAttached -> {
                val record = pending[event.hostId] ?: return
                if (event.connectionGeneration != record.generation) pending.remove(event.hostId)
            }
            else -> Unit
        }
    }

    /** True while [hostId] has an outstanding refresh. Read-only. */
    @Synchronized
    fun isRefreshing(hostId: HostId): Boolean = pending.containsKey(hostId)

    @Synchronized
    private fun admitted(hostId: HostId, record: Pending, admission: RosterSubscriptionAdmission) {
        if (pending[hostId] !== record) return
        val retiring = when (admission) {
            is RosterSubscriptionAdmission.RetirementRequested -> admission.subscriptionId
            is RosterSubscriptionAdmission.RetirementJoined -> admission.subscriptionId
            else -> null
        }
        if (retiring == null) {
            // Refused, not reached, stopped, or nothing was subscribed: no retirement
            // of ours exists, so nothing is owed and nothing is retried.
            pending.remove(hostId)
            return
        }
        record.retiringId = retiring
        val observed = record.observed
        if (observed != null && observed.first == retiring) finish(hostId, record, observed.second)
    }

    private fun finish(hostId: HostId, record: Pending, acknowledged: Boolean) {
        if (pending[hostId] !== record) return
        pending.remove(hostId)
        // An unconfirmed retirement ends the channel; it is never followed by a retry.
        if (!acknowledged) return
        scope.launch {
            // Only the exact channel this refresh retired is re-subscribed. A replaced
            // channel subscribes through its own handshake, never through this.
            if (runtime.hostState(hostId)?.connectionGeneration == record.generation) {
                runtime.subscribeRoster(hostId)
            }
        }
    }
}
