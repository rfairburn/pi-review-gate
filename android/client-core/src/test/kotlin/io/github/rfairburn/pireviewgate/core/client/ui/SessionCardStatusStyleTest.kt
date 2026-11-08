package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Desktop status color parity for session cards.
 *
 * The values are the Pi v1.5.0 dark/light foreground tokens the desktop sidebar
 * paints with; each role, color, and weight is pinned exactly, and painting never
 * changes what the card classifies.
 */
class SessionCardStatusStyleTest {

    private val dark = SessionStatusTheme.DARK
    private val light = SessionStatusTheme.LIGHT

    @Test
    fun `every role has the exact desktop color in both variants`() {
        val expected = mapOf(
            SessionStatusRole.STARTING to (0x69ADD0 to 0x2F7899), // mdLink
            SessionStatusRole.RUNNING to (0x68B78D to 0x337E58), // success
            SessionStatusRole.WAITING to (0xCD9A22 to 0x8F6802), // warning
            SessionStatusRole.INPUT_PENDING to (0xCD9A22 to 0x8F6802), // warning
            SessionStatusRole.IDLE to (0x9DA5A9 to 0x677176), // muted
            SessionStatusRole.UNKNOWN to (0x7E888E to 0x879095), // dim
            SessionStatusRole.EXITED to (0x7E888E to 0x879095), // dim
            SessionStatusRole.ERROR to (0xEA7F81 to 0xC8253D), // error
        )
        assertEquals(SessionStatusRole.entries.toSet(), expected.keys)
        expected.forEach { (role, rgb) ->
            assertEquals(rgb.first, role.style(dark).rgb, "dark $role")
            assertEquals(rgb.second, role.style(light).rgb, "light $role")
        }
    }

    @Test
    fun `weights follow the desktop palette`() {
        for (theme in SessionStatusTheme.entries) {
            for (role in listOf(
                SessionStatusRole.RUNNING,
                SessionStatusRole.WAITING,
                SessionStatusRole.ERROR,
                SessionStatusRole.INPUT_PENDING,
            )) {
                assertEquals(true, role.style(theme).bold, "$theme $role")
            }
            for (role in listOf(SessionStatusRole.IDLE, SessionStatusRole.UNKNOWN, SessionStatusRole.EXITED)) {
                assertEquals(false, role.style(theme).bold, "$theme $role")
            }
        }
        // Starting is bold on dark and normal on light.
        assertEquals(true, SessionStatusRole.STARTING.style(dark).bold)
        assertEquals(false, SessionStatusRole.STARTING.style(light).bold)
    }

    @Test
    fun `the variant follows the native surface brightness`() {
        assertEquals(dark, SessionStatusTheme.forSurfaceLuminance(0.0f))
        assertEquals(dark, SessionStatusTheme.forSurfaceLuminance(0.12f))
        assertEquals(light, SessionStatusTheme.forSurfaceLuminance(0.5f))
        assertEquals(light, SessionStatusTheme.forSurfaceLuminance(0.93f))
    }

    // -- roles read the existing classification unchanged ----------------------------

    private fun roles(row: SessionUiState) = sessionCardStatusRoles(row)

    @Test
    fun `running wins over pending input, which stays painted independently`() {
        val row = ClientUiFixtures.row("a", busy = true, pendingInput = true, activeTasks = 0L, activeShells = 0L)
        assertEquals(SessionCardStatusRoles(null, SessionStatusRole.RUNNING, SessionStatusRole.INPUT_PENDING), roles(row))
    }

    @Test
    fun `a positive activity count is running even when busy is false`() {
        val row = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = 0L, activeShells = 2L)
        assertEquals(SessionStatusRole.RUNNING, roles(row).agent)
        assertEquals(SessionStatusRole.IDLE, roles(row).input)
    }

    @Test
    fun `waiting comes from pending input or an open surface`() {
        val pending = ClientUiFixtures.row("a", busy = false, pendingInput = true, activeTasks = 0L, activeShells = 0L)
        val surface = ClientUiFixtures.row("a", busy = false, pendingInput = false, inputSurface = true, activeTasks = 0L, activeShells = 0L)
        assertEquals(SessionCardStatusRoles(null, SessionStatusRole.WAITING, SessionStatusRole.INPUT_PENDING), roles(pending))
        assertEquals(SessionCardStatusRoles(null, SessionStatusRole.WAITING, SessionStatusRole.INPUT_PENDING), roles(surface))
    }

    @Test
    fun `idle needs every observation and input none is painted muted`() {
        val idle = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = 0L, activeShells = 0L)
        assertEquals(SessionCardStatusRoles(null, SessionStatusRole.IDLE, SessionStatusRole.IDLE), roles(idle))
        assertEquals(0x9DA5A9, SessionStatusRole.IDLE.style(dark).rgb)
    }

    @Test
    fun `unknown never becomes idle`() {
        val missingCount = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = null, activeShells = 0L)
        assertEquals(SessionStatusRole.UNKNOWN, roles(missingCount).agent)
        assertEquals(SessionStatusRole.IDLE, roles(missingCount).input)
        val nothing = ClientUiFixtures.row("a")
        assertEquals(SessionCardStatusRoles(null, SessionStatusRole.UNKNOWN, SessionStatusRole.UNKNOWN), roles(nothing))
    }

    @Test
    fun `starting paints lifecycle and input but has no agent value`() {
        val row = ClientUiFixtures.row("a", lifecycle = RosterLifecycle.STARTING, pendingInput = null)
        assertEquals(SessionCardStatusRoles(SessionStatusRole.STARTING, null, SessionStatusRole.UNKNOWN), roles(row))
    }

    @Test
    fun `exited and error paint only the lifecycle`() {
        val exited = ClientUiFixtures.row("a", lifecycle = RosterLifecycle.EXITED, pendingInput = true, exitCode = 0.0)
        val error = ClientUiFixtures.row("a", lifecycle = RosterLifecycle.ERROR, pendingInput = false, exitCode = 2.0)
        assertEquals(SessionCardStatusRoles(SessionStatusRole.EXITED, null, null), roles(exited))
        assertEquals(SessionCardStatusRoles(SessionStatusRole.ERROR, null, null), roles(error))
    }

    @Test
    fun `an alive lifecycle is not itself a painted value`() {
        val row = ClientUiFixtures.row("a", busy = true)
        assertNull(roles(row).lifecycle)
    }

    // -- the desktop count bands paint only an observed number ------------------------

    @Test
    fun `each count band maps to the existing palette role it reuses`() {
        // Zero is an observation and is never unknown; the bands are exactly the
        // desktop card's 0 / 1-2 / 3-6 / 7+.
        assertEquals(SessionStatusRole.IDLE, sessionCountStatusRole(0L))
        assertEquals(SessionStatusRole.RUNNING, sessionCountStatusRole(1L))
        assertEquals(SessionStatusRole.RUNNING, sessionCountStatusRole(2L))
        assertEquals(SessionStatusRole.WAITING, sessionCountStatusRole(3L))
        assertEquals(SessionStatusRole.WAITING, sessionCountStatusRole(6L))
        assertEquals(SessionStatusRole.ERROR, sessionCountStatusRole(7L))
        assertEquals(SessionStatusRole.ERROR, sessionCountStatusRole(1_000_000L))
        assertEquals(SessionStatusRole.ERROR, sessionCountStatusRole(Long.MAX_VALUE))
    }

    @Test
    fun `every count boundary paints the exact desktop color and weight`() {
        // count to dark rgb, light rgb, and whether the number is bold.
        val bands = listOf(
            0L to Triple(0x9DA5A9, 0x677176, false), // muted, normal
            1L to Triple(0x68B78D, 0x337E58, true), // success
            2L to Triple(0x68B78D, 0x337E58, true), // success
            3L to Triple(0xCD9A22, 0x8F6802, true), // warning
            6L to Triple(0xCD9A22, 0x8F6802, true), // warning
            7L to Triple(0xEA7F81, 0xC8253D, true), // error intensity
            1_000_000L to Triple(0xEA7F81, 0xC8253D, true), // error intensity
            Long.MAX_VALUE to Triple(0xEA7F81, 0xC8253D, true), // error intensity
        )
        bands.forEach { (count, painted) ->
            val (darkRgb, lightRgb, bold) = painted
            val role = requireNotNull(sessionCountStatusRole(count)) { "count $count must paint" }
            assertEquals(darkRgb, role.style(dark).rgb, "dark count $count")
            assertEquals(lightRgb, role.style(light).rgb, "light count $count")
            assertEquals(bold, role.style(dark).bold, "dark count $count weight")
            assertEquals(bold, role.style(light).bold, "light count $count weight")
        }
    }

    @Test
    fun `a missing or invalid count paints nothing and is never dimmed or zero`() {
        // No observed number means no painted span at all: the chip keeps its own
        // neutral content color instead of the dimmed UNKNOWN role, and a negative
        // is not an observation either.
        assertNull(sessionCountStatusRole(null))
        assertNull(sessionCountStatusRole(-1L))
        assertNull(sessionCountStatusRole(Long.MIN_VALUE))
        // Zero stays distinct: it is an observed number, not an unknown.
        assertEquals(SessionStatusRole.IDLE, sessionCountStatusRole(0L))
    }

    @Test
    fun `a count band never changes what the card classifies`() {
        // The highest band is red activity intensity on the number only. The row is
        // still classified exactly as before: running, with input unknown.
        val intense = ClientUiFixtures.row("a", activeTasks = 9L, activeShells = 7L)
        assertEquals(AgentActivity.RUNNING, intense.agentActivity)
        assertEquals(SessionStatusRole.RUNNING, roles(intense).agent)
        assertEquals(SessionStatusRole.UNKNOWN, roles(intense).input)
        assertEquals(
            SessionStatusRole.ERROR,
            sessionCountStatusRole(intense.metadata.activeTasks),
        )
        // And an unknown count keeps its neutral value while the agent classification
        // stays unknown rather than becoming idle.
        val missing = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = null, activeShells = 0L)
        assertNull(sessionCountStatusRole(missing.metadata.activeTasks))
        assertEquals(SessionStatusRole.UNKNOWN, roles(missing).agent)
    }
}
