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
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RemoveHostTarget
import io.github.rfairburn.pireviewgate.core.client.ui.EditHostAddressTarget
import io.github.rfairburn.pireviewgate.core.client.ui.UiCoverage
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionObservation
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import io.github.rfairburn.pireviewgate.permissions.LocalNetworkPermissionDeniedPanel

/**
 * The host screen.
 *
 * Every saved association is listed with its real endpoint, its real connection
 * state, and the full fingerprint this client remembers for it — never abbreviated,
 * because an abbreviated identity is not comparable. The operations offered here are
 * the local ones this client actually has: connect, disconnect, forget, and the
 * owner-side operations their negotiated capabilities allow.
 *
 * Remove is a local forget only. The confirmation the intent opens says so in fixed
 * text and never claims to stop anything remote.
 */
@Composable
fun HostsScreen(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
    listState: androidx.compose.foundation.lazy.LazyListState,
    modifier: Modifier = Modifier,
) {
    val hosts = state.hostStates

    if (hosts.isEmpty()) {
        Column(
            modifier = modifier
                .fillMaxSize()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.hosts_empty), style = MaterialTheme.typography.bodyLarge)
            Button(onClick = { onIntent(ClientIntent.RequestAddHost) }) {
                Text(stringResource(R.string.action_add_host))
            }
        }
        return
    }

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Button(
                onClick = { onIntent(ClientIntent.RequestAddHost) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.action_add_host)) }
        }
        items(hosts, key = { it.host.id.value }) { host ->
            HostCard(
                host = host,
                permission = state.localNetworkPermission,
                onIntent = onIntent,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HostCard(
    host: HostUiState,
    permission: LocalNetworkPermissionObservation?,
    onIntent: (ClientIntent) -> Unit,
) {
    var menuOpen by remember(host.host.id) { mutableStateOf(false) }
    val connected = host.connection == HostConnectionState.CONNECTED

    ClientCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = host.host.label.value,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
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
                        text = { Text(stringResource(R.string.action_connect)) },
                        enabled = !connected,
                        onClick = {
                            menuOpen = false
                            onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
                            onIntent(ClientIntent.ConnectHost(host.host.id, host.pendingConnectToken))
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_disconnect)) },
                        enabled = connected || host.host.reconnectSuppressed.not(),
                        onClick = {
                            menuOpen = false
                            onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
                            onIntent(ClientIntent.DisconnectHost(host.host.id))
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_create_session)) },
                        enabled = host.canCreateSession,
                        onClick = {
                            menuOpen = false
                            onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
                            onIntent(ClientIntent.RequestSessionCreate)
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_saved)) },
                        enabled = host.capabilities.supports(RosterWire.SAVED_CAPABILITY),
                        onClick = {
                            menuOpen = false
                            onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
                            onIntent(ClientIntent.ShowSaved(host.host.id))
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_edit_host_address)) },
                        onClick = {
                            menuOpen = false
                            onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
                            onIntent(ClientIntent.RequestEditHostAddress(EditHostAddressTarget(host.host.id, host.host.endpoint)))
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_remove_host)) },
                        onClick = {
                            menuOpen = false
                            onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
                            onIntent(
                                ClientIntent.RequestRemoveHost(
                                    RemoveHostTarget(
                                        hostId = host.host.id,
                                        label = host.host.label.value,
                                        endpointDisplayText = host.host.endpoint.displayText(),
                                    ),
                                ),
                            )
                        },
                    )
                }
            }
        }

        // Full endpoint, never ellipsized: the operator has to be able to read what
        // this association dials.
        Text(
            text = host.host.endpoint.displayText(),
            style = MaterialTheme.typography.bodyMedium,
            softWrap = true,
            overflow = TextOverflow.Clip,
            maxLines = Int.MAX_VALUE,
        )

        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ConnectionChip(host.connection)
            RosterFreshnessChip(host.roster?.freshness)
        }

        FactRow(
            stringResource(R.string.fact_connection_history),
            if (host.host.previouslyConnected) {
                stringResource(R.string.value_yes)
            } else {
                stringResource(R.string.value_no)
            },
        )
        FactRow(
            stringResource(R.string.fact_reconnect_suppressed),
            if (host.host.reconnectSuppressed) stringResource(R.string.value_yes) else stringResource(R.string.value_no),
        )
        FactRow(
            stringResource(R.string.fact_server_fingerprint),
            host.serverFingerprint ?: stringResource(R.string.value_unknown),
        )

        host.noticeText?.let { NoticeText(it) }

        if (permission != null && permission.needsPermission) {
            LocalNetworkPermissionDeniedPanel(
                observation = permission,
                targetDisplayText = host.host.endpoint.displayText(),
                onRequestAgain = { onIntent(ClientIntent.RequestLocalNetworkPermissionRetry(host.host.id)) },
                onOpenSettings = { onIntent(ClientIntent.OpenLocalNetworkPermissionSettings(host.host.id)) },
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onIntent(ClientIntent.ConnectHost(host.host.id, host.pendingConnectToken)) },
                enabled = !connected,
            ) { Text(stringResource(R.string.action_connect)) }
            OutlinedButton(
                onClick = { onIntent(ClientIntent.DisconnectHost(host.host.id)) },
            ) { Text(stringResource(R.string.action_disconnect)) }
        }
    }
}
