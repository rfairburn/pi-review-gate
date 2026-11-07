package io.github.rfairburn.pireviewgate.ui.client

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsIgnoringVisibility
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.waterfall
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.QuickSwitcherRow
import io.github.rfairburn.pireviewgate.core.client.ui.SessionActionTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SessionRowKey
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalControlKey
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalKeyRequest
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalModifier
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalModifiers
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.quickSwitcherRows

/** Overlay chrome is translucent enough to hint at covered cells, opaque enough to read. */
private const val OVERLAY_ALPHA = 0.92f

/**
 * The fullscreen terminal.
 *
 * The pane is the whole app drawable window minus only the stable physical system
 * bars, display cutout, and waterfall insets. No app heading, permanent key rows,
 * navigation bar, or status slot is measured into it; those safety areas are kept,
 * not claimed as removed. Nothing below the pane is reserved, so its size, origin,
 * and grid change only when the real window or orientation does.
 *
 * Everything else floats over the pane in this same window: a compact control strip
 * (Back, Switch, Keyboard, Keys), truthful readiness/status notices, and the
 * dismissible Keys panel with the existing modifiers, paste, special and function
 * keys. None of them is a Dialog, sheet, or focusable popup, so opening one neither
 * takes native window focus nor reports coverage; only the real quick switcher and
 * modal dialogs do that. Every overlay surface consumes its own touches so a tap on
 * a control never reaches the terminal underneath, while the rest of the pane
 * remains the terminal's.
 *
 * There is no persistent sidebar and no host or session navigation chrome here.
 * The viewport itself is [terminalContent], supplied by whoever owns a real
 * `TerminalSurface` with its binding and listener. [onKey] and [onPaste] are equally
 * required: the Keys panel submits a semantic key request and a paste request
 * through them, and the surface's own public submit API encodes them under the
 * negotiated modes. Nothing in this screen synthesizes a hardware event or writes a
 * packet. [status] is the app's latest admission/settlement notice, shown here
 * instead of in a layout-reserving slot.
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
    status: String? = null,
) {
    TerminalImeWindowPolicy()
    // safeDrawing includes IME. Keep bars/cutouts/waterfall, but never subtract
    // the keyboard from the pane, even on enforced edge-to-edge Android versions.
    // The ignoring-visibility bars keep the pane stable if transient bars change.
    val stable = WindowInsets.systemBarsIgnoringVisibility.union(WindowInsets.displayCutout).union(WindowInsets.waterfall)
    // Which pop-out is open is screen-owned presentation, like an open menu.
    var keysOpen by rememberSaveable { mutableStateOf(false) }
    var dismissedStatus by rememberSaveable { mutableStateOf<String?>(null) }
    // Registered after RootUIScreen's terminal handler, so it wins only while
    // enabled: the switcher and a visible IME keep their existing Back priority.
    BackHandler(enabled = keysOpen && !terminal.quickSwitcherVisible && !terminal.keyboardVisible) {
        keysOpen = false
    }
    Box(modifier.fillMaxSize().windowInsetsPadding(stable)) {
        // The pane: identical constraints whatever the overlays, IME, or readiness.
        Box(Modifier.fillMaxSize()) { terminalContent(terminal) }
        // Overlays only. The IME may cover cells: the overlay layer (never the pane)
        // keeps the Keys panel above it. Stable painting is not a claim of physical
        // pixel visibility and grants no input or commit authority. This column has
        // no pointer handler of its own, so touches outside its surfaces reach the
        // terminal.
        Column(
            modifier = Modifier.matchParentSize().windowInsetsPadding(WindowInsets.ime),
            horizontalAlignment = Alignment.End,
        ) {
            TerminalControls(
                terminal = terminal,
                keysOpen = keysOpen,
                onToggleKeys = { keysOpen = !keysOpen },
                onIntent = onIntent,
            )
            TerminalNotices(
                terminal = terminal,
                status = status?.takeIf { it != dismissedStatus },
                onDismissStatus = { dismissedStatus = it },
            )
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.BottomCenter) {
                if (keysOpen) TerminalKeysPanel(terminal, status, onKey, onPaste, onIntent)
            }
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

/**
 * Overlay surfaces own every touch that lands on them through HIT TESTING, not
 * consumption: Compose stops testing overlapping siblings at the first one hit
 * that has pointer input (sharing is opt-in), so the terminal sibling below never
 * receives a touch that lands here. This handler deliberately consumes nothing:
 * consuming here (an ancestor, Main pass) would make descendant buttons and the
 * Keys panel's scroll detector see their own pre-slop moves as consumed and cancel.
 */
private fun Modifier.ownsTouches(): Modifier = pointerInput(Unit) {}

/**
 * The compact control strip: Back, cross-host Switch, the explicit keyboard toggle,
 * and the Keys pop-out. The keyboard toggle only emits the existing intent; its
 * label follows observed IME insets ([TerminalUiState.keyboardVisible]), never the
 * tap.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TerminalControls(
    terminal: TerminalUiState,
    keysOpen: Boolean,
    onToggleKeys: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
) {
    Surface(
        modifier = Modifier.padding(4.dp).ownsTouches(),
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surface.copy(alpha = OVERLAY_ALPHA),
        tonalElevation = 2.dp,
    ) {
        // Wraps rather than squeezing trailing controls in narrow windows or with
        // enlarged text; only this overlay grows, never the pane's constraints.
        FlowRow(horizontalArrangement = Arrangement.End) {
            OverlayButton(onClick = { onIntent(ClientIntent.LeaveTerminal) }) {
                Text(stringResource(R.string.action_back), maxLines = 1)
            }
            OverlayButton(onClick = { onIntent(ClientIntent.ShowQuickSwitcher) }) {
                Text(stringResource(R.string.action_switch_session), maxLines = 1)
            }
            OverlayButton(onClick = { onIntent(ClientIntent.SetTerminalKeyboardVisible(!terminal.keyboardVisible)) }) {
                StableLabel(
                    R.string.key_hide_keyboard to terminal.keyboardVisible,
                    R.string.key_show_keyboard to !terminal.keyboardVisible,
                )
            }
            OverlayButton(onClick = onToggleKeys) {
                StableLabel(
                    R.string.terminal_keys_close to keysOpen,
                    R.string.terminal_keys_open to !keysOpen,
                )
            }
        }
    }
}

/** Compact text button; Material keeps the 48dp minimum interactive target. */
@Composable
private fun OverlayButton(onClick: () -> Unit, content: @Composable () -> Unit) {
    TextButton(onClick = onClick, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) {
        content()
    }
}

/** All alternatives share one footprint; only the visible one is in semantics. */
@Composable
private fun StableLabel(vararg labels: Pair<Int, Boolean>) {
    Box {
        labels.forEach { (label, visible) ->
            Text(stringResource(label), maxLines = 1,
                modifier = if (visible) Modifier else Modifier.alpha(0f).clearAndSetSemantics {})
        }
    }
}

/**
 * Readiness and status notices, overlaid without reserving layout. A paused
 * terminal always says so while it is paused; the latest app status can be
 * dismissed here and stays readable in the Keys panel.
 */
@Composable
private fun TerminalNotices(
    terminal: TerminalUiState,
    status: String?,
    onDismissStatus: (String) -> Unit,
) {
    val paused = when {
        terminal.coverage.suspendsTerminalInput -> R.string.terminal_suspended_coverage
        !terminal.inputReady -> R.string.terminal_suspended_viewport
        else -> null
    }
    if (paused == null && status == null) return
    Surface(
        modifier = Modifier.padding(horizontal = 4.dp).widthIn(max = 360.dp).ownsTouches(),
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surface.copy(alpha = OVERLAY_ALPHA),
        tonalElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (paused != null) {
                Text(
                    stringResource(paused),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            if (status != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        status,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f, fill = false).semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    TextButton(onClick = { onDismissStatus(status) }) {
                        Text(stringResource(R.string.terminal_status_dismiss))
                    }
                }
            }
        }
    }
}

/**
 * The Keys pop-out: the same native key toolbar, now transient.
 *
 * Sticky modifiers are held state, cleared across targets, coverage, and
 * backgrounding by the controller. Every key button submits a semantic
 * [TerminalControlKey] through the slot; nothing here builds an escape sequence or
 * fakes a hardware event. Opening, scrolling, or expanding this panel never
 * measures into the pane. It also carries the session title and host context that
 * the removed app bar used to show.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TerminalKeysPanel(
    terminal: TerminalUiState,
    status: String?,
    onKey: (TerminalKeyRequest) -> Unit,
    onPaste: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
) {
    val suspended = terminal.coverage.suspendsTerminalInput || !terminal.inputReady
    val held = terminal.modifiers

    Surface(
        modifier = Modifier.fillMaxWidth().ownsTouches(),
        color = MaterialTheme.colorScheme.surface.copy(alpha = OVERLAY_ALPHA),
        tonalElevation = 3.dp,
    ) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = terminal.sessionTitle,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = stringResource(R.string.session_host_context, terminal.hostLabel),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            status?.let { NoticeText(it) }

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
