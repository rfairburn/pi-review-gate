package io.github.rfairburn.pireviewgate.ui.client

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialogDefaults
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import android.os.SystemClock
import kotlinx.coroutines.delay
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.AddHostDialog
import io.github.rfairburn.pireviewgate.core.client.ui.EditHostAddressDialog
import io.github.rfairburn.pireviewgate.core.hosts.HostAddress
import io.github.rfairburn.pireviewgate.core.client.ui.ClientDialogKind
import io.github.rfairburn.pireviewgate.core.client.ui.ClientDraft
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.CloseSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.CreateSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.FirstContactConsentDialog
import io.github.rfairburn.pireviewgate.core.client.ui.FirstContactConsentTarget
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.client.ui.RemoveHostDialog
import io.github.rfairburn.pireviewgate.core.client.ui.RemoveHostTarget
import io.github.rfairburn.pireviewgate.core.client.ui.RenameSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.SavedDeleteDialog
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof

/**
 * The dialog layer.
 *
 * Every dialog here is a real Material dialog, and every submitting or destructive
 * control inside one is commit-guarded: it emits only while the dialog window can
 * prove the frame it is standing in was submitted, and — where the dialog names an
 * identity — only while that identity is fully inside the visible frame.
 *
 * Two things are stated per dialog rather than inherited from the screen:
 *
 * - [coveredDialog] is whether *another window* is on top of this dialog. The dialog
 *   itself is the modal over the terminal, and that never retires its own standing;
 *   only a further dialog above it does.
 * - `requiredCriticalLines` is what this dialog must have fully visible to act, from
 *   zero for an intentionally identity-free confirmation to the full set of identity
 *   lines for a server-key consent.
 *
 * The dialog states themselves come from the controller, and each carries the frozen
 * target it was drawn for. A metadata change underneath an open dialog therefore
 * cannot retarget it: the dialog keeps naming what the operator looked at, and the
 * controller refuses it against its own facts.
 */
@Composable
fun ClientDialogLayer(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
) {
    val dialogs = state.dialogs

    dialogs.addHost?.let {
        AddHostDialogView(it, dialogs.isCovered(ClientDialogKind.ADD_HOST), onIntent)
    }
    dialogs.editHostAddress?.let {
        EditHostAddressDialogView(it, dialogs.isCovered(ClientDialogKind.EDIT_HOST_ADDRESS), onIntent)
    }
    dialogs.removeHost?.let {
        RemoveHostDialogView(it, dialogs.isCovered(ClientDialogKind.REMOVE_HOST), onIntent)
    }
    dialogs.firstContactConsent?.let {
        ConsentDialogView(it, dialogs.isCovered(ClientDialogKind.FIRST_CONTACT_CONSENT), onIntent)
    }
    dialogs.createSession?.let {
        CreateSessionDialogView(it, dialogs.isCovered(ClientDialogKind.CREATE_SESSION), onIntent)
    }
    dialogs.renameSession?.let {
        RenameDialogView(it, dialogs.isCovered(ClientDialogKind.RENAME_SESSION), onIntent)
    }
    dialogs.closeSession?.let {
        CloseDialogView(it, dialogs.isCovered(ClientDialogKind.CLOSE_SESSION), onIntent)
    }
    dialogs.savedDelete?.let {
        SavedDeleteDialogView(it, dialogs.isCovered(ClientDialogKind.SAVED_DELETE), onIntent)
    }
}

/**
 * One dialog: title, a scrollable body owned by the gate, and a button row. The whole
 * body runs inside [UiProofGate], which attaches to this dialog's own window rather
 * than the activity's, so content scrolled out of the body is out of the frame.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ClientAlertDialog(
    title: String,
    onDismiss: () -> Unit,
    covered: Boolean,
    proof: UiActionProof,
    requiredCriticalLines: Int,
    semanticKey: Any,
    body: @Composable (ProofGate) -> Unit,
) {
    BasicAlertDialog(onDismissRequest = onDismiss) {
        Surface(
            shape = AlertDialogDefaults.shape,
            color = AlertDialogDefaults.containerColor,
            tonalElevation = AlertDialogDefaults.TonalElevation,
        ) {
            UiProofGate(
                proof = proof,
                semanticKey = semanticKey,
                covered = covered,
                requiredCriticalLines = requiredCriticalLines,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp),
            ) { gate ->
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(title, style = MaterialTheme.typography.titleLarge)
                    body(gate)
                    if (!gate.commitReportingAvailable) {
                        Text(
                            text = stringResource(R.string.commit_unavailable_notice),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
    }
}

/** The dismiss control shared by every dialog. */
@Composable
private fun DismissButton(onDismiss: () -> Unit) {
    TextButton(onClick = onDismiss) { Text(stringResource(R.string.dialog_dismiss)) }
}

/**
 * Milliseconds left on a controller-issued monotonic deadline, as a display value.
 *
 * This is a display clock only: it ticks against the same monotonic clock the
 * controller used, and expiring here only stops the UI from inviting an approval.
 * The controller owns retiring the consent.
 */
@Composable
private fun remainingMonotonicMillis(deadlineAtMonotonicMillis: Long?): Long? {
    if (deadlineAtMonotonicMillis == null) return null
    var now by remember(deadlineAtMonotonicMillis) { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(deadlineAtMonotonicMillis) {
        while (now < deadlineAtMonotonicMillis) {
            delay(1_000L)
            now = SystemClock.elapsedRealtime()
        }
    }
    return deadlineAtMonotonicMillis - now
}

// ---------------------------------------------------------------------------
// Add host
// ---------------------------------------------------------------------------

@Composable
private fun AddHostDialogView(
    dialog: AddHostDialog,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    val labelValid = dialog.labelDraft.isEmpty() || HostLabel.isValid(dialog.labelDraft)
    val hostValid = dialog.hostDraft.isEmpty() || Endpoint.isValidHost(dialog.hostDraft)
    val portValid = dialog.portDraft.isEmpty() || Endpoint.parsePortOrNull(dialog.portDraft) != null
    val ready = dialog.labelDraft.isNotEmpty() && dialog.hostDraft.isNotEmpty() &&
        dialog.portDraft.isNotEmpty() && labelValid && hostValid && portValid

    ClientAlertDialog(
        title = stringResource(R.string.add_host_title),
        onDismiss = { onIntent(ClientIntent.DismissDialog(ClientDialogKind.ADD_HOST)) },
        covered = covered,
        proof = dialog.proof,
        // Nothing identity-bearing to compare here: the gate still requires an actual
        // committed frame for the Save control, and nothing else.
        requiredCriticalLines = 0,
        // The key is the drawn form itself, drafts included. Keying on the proof target
        // alone would let a same-length edit keep spending the frame drawn before it.
        semanticKey = dialog,
    ) { gate ->
        OutlinedTextField(
            value = dialog.labelDraft,
            onValueChange = {
                gate.retireForEdit()
                onIntent(ClientIntent.UpdateDraft(ClientDraft.HostForm(it, dialog.hostDraft, dialog.portDraft)))
            },
            label = { Text(stringResource(R.string.add_host_label_field)) },
            isError = !labelValid,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = dialog.hostDraft,
            onValueChange = {
                gate.retireForEdit()
                onIntent(ClientIntent.UpdateDraft(ClientDraft.HostForm(dialog.labelDraft, it, dialog.portDraft)))
            },
            label = { Text(stringResource(R.string.add_host_host_field)) },
            isError = !hostValid,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = dialog.portDraft,
            onValueChange = {
                gate.retireForEdit()
                onIntent(ClientIntent.UpdateDraft(ClientDraft.HostForm(dialog.labelDraft, dialog.hostDraft, it)))
            },
            label = { Text(stringResource(R.string.add_host_port_field)) },
            isError = !portValid,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (!labelValid) NoticeText(stringResource(R.string.error_label_invalid))
        if (!hostValid) NoticeText(stringResource(R.string.error_host_invalid))
        if (!portValid) NoticeText(stringResource(R.string.error_port_invalid))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            DismissButton { onIntent(ClientIntent.DismissDialog(ClientDialogKind.ADD_HOST)) }
            Button(
                onClick = {
                    gate.attempt {
                        onIntent(
                            ClientIntent.SubmitNewHost(
                                label = dialog.labelDraft,
                                host = dialog.hostDraft,
                                port = dialog.portDraft,
                                proof = dialog.proof,
                            ),
                        )
                    }
                },
                enabled = ready,
            ) { Text(stringResource(R.string.add_host_submit)) }
        }
    }
}

// ---------------------------------------------------------------------------
// Edit address
// ---------------------------------------------------------------------------

@Composable
private fun EditHostAddressDialogView(
    dialog: EditHostAddressDialog,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    val valid = HostAddress.parseOrNull(dialog.addressDraft) != null
    val dismiss = { onIntent(ClientIntent.DismissDialog(ClientDialogKind.EDIT_HOST_ADDRESS)) }
    ClientAlertDialog(
        title = stringResource(R.string.action_edit_host_address),
        onDismiss = dismiss,
        covered = covered,
        proof = dialog.proof,
        requiredCriticalLines = 3,
        semanticKey = dialog,
    ) { gate ->
        gate.Body {
            gate.CriticalIdentityText(key = "label", value = dialog.label)
            gate.CriticalIdentityText(key = "old-endpoint", value = dialog.target.expectedOldEndpoint.displayText())
            Text(stringResource(R.string.edit_host_address_port, dialog.target.expectedOldEndpoint.port))
            OutlinedTextField(
                value = dialog.addressDraft,
                onValueChange = {
                    gate.retireForEdit()
                    onIntent(ClientIntent.UpdateDraft(ClientDraft.HostAddressForm(dialog.target, it, dialog.proof)))
                },
                label = { Text(stringResource(R.string.add_host_host_field)) },
                isError = !valid,
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            // Full draft as well as field: horizontally scrolled input is not identity evidence.
            gate.CriticalIdentityText(key = "new-address", value = dialog.addressDraft)
            if (!valid) NoticeText(stringResource(R.string.error_host_invalid))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            TextButton(onClick = dismiss) { Text(stringResource(R.string.action_cancel_address_edit)) }
            Button(
                onClick = {
                    gate.attempt {
                        onIntent(ClientIntent.SaveHostAddressAndReconnect(dialog.target, dialog.addressDraft, dialog.proof))
                    }
                },
                enabled = valid,
            ) { Text(stringResource(R.string.action_save_address_and_reconnect)) }
        }
    }
}

// ---------------------------------------------------------------------------
// Remove host
// ---------------------------------------------------------------------------

@Composable
private fun RemoveHostDialogView(
    dialog: RemoveHostDialog,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    ClientAlertDialog(
        title = stringResource(R.string.remove_host_title),
        onDismiss = { onIntent(ClientIntent.DismissDialog(ClientDialogKind.REMOVE_HOST)) },
        covered = covered,
        proof = dialog.proof,
        requiredCriticalLines = 2,
        semanticKey = dialog,
    ) { gate ->
        gate.Body {
            gate.CriticalIdentityText(key = "label", value = dialog.label)
            gate.CriticalIdentityText(key = "endpoint", value = dialog.endpointDisplayText)
            // Fixed wording: this forgets a local association and says so. It never
            // claims to stop, signal, or otherwise touch a remote process.
            Text(stringResource(R.string.remove_host_body), style = MaterialTheme.typography.bodyMedium)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            DismissButton { onIntent(ClientIntent.DismissDialog(ClientDialogKind.REMOVE_HOST)) }
            Button(
                onClick = {
                    gate.attempt {
                        onIntent(
                            ClientIntent.RemoveHost(
                                target = RemoveHostTarget(
                                    hostId = dialog.hostId,
                                    label = dialog.label,
                                    endpointDisplayText = dialog.endpointDisplayText,
                                ),
                                proof = dialog.proof,
                            ),
                        )
                    }
                },
            ) { Text(stringResource(R.string.remove_host_confirm)) }
        }
    }
}

// ---------------------------------------------------------------------------
// First-contact server key consent
// ---------------------------------------------------------------------------

@Composable
private fun ConsentDialogView(
    dialog: FirstContactConsentDialog,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    val target = FirstContactConsentTarget(
        hostId = dialog.hostId,
        latchedLabel = dialog.latchedLabel,
        endpointDisplayText = dialog.endpointDisplayText,
        serverFingerprint = dialog.serverFingerprint,
    )
    val remainingMillis = remainingMonotonicMillis(dialog.deadlineAtMonotonicMillis)
    val expired = remainingMillis != null && remainingMillis <= 0L
    ClientAlertDialog(
        title = stringResource(R.string.consent_title),
        onDismiss = { onIntent(ClientIntent.DeclineFirstContactServerKey(target)) },
        covered = covered,
        proof = dialog.proof,
        // Every identity line is critical: the label the consent was latched for, the
        // endpoint being dialled, and the full fingerprint. None is abbreviated, and
        // none may be scrolled out of the frame the approval is spent on.
        requiredCriticalLines = 3,
        semanticKey = dialog,
    ) { gate ->
        gate.Body {
            Text(stringResource(R.string.consent_body), style = MaterialTheme.typography.bodyMedium)
            gate.CriticalIdentityText(key = "label", value = dialog.latchedLabel)
            gate.CriticalIdentityText(key = "endpoint", value = dialog.endpointDisplayText)
            gate.CriticalIdentityText(key = "fingerprint", value = dialog.serverFingerprint)
            if (remainingMillis != null) {
                NoticeText(
                    if (expired) {
                        stringResource(R.string.consent_expired)
                    } else {
                        stringResource(R.string.consent_remaining, remainingMillis / 1000L)
                    },
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = { onIntent(ClientIntent.DeclineFirstContactServerKey(target)) }) {
                Text(stringResource(R.string.consent_decline))
            }
            Button(
                onClick = {
                    gate.attempt {
                        onIntent(ClientIntent.ApproveFirstContactServerKey(target, dialog.proof))
                    }
                },
                // Past the deadline the UI stops offering Approve. Only the
                // controller retires the consent; this only refuses to invite it.
                enabled = !expired,
            ) { Text(stringResource(R.string.consent_approve)) }
        }
    }
}

// ---------------------------------------------------------------------------
// Create session
// ---------------------------------------------------------------------------

@Composable
private fun CreateSessionDialogView(
    dialog: CreateSessionDialog,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    var ownerMenuOpen by remember { mutableStateOf(false) }
    val selected = dialog.selectedOwner
    // The controller states whether that owner can take a create right now: live
    // connection and positively acknowledged create capability. An unknown capability
    // is never eligible, and the form never guesses from history or another host.
    val eligible = selected?.createEligible == true
    ClientAlertDialog(
        title = stringResource(R.string.create_title),
        onDismiss = { onIntent(ClientIntent.DismissDialog(ClientDialogKind.CREATE_SESSION)) },
        covered = covered,
        proof = dialog.proof,
        requiredCriticalLines = if (selected == null) 0 else 1,
        // The chosen owner and the workspace draft are what the committed frame showed,
        // so both belong in the key: switching owner or editing the workspace retires
        // the previous standing instead of letting it address a different form.
        semanticKey = listOf(
            dialog.proof.target,
            selected?.hostId,
            selected?.label,
            selected?.endpointDisplayText,
            dialog.workspaceDraft,
        ),
    ) { gate ->
        gate.Body {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (selected == null) {
                    Text(
                        text = stringResource(R.string.create_owner_none),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.weight(1f),
                    )
                } else {
                    gate.CriticalIdentityText(
                        key = "owner",
                        value = "${selected.label} — ${selected.endpointDisplayText}",
                        modifier = Modifier.weight(1f),
                    )
                }
                TextButton(onClick = { ownerMenuOpen = true }) { Text(stringResource(R.string.create_choose_owner)) }
                DropdownMenu(
                    expanded = ownerMenuOpen,
                    onDismissRequest = { ownerMenuOpen = false },
                ) {
                    dialog.owners.forEach { owner ->
                        DropdownMenuItem(
                            text = { Text("${owner.label} — ${owner.endpointDisplayText} · ${owner.connection}") },
                            onClick = {
                                gate.retireForEdit()
                                ownerMenuOpen = false
                                onIntent(ClientIntent.SelectCreateOwner(owner.hostId))
                            },
                        )
                    }
                }
            }

            // A chosen owner that is not connected stays chosen and says so. The form
            // never swaps in another host behind the operator's back.
            if (selected != null && !eligible) {
                NoticeText(stringResource(R.string.create_owner_not_connected))
            }

            OutlinedTextField(
                value = dialog.workspaceDraft,
                onValueChange = {
                    gate.retireForEdit()
                    onIntent(ClientIntent.UpdateDraft(ClientDraft.Workspace(it)))
                },
                label = { Text(stringResource(R.string.create_workspace_field)) },
                modifier = Modifier.fillMaxWidth(),
            )
            NoticeText(stringResource(R.string.create_workspace_note))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            DismissButton { onIntent(ClientIntent.DismissDialog(ClientDialogKind.CREATE_SESSION)) }
            Button(
                onClick = {
                    gate.attempt {
                        selected?.let {
                            onIntent(ClientIntent.SubmitSessionCreate(it.hostId, dialog.workspaceDraft, dialog.proof))
                        }
                    }
                },
                enabled = eligible && dialog.workspaceDraft.isNotBlank(),
            ) { Text(stringResource(R.string.create_submit)) }
        }
    }
}

// ---------------------------------------------------------------------------
// Rename session
// ---------------------------------------------------------------------------

@Composable
private fun RenameDialogView(
    dialog: RenameSessionDialog,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    ClientAlertDialog(
        title = stringResource(R.string.rename_title),
        onDismiss = { onIntent(ClientIntent.DismissDialog(ClientDialogKind.RENAME_SESSION)) },
        covered = covered,
        proof = dialog.proof,
        requiredCriticalLines = 1,
        semanticKey = dialog,
    ) { gate ->
        gate.Body {
            gate.CriticalIdentityText(key = "row", value = dialog.target.base.drawnTitle)
            FactRow(stringResource(R.string.rename_native_field), dialog.target.currentName)
            FactRow(
                stringResource(R.string.rename_tuple_field),
                "${dialog.target.expectedSessionId} · ${dialog.target.expectedSessionEpoch}",
            )
            NoticeText(stringResource(R.string.rename_note))
            OutlinedTextField(
                value = dialog.nameDraft,
                onValueChange = {
                    gate.retireForEdit()
                    onIntent(ClientIntent.UpdateDraft(ClientDraft.Rename(dialog.target, it)))
                },
                label = { Text(stringResource(R.string.rename_name_field)) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            DismissButton { onIntent(ClientIntent.DismissDialog(ClientDialogKind.RENAME_SESSION)) }
            Button(
                onClick = {
                    gate.attempt {
                        onIntent(ClientIntent.SubmitSessionRename(dialog.target, dialog.nameDraft, dialog.proof))
                    }
                },
                enabled = dialog.nameDraft.isNotBlank(),
            ) { Text(stringResource(R.string.rename_submit)) }
        }
    }
}

// ---------------------------------------------------------------------------
// Close session
// ---------------------------------------------------------------------------

@Composable
private fun CloseDialogView(
    dialog: CloseSessionDialog,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    val hostConfirmation = dialog.confirmationRequestId != null
    ClientAlertDialog(
        title = stringResource(
            if (hostConfirmation) R.string.close_host_confirmation_title else R.string.close_title,
        ),
        onDismiss = { onIntent(ClientIntent.DismissDialog(ClientDialogKind.CLOSE_SESSION)) },
        covered = covered,
        proof = dialog.proof,
        requiredCriticalLines = 1,
        semanticKey = dialog,
    ) { gate ->
        gate.Body {
            gate.CriticalIdentityText(key = "row", value = dialog.target.drawnTitle)
            // Fixed wording. It never says a close already accepted can be withdrawn,
            // and it never offers a retry.
            Text(
                stringResource(
                    if (hostConfirmation) R.string.close_host_confirmation_body else R.string.close_body,
                ),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            DismissButton { onIntent(ClientIntent.DismissDialog(ClientDialogKind.CLOSE_SESSION)) }
            Button(
                onClick = {
                    gate.attempt {
                        onIntent(ClientIntent.ConfirmSessionClose(dialog.target, dialog.proof))
                    }
                },
            ) {
                Text(
                    stringResource(
                        if (hostConfirmation) R.string.close_host_confirmation_button else R.string.close_confirm,
                    ),
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Saved delete
// ---------------------------------------------------------------------------

@Composable
private fun SavedDeleteDialogView(
    dialog: SavedDeleteDialog,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    ClientAlertDialog(
        title = stringResource(R.string.saved_delete_title),
        onDismiss = { onIntent(ClientIntent.DismissDialog(ClientDialogKind.SAVED_DELETE)) },
        covered = covered,
        proof = dialog.proof,
        requiredCriticalLines = 1,
        semanticKey = dialog,
    ) { gate ->
        gate.Body {
            gate.CriticalIdentityText(key = "entry", value = dialog.target.caption)
            Text(stringResource(R.string.saved_delete_body), style = MaterialTheme.typography.bodyMedium)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            DismissButton { onIntent(ClientIntent.DismissDialog(ClientDialogKind.SAVED_DELETE)) }
            Button(
                onClick = {
                    gate.attempt {
                        onIntent(ClientIntent.ConfirmSavedDelete(dialog.target, dialog.proof))
                    }
                },
            ) { Text(stringResource(R.string.saved_delete_confirm)) }
        }
    }
}
