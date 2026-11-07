package io.github.rfairburn.pireviewgate.ui.client

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.AgentActivity
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.InputObservation
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle

/**
 * Shared native status widgets.
 *
 * Everything here is a Material control: cards, chips, and labelled facts. Nothing
 * imitates a text sidebar, draws an ASCII status bar, or embeds a TUI inside a
 * native screen. Unknown is always spelled out as unknown rather than shortened to
 * a dash a reader could mistake for zero or no.
 */

@Composable
fun ConnectionChip(state: HostConnectionState, modifier: Modifier = Modifier) {
    val label = when (state) {
        HostConnectionState.DISCONNECTED -> stringResource(R.string.connection_disconnected)
        HostConnectionState.CONNECTING -> stringResource(R.string.connection_connecting)
        HostConnectionState.PAIRING -> stringResource(R.string.connection_pairing)
        HostConnectionState.RETRYING -> stringResource(R.string.connection_retrying)
        HostConnectionState.CONNECTED -> stringResource(R.string.connection_connected)
        HostConnectionState.ERROR -> stringResource(R.string.connection_error)
    }
    StatusChip(label, modifier)
}

/**
 * One non-interactive status chip.
 *
 * It is a [Surface], not a button: a status word that looked tappable would offer a
 * control that does nothing.
 */
@Composable
fun StatusChip(label: String, modifier: Modifier = Modifier, emphasized: Boolean = false) {
    Surface(
        modifier = modifier,
        shape = MaterialTheme.shapes.small,
        color = if (emphasized) {
            MaterialTheme.colorScheme.secondaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        },
        contentColor = if (emphasized) {
            MaterialTheme.colorScheme.onSecondaryContainer
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

/** A plain non-interactive chip used for a single status word. */
@Composable
fun TextChip(label: String, modifier: Modifier = Modifier) {
    StatusChip(label, modifier)
}

/**
 * Roster freshness chip. A `null` freshness means this host has never produced a
 * snapshot, which is stated as such instead of being shown as an empty list.
 */
@Composable
fun RosterFreshnessChip(freshness: RosterFreshness?, modifier: Modifier = Modifier) {
    val label = when (freshness) {
        null -> stringResource(R.string.roster_never_reported)
        RosterFreshness.CURRENT -> stringResource(R.string.roster_current)
        RosterFreshness.STALE -> stringResource(R.string.roster_stale)
    }
    StatusChip(label, modifier, emphasized = true)
}

/** Agent activity chip. `null` means the lifecycle is not alive, so there is none. */
@Composable
fun AgentActivityChip(activity: AgentActivity?, modifier: Modifier = Modifier) {
    val label = when (activity) {
        AgentActivity.RUNNING -> stringResource(R.string.activity_running)
        AgentActivity.WAITING -> stringResource(R.string.activity_waiting)
        AgentActivity.IDLE -> stringResource(R.string.activity_idle)
        AgentActivity.UNKNOWN -> stringResource(R.string.activity_unknown)
        null -> stringResource(R.string.activity_not_applicable)
    }
    StatusChip(label, modifier)
}

@Composable
fun InputObservationChip(observation: InputObservation, modifier: Modifier = Modifier) {
    val label = when (observation) {
        InputObservation.PENDING -> stringResource(R.string.input_pending)
        InputObservation.NONE -> stringResource(R.string.input_none)
        InputObservation.UNKNOWN -> stringResource(R.string.input_unknown)
    }
    StatusChip(label, modifier)
}

/** Lifecycle chip: the owner's own lifecycle word, with exit code when it has one. */
@Composable
fun LifecycleChip(lifecycle: RosterLifecycle, exitCode: Double?, modifier: Modifier = Modifier) {
    val base = when (lifecycle) {
        RosterLifecycle.STARTING -> stringResource(R.string.lifecycle_starting)
        RosterLifecycle.ALIVE -> stringResource(R.string.lifecycle_alive)
        RosterLifecycle.EXITED -> stringResource(R.string.lifecycle_exited)
        RosterLifecycle.ERROR -> stringResource(R.string.lifecycle_error)
    }
    val label = if (exitCode != null) "$base ${exitCode.toInt()}" else base
    StatusChip(label, modifier)
}

/** One owner-reported count, spelled out when the owner did not report one. */
@Composable
fun CountText(value: Long?, modifier: Modifier = Modifier) {
    Text(
        text = value?.toString() ?: stringResource(R.string.value_unknown),
        style = MaterialTheme.typography.bodyMedium,
        modifier = modifier,
    )
}

/** One labelled fact inside an expanded card. */
@Composable
fun FactRow(label: String, value: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.wrapContentSize(),
        )
        Text(text = value, style = MaterialTheme.typography.bodyMedium)
    }
}

/** A card container used for one host or one session row. */
@Composable
fun ClientCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) { content() }
    }
}

/** A fixed, non-editable notice line. */
@Composable
fun NoticeText(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.fillMaxWidth(),
    )
}

/** A short centred message for an empty list. */
@Composable
fun EmptyMessage(text: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = text, style = MaterialTheme.typography.bodyLarge)
    }
}
