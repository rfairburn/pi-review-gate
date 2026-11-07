package io.github.rfairburn.pireviewgate.ui.client

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.BackAction
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.NavigationDestination
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalBackAction
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalKeyRequest
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiCoverage
import io.github.rfairburn.pireviewgate.core.client.ui.backAction
import io.github.rfairburn.pireviewgate.core.client.ui.destination

/**
 * The whole client screen.
 *
 * It renders [state] and emits [ClientIntent] values, and nothing else: it opens no
 * connection, reads no storage, selects no owner, and keeps no second copy of a
 * host, a row, or a Saved entry. Expansion, text drafts, and which menu is open are
 * the only things it owns.
 *
 * Three things are required rather than defaulted, because a screen that quietly
 * works without them would be lying:
 *
 * - [terminalContent] is where the real terminal surface goes. There is no built-in
 *   placeholder, so a host that has not wired its surface cannot accidentally show a
 *   fake one.
 * - [onTerminalKey] and [onTerminalPaste] are how the toolbar submits keys and a
 *   paste. They reach the surface's own public submit API; this screen never
 *   synthesizes a hardware event or encodes a packet.
 *
 * Coverage is reported from here as well: a modal dialog or the quick switcher sheet
 * means terminal input is suspended and in-flight proofs retire, and the controller
 * learns that from the same screen that drew the covering control.
 */
@Composable
fun RootUIScreen(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
    onTerminalKey: (TerminalKeyRequest) -> Unit,
    onTerminalPaste: () -> Unit,
    terminalContent: @Composable (TerminalUiState) -> Unit,
) {
    // List positions are owned above the route switch: entering the fullscreen
    // terminal leaves this route's composition, and a state owned by the screen
    // itself would be recreated at the top on the way back.
    val sessionsListState = androidx.compose.foundation.lazy.rememberLazyListState()
    val hostsListState = androidx.compose.foundation.lazy.rememberLazyListState()
    val savedListState = androidx.compose.foundation.lazy.rememberLazyListState()

    UiCommitScope {
        MaterialTheme {
            reportCoverage(state, onIntent)
            handleBack(state, onIntent)

            val route = state.route
            if (route is ClientRoute.Terminal) {
                // Fullscreen: no navigation bar, no sidebar, no host list. Just the
                // terminal, its compact app bar, and the toolbar.
                TerminalScreen(
                    terminal = route.terminal,
                    terminalContent = terminalContent,
                    onKey = onTerminalKey,
                    onPaste = onTerminalPaste,
                    onIntent = onIntent,
                )
            } else {
                NonTerminalScaffold(
                    state = state,
                    onIntent = onIntent,
                    content = { padding ->
                        Box(modifier = Modifier.padding(padding)) {
                            when (route) {
                                is ClientRoute.Sessions -> SessionsScreen(
                                    state = state,
                                    onIntent = onIntent,
                                    listState = sessionsListState,
                                )
                                is ClientRoute.Hosts -> HostsScreen(
                                    state = state,
                                    onIntent = onIntent,
                                    listState = hostsListState,
                                )
                                is ClientRoute.Settings -> SettingsScreen(state = state, onIntent = onIntent)
                                is ClientRoute.Saved -> SavedScreen(
                                    state = state,
                                    onIntent = onIntent,
                                    listState = savedListState,
                                )
                                is ClientRoute.Terminal -> Unit
                            }
                        }
                    },
                )
            }

            if ((route as? ClientRoute.Terminal)?.terminal?.quickSwitcherVisible == true) {
                QuickSwitcherSheet(state = state, onIntent = onIntent)
            }

            ClientDialogLayer(state = state, onIntent = onIntent)
        }
    }
}

/** The scaffold every non-terminal route shares. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NonTerminalScaffold(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
    content: @Composable (PaddingValues) -> Unit,
) {
    val route = state.route
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(route.titleRes())) },
                navigationIcon = {
                    if (state.backAction() == BackAction.SHOW_SESSIONS) {
                        TextButton(onClick = { onIntent(ClientIntent.ShowDestination(NavigationDestination.SESSIONS)) }) {
                            Text(stringResource(R.string.action_back))
                        }
                    }
                },
                actions = {
                    if (route != ClientRoute.Settings) {
                        TextButton(onClick = { onIntent(ClientIntent.ShowDestination(NavigationDestination.SETTINGS)) }) {
                            Text(stringResource(R.string.nav_settings))
                        }
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = route.destination() == NavigationDestination.SESSIONS,
                    onClick = { onIntent(ClientIntent.ShowDestination(NavigationDestination.SESSIONS)) },
                    icon = {},
                    label = { Text(stringResource(R.string.nav_sessions)) },
                )
                NavigationBarItem(
                    selected = route.destination() == NavigationDestination.HOSTS,
                    onClick = { onIntent(ClientIntent.ShowDestination(NavigationDestination.HOSTS)) },
                    icon = {},
                    label = { Text(stringResource(R.string.nav_hosts)) },
                )
                NavigationBarItem(
                    selected = route.destination() == NavigationDestination.SETTINGS,
                    onClick = { onIntent(ClientIntent.ShowDestination(NavigationDestination.SETTINGS)) },
                    icon = {},
                    label = { Text(stringResource(R.string.nav_settings)) },
                )
            }
        },
        content = content,
    )
}

/**
 * Report coverage upward whenever a modal or a sheet appears or disappears.
 *
 * Menus report their own coverage where they open, so this only escalates to a modal
 * or a sheet and only steps back down from those.
 */
@Composable
private fun reportCoverage(state: ClientUiState, onIntent: (ClientIntent) -> Unit) {
    val modal = state.dialogs.hasModal
    val sheet = (state.route as? ClientRoute.Terminal)?.terminal?.quickSwitcherVisible == true
    LaunchedEffect(modal, sheet) {
        when {
            modal -> onIntent(ClientIntent.UiCoverageChanged(UiCoverage.MODAL_DIALOG))
            sheet -> onIntent(ClientIntent.UiCoverageChanged(UiCoverage.BOTTOM_SHEET))
            state.coverage == UiCoverage.MODAL_DIALOG || state.coverage == UiCoverage.BOTTOM_SHEET ->
                onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
            else -> Unit
        }
    }
}

/**
 * System back.
 *
 * On the terminal the order is fixed: retire the quick switcher, then let the soft
 * keyboard go, then leave the terminal. Anywhere else, Hosts, Settings, and Saved
 * return to the session list, and on the session list itself the UI claims nothing so
 * the system decides.
 */
@Composable
private fun handleBack(state: ClientUiState, onIntent: (ClientIntent) -> Unit) {
    val route = state.route
    if (route is ClientRoute.Terminal) {
        BackHandler(enabled = true) {
            when (route.terminal.backAction()) {
                TerminalBackAction.DISMISS_QUICK_SWITCHER -> onIntent(ClientIntent.DismissQuickSwitcher)
                TerminalBackAction.DISMISS_KEYBOARD -> onIntent(ClientIntent.SetTerminalKeyboardVisible(false))
                TerminalBackAction.LEAVE_TERMINAL -> onIntent(ClientIntent.LeaveTerminal)
            }
        }
        return
    }
    BackHandler(enabled = state.backAction() == BackAction.SHOW_SESSIONS) {
        onIntent(ClientIntent.ShowDestination(NavigationDestination.SESSIONS))
    }
}

private fun ClientRoute.titleRes(): Int = when (this) {
    is ClientRoute.Sessions -> R.string.sessions_title
    is ClientRoute.Hosts -> R.string.hosts_title
    is ClientRoute.Settings -> R.string.settings_title
    is ClientRoute.Saved -> R.string.saved_title
    is ClientRoute.Terminal -> R.string.terminal_title
}
