package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationMovePosition
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationOwnerKind
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Truthful projection of remote rows into the unified session list.
 *
 * The point of every case here is that an absent observation stays absent: unknown
 * is never rendered as idle, an absent count is never zero, and a host that never
 * reported a roster is never shown as a host with no sessions.
 */
class SessionProjectionTest {

    @Test
    fun `busy true is running regardless of the other observations`() {
        val row = ClientUiFixtures.row("a", busy = true, pendingInput = false, activeTasks = 0L, activeShells = 0L)
        assertEquals(AgentActivity.RUNNING, row.agentActivity)
    }

    @Test
    fun `a positive activity-intent count is running even when busy is false`() {
        val byTasks = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = 2L, activeShells = 0L)
        val byShells = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = 0L, activeShells = 1L)
        assertEquals(AgentActivity.RUNNING, byTasks.agentActivity)
        assertEquals(AgentActivity.RUNNING, byShells.agentActivity)
    }

    @Test
    fun `pending input or an open surface is waiting, not idle`() {
        val pending = ClientUiFixtures.row("a", busy = false, pendingInput = true, activeTasks = 0L, activeShells = 0L)
        val surface = ClientUiFixtures.row("a", busy = false, pendingInput = false, inputSurface = true, activeTasks = 0L, activeShells = 0L)
        assertEquals(AgentActivity.WAITING, pending.agentActivity)
        assertEquals(AgentActivity.WAITING, surface.agentActivity)
    }

    @Test
    fun `idle requires the complete positive observation`() {
        val idle = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = 0L, activeShells = 0L)
        assertEquals(AgentActivity.IDLE, idle.agentActivity)
    }

    @Test
    fun `a missing count is unknown and never idle`() {
        val missingTasks = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = null, activeShells = 0L)
        val missingShells = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = 0L, activeShells = null)
        val missingBusy = ClientUiFixtures.row("a", busy = null, pendingInput = false, activeTasks = 0L, activeShells = 0L)
        val missingPending = ClientUiFixtures.row("a", busy = false, pendingInput = null, activeTasks = 0L, activeShells = 0L)
        assertEquals(AgentActivity.UNKNOWN, missingTasks.agentActivity)
        assertEquals(AgentActivity.UNKNOWN, missingShells.agentActivity)
        assertEquals(AgentActivity.UNKNOWN, missingBusy.agentActivity)
        assertEquals(AgentActivity.UNKNOWN, missingPending.agentActivity)
    }

    @Test
    fun `lifecycle other than alive has no agent activity`() {
        for (lifecycle in listOf(RosterLifecycle.STARTING, RosterLifecycle.EXITED, RosterLifecycle.ERROR)) {
            val row = ClientUiFixtures.row("a", lifecycle = lifecycle, busy = false, pendingInput = false, activeTasks = 0L, activeShells = 0L)
            assertNull(row.agentActivity, "lifecycle $lifecycle must not claim agent activity")
        }
    }

    @Test
    fun `input observation is independent of agent activity`() {
        val runningWithPending = ClientUiFixtures.row("a", busy = true, pendingInput = true, activeTasks = 0L, activeShells = 0L)
        assertEquals(AgentActivity.RUNNING, runningWithPending.agentActivity)
        assertEquals(InputObservation.PENDING, runningWithPending.inputObservation)

        val noneObserved = ClientUiFixtures.row("a", busy = false, pendingInput = false, activeTasks = 0L, activeShells = 0L)
        assertEquals(InputObservation.NONE, noneObserved.inputObservation)

        val unobserved = ClientUiFixtures.row("a", busy = null, pendingInput = null, activeTasks = 0L, activeShells = 0L)
        assertEquals(InputObservation.UNKNOWN, unobserved.inputObservation)
    }

    @Test
    fun `the native name is the title and the label is only the fallback`() {
        val named = ClientUiFixtures.row("a", label = "fallback label", nativeSession = ClientUiFixtures.nativeSession(name = "Real name"))
        val unnamed = ClientUiFixtures.row("a", label = "fallback label")
        assertEquals("Real name", named.displayTitle)
        assertEquals("fallback label", unnamed.displayTitle)
    }

    @Test
    fun `the same row id on two hosts stays two rows`() {
        val first = ClientUiFixtures.row("a", rowId = "row-1", label = "first host row")
        val second = ClientUiFixtures.row("b", rowId = "row-1", label = "second host row")
        val state = ClientUiState(
            hostStates = listOf(
                ClientUiFixtures.hostState("a", rows = listOf(first)),
                ClientUiFixtures.hostState("b", rows = listOf(second)),
            ),
        )
        val rows = state.sessions
        assertEquals(2, rows.size)
        assertEquals(listOf(HostId.parse("a"), HostId.parse("b")), rows.map { it.hostId })
        assertEquals(listOf("first host row", "second host row"), rows.map { it.metadata.label })

        // Both rows carry the same owner row id, so only the qualifying triple tells
        // them apart.
        val targets = rows.map { SessionActionTarget.of(it) }
        assertEquals(2, targets.toSet().size)
        assertEquals(listOf("row-1", "row-1"), targets.map { it.rowId })
        assertEquals(listOf(HostId.parse("a"), HostId.parse("b")), targets.map { it.hostId })
    }

    @Test
    fun `unified rows follow saved host order then owner order`() {
        val a1 = ClientUiFixtures.row("a", rowId = "a1")
        val a2 = ClientUiFixtures.row("a", rowId = "a2")
        val b1 = ClientUiFixtures.row("b", rowId = "b1")
        val state = ClientUiState(
            settings = ClientUiFixtures.settings(ClientUiFixtures.host("a"), ClientUiFixtures.host("b")),
            hostStates = listOf(
                ClientUiFixtures.hostState("b", rows = listOf(b1)),
                ClientUiFixtures.hostState("a", rows = listOf(a1, a2)),
            ),
        )
        assertEquals(listOf("b1", "a1", "a2"), state.sessions.map { it.rowId })
    }

    @Test
    fun `a host that never reported a roster contributes no rows and is labelled never-reported`() {
        val never = ClientUiFixtures.hostState("a", rows = null)
        val empty = ClientUiFixtures.hostState("b", rows = emptyList())
        val stale = ClientUiFixtures.hostState("c", rows = listOf(ClientUiFixtures.row("c", rowId = "c1", stale = true)))
        val state = ClientUiState(hostStates = listOf(never, empty, stale))

        assertEquals(listOf("c1"), state.sessions.map { it.rowId })
        assertEquals(
            listOf(EmptyHostRow.NeverReported::class, EmptyHostRow.ReportedEmpty::class),
            state.emptyHosts.map { it::class },
        )
        assertTrue(stale.isStale)
        assertFalse(never.hasRosterObservation)
        assertTrue(empty.hasRosterObservation)
        assertEquals(0, empty.roster?.rowCount)
    }

    @Test
    fun `a stale host with rows still contributes them and marks them stale`() {
        val staleRow = ClientUiFixtures.row("a", stale = true)
        val host = ClientUiFixtures.hostState("a", rows = listOf(staleRow))
        assertEquals(listOf("row-1"), host.rows.map { it.rowId })
        assertTrue(host.rows.single().stale)
        assertTrue(host.isStale)
        assertFalse(host.rows.single().metadata.id.isEmpty())
    }

    // -- one global order, not one list per host --------------------------------

    @Test
    fun `a stated row order interleaves hosts instead of grouping by host`() {
        val a1 = ClientUiFixtures.row("a", rowId = "a1")
        val a2 = ClientUiFixtures.row("a", rowId = "a2")
        val b1 = ClientUiFixtures.row("b", rowId = "b1")
        val state = ClientUiState(
            hostStates = listOf(
                ClientUiFixtures.hostState("a", rows = listOf(a1, a2)),
                ClientUiFixtures.hostState("b", rows = listOf(b1)),
            ),
            rowOrder = listOf(
                SessionRowKey.of(a1),
                SessionRowKey.of(b1),
                SessionRowKey.of(a2),
            ),
        )
        assertEquals(listOf("a1", "b1", "a2"), state.sessions.map { it.rowId })
    }

    @Test
    fun `rows the stated order omits keep their fallback place and unknown keys are ignored`() {
        val a1 = ClientUiFixtures.row("a", rowId = "a1")
        val b1 = ClientUiFixtures.row("b", rowId = "b1")
        val state = ClientUiState(
            hostStates = listOf(
                ClientUiFixtures.hostState("a", rows = listOf(a1)),
                ClientUiFixtures.hostState("b", rows = listOf(b1)),
            ),
            rowOrder = listOf(
                SessionRowKey(HostId.parse("q"), ClientUiFixtures.RUN_A, "never-seen"),
                SessionRowKey.of(b1),
            ),
        )
        assertEquals(listOf("b1", "a1"), state.sessions.map { it.rowId })
    }

    @Test
    fun `no stated order falls back to saved host order then owner order`() {
        val a1 = ClientUiFixtures.row("a", rowId = "a1")
        val b1 = ClientUiFixtures.row("b", rowId = "b1")
        val state = ClientUiState(
            hostStates = listOf(
                ClientUiFixtures.hostState("a", rows = listOf(a1)),
                ClientUiFixtures.hostState("b", rows = listOf(b1)),
            ),
        )
        assertEquals(listOf("a1", "b1"), state.sessions.map { it.rowId })
    }

    @Test
    fun `move neighbours come from the rendered order and cross host boundaries`() {
        val a1 = ClientUiFixtures.row("a", rowId = "a1")
        val a2 = ClientUiFixtures.row("a", rowId = "a2")
        val b1 = ClientUiFixtures.row("b", rowId = "b1")
        val ordered = orderedSessionRows(
            hostStates = listOf(
                ClientUiFixtures.hostState("a", rows = listOf(a1, a2)),
                ClientUiFixtures.hostState("b", rows = listOf(b1)),
            ),
            rowOrder = listOf(
                SessionRowKey.of(a1),
                SessionRowKey.of(b1),
                SessionRowKey.of(a2),
            ),
        )
        val (above, below) = sessionRowNeighbours(ordered, a2)
        // The row above a2 belongs to another host. Grouping by host made a move
        // across that boundary impossible to express at all.
        assertEquals("b1", above?.rowId)
        assertEquals(HostId.parse("b"), above?.hostId)
        assertNull(below)

        val (firstAbove, _) = sessionRowNeighbours(ordered, a1)
        assertNull(firstAbove)
    }

    @Test
    fun `a row absent from the rendered order has no neighbours`() {
        val a1 = ClientUiFixtures.row("a", rowId = "a1")
        val other = ClientUiFixtures.row("a", rowId = "ghost")
        val (above, below) = sessionRowNeighbours(listOf(a1), other)
        assertNull(above)
        assertNull(below)
    }

    // -- the owner's own label, kept visible -------------------------------------

    @Test
    fun `the owner label stays readable next to a native session name`() {
        val row = ClientUiFixtures.row(
            "a",
            rowId = "row-1",
            label = "owner label",
            nativeSession = ClientUiFixtures.nativeSession(name = "Native name"),
        )
        // The title is the canonical one, and the owner's label is still carried on the
        // row so a details view can name the row the way the owner's own list does.
        assertEquals("Native name", row.displayTitle)
        assertEquals("owner label", row.metadata.label)
    }
}
