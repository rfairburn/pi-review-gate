package io.github.rfairburn.pireviewgate.permissions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionObservation

/**
 * Native rationale shown before an explicit local-network permission request.
 *
 * This dialog only explains why the current host needs LAN access and offers
 * Continue or Not now. The Android system prompt is launched separately by
 * [LocalNetworkPermissionLauncher.request] after the user chooses Continue. The text
 * uses the real app name and target host, not a development or phase label. When the
 * permission is granted or not required, nothing is rendered.
 */
@Composable
public fun LocalNetworkPermissionRationaleDialog(
    observation: LocalNetworkPermissionObservation,
    targetDisplayText: String,
    onContinue: () -> Unit,
    onNotNow: () -> Unit,
) {
    if (!observation.needsPermission) return
    val appName = stringResource(R.string.app_name)
    AlertDialog(
        onDismissRequest = onNotNow,
        title = {
            Text(stringResource(R.string.local_network_permission_rationale_title))
        },
        text = {
            Text(
                stringResource(
                    R.string.local_network_permission_rationale_body,
                    appName,
                    targetDisplayText,
                ),
            )
        },
        confirmButton = {
            TextButton(onClick = onContinue) {
                Text(stringResource(R.string.local_network_permission_continue))
            }
        },
        dismissButton = {
            TextButton(onClick = onNotNow) {
                Text(stringResource(R.string.local_network_permission_not_now))
            }
        },
    )
}

/**
 * Truthful denial or revocation panel for one local-network target.
 *
 * The panel never requests permission and never opens Settings by itself. The
 * caller wires [onRequestAgain] and [onOpenSettings] to explicit user actions.
 * Settings is offered only after an observed explicit denial without a remaining
 * rationale; a missing rationale before the first request is not treated as a
 * permanent denial. When the permission is granted or not required, nothing is
 * rendered.
 */
@Composable
public fun LocalNetworkPermissionDeniedPanel(
    observation: LocalNetworkPermissionObservation,
    targetDisplayText: String,
    onRequestAgain: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (!observation.needsPermission) return
    val appName = stringResource(R.string.app_name)
    val body = if (observation.settingsAffordanceSuggested) {
        stringResource(
            R.string.local_network_permission_denied_body_settings,
            appName,
            targetDisplayText,
        )
    } else {
        stringResource(
            R.string.local_network_permission_denied_body,
            appName,
            targetDisplayText,
        )
    }

    OutlinedCard(modifier = modifier) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = stringResource(R.string.local_network_permission_denied_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = body,
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onRequestAgain) {
                    Text(stringResource(R.string.local_network_permission_try_again))
                }
                if (observation.settingsAffordanceSuggested) {
                    TextButton(onClick = onOpenSettings) {
                        Text(stringResource(R.string.local_network_permission_open_settings))
                    }
                }
            }
        }
    }
}
