package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.runtime.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.*
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationObservedRow

/** Retains the last COMPLETE observation across channel replacement, not partial transfers. */
class ClientProjection {
    private val retained = mutableMapOf<HostId, RosterProjection>()

    fun hosts(registry: ConnectionRegistrySnapshot, runtime: ClientRuntimeState): List<HostUiState> {
        retained.keys.retainAll(registry.hosts.map { it.hostId }.toSet())
        return registry.hosts.map { connection ->
            val lane = runtime.hosts.firstOrNull {
                it.hostId == connection.hostId && it.connectionGeneration == connection.generation
            }
            val roster = lane?.roster
            val received = roster?.projection?.takeIf { it.state != RosterProjectionState.EMPTY }
            if (received != null) retained[connection.hostId] = received
            val complete = received ?: retained[connection.hostId]
            val current = received?.state == RosterProjectionState.CURRENT &&
                lane?.lane == HostLanePhase.ATTACHED && connection.phase == HostConnectionPhase.CONNECTED
            val snapshot = complete?.let { projection ->
                val run = projection.hostRunId ?: return@let null
                val revision = projection.revision ?: return@let null
                RosterSnapshot(
                    if (current) RosterFreshness.CURRENT else RosterFreshness.STALE,
                    run, revision,
                    projection.rows.map { metadata ->
                        SessionUiState(connection.hostId, connection.label, run, !current, revision, metadata)
                    },
                )
            }
            HostUiState(
                host = ConfiguredHost(connection.hostId, HostLabel.parse(connection.label), connection.endpoint,
                    connection.previouslyConnected, connection.reconnectSuppressed),
                connection = when (connection.phase) {
                    HostConnectionPhase.NEVER, HostConnectionPhase.DISCONNECTED -> HostConnectionState.DISCONNECTED
                    HostConnectionPhase.CONNECTING -> HostConnectionState.CONNECTING
                    HostConnectionPhase.PAIRING -> HostConnectionState.PAIRING
                    HostConnectionPhase.RETRYING -> HostConnectionState.RETRYING
                    HostConnectionPhase.CONNECTED -> HostConnectionState.CONNECTED
                    HostConnectionPhase.ERROR -> HostConnectionState.ERROR
                },
                roster = snapshot,
                // No acknowledged minor is published by the portable lane. Preserve unknown.
                capabilities = HostCapabilities(
                    negotiated = roster != null && roster.phase != RosterClientPhase.AWAITING_ACK &&
                        roster.phase != RosterClientPhase.FAILED && roster.phase != RosterClientPhase.DETACHED,
                    close = capability(roster, roster?.supportsClose),
                    create = capability(roster, roster?.supportsCreate),
                    saved = capability(roster, roster?.supportsSaved),
                    rename = capability(roster, roster?.supportsRename),
                    rosterSlot = capability(roster, roster?.supportsRosterSlot),
                ),
                savedPolicy = when (roster?.savedPolicy?.deleteExposed) {
                    true -> SavedPolicyStatus.EXPOSED
                    false -> SavedPolicyStatus.OFF
                    null -> SavedPolicyStatus.UNKNOWN
                },
                serverFingerprint = connection.peerFingerprint,
                noticeText = listOfNotNull(
                    connection.reason.takeUnless { it == HostConnectionReason.NONE }?.name,
                    registry.notice?.takeIf { it.hostId == null || it.hostId == connection.hostId }?.reason?.name,
                ).joinToString(" · ").takeIf { it.isNotEmpty() },
            )
        }
    }

    private fun capability(roster: RosterClientState?, supported: Boolean?): CapabilityStatus = when {
        roster == null || roster.phase == RosterClientPhase.AWAITING_ACK ||
            roster.phase == RosterClientPhase.FAILED || roster.phase == RosterClientPhase.DETACHED -> CapabilityStatus.UNKNOWN
        supported == true -> CapabilityStatus.SUPPORTED
        else -> CapabilityStatus.UNSUPPORTED
    }
}

fun List<HostUiState>.presentationRows(): List<RemotePresentationObservedRow> = flatMap { host ->
    host.rows.map { RemotePresentationObservedRow(it.hostId, it.hostRunId, it.rowId, it.metadata.rosterSlotId) }
}

/** Exact event key; a delayed old-channel settlement cannot settle a replacement operation. */
data class OperationKey(val hostId: HostId, val channelGeneration: Long, val kind: RosterOperationKind, val requestId: String)

/** Admission may return AFTER settlement. Keep only bounded, in-flight correlation. */
class OperationCorrelation<T : Any>(private val capacity: Int = 128) {
    private val accepted = LinkedHashMap<OperationKey, T>()
    private val early = LinkedHashMap<OperationKey, RosterClientEvent.OperationSettled>()
    private val admitting = mutableMapOf<Pair<HostId, Long>, Int>()
    fun begin(hostId: HostId, generation: Long) {
        val key = hostId to generation
        admitting[key] = (admitting[key] ?: 0) + 1
    }
    fun accept(key: OperationKey, value: T): Pair<T, RosterClientEvent.OperationSettled>? {
        val event = early.remove(key)
        if (event != null) return value to event
        check(accepted.size < capacity) { "operation correlation capacity exceeded" }
        accepted[key] = value
        return null
    }
    fun end(hostId: HostId, generation: Long) {
        val key = hostId to generation
        val left = (admitting[key] ?: 1) - 1
        if (left <= 0) {
            admitting.remove(key)
            early.keys.removeAll { it.hostId == hostId && it.channelGeneration == generation }
        } else admitting[key] = left
    }
    fun settle(key: OperationKey, event: RosterClientEvent.OperationSettled): Pair<T, RosterClientEvent.OperationSettled>? {
        accepted.remove(key)?.let { return it to event }
        if ((admitting[key.hostId to key.channelGeneration] ?: 0) > 0) {
            check(early.size < capacity) { "early settlement capacity exceeded" }
            early[key] = event
        }
        return null
    }
}
