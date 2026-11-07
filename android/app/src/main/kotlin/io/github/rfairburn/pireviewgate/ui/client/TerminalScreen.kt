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
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.systemBarsIgnoringVisibility
import androidx.compose.foundation.layout.waterfall
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.layout.onSizeChanged
import io.github.rfairburn.pireviewgate.core.input.AdaptiveTerminalGrid
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalPaints
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.QuickSwitcherRow
import io.github.rfairburn.pireviewgate.core.client.ui.SessionRowKey
import io.github.rfairburn.pireviewgate.core.client.ui.SessionActionTarget
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalControlKey
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalKeyRequest
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalModifier
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalModifiers
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.UiCoverage
import io.github.rfairburn.pireviewgate.core.client.ui.quickSwitcherRows

/**
 * The fullscreen terminal.
 *
 * There is no persistent sidebar and no host or session navigation chrome here: the
 * only navigation affordances are the compact app bar's back action, the session
 * title with its host, and the quick switcher. That is the whole point of the
 * screen — the terminal owns the viewport, and switching sessions is one gesture
 * that spans every configured host.
 *
 * The viewport itself is [terminalContent], supplied by whoever owns a real
 * `TerminalSurface` with its binding and listener. [onKey] and [onPaste] are equally
 * required: the toolbar submits a semantic key request and a paste request through
 * them, and the surface's own public submit API encodes them under the negotiated
 * modes. Nothing in this screen synthesizes a hardware event or writes a packet.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TerminalScreen(
    terminal: TerminalUiState,
    terminalContent: @Composable (TerminalUiState) -> Unit,
    onKey: (TerminalKeyRequest) -> Unit,
    onPaste: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
    modifier: Modifier = Modifier,
) {
    TerminalImeWindowPolicy()
    val density = LocalDensity.current
    // safeDrawing includes IME. Keep bars/cutouts/waterfall, but never subtract
    // the keyboard from the pane, even on enforced edge-to-edge Android versions.
    val safe = WindowInsets.systemBarsIgnoringVisibility.union(WindowInsets.displayCutout).union(WindowInsets.waterfall)
    val ime = WindowInsets.ime
    val scroll = rememberScrollState()
    var measuredToolbarHeight by remember { mutableIntStateOf(-1) }
    val minimumPaneHeight = remember {
        TerminalPaints().measureFont(AdaptiveTerminalGrid.MIN_TEXT_SIZE_PX).heightPx * AdaptiveTerminalGrid.MIN_ROWS
    }
    Layout(
        modifier = modifier.fillMaxSize().windowInsetsPadding(safe),
        content = {
            TerminalAppBar(
                terminal = terminal,
                onBack = { onIntent(ClientIntent.LeaveTerminal) },
                onSwitch = { onIntent(ClientIntent.ShowQuickSwitcher) },
            )
            Box { terminalContent(terminal) }
            // This is the SAME toolbar, not a second keyboard or hidden duplicate.
            // If the native IME leaves less room, scroll its existing actions and
            // feedback in an opaque owned overlay without changing the pane.
            // IME/accessories may cover cells: stable painting is not a claim of
            // physical pixel visibility and grants no input or commit authority.
            Box(Modifier.background(MaterialTheme.colorScheme.surface).verticalScroll(scroll)) {
                Box(Modifier.wrapContentHeight(Alignment.Top, unbounded = true)
                    .onSizeChanged { measuredToolbarHeight = it.height }) {
                    TerminalToolbar(terminal, onKey, onPaste, onIntent)
                }
            }
        },
    ) { children, constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val bar = children[0].measure(Constraints.fixedWidth(width).copy(maxHeight = height))
        val remaining = (height - bar.height).coerceAtLeast(0)
        // Reserve the keyboard-HIDDEN toolbar footprint. The IME never enters
        // this calculation, so neither pane origin nor pane size can move with it.
        // Even expanded keys must leave room for the real minimum-size font.
        // When chrome cannot fit, scroll it rather than collapsing the terminal.
        // The scroll CONTENT is measured with unbounded height and reports its
        // natural footprint, independent of its IME-constrained viewport. Until
        // that first real measurement arrives, keep the pane empty/fail-closed.
        val reserved = if (measuredToolbarHeight < 0) remaining else measuredToolbarHeight
            .coerceIn(0, (remaining - minimumPaneHeight).coerceAtLeast(0))
        val pane = children[1].measure(Constraints.fixed(width, remaining - reserved))
        val coveredBottom = (ime.getBottom(density) - safe.getBottom(density)).coerceAtLeast(0)
        val toolbarBottom = (height - coveredBottom).coerceIn(bar.height, height)
        val toolbarHeight = reserved.coerceAtMost(toolbarBottom - bar.height)
        val toolbar = children[2].measure(Constraints.fixed(width, toolbarHeight))
        layout(width, height) {
            bar.placeRelative(0, 0)
            pane.placeRelative(0, bar.height)
            toolbar.placeRelative(0, toolbarBottom - toolbar.height)
        }
    }
}

/** Only the terminal Activity window opts out of both OS resize and OS pan.
 * Separate dialog/sheet windows retain their own IME behavior; leaving the route
 * restores the Activity's original mode for Add Host and other forms.
 */
@Composable
private fun TerminalImeWindowPolicy() {
    val view = LocalView.current
    DisposableEffect(view) {
        val window = view.context.activity()?.window
        val previous = window?.attributes?.softInputMode
        if (window != null && previous != null) {
            window.setSoftInputMode((previous and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST.inv()) or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
        }
        onDispose { if (window != null && previous != null) window.setSoftInputMode(previous) }
    }
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TerminalAppBar(
    terminal: TerminalUiState,
    onBack: () -> Unit,
    onSwitch: () -> Unit,
) {
    TopAppBar(
        title = {
            Column {
                Text(
                    text = terminal.sessionTitle,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = stringResource(R.string.session_host_context, terminal.hostLabel),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        navigationIcon = {
            TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) }
        },
        actions = {
            TextButton(onClick = onSwitch) { Text(stringResource(R.string.action_switch_session)) }
        },
    )
}

/**
 * The native key toolbar.
 *
 * Sticky modifiers are held state, cleared across targets, coverage, and
 * backgrounding by the controller. Every key button submits a semantic
 * [TerminalControlKey] through the slot; nothing here builds an escape sequence or
 * fakes a hardware event.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TerminalToolbar(
    terminal: TerminalUiState,
    onKey: (TerminalKeyRequest) -> Unit,
    onPaste: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
) {
    val suspended = terminal.coverage.suspendsTerminalInput || !terminal.inputReady
    val held = terminal.modifiers

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Both messages always participate in measurement, reserving the larger
        // localized/wrapped footprint even while input is ready. Readiness comes
        // from this pane's real commit and must never resize that same pane.
        Box {
            listOf(
                R.string.terminal_suspended_coverage to terminal.coverage.suspendsTerminalInput,
                R.string.terminal_suspended_viewport to (suspended && !terminal.coverage.suspendsTerminalInput),
            ).forEach { (message, visible) ->
                NoticeText(
                    stringResource(message),
                    if (visible) Modifier else Modifier.alpha(0f).clearAndSetSemantics {},
                )
            }
        }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ModifierToggle(
                modifier = TerminalModifier.CTRL,
                label = stringResource(R.string.key_ctrl),
                held = held,
                onIntent = onIntent,
            )
            ModifierToggle(
                modifier = TerminalModifier.ALT,
                label = stringResource(R.string.key_alt),
                held = held,
                onIntent = onIntent,
            )
            ModifierToggle(
                modifier = TerminalModifier.SHIFT,
                label = stringResource(R.string.key_shift),
                held = held,
                onIntent = onIntent,
            )
            OutlinedButton(
                onClick = { onIntent(ClientIntent.SetTerminalKeyboardVisible(!terminal.keyboardVisible)) },
            ) {
                // Both localized labels own one stable footprint: observing the
                // real IME must not wrap this FlowRow and resize the pane either.
                Box {
                    listOf(
                        R.string.key_hide_keyboard to terminal.keyboardVisible,
                        R.string.key_show_keyboard to !terminal.keyboardVisible,
                    ).forEach { (label, visible) ->
                        Text(stringResource(label),
                            if (visible) Modifier else Modifier.alpha(0f).clearAndSetSemantics {})
                    }
                }
            }
            OutlinedButton(onClick = onPaste, enabled = !suspended) {
                Text(stringResource(R.string.key_paste))
            }
            OutlinedButton(
                onClick = { onIntent(ClientIntent.SetTerminalExtraKeysVisible(!terminal.extraKeysVisible)) },
            ) {
                Text(
                    stringResource(
                        if (terminal.extraKeysVisible) R.string.key_hide_extra else R.string.key_show_extra,
                    ),
                )
            }
        }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            KeyButton(TerminalControlKey.ESCAPE, stringResource(R.string.key_escape), held, suspended, onKey)
            KeyButton(TerminalControlKey.TAB, stringResource(R.string.key_tab), held, suspended, onKey)
            KeyButton(TerminalControlKey.BACKTAB, stringResource(R.string.key_shift_tab), held, suspended, onKey)
            KeyButton(TerminalControlKey.HOME, stringResource(R.string.key_home), held, suspended, onKey)
            KeyButton(TerminalControlKey.END, stringResource(R.string.key_end), held, suspended, onKey)
            KeyButton(TerminalControlKey.PAGE_UP, stringResource(R.string.key_page_up), held, suspended, onKey)
            KeyButton(TerminalControlKey.PAGE_DOWN, stringResource(R.string.key_page_down), held, suspended, onKey)
        }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            KeyButton(TerminalControlKey.ARROW_LEFT, stringResource(R.string.key_arrow_left), held, suspended, onKey)
            KeyButton(TerminalControlKey.ARROW_UP, stringResource(R.string.key_arrow_up), held, suspended, onKey)
            KeyButton(TerminalControlKey.ARROW_DOWN, stringResource(R.string.key_arrow_down), held, suspended, onKey)
            KeyButton(TerminalControlKey.ARROW_RIGHT, stringResource(R.string.key_arrow_right), held, suspended, onKey)
        }

        if (terminal.extraKeysVisible) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                KeyButton(TerminalControlKey.INSERT, stringResource(R.string.key_insert), held, suspended, onKey)
                KeyButton(TerminalControlKey.DELETE, stringResource(R.string.key_delete), held, suspended, onKey)
                val functionKeys = listOf(
                    TerminalControlKey.F1,
                    TerminalControlKey.F2,
                    TerminalControlKey.F3,
                    TerminalControlKey.F4,
                    TerminalControlKey.F5,
                    TerminalControlKey.F6,
                    TerminalControlKey.F7,
                    TerminalControlKey.F8,
                    TerminalControlKey.F9,
                    TerminalControlKey.F10,
                    TerminalControlKey.F11,
                    TerminalControlKey.F12,
                )
                functionKeys.forEach { key ->
                    KeyButton(key, key.name, held, suspended, onKey)
                }
            }
        }
    }
}

@Composable
private fun ModifierToggle(
    modifier: TerminalModifier,
    label: String,
    held: TerminalModifiers,
    onIntent: (ClientIntent) -> Unit,
) {
    if (held.holds(modifier)) {
        Button(onClick = { onIntent(ClientIntent.ToggleTerminalModifier(modifier)) }) { Text(label) }
    } else {
        OutlinedButton(onClick = { onIntent(ClientIntent.ToggleTerminalModifier(modifier)) }) { Text(label) }
    }
}

@Composable
private fun KeyButton(
    key: TerminalControlKey,
    label: String,
    held: TerminalModifiers,
    suspended: Boolean,
    onKey: (TerminalKeyRequest) -> Unit,
) {
    OutlinedButton(
        onClick = { onKey(TerminalKeyRequest(key, held)) },
        enabled = !suspended,
    ) { Text(label) }
}

/**
 * The cross-host quick switcher.
 *
 * Every configured host appears, connected or not, and a host whose rows are no
 * longer live is labelled stale rather than being presented as current. Selecting a
 * row asks the controller to switch the terminal to that exact target; the sheet
 * reports its own coverage so terminal input is suspended while it is open.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickSwitcherSheet(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
) {
    val terminal = (state.route as? io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute.Terminal)?.terminal
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = { onIntent(ClientIntent.DismissQuickSwitcher) },
        sheetState = sheetState,
    ) {
        // The sheet is its own window. Commit proof for its entries has to come from
        // frames of *this* window: inheriting the activity's commit source through the
        // composition local would certify a sheet control against an activity frame in
        // which the control was never drawn.
        UiCommitScope {
            Text(
                stringResource(R.string.quick_switcher_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                items(
                    items = quickSwitcherRows(state.hostStates, terminal?.target, state.rowOrder),
                    key = {
                        when (it) {
                            is QuickSwitcherRow.Session ->
                                "qs-${it.session.hostId.value}|${it.session.hostRunId}|${it.session.rowId}"
                            is QuickSwitcherRow.HostWithoutRoster -> "qs-host-${it.host.host.id.value}"
                        }
                    },
                ) { row ->
                    when (row) {
                        is QuickSwitcherRow.Session -> QuickSwitcherSessionRow(
                            row = row,
                            proof = terminal?.chooserProofs?.get(SessionRowKey.of(row.session)),
                            covered = state.dialogs.hasModal,
                            onIntent = onIntent,
                        )
                        is QuickSwitcherRow.HostWithoutRoster -> {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(row.host.host.label.value, style = MaterialTheme.typography.bodyLarge)
                                    Text(
                                        text = row.host.host.endpoint.displayText(),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                ConnectionChip(row.host.connection)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun QuickSwitcherSessionRow(
    row: QuickSwitcherRow.Session,
    proof: UiActionProof?,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    // The switch is attributed to the chooser entry the operator actually saw, so the
    // proof is the entry's own and not the terminal being left. The semantic key is
    // the frozen entry target, so a listed row that changed under the sheet retires
    // its standing instead of being chosen from a frame that no longer shows it.
    val target = SessionActionTarget.of(row.session)
    val guard = rememberUiActionGuard(proof = proof, semanticKey = target, covered = covered)
    TextButton(
        onClick = {
            proof?.let {
                guard.attempt { onIntent(ClientIntent.SwitchTerminalTarget(target, it)) }
            }
        },
        enabled = proof != null,
        modifier = Modifier
            .fillMaxWidth()
            .then(guard.modifier),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(row.session.displayTitle, style = MaterialTheme.typography.bodyLarge)
                Text(
                    text = stringResource(R.string.session_host_context, row.session.hostLabel),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            when {
                row.isCurrent -> Text(stringResource(R.string.quick_switcher_current), style = MaterialTheme.typography.labelLarge)
                row.session.stale -> Text(stringResource(R.string.roster_stale), style = MaterialTheme.typography.labelLarge)
                else -> {}
            }
        }
    }
}
