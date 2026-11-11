package io.github.rfairburn.pireviewgate.ui.client

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIdentityState
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientStorageState
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.SavedFirstReplyTimeoutEditor
import io.github.rfairburn.pireviewgate.core.hosts.AppAppearance
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionObservation
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionStatus

/**
 * The settings screen.
 *
 * Only what this client actually is: a viewer. It exposes the five remembered global
 * preferences with their source defaults — automatic reconnect off, this viewer's
 * remote native input and copy on, a 60-second Saved first-reply timeout, whole-app
 * diagnostic status/notice messaging off, and the app's own appearance light — plus
 * this device's own identity fingerprint when it is known and the state of its
 * private storage.
 *
 * There is deliberately no hosting control, no incoming-connection grant or revoke,
 * no listener control, and no owner-side history or policy control: this client hosts
 * nothing, so such a switch would be a control with no effect.
 */
@Composable
fun SettingsScreen(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        SwitchRow(
            title = stringResource(R.string.setting_auto_reconnect),
            description = stringResource(R.string.setting_auto_reconnect_body),
            checked = state.settings.autoReconnect,
            onCheckedChange = { onIntent(ClientIntent.SetAutoReconnectEnabled(it)) },
        )
        SwitchRow(
            title = stringResource(R.string.setting_viewer_remote_input),
            description = stringResource(R.string.setting_viewer_remote_input_body),
            checked = state.settings.viewerRemoteInputEnabled,
            onCheckedChange = { onIntent(ClientIntent.SetViewerRemoteInputEnabled(it)) },
        )
        SwitchRow(
            title = stringResource(R.string.setting_debug_input_messaging),
            description = stringResource(R.string.setting_debug_input_messaging_body),
            checked = state.settings.debugInputMessagingEnabled,
            onCheckedChange = { onIntent(ClientIntent.SetDebugInputMessagingEnabled(it)) },
        )
        SavedFirstReplyTimeoutRow(
            currentSeconds = state.settings.savedFirstReplyTimeoutSeconds,
            onSave = { onIntent(ClientIntent.SetSavedFirstReplyTimeoutSeconds(it)) },
        )
        AppearanceRow(
            selected = state.settings.appearance,
            onSelect = { onIntent(ClientIntent.SetAppearance(it)) },
        )

        SectionTitle(stringResource(R.string.settings_identity_section))
        IdentitySection(state.identity)

        SectionTitle(stringResource(R.string.settings_storage_section))
        Text(
            text = when (val storage = state.storage) {
                ClientStorageState.Unknown -> stringResource(R.string.storage_unknown)
                ClientStorageState.Healthy -> stringResource(R.string.storage_healthy)
                is ClientStorageState.Refused -> storageReason(storage.reason)
            },
            style = MaterialTheme.typography.bodyMedium,
        )

        SectionTitle(stringResource(R.string.settings_permission_section))
        Text(
            text = permissionText(state.localNetworkPermission),
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

/**
 * One editable global preference with an explicit save.
 *
 * The text is a local draft: changing it writes nothing and emits nothing. Only the
 * Save control emits the parsed value, and invalid text leaves that control disabled
 * with the fixed error below the field.
 */
@Composable
private fun SavedFirstReplyTimeoutRow(
    currentSeconds: Int,
    onSave: (Int) -> Unit,
) {
    var editor by remember(currentSeconds) {
        mutableStateOf(SavedFirstReplyTimeoutEditor.of(currentSeconds))
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(R.string.setting_saved_first_reply_timeout),
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            text = stringResource(R.string.setting_saved_first_reply_timeout_body),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = editor.draft,
            onValueChange = { editor = editor.edited(it) },
            label = { Text(stringResource(R.string.setting_saved_first_reply_timeout_field)) },
            isError = editor.showsError,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )
        if (editor.showsError) {
            NoticeText(
                stringResource(
                    R.string.setting_saved_first_reply_timeout_invalid,
                    NetworkSettings.MAX_SAVED_FIRST_REPLY_TIMEOUT_SECONDS,
                ),
            )
        }
        Button(
            onClick = { editor.parsedSeconds?.let(onSave) },
            enabled = editor.canSave,
        ) {
            Text(stringResource(R.string.setting_saved_first_reply_timeout_save))
        }
    }
}

/**
 * The saved appearance of the app's own surfaces.
 *
 * Selecting an option emits that one preference; the drawn selection is what was
 * saved rather than what was tapped, so the options move when the producer
 * republishes the stored value. Light is the shipped default and stays in effect
 * until a choice is saved. The two options form one selectable group, and each row
 * is the selectable control its own label belongs to, so the choice a person hears
 * is the choice their tap sends. The choice paints this app only: the terminal's
 * colors come from the host and are not part of any appearance.
 */
@Composable
private fun AppearanceRow(
    selected: AppAppearance,
    onSelect: (AppAppearance) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(R.string.setting_appearance),
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            text = stringResource(R.string.setting_appearance_body),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        androidx.compose.foundation.layout.Row(
            horizontalArrangement = Arrangement.spacedBy(24.dp),
            modifier = Modifier.selectableGroup(),
        ) {
            AppearanceOption(
                label = stringResource(R.string.setting_appearance_light),
                appearance = AppAppearance.LIGHT,
                selected = selected,
                onSelect = onSelect,
            )
            AppearanceOption(
                label = stringResource(R.string.setting_appearance_dark),
                appearance = AppAppearance.DARK,
                selected = selected,
                onSelect = onSelect,
            )
        }
    }
}

/**
 * One appearance option: the label and its radio are one selectable control.
 *
 * The row owns the selection, the radio role, and the tap, and it merges the label
 * and the indicator into that one control, so an announced option always names which
 * appearance its tap selects. The indicator is never a second independent target.
 */
@Composable
private fun AppearanceOption(
    label: String,
    appearance: AppAppearance,
    selected: AppAppearance,
    onSelect: (AppAppearance) -> Unit,
) {
    val isSelected = appearance == selected
    androidx.compose.foundation.layout.Row(
        modifier = Modifier
            .selectable(
                selected = isSelected,
                role = Role.RadioButton,
                onClick = { onSelect(appearance) },
            )
            // Explicit rather than incidental: this control owns its label text.
            .semantics(mergeDescendants = true) { /* the label belongs to this control */ },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RadioButton(selected = isSelected, onClick = null)
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

/** One labelled preference with its native switch. */
@Composable
private fun SwitchRow(
    title: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    androidx.compose.foundation.layout.Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(),
        )
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleLarge)
}

/**
 * This device's own peer identity.
 *
 * A fingerprint is shown in full and never invented: an unknown or uninitialized
 * identity says which, and a refused read reports its fixed storage reason instead of
 * looking like a fresh device.
 */
@Composable
private fun IdentitySection(identity: ClientIdentityState) {
    when (identity) {
        ClientIdentityState.Unknown -> Text(
            stringResource(R.string.identity_unknown),
            style = MaterialTheme.typography.bodyMedium,
        )
        ClientIdentityState.NotInitialized -> Text(
            stringResource(R.string.identity_not_initialized),
            style = MaterialTheme.typography.bodyMedium,
        )
        is ClientIdentityState.Refused -> Text(
            stringResource(R.string.identity_refused, storageReason(identity.reason)),
            style = MaterialTheme.typography.bodyMedium,
        )
        is ClientIdentityState.Ready -> {
            Text(
                stringResource(R.string.identity_fingerprint_label),
                style = MaterialTheme.typography.labelLarge,
            )
            Text(
                text = identity.fingerprint,
                style = MaterialTheme.typography.bodyLarge,
                softWrap = true,
                overflow = TextOverflow.Clip,
                maxLines = Int.MAX_VALUE,
            )
        }
    }
}

@Composable
private fun permissionText(permission: LocalNetworkPermissionObservation?): String {
    if (permission == null) return stringResource(R.string.permission_unknown)
    return when (permission.status) {
        LocalNetworkPermissionStatus.NOT_REQUIRED -> stringResource(R.string.permission_not_required)
        LocalNetworkPermissionStatus.GRANTED -> stringResource(R.string.permission_granted)
        LocalNetworkPermissionStatus.NOT_GRANTED ->
            if (permission.settingsAffordanceSuggested) {
                stringResource(R.string.permission_denied_settings)
            } else {
                stringResource(R.string.permission_denied)
            }
    }
}

@Composable
private fun storageReason(reason: StorageFailureReason): String = when (reason) {
    StorageFailureReason.MISSING_INITIALIZED -> stringResource(R.string.storage_missing_initialized)
    StorageFailureReason.UNSAFE_OBJECT -> stringResource(R.string.storage_unsafe_object)
    StorageFailureReason.MALFORMED -> stringResource(R.string.storage_malformed)
    StorageFailureReason.UNSUPPORTED_VERSION -> stringResource(R.string.storage_unsupported_version)
    StorageFailureReason.UNREADABLE -> stringResource(R.string.storage_unreadable)
    StorageFailureReason.CHANGED -> stringResource(R.string.storage_changed)
    StorageFailureReason.WRITE_FAILED -> stringResource(R.string.storage_write_failed)
    StorageFailureReason.UNAVAILABLE -> stringResource(R.string.storage_unavailable)
}
