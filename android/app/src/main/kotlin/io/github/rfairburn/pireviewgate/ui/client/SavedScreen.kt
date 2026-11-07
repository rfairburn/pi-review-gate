package io.github.rfairburn.pireviewgate.ui.client

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.ClientDraft
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.SavedEntryControlProofs
import io.github.rfairburn.pireviewgate.core.client.ui.SavedEntryKey
import io.github.rfairburn.pireviewgate.core.client.ui.SavedEntryTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SavedOwnerTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SavedResultTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SavedMoreDecision
import io.github.rfairburn.pireviewgate.core.client.ui.SavedRequestStatus
import io.github.rfairburn.pireviewgate.core.client.ui.SavedUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiCoverage
import io.github.rfairburn.pireviewgate.core.client.ui.moreDecision
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry

/**
 * One owner's Saved catalog browser.
 *
 * Everything the browser acts on is an owner-issued opaque handle: the run, the
 * catalog, the result, and the entry id. The owner's [OwnerSavedEntry.file] and
 * [OwnerSavedEntry.cwd] are shown because the owner wrote them, and they are shown
 * only — this client never opens, lists, resolves, or completes a path, so there is
 * no local filesystem completion anywhere in this screen.
 *
 * The owner states its full total and the actual offset of what it sent. When it
 * does not say, the screen says so instead of presenting a first page as the whole
 * answer.
 */
@Composable
fun SavedScreen(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
    listState: androidx.compose.foundation.lazy.LazyListState,
    modifier: Modifier = Modifier,
) {
    val saved = state.saved
    // The drawn screen's own eligibility: the selected owner must be live and have
    // positively acknowledged the Saved capability. Unknown is never eligible.
    val owner = saved.selectedHostId?.let { state.hostState(it) }
    val eligible = owner?.canBrowseSaved == true

    Column(modifier = modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val ownerTarget = saved.selectedHostId?.let { id ->
                saved.hostRunId?.let { SavedOwnerTarget(id, it) }
            }
            // Listing and searching are owner operations, so the search control spends
            // the proof the controller minted for this owner run and this query. The
            // query is part of the semantic key: editing the field retires the previous
            // standing synchronously, in composition, rather than only once a later side
            // effect or recomposition gets there.
            val searchGuard = rememberUiActionGuard(
                proof = saved.listProof,
                semanticKey = ownerTarget to saved.query,
                covered = state.dialogs.hasModal,
            )
            OwnerSelector(state = state, saved = saved, onIntent = onIntent)

            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = saved.query,
                    onValueChange = {
                        // Retire before dispatching, in the edit callback itself: the
                        // committed frame showed the query being changed, and a guard
                        // read from another thread right after this must already see
                        // the retired standing rather than wait for recomposition.
                        searchGuard.retireForEdit()
                        onIntent(ClientIntent.UpdateDraft(ClientDraft.SavedSearch(it)))
                    },
                    label = { Text(stringResource(R.string.saved_search_label)) },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = {
                        val target = ownerTarget ?: return@TextButton
                        val proof = saved.listProof ?: return@TextButton
                        searchGuard.attempt {
                            onIntent(ClientIntent.RequestSavedList(target, saved.query, proof))
                        }
                    },
                    modifier = searchGuard.modifier,
                    enabled = ownerTarget != null && eligible && saved.listProof != null,
                ) { Text(stringResource(R.string.saved_search_action)) }
            }

            StatusLine(saved)
            TotalLine(saved)
            if (saved.selectedHostId != null && !eligible) {
                NoticeText(stringResource(R.string.saved_owner_not_eligible))
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(saved.entries, key = { "${it.entryId}|${it.sessionId}" }) { entry ->
                SavedEntryCard(
                    entry = entry,
                    target = SavedEntryTarget.of(saved, entry),
                    proofs = savedEntryProofs(saved, entry),
                    eligible = eligible,
                    covered = state.dialogs.hasModal,
                    deleteExposed = owner?.savedDeleteExposed == true,
                    onIntent = onIntent,
                )
            }
            item {
                LoadMoreRow(
                    saved = saved,
                    result = SavedResultTarget.of(saved),
                    eligible = eligible,
                    covered = state.dialogs.hasModal,
                    onIntent = onIntent,
                )
            }
        }
    }
}

/** The owner a Saved request is addressed to; choosing is explicit and never guessed. */
@Composable
private fun OwnerSelector(
    state: ClientUiState,
    saved: SavedUiState,
    onIntent: (ClientIntent) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val selected = saved.selectedHostId?.let { state.hostState(it) }
    Box {
        OutlinedButton(
            onClick = {
                open = true
                onIntent(ClientIntent.UiCoverageChanged(UiCoverage.OPEN_MENU))
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text = selected?.host?.label?.value ?: stringResource(R.string.saved_owner_none),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = {
                open = false
                onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
            },
        ) {
            state.hostStates.forEach { host ->
                DropdownMenuItem(
                    text = { Text("${host.host.label.value} — ${host.host.endpoint.displayText()}") },
                    onClick = {
                        open = false
                        onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
                        onIntent(ClientIntent.SelectSavedOwner(host.host.id))
                    },
                )
            }
        }
    }
}

/**
 * The request status. Both the drawn status and the pending text are always laid out in
 * one slot, and only their visibility changes, so admitted-read feedback never changes
 * this line's height or moves a control below it. The hidden text is not announced.
 */
@Composable
private fun StatusLine(saved: SavedUiState) {
    val base = saved.readFeedbackBaseStatus
    val hidden = Modifier.alpha(0f).clearAndSetSemantics { }
    Box {
        NoticeText(savedStatusText(base ?: saved.status), modifier = if (base != null) hidden else Modifier)
        NoticeText(
            savedStatusText(SavedRequestStatus.Requesting),
            modifier = if (base != null) Modifier else hidden,
        )
    }
}

@Composable
private fun savedStatusText(value: SavedRequestStatus): String {
    val text = when (val status = value) {
        SavedRequestStatus.Idle -> stringResource(R.string.saved_status_idle)
        SavedRequestStatus.Requesting -> stringResource(R.string.saved_status_requesting)
        SavedRequestStatus.Ready -> stringResource(R.string.saved_status_ready)
        SavedRequestStatus.Unavailable -> stringResource(R.string.saved_status_unavailable)
        SavedRequestStatus.Unknown -> stringResource(R.string.saved_status_unknown)
        is SavedRequestStatus.Refused -> {
            val reason = status.reason
            if (reason == null) {
                stringResource(R.string.saved_status_refused)
            } else {
                stringResource(R.string.saved_status_refused_reason, reason.name)
            }
        }
    }
    return text
}

/** The owner's own totals, spelled out when the owner did not state them. */
@Composable
private fun TotalLine(saved: SavedUiState) {
    val total = saved.total
    val text = if (total == null) {
        stringResource(R.string.saved_total_unknown, saved.entries.size)
    } else {
        stringResource(R.string.saved_total, saved.shownThrough, total)
    }
    Text(text = text, style = MaterialTheme.typography.bodyMedium)
    val issueCount = saved.issueCount
    if (issueCount != null) {
        NoticeText(stringResource(R.string.saved_issue_count, issueCount))
    }
}

@Composable
private fun LoadMoreRow(
    saved: SavedUiState,
    result: SavedResultTarget?,
    eligible: Boolean,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    // The next window is addressed to the exact result on screen, and spends that
    // control's own proof. The semantic key is the frozen result, so a result replaced
    // by a newer transfer retires this standing instead of letting an old frame fetch
    // pages for it.
    val windowGuard = rememberUiActionGuard(proof = saved.windowProof, semanticKey = result, covered = covered)
    when (saved.moreDecision()) {
        SavedMoreDecision.MAY_REQUEST -> OutlinedButton(
            onClick = {
                val target = result ?: return@OutlinedButton
                val proof = saved.windowProof ?: return@OutlinedButton
                windowGuard.attempt {
                    onIntent(ClientIntent.RequestSavedWindow(target, saved.shownThrough, DEFAULT_WINDOW_SIZE, proof))
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .then(windowGuard.modifier),
            enabled = result != null && eligible && saved.windowProof != null,
        ) { Text(stringResource(R.string.saved_load_more)) }

        SavedMoreDecision.NOTHING_MORE -> NoticeText(stringResource(R.string.saved_all_shown))
        SavedMoreDecision.UNKNOWN_TOTAL -> NoticeText(stringResource(R.string.saved_total_unknown_more))
        SavedMoreDecision.REQUEST_IN_FLIGHT -> NoticeText(stringResource(R.string.saved_request_in_flight))
    }
}

/**
 * One Saved entry.
 *
 * Resume and delete address the entry by its owner handle only. Delete appears only
 * when that owner positively exposed delete: an unknown policy and a refused policy
 * both hide it. An entry the view cannot address — no run, catalog, or result — gets
 * no action buttons rather than a button that would guess.
 */
@Composable
/**
 * The proofs minted for one entry's controls, looked up by the entry's owner handles.
 *
 * A caption is display text and never selects a proof; only the run, catalog, result,
 * and entry handles do.
 */
private fun savedEntryProofs(saved: SavedUiState, entry: OwnerSavedEntry): SavedEntryControlProofs {
    val hostRunId = saved.hostRunId ?: return SavedEntryControlProofs()
    val catalogId = saved.catalogId ?: return SavedEntryControlProofs()
    val resultId = saved.resultId ?: return SavedEntryControlProofs()
    return saved.proofsFor(SavedEntryKey(hostRunId, catalogId, resultId, entry.entryId))
}

@Composable
private fun SavedEntryCard(
    entry: OwnerSavedEntry,
    target: SavedEntryTarget?,
    proofs: SavedEntryControlProofs,
    eligible: Boolean,
    covered: Boolean,
    deleteExposed: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    // Resume and delete preparation are separate actions on one entry, each with its
    // own proof and its own frozen target, so neither inherits the other's standing.
    val resumeGuard = rememberUiActionGuard(proof = proofs.resume, semanticKey = target, covered = covered)
    val deleteGuard = rememberUiActionGuard(
        proof = proofs.deletePrepare,
        semanticKey = target,
        covered = covered,
    )
    ClientCard {
        Text(
            text = entry.caption,
            style = MaterialTheme.typography.titleMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        FactRow(stringResource(R.string.saved_file), entry.file)
        FactRow(stringResource(R.string.saved_cwd), entry.cwd)
        if (target == null) {
            NoticeText(stringResource(R.string.saved_not_addressable))
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        proofs.resume?.let { proof ->
                            resumeGuard.attempt { onIntent(ClientIntent.ResumeSavedEntry(target, proof)) }
                        }
                    },
                    enabled = eligible && proofs.resume != null,
                    // The guard observes the control it stands for, so the bounds that
                    // decide this action are the bounds of the button the operator
                    // presses, not of the card around it.
                    modifier = resumeGuard.modifier,
                ) { Text(stringResource(R.string.saved_resume)) }
                if (deleteExposed) {
                    OutlinedButton(
                        onClick = {
                            proofs.deletePrepare?.let { proof ->
                                deleteGuard.attempt { onIntent(ClientIntent.PrepareSavedDelete(target, proof)) }
                            }
                        },
                        enabled = eligible && proofs.deletePrepare != null,
                        modifier = deleteGuard.modifier,
                    ) { Text(stringResource(R.string.saved_delete)) }
                }
            }
        }
    }
}

/** Rows requested per Saved window; the owner's own bounds still apply. */
private const val DEFAULT_WINDOW_SIZE: Long = 50L
