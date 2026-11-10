package io.github.rfairburn.pireviewgate.ui.client

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel

/**
 * The terminal screen's Keys presentation: which pop-out is open, and which raw status
 * text the operator dismissed.
 *
 * Both are presentation, like an open menu, and both belong to one instance of the
 * terminal route. They are deliberately not saved: neither the open flag nor a dismissed
 * notice is written to the instance-state bundle, to the version-2 placement document, or
 * to any other store. [androidx.compose.runtime.saveable.rememberSaveable] could not give
 * that guarantee, because its whole purpose is to be restored after the system killed the
 * process and started it again — so this holder keeps the values outside the bundle and
 * the screen hands [claimRoute] the identity of the route instance it is composing.
 *
 * A plain `remember` would be wrong in the other direction: it is dropped by every
 * configuration change, so a rotation would close a panel the operator had just opened.
 * A lifecycle-retained [ViewModel] is what survives that recreation, and it outlives the
 * composition too, which is why the route token is needed: the owner is the scope that
 * spans a rotation, and the token is what tells a rotation apart from leaving the
 * terminal and entering it again.
 *
 * What that scope therefore covers, in source:
 * - Configuration change (rotation): the same owner sees the same route token, so the
 *   open panel, the docking it is using, and the dismissed notice all stay as they were.
 * - Backgrounding and return: neither the owner nor the token changes, so nothing here
 *   closes the panel or un-dismisses a notice because the app was backgrounded. There is
 *   deliberately no forced close on background.
 * - Terminal target change and every overlay/docking presentation change: the screen is
 *   still the same route instance with the same token, so this holder is not reset.
 * - Leaving the terminal and entering it again: the route instance is gone, so a fresh
 *   token arrives and the panel is closed with nothing dismissed — the scope this
 *   presentation had when it was screen-local state.
 * - A cold process start: a new owner has no token at all, so the first claim resets, and
 *   the screen starts closed with nothing dismissed whatever the remembered docking says.
 */
internal class TerminalKeysEphemeralState : ViewModel() {
    /** Whether the Keys pop-out is open. Never serialized. */
    var keysOpen by mutableStateOf(false)

    /** The exact raw status text the operator dismissed. Never serialized. */
    var dismissedStatus by mutableStateOf<String?>(null)

    /**
     * The token of the terminal route instance this presentation currently belongs to, or
     * null when no terminal screen has claimed this owner since it was created. Held in
     * memory only: it is an identity, not state the operator sees, and it is never
     * serialized.
     */
    private var routeToken: String? = null

    /**
     * Claims [token] for the terminal screen now composing. The same token is a no-op, so
     * recomposition, backgrounding, and a configuration change all leave the presentation
     * alone. A token this owner has not seen — a route instance it never served, which
     * includes the first claim after process start — closes the panel and un-dismisses
     * every notice before the screen reads them.
     */
    fun claimRoute(token: String) {
        if (routeToken == token) return
        routeToken = token
        keysOpen = false
        dismissedStatus = null
    }
}

/**
 * The Keys presentation owner for the terminal screen in composition. It is retained
 * across a configuration change and released with the process; the screen's saved route
 * token, not this owner, is what separates a rotation from leaving and re-entering the
 * terminal.
 */
@Composable
internal fun rememberTerminalKeysEphemeralState(): TerminalKeysEphemeralState = viewModel()
