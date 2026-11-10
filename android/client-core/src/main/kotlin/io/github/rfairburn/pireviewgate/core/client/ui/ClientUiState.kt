package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionObservation

/**
 * Where the screen currently is.
 *
 * [Sessions], [Hosts], and [Settings] are the three top-level destinations and are
 * reachable from each other by native navigation. [Saved] is a per-owner browser
 * opened from the session list's header after an explicit host choice, so it belongs
 * to [NavigationDestination.SESSIONS]. [Terminal] is fullscreen: it carries its own
 * state and deliberately has no app bar, navigation bar, or sidebar, only in-window
 * overlays.
 */
public sealed interface ClientRoute {
    public data object Sessions : ClientRoute
    public data object Hosts : ClientRoute
    public data object Settings : ClientRoute

    /** One owner's Saved catalog browser. */
    public data class Saved(public val hostId: HostId) : ClientRoute

    /** The fullscreen terminal. */
    public data class Terminal(public val terminal: TerminalUiState) : ClientRoute
}

/** The three top-level destinations the navigation chrome can point at. */
public enum class NavigationDestination {
    SESSIONS,
    HOSTS,
    SETTINGS,
}

/** The destination one route belongs to, for highlighting native navigation. */
public fun ClientRoute.destination(): NavigationDestination? = when (this) {
    is ClientRoute.Sessions -> NavigationDestination.SESSIONS
    is ClientRoute.Hosts -> NavigationDestination.HOSTS
    is ClientRoute.Settings -> NavigationDestination.SETTINGS
    is ClientRoute.Saved -> NavigationDestination.SESSIONS
    is ClientRoute.Terminal -> null
}

/**
 * This client's own peer identity, as far as it is known.
 *
 * [NotInitialized] and [Unknown] are different statements, and neither is rendered
 * as a fingerprint: no placeholder key text is ever drawn. A refused read is
 * reported as refused, never as absent.
 */
public sealed interface ClientIdentityState {
    /** Not observed yet. */
    public data object Unknown : ClientIdentityState

    /** This device has no peer identity yet. */
    public data object NotInitialized : ClientIdentityState

    /** The identity exists; [fingerprint] is display-only proof text. */
    public data class Ready(public val fingerprint: String) : ClientIdentityState

    /** Identity storage refused. The state is unknown, not empty. */
    public data class Refused(public val reason: StorageFailureReason) : ClientIdentityState
}

/** Whether this client's private durable state is readable. */
public sealed interface ClientStorageState {
    /** Not observed yet. */
    public data object Unknown : ClientStorageState

    /** The client's documents are readable. */
    public data object Healthy : ClientStorageState

    /** Storage refused; [reason] is display-safe and carries no path. */
    public data class Refused(public val reason: StorageFailureReason) : ClientStorageState
}

/**
 * The complete state one native frame renders.
 *
 * The UI has no backend authority: it reads this value, renders it, and emits
 * [ClientIntent] values. It never opens a connection, never reads storage, never
 * selects an owner, and never keeps a second mutable copy of a host, a row, or a
 * Saved entry — [settings], [hostStates], [SessionUiState.metadata], and
 * [SavedUiState.entries] are the same core types the rest of the client uses.
 *
 * [hostStates] is ordered by the saved catalog. A host with no [HostUiState.roster]
 * has never reported one; that is not the same as a zero-row roster, and the
 * session list says so instead of hiding the host.
 *
 * [rowOrder] is the controller's own canonical global ordering, stated as row keys.
 * It is a projection of an order that lives elsewhere (the presentation-order owner),
 * not a second row store: an empty list means no order was stated and the fallback
 * is saved host order then owner order. The unified list, the quick switcher, and
 * move neighbours are all computed from the same resolved order.
 *
 * [coverage] is what the UI most recently reported it drew over the terminal, so the
 * controller can retire proofs and suspend terminal input from the same fact the
 * screen used. It describes the terminal, never a dialog's own window.
 */
public data class ClientUiState(
    public val route: ClientRoute = ClientRoute.Sessions,
    public val settings: NetworkSettings = NetworkSettings.DEFAULTS,
    public val hostStates: List<HostUiState> = emptyList(),
    public val rowOrder: List<SessionRowKey> = emptyList(),
    public val saved: SavedUiState = SavedUiState.EMPTY,
    public val dialogs: ClientDialogs = ClientDialogs.NONE,
    public val identity: ClientIdentityState = ClientIdentityState.Unknown,
    public val storage: ClientStorageState = ClientStorageState.Unknown,
    public val localNetworkPermission: LocalNetworkPermissionObservation? = null,
    public val coverage: UiCoverage = UiCoverage.NONE,
) {
    /** One host's view state by stable id, or `null` when it is not in the view. */
    public fun hostState(id: HostId): HostUiState? = hostStates.firstOrNull { it.host.id == id }

    /** Unified, globally ordered session rows across every host, as rendered. */
    public val sessions: List<SessionUiState> get() = orderedSessionRows(hostStates, rowOrder)

    /** Hosts contributing no rows right now, with the honest reason for each. */
    public val emptyHosts: List<EmptyHostRow> get() = emptyHostRows(hostStates)

    /** True when at least one host currently holds a live (non-stale) roster view. */
    public val hasLiveRoster: Boolean
        get() = hostStates.any { it.roster?.freshness == RosterFreshness.CURRENT }

    /**
     * The open dialogs in the order their layers are composed, bottom first.
     *
     * A dialog is covered only by one that comes after it in this list; the terminal
     * underneath it is not coverage over the dialog.
     */
    public val coveredDialogKinds: List<ClientDialogKind> get() = dialogs.openKinds
}

/** What a system Back press must do on a non-terminal route. */
public enum class BackAction {
    /** Show the session list again. */
    SHOW_SESSIONS,

    /** Nothing to unwind here; let the system handle it. */
    SYSTEM_DEFAULT,
}

/**
 * The honest back plan for one route.
 *
 * Hosts, Settings, and Saved return to the session list. On the session list itself
 * the UI claims nothing: the system decides, which is what makes "back to the
 * session list" one predictable gesture from anywhere that has somewhere to go.
 */
public fun ClientUiState.backAction(): BackAction = when (route) {
    is ClientRoute.Sessions -> BackAction.SYSTEM_DEFAULT
    is ClientRoute.Hosts -> BackAction.SHOW_SESSIONS
    is ClientRoute.Settings -> BackAction.SHOW_SESSIONS
    is ClientRoute.Saved -> BackAction.SHOW_SESSIONS
    is ClientRoute.Terminal -> BackAction.SYSTEM_DEFAULT
}
