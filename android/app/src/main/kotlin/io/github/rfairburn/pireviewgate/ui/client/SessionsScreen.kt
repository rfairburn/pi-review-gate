package io.github.rfairburn.pireviewgate.ui.client

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.EmptyHostRow
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.RenameTarget
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.sessionRowNeighbours
import io.github.rfairburn.pireviewgate.core.client.ui.SessionActionTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiCoverage
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationMovePosition
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteNativePersistence
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire

/**
 * The unified session list.
 *
 * One list across every configured host, in saved host order and then in each
 * owner's own row order, so a row stays where its owner put it. Every card names the
 * host it came from because two owners may report the same row id and only the
 * qualifying triple tells them apart.
 *
 * Hosts that contribute no rows stay visible with the honest reason: never reported,
 * positively empty, or retained but stale. Nothing here is sample data, and an
 * unknown count is never rendered as zero.
 */
@Composable
fun SessionsScreen(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
    listState: androidx.compose.foundation.lazy.LazyListState,
    modifier: Modifier = Modifier,
) {
    val sessions = state.sessions
    val emptyHosts = state.emptyHosts

    if (sessions.isEmpty() && emptyHosts.isEmpty()) {
        EmptyMessage(
            text = stringResource(R.string.sessions_empty_no_hosts),
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
        )
        return
    }

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(sessions, key = { "${it.hostId.value}|${it.hostRunId}|${it.rowId}" }) { row ->
            SessionCard(
                row = row,
                host = state.hostState(row.hostId),
                orderedRows = sessions,
                covered = state.dialogs.hasModal,
                onIntent = onIntent,
            )
        }
        items(emptyHosts, key = { "empty-${it.host.host.id.value}" }) { empty ->
            EmptyHostCard(empty = empty, onIntent = onIntent)
        }
    }
}

/**
 * One session card.
 *
 * The action menu is capability-gated and stale-gated: an unacknowledged capability
 * is never offered as support, and a row from a view the client is no longer being
 * fed is labelled stale rather than being treated as live. Opening the menu reports
 * menu coverage so terminal input is suspended and in-flight proofs retire.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionCard(
    row: SessionUiState,
    host: HostUiState?,
    orderedRows: List<SessionUiState>,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    var expanded by remember(row.hostId, row.rowId) { mutableStateOf(false) }
    var menuOpen by remember(row.hostId, row.rowId) { mutableStateOf(false) }
    val capabilities: HostCapabilities = host?.capabilities ?: HostCapabilities.UNKNOWN
    val live = host?.connection == HostConnectionState.CONNECTED &&
        host.roster?.freshness == RosterFreshness.CURRENT
    val renameTarget = RenameTarget.of(row)
    // Reordering is addressed by presentation identities, and only ever relative to a
    // neighbour that is itself addressable: no index, no label, no row id alone. The
    // neighbours come from the same globally ordered projection that is rendered, so
    // a move can cross a host boundary — the presentation order is host-independent.
    val (above, below) = sessionRowNeighbours(orderedRows, row)
    val identity = row.presentationIdentity
    // Opening the terminal selects a row for the controller to write, so it is
    // attributed to that row's own commit proof. The semantic key is the frozen target
    // as drawn: a row whose title or revision changed retires its previous standing
    // synchronously, while an unrelated host reporting changes nothing here.
    val selectTarget = SessionActionTarget.of(row)
    val selectGuard = rememberUiActionGuard(
        proof = row.selectProof,
        semanticKey = selectTarget,
        covered = covered,
    )
    val aboveIdentity = above?.presentationIdentity
    val belowIdentity = below?.presentationIdentity

    /** Closes the menu, reports the coverage change, then acts on the frozen row. */
    fun act(block: () -> Unit) {
        menuOpen = false
        onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
        block()
    }

    // The action lives on the card itself, not in the overflow menu. A dropdown is a
    // popup that takes window focus, which retires the card's own commit standing; an
    // item inside it would then be spending a proof its window had already invalidated.
    ClientCard {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = row.displayTitle, style = MaterialTheme.typography.titleMedium)
                Text(
                    text = stringResource(R.string.session_host_context, row.hostLabel),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(
                onClick = {
                    row.selectProof?.let { proof ->
                        selectGuard.attempt {
                            onIntent(ClientIntent.EnterTerminal(selectTarget, proof))
                        }
                    }
                },
                enabled = live && row.selectProof != null,
                modifier = selectGuard.modifier,
            ) { Text(stringResource(R.string.action_open_terminal)) }
            Box {
                TextButton(
                    onClick = {
                        menuOpen = true
                        onIntent(ClientIntent.UiCoverageChanged(UiCoverage.OPEN_MENU))
                    },
                ) { Text(stringResource(R.string.action_menu)) }
                DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = {
                        menuOpen = false
                        onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
                    },
                ) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_rename)) },
                        enabled = live &&
                            capabilities.supports(RosterWire.RENAME_CAPABILITY) &&
                            renameTarget != null,
                        onClick = {
                            act { renameTarget?.let { onIntent(ClientIntent.RequestSessionRename(it)) } }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_close)) },
                        enabled = live && capabilities.supports(RosterWire.CLOSE_CAPABILITY),
                        onClick = {
                            act { onIntent(ClientIntent.RequestSessionClose(SessionActionTarget.of(row))) }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_saved)) },
                        enabled = capabilities.supports(RosterWire.SAVED_CAPABILITY),
                        onClick = { act { onIntent(ClientIntent.ShowSaved(row.hostId)) } },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_move_up)) },
                        enabled = live && identity != null && aboveIdentity != null,
                        onClick = {
                            act {
                                val mine = identity
                                val above = aboveIdentity
                                if (mine != null && above != null) {
                                    onIntent(
                                        ClientIntent.MoveSessionRow(
                                            mine,
                                            RemotePresentationMovePosition.BEFORE,
                                            above,
                                        ),
                                    )
                                }
                            }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_move_down)) },
                        enabled = live && identity != null && belowIdentity != null,
                        onClick = {
                            act {
                                val mine = identity
                                val below = belowIdentity
                                if (mine != null && below != null) {
                                    onIntent(
                                        ClientIntent.MoveSessionRow(
                                            mine,
                                            RemotePresentationMovePosition.AFTER,
                                            below,
                                        ),
                                    )
                                }
                            }
                        },
                    )
                    DropdownMenuItem(
                        text = {
                            Text(
                                stringResource(
                                    if (expanded) R.string.action_hide_details else R.string.action_show_details,
                                ),
                            )
                        },
                        onClick = { act { expanded = !expanded } },
                    )
                }
            }
        }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LifecycleChip(row.metadata.lifecycle, row.metadata.exitCode)
            AgentActivityChip(row.agentActivity)
            InputObservationChip(row.inputObservation)
            if (row.stale) TextChip(stringResource(R.string.roster_stale))
            row.metadata.rosterSlotId?.let { TextChip(stringResource(R.string.session_slot, it)) }
        }

        row.metadata.error?.let { NoticeText(stringResource(R.string.session_error, it)) }

        if (expanded) SessionDetails(row)
    }
}

/**
 * Every current owner fact for one row.
 *
 * Nothing is summarised away: workspace, live process, busy and pending-input
 * observations, the input surface, both ownership counts and both activity-intent
 * counts, exit code, error text, the roster slot, and the native identity with its
 * epoch, name, and persistence. Absences are spelled out instead of blanked.
 */
@Composable
private fun SessionDetails(row: SessionUiState) {
    val metadata = row.metadata
    FactRow(stringResource(R.string.fact_row_label), metadata.label)
    FactRow(stringResource(R.string.fact_workspace), metadata.workspace)
    FactRow(
        stringResource(R.string.fact_live_process),
        if (metadata.hasLiveProcess) stringResource(R.string.value_yes) else stringResource(R.string.value_no),
    )
    FactRow(stringResource(R.string.fact_busy), triState(metadata.busy))
    FactRow(stringResource(R.string.fact_pending_input), triState(metadata.pendingInput))
    FactRow(
        stringResource(R.string.fact_input_surface),
        if (metadata.inputSurface) stringResource(R.string.value_yes) else stringResource(R.string.value_no),
    )
    FactRow(stringResource(R.string.fact_background_tasks), countOrUnknown(metadata.backgroundTasks))
    FactRow(stringResource(R.string.fact_background_shells), countOrUnknown(metadata.backgroundShells))
    FactRow(stringResource(R.string.fact_active_tasks), countOrUnknown(metadata.activeTasks))
    FactRow(stringResource(R.string.fact_active_shells), countOrUnknown(metadata.activeShells))
    FactRow(
        stringResource(R.string.fact_exit_code),
        metadata.exitCode?.let { it.toInt().toString() } ?: stringResource(R.string.value_unknown),
    )
    FactRow(stringResource(R.string.fact_error), metadata.error ?: stringResource(R.string.value_none))
    FactRow(
        stringResource(R.string.fact_roster_slot),
        metadata.rosterSlotId ?: stringResource(R.string.value_none),
    )

    val native = metadata.nativeSession
    if (native == null) {
        NoticeText(stringResource(R.string.session_no_native))
    } else {
        FactRow(stringResource(R.string.fact_native_id), native.sessionId)
        FactRow(stringResource(R.string.fact_native_epoch), native.epoch.toString())
        FactRow(stringResource(R.string.fact_native_name), native.name)
        FactRow(stringResource(R.string.fact_native_persistence), persistenceLabel(native.persistence))
    }

    if (metadata.activity.isEmpty()) {
        NoticeText(stringResource(R.string.session_no_activity))
    } else {
        Text(stringResource(R.string.session_activity_lines), style = MaterialTheme.typography.labelLarge)
        metadata.activity.forEach { line -> NoticeText(line) }
    }
}

/** One host that currently contributes no rows, with the honest reason. */
@Composable
private fun EmptyHostCard(empty: EmptyHostRow, onIntent: (ClientIntent) -> Unit) {
    val host = empty.host
    ClientCard {
        Text(text = host.host.label.value, style = MaterialTheme.typography.titleMedium)
        Text(
            text = host.host.endpoint.displayText(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = when (empty) {
                is EmptyHostRow.NeverReported -> stringResource(R.string.empty_host_never_reported)
                is EmptyHostRow.ReportedEmpty -> stringResource(R.string.empty_host_reported_empty)
                is EmptyHostRow.Stale -> stringResource(R.string.empty_host_stale)
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        Button(onClick = { onIntent(ClientIntent.ConnectHost(host.host.id, host.pendingConnectToken)) }) {
            Text(stringResource(R.string.action_connect))
        }
    }
}

@Composable
private fun triState(value: Boolean?): String = when (value) {
    true -> stringResource(R.string.value_yes)
    false -> stringResource(R.string.value_no)
    null -> stringResource(R.string.value_unknown)
}

@Composable
private fun countOrUnknown(value: Long?): String =
    value?.toString() ?: stringResource(R.string.value_unknown)

@Composable
private fun persistenceLabel(persistence: RemoteNativePersistence?): String = when (persistence) {
    RemoteNativePersistence.SAVED -> stringResource(R.string.persistence_saved)
    RemoteNativePersistence.UNSAVED -> stringResource(R.string.persistence_unsaved)
    RemoteNativePersistence.UNKNOWN, null -> stringResource(R.string.value_unknown)
}
