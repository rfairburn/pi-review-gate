package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationIdentity
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationMovePosition
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationOwnerKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Session-card drag ordering, accessible moves, and the background line.
 *
 * Every drop resolves to at most one existing [ClientIntent.MoveSessionRow] addressed
 * by presentation identities; anything stale, ambiguous, or unchanged drops nothing.
 */
class SessionCardInteractionTest {

    private fun row(host: String, id: String, slot: String? = "slot-$host-$id") =
        ClientUiFixtures.row(host, rowId = id, rosterSlotId = slot)

    private val a1 = row("a", "a1")
    private val a2 = row("a", "a2")
    private val a3 = row("a", "a3")
    private val b1 = row("b", "b1")
    private val rows = listOf(a1, a2, a3, b1)

    private fun key(row: SessionUiState) = SessionRowKey.of(row)

    private fun slot(host: String, id: String) =
        assertNotNull(RemotePresentationIdentity.slot(HostId.parse(host), "slot-$host-$id"))

    private fun dragOf(source: SessionUiState, current: List<SessionUiState> = rows) =
        assertNotNull(SessionCardDrag.begin(current, key(source), eligible = true))

    // -- background line ------------------------------------------------------------

    @Test
    fun `both activity counts missing is background unknown`() {
        assertEquals(SessionCardBackground.Unknown, sessionCardBackground(row("a", "x").metadata))
    }

    @Test
    fun `one missing count stays unknown beside a known one`() {
        val tasksOnly = ClientUiFixtures.row("a", activeTasks = 2L, activeShells = null)
        val shellsOnly = ClientUiFixtures.row("a", activeTasks = null, activeShells = 0L)
        assertEquals(SessionCardBackground.Counts(2L, null), sessionCardBackground(tasksOnly.metadata))
        assertEquals(SessionCardBackground.Counts(null, 0L), sessionCardBackground(shellsOnly.metadata))
    }

    @Test
    fun `zero is a real count and is not unknown`() {
        val zero = ClientUiFixtures.row("a", activeTasks = 0L, activeShells = 0L)
        assertEquals(SessionCardBackground.Counts(0L, 0L), sessionCardBackground(zero.metadata))
    }

    @Test
    fun `a negative count is unknown, never zero`() {
        val bad = ClientUiFixtures.row("a", activeTasks = -1L, activeShells = -3L)
        assertEquals(SessionCardBackground.Unknown, sessionCardBackground(bad.metadata))
        val half = ClientUiFixtures.row("a", activeTasks = -1L, activeShells = 4L)
        assertEquals(SessionCardBackground.Counts(null, 4L), sessionCardBackground(half.metadata))
    }

    @Test
    fun `the line reads activity-intent counts, never ownership counts`() {
        val ownershipOnly = ClientUiFixtures.row(
            "a", backgroundTasks = 5L, backgroundShells = 3L, activeTasks = null, activeShells = null,
        )
        assertEquals(SessionCardBackground.Unknown, sessionCardBackground(ownershipOnly.metadata))
        val both = ClientUiFixtures.row(
            "a", backgroundTasks = 9L, backgroundShells = 9L, activeTasks = 1L, activeShells = 2L,
        )
        assertEquals(SessionCardBackground.Counts(1L, 2L), sessionCardBackground(both.metadata))
    }

    // -- identity, fail closed --------------------------------------------------------

    @Test
    fun `a unique durable slot names the row and the internal identity is unchanged`() {
        assertEquals(slot("a", "a1"), uniqueSessionPresentationIdentity(rows, key(a1)))
        assertEquals(a1.presentationIdentity, uniqueSessionPresentationIdentity(rows, key(a1)))
        assertEquals("slot-a-a1", a1.metadata.rosterSlotId)
    }

    @Test
    fun `a row with no slot keeps the legacy runtime identity`() {
        val legacy = row("a", "legacy", slot = null)
        val identity = assertNotNull(uniqueSessionPresentationIdentity(listOf(legacy), key(legacy)))
        assertEquals(RemotePresentationOwnerKind.LEGACY_RUNTIME, identity.ownerKind)
    }

    @Test
    fun `a duplicate identity is refused for both rows`() {
        val dupA = row("a", "x1", slot = "shared")
        val dupB = row("a", "x2", slot = "shared")
        val current = listOf(dupA, dupB)
        assertNull(uniqueSessionPresentationIdentity(current, key(dupA)))
        assertNull(uniqueSessionPresentationIdentity(current, key(dupB)))
        assertNull(SessionCardDrag.begin(current, key(dupA), eligible = true))
    }

    @Test
    fun `the same slot on two hosts is two identities`() {
        val onA = row("a", "x", slot = "shared")
        val onB = row("b", "x", slot = "shared")
        val current = listOf(onA, onB)
        assertNotNull(uniqueSessionPresentationIdentity(current, key(onA)))
        assertNotNull(uniqueSessionPresentationIdentity(current, key(onB)))
    }

    @Test
    fun `a missing or repeated row key resolves nothing`() {
        assertNull(uniqueSessionPresentationIdentity(rows, SessionRowKey(HostId.parse("a"), ClientUiFixtures.RUN_A, "ghost")))
        assertNull(uniqueSessionPresentationIdentity(listOf(a1, a1), key(a1)))
    }

    @Test
    fun `a malformed reported slot is refused rather than replaced by a runtime identity`() {
        val malformed = row("a", "bad", slot = "bad\u0001slot")
        assertNull(uniqueSessionPresentationIdentity(listOf(malformed), key(malformed)))
        assertNull(SessionCardDrag.begin(listOf(malformed), key(malformed), eligible = true))
    }

    @Test
    fun `the shared identity index answers exactly like a per-row resolution`() {
        val current = listOf(
            a1, a2, row("a", "dup1", slot = "shared"), row("a", "dup2", slot = "shared"),
            row("a", "legacy", slot = null), row("a", "bad", slot = "bad\u0001slot"), a1, b1,
        )
        val index = SessionIdentityIndex(current)
        for (r in current) {
            val k = key(r)
            val matches = current.count { key(it) == k }
            val identity = r.presentationIdentity
            val expected = identity?.takeIf {
                matches == 1 &&
                    current.count { other -> other.presentationIdentity == it } == 1 &&
                    (r.metadata.rosterSlotId == null || it.ownerKind == RemotePresentationOwnerKind.SLOT)
            }
            assertEquals(expected, index[k], "row ${r.rowId}")
        }
        assertNull(index[key(a1)]) // a1 appears twice
        assertNotNull(index[key(a2)])
        assertNotNull(index[key(b1)])
    }

    // -- accessible moves -------------------------------------------------------------

    @Test
    fun `accessible moves are the former menu intents against rendered neighbours`() {
        val moves = sessionCardAccessibleMoves(rows, a3)
        assertEquals(
            ClientIntent.MoveSessionRow(slot("a", "a3"), RemotePresentationMovePosition.BEFORE, slot("a", "a2")),
            moves.moveUp,
        )
        // Below a3 is a row of another host: the presentation order is host-independent.
        assertEquals(
            ClientIntent.MoveSessionRow(slot("a", "a3"), RemotePresentationMovePosition.AFTER, slot("b", "b1")),
            moves.moveDown,
        )
    }

    @Test
    fun `accessible moves have no action past either end`() {
        assertNull(sessionCardAccessibleMoves(rows, a1).moveUp)
        assertNull(sessionCardAccessibleMoves(rows, b1).moveDown)
    }

    @Test
    fun `an ambiguous neighbour or row offers no accessible move`() {
        val x = row("a", "x", slot = "shared")
        val y = row("a", "y")
        val z = row("a", "z", slot = "shared")
        val current = listOf(x, y, z)
        val moves = sessionCardAccessibleMoves(current, y)
        assertNull(moves.moveUp)
        assertNull(moves.moveDown)
        assertEquals(SessionCardAccessibleMoves(null, null), sessionCardAccessibleMoves(current, x))
    }

    // -- drag: begin ------------------------------------------------------------------

    @Test
    fun `an ineligible or unknown source never starts a drag`() {
        assertNull(SessionCardDrag.begin(rows, key(a1), eligible = false))
        assertNull(SessionCardDrag.begin(rows, SessionRowKey(HostId.parse("a"), ClientUiFixtures.RUN_A, "ghost"), eligible = true))
    }

    @Test
    fun `a fresh drag previews the real order and drops nothing`() {
        val drag = dragOf(a1)
        assertNull(drag.target)
        assertEquals(rows, drag.previewRows(rows))
        assertNull(drag.dropIntent(rows))
    }

    // -- drag: before / after / cross-host / end ---------------------------------------

    @Test
    fun `lower half of a card drops after it, exactly one move`() {
        val drag = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a3), upperHalf = false))
        assertEquals(listOf(a2, a3, a1, b1), drag.previewRows(rows))
        assertEquals(
            ClientIntent.MoveSessionRow(slot("a", "a1"), RemotePresentationMovePosition.AFTER, slot("a", "a3")),
            drag.dropIntent(rows),
        )
    }

    @Test
    fun `upper half of a card drops before it`() {
        val drag = dragOf(b1).retarget(rows, SessionDragHover.OverRow(key(a2), upperHalf = true))
        assertEquals(listOf(a1, b1, a2, a3), drag.previewRows(rows))
        assertEquals(
            ClientIntent.MoveSessionRow(slot("b", "b1"), RemotePresentationMovePosition.BEFORE, slot("a", "a2")),
            drag.dropIntent(rows),
        )
    }

    @Test
    fun `a drop across a host boundary names the other host's identity`() {
        val drag = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(b1), upperHalf = false))
        val intent = assertNotNull(drag.dropIntent(rows))
        assertEquals(HostId.parse("a"), intent.identity.hostId)
        assertEquals(HostId.parse("b"), intent.relativeTo.hostId)
        assertEquals(RemotePresentationMovePosition.AFTER, intent.position)
    }

    @Test
    fun `blank space below the last card appends after it`() {
        val drag = dragOf(a2).retarget(rows, SessionDragHover.EndBlank)
        assertEquals(true, drag.target?.endDrop)
        assertEquals(listOf(a1, a3, b1, a2), drag.previewRows(rows))
        assertEquals(
            ClientIntent.MoveSessionRow(slot("a", "a2"), RemotePresentationMovePosition.AFTER, slot("b", "b1")),
            drag.dropIntent(rows),
        )
        // Once appended the pointer over the previewed source keeps the end drop.
        val again = drag.retarget(rows, SessionDragHover.OverRow(key(a2), upperHalf = true))
        assertEquals(drag, again)
    }

    @Test
    fun `blank space below the last card is nothing when the source is already last`() {
        val drag = dragOf(b1).retarget(rows, SessionDragHover.EndBlank)
        assertNull(drag.target)
        assertNull(drag.dropIntent(rows))
    }

    // -- drag: nothing to drop ---------------------------------------------------------

    @Test
    fun `a self drop sends nothing`() {
        val drag = dragOf(a2).retarget(rows, SessionDragHover.OverRow(key(a2), upperHalf = true))
        assertNull(drag.target)
        assertNull(drag.dropIntent(rows))
    }

    @Test
    fun `a drop that leaves the order unchanged sends nothing`() {
        // a1 is already directly before a2, and a3 already directly after a2.
        assertNull(dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a2), upperHalf = true)).dropIntent(rows))
        assertNull(dragOf(a3).retarget(rows, SessionDragHover.OverRow(key(a2), upperHalf = false)).dropIntent(rows))
    }

    @Test
    fun `leaving the viewport or a host row clears the preview and drops nothing`() {
        val armed = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a3), upperHalf = false))
        for (hover in listOf(SessionDragHover.Outside, SessionDragHover.NoDrop)) {
            val cleared = armed.retarget(rows, hover)
            assertNull(cleared.target)
            assertEquals(rows, cleared.previewRows(rows))
            assertNull(cleared.dropIntent(rows))
        }
    }

    @Test
    fun `a gap between cards keeps the established preview`() {
        val armed = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a3), upperHalf = false))
        assertEquals(armed, armed.retarget(rows, SessionDragHover.Gap))
    }

    @Test
    fun `the pointer over the previewed source keeps its target`() {
        val armed = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a3), upperHalf = false))
        assertEquals(armed, armed.retarget(rows, SessionDragHover.OverRow(key(a1), upperHalf = true)))
    }

    // -- drag: fencing -----------------------------------------------------------------

    @Test
    fun `repeated busy and count updates keep a valid drag`() {
        val armed = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a3), upperHalf = false))
        var current = rows
        repeat(5) { n ->
            current = current.map {
                it.copy(
                    rosterRevision = 8L + n,
                    metadata = it.metadata.copy(
                        busy = n % 2 == 0,
                        pendingInput = n % 2 == 1,
                        activeTasks = n.toLong(),
                        activeShells = null,
                        backgroundTasks = n.toLong() + 1,
                        activity = listOf("update $n"),
                    ),
                )
            }
            assertTrue(armed.stillValidFor(current))
        }
        assertEquals(
            ClientIntent.MoveSessionRow(slot("a", "a1"), RemotePresentationMovePosition.AFTER, slot("a", "a3")),
            armed.dropIntent(current),
        )
    }

    @Test
    fun `membership change drops nothing and previews the real order`() {
        val armed = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a3), upperHalf = false))
        val joined = rows + row("b", "b2")
        val left = listOf(a1, a3, b1)
        for (current in listOf(joined, left)) {
            assertFalse(armed.stillValidFor(current))
            assertNull(armed.dropIntent(current))
            assertEquals(current, armed.previewRows(current))
        }
    }

    @Test
    fun `a new owner run drops nothing`() {
        val armed = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a3), upperHalf = false))
        val rerun = rows.map { if (it == a3) it.copy(hostRunId = ClientUiFixtures.RUN_B) else it }
        assertFalse(armed.stillValidFor(rerun))
        assertNull(armed.dropIntent(rerun))
    }

    @Test
    fun `a changed source or target identity drops nothing`() {
        val armed = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a3), upperHalf = false))
        val sourceMoved = rows.map { if (it == a1) it.copy(metadata = it.metadata.copy(rosterSlotId = "other")) else it }
        val targetMoved = rows.map { if (it == a3) it.copy(metadata = it.metadata.copy(rosterSlotId = "other")) else it }
        assertNull(armed.dropIntent(sourceMoved))
        assertNull(armed.dropIntent(targetMoved))
    }

    @Test
    fun `a target that becomes ambiguous drops nothing`() {
        val armed = dragOf(a1).retarget(rows, SessionDragHover.OverRow(key(a3), upperHalf = false))
        val duplicated = rows.map {
            if (it == a2) it.copy(metadata = it.metadata.copy(rosterSlotId = "slot-a-a3")) else it
        }
        assertNull(armed.dropIntent(duplicated))
    }

    @Test
    fun `retargeting onto an ambiguous row clears the target`() {
        val x = row("a", "x", slot = "shared")
        val y = row("a", "y", slot = "shared")
        val current = listOf(a1, x, y)
        val drag = dragOf(a1, current).retarget(current, SessionDragHover.OverRow(key(y), upperHalf = false))
        assertNull(drag.target)
        assertNull(drag.dropIntent(current))
    }

    // -- geometry ----------------------------------------------------------------------

    private fun span(row: SessionUiState?, top: Float, bottom: Float) =
        SessionDragItemSpan(row?.let { key(it) }, top, bottom)

    @Test
    fun `hover picks the card half under the pointer`() {
        val items = listOf(span(a1, 12f, 112f), span(a2, 122f, 222f))
        assertEquals(SessionDragHover.OverRow(key(a1), true), sessionDragHover(200f, 40f, 400f, 600f, items, key(b1)))
        assertEquals(SessionDragHover.OverRow(key(a1), false), sessionDragHover(200f, 80f, 400f, 600f, items, key(b1)))
        assertEquals(SessionDragHover.OverRow(key(a2), true), sessionDragHover(200f, 150f, 400f, 600f, items, key(b1)))
    }

    @Test
    fun `hover between cards is a gap and over a host row is no drop`() {
        val items = listOf(span(a1, 12f, 112f), span(a2, 122f, 222f), span(null, 232f, 332f))
        assertEquals(SessionDragHover.Gap, sessionDragHover(200f, 116f, 400f, 600f, items, key(b1)))
        assertEquals(SessionDragHover.Gap, sessionDragHover(200f, 4f, 400f, 600f, items, key(b1)))
        assertEquals(SessionDragHover.NoDrop, sessionDragHover(200f, 280f, 400f, 600f, items, key(b1)))
    }

    @Test
    fun `blank space appends only when the last session card is drawn`() {
        val drawn = listOf(span(a3, 12f, 112f), span(b1, 122f, 222f), span(null, 232f, 332f))
        assertEquals(SessionDragHover.EndBlank, sessionDragHover(200f, 226f, 400f, 600f, drawn, key(b1)))
        assertEquals(SessionDragHover.EndBlank, sessionDragHover(200f, 500f, 400f, 600f, drawn, key(b1)))
        val notDrawn = listOf(span(a1, 12f, 112f), span(a2, 122f, 222f))
        assertEquals(SessionDragHover.Gap, sessionDragHover(200f, 500f, 400f, 600f, notDrawn, key(b1)))
    }

    @Test
    fun `outside the viewport is no drop`() {
        val items = listOf(span(a1, 0f, 100f))
        assertEquals(SessionDragHover.Outside, sessionDragHover(200f, -1f, 400f, 600f, items, key(a1)))
        assertEquals(SessionDragHover.Outside, sessionDragHover(200f, 601f, 400f, 600f, items, key(a1)))
        assertEquals(SessionDragHover.Outside, sessionDragHover(200f, Float.NaN, 400f, 600f, items, key(a1)))
    }

    @Test
    fun `leaving through the left or right side is outside even beside a card`() {
        val items = listOf(span(a1, 0f, 100f), span(a3, 110f, 210f))
        // Vertically over a3, horizontally outside the list on either side.
        assertEquals(SessionDragHover.Outside, sessionDragHover(-1f, 150f, 400f, 600f, items, key(a3)))
        assertEquals(SessionDragHover.Outside, sessionDragHover(401f, 150f, 400f, 600f, items, key(a3)))
        assertEquals(SessionDragHover.Outside, sessionDragHover(Float.NaN, 150f, 400f, 600f, items, key(a3)))
        assertFalse(sessionDragInsideViewport(-0.5f, 150f, 400f, 600f))
        assertTrue(sessionDragInsideViewport(0f, 150f, 400f, 600f))
        // An armed preview released after a sideways exit drops nothing.
        val armed = dragOf(a1).retarget(rows, sessionDragHover(200f, 180f, 400f, 600f, items, key(b1)))
        assertNotNull(armed.dropIntent(rows))
        for (x in listOf(-40f, 440f)) {
            val exited = armed.retarget(rows, sessionDragHover(x, 180f, 400f, 600f, items, key(b1)))
            assertNull(exited.target)
            assertNull(exited.dropIntent(rows))
        }
        // No edge scroll from beside the list, even level with an edge band.
        assertEquals(0f, sessionDragEdgeScroll(-1f, 595f, 400f, 600f, 50f, 20f))
        assertEquals(0f, sessionDragEdgeScroll(401f, 5f, 400f, 600f, 50f, 20f))
    }

    @Test
    fun `a long list reaches an offscreen target through a scrolled window`() {
        val long = (0 until 40).map { row("a", "r$it") }
        val source = long.first()
        var drag = dragOf(source, long)
        // The window has scrolled far past the source; only rows 30..34 are drawn.
        val window = (30..34).map { i -> span(long[i], (i - 30) * 110f, (i - 30) * 110f + 100f) }
        drag = drag.retarget(long, sessionDragHover(200f, 270f, 400f, 600f, window, key(long.last())))
        val intent = assertNotNull(drag.dropIntent(long))
        assertEquals(
            ClientIntent.MoveSessionRow(slot("a", "r0"), RemotePresentationMovePosition.AFTER, slot("a", "r32")),
            intent,
        )
        assertEquals(key(source), key(drag.previewRows(long)[32]))
    }

    @Test
    fun `edge scrolling moves toward the near edge and stays bounded`() {
        assertTrue(sessionDragEdgeScroll(200f, 5f, 400f, 600f, 50f, 20f) < 0f)
        assertTrue(sessionDragEdgeScroll(200f, 595f, 400f, 600f, 50f, 20f) > 0f)
        assertEquals(0f, sessionDragEdgeScroll(200f, 300f, 400f, 600f, 50f, 20f))
        assertEquals(0f, sessionDragEdgeScroll(200f, -5f, 400f, 600f, 50f, 20f))
        assertEquals(0f, sessionDragEdgeScroll(200f, 605f, 400f, 600f, 50f, 20f))
        assertEquals(-20f, sessionDragEdgeScroll(200f, 0f, 400f, 600f, 50f, 20f))
        assertEquals(20f, sessionDragEdgeScroll(200f, 600f, 400f, 600f, 50f, 20f))
        assertTrue(sessionDragEdgeScroll(200f, 10f, 400f, 600f, 50f, 20f) < sessionDragEdgeScroll(200f, 40f, 400f, 600f, 50f, 20f))
    }
}
