package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The dedicated Saved route belongs to the session list: it is opened from the session
 * list's header, so it highlights Sessions and returns there.
 */
class SavedRouteNavigationTest {

    @Test
    fun `the Saved route highlights Sessions for every owner`() {
        listOf(HostId.parse("a"), HostId.parse("b")).forEach { host ->
            assertEquals(NavigationDestination.SESSIONS, ClientRoute.Saved(host).destination())
        }
    }

    @Test
    fun `back from the Saved route returns to Sessions`() {
        assertEquals(
            BackAction.SHOW_SESSIONS,
            ClientUiState(route = ClientRoute.Saved(HostId.parse("a"))).backAction(),
        )
    }

    @Test
    fun `the other top-level routes keep their own destinations`() {
        assertEquals(NavigationDestination.SESSIONS, ClientRoute.Sessions.destination())
        assertEquals(NavigationDestination.HOSTS, ClientRoute.Hosts.destination())
        assertEquals(NavigationDestination.SETTINGS, ClientRoute.Settings.destination())
    }
}
