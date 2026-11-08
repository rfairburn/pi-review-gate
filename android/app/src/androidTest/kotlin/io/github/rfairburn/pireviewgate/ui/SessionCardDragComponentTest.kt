package io.github.rfairburn.pireviewgate.ui

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.RosterSnapshot
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiCoverage
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationIdentity
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationMovePosition
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import io.github.rfairburn.pireviewgate.ui.client.SessionsScreen
import io.github.rfairburn.pireviewgate.ui.client.UiCommitScope
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Session-card drag ordering through the actual Compose gesture and list components.
 *
 * Invented component inputs only: no transport, owner, controller, or storage is
 * installed, and nothing here asserts that a move was applied — only which existing
 * [ClientIntent.MoveSessionRow] the screen requested. Fixtures are local to this file.
 */
@RunWith(AndroidJUnit4::class)
class SessionCardDragComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private companion object {
        const val RUN_A = "33333333-3333-4333-8333-333333333333"
        const val RUN_B = "44444444-4444-4444-8444-444444444444"
        val hostA: HostId = HostId.parse("drag-a")
        val hostB: HostId = HostId.parse("drag-b")
    }

    private fun row(
        host: HostId,
        id: String,
        slot: String? = "slot-${host.value}-$id",
        run: String = if (host == hostA) RUN_A else RUN_B,
        busy: Boolean? = null,
        activeTasks: Long? = null,
        activeShells: Long? = null,
        backgroundTasks: Long? = null,
        backgroundShells: Long? = null,
    ) = SessionUiState(
        hostId = host, hostLabel = if (host == hostA) "Drag owner A" else "Drag owner B",
        hostRunId = run, stale = false, rosterRevision = 1,
        metadata = RemoteSessionMetadata(
            id = id, label = "Card $id", workspace = "/synthetic/drag/$id",
            lifecycle = RosterLifecycle.ALIVE, hasLiveProcess = true, inputSurface = false,
            rosterSlotId = slot, busy = busy, pendingInput = null,
            activeTasks = activeTasks, activeShells = activeShells,
            backgroundTasks = backgroundTasks, backgroundShells = backgroundShells,
        ),
    )

    private fun host(id: HostId, rows: List<SessionUiState>) = HostUiState(
        host = ConfiguredHost(id, HostLabel.parse(if (id == hostA) "Drag owner A" else "Drag owner B"),
            Endpoint("${id.value}.invalid", 8443)),
        connection = HostConnectionState.CONNECTED,
        roster = RosterSnapshot(RosterFreshness.CURRENT, rows.firstOrNull()?.hostRunId ?: RUN_A, 1, rows),
        capabilities = HostCapabilities.fromAcknowledged(listOf(RosterWire.SAVED_CAPABILITY), 1),
    )

    private fun stateOf(aRows: List<SessionUiState>, bRows: List<SessionUiState> = emptyList()) =
        ClientUiState(hostStates = listOfNotNull(host(hostA, aRows), bRows.takeIf { it.isNotEmpty() }?.let { host(hostB, it) }))

    private fun slot(host: HostId, id: String) =
        requireNotNull(RemotePresentationIdentity.slot(host, "slot-${host.value}-$id"))

    private var state by mutableStateOf(ClientUiState())
    private val intents = CopyOnWriteArrayList<ClientIntent>()
    private lateinit var listState: LazyListState

    private var shown = false

    /** Set the screen's state; content is installed once per test. */
    private fun show(initial: ClientUiState) {
        if (shown) {
            compose.runOnIdle { state = initial }
            compose.waitForIdle()
            return
        }
        shown = true
        state = initial
        compose.setContent {
            listState = rememberLazyListState()
            MaterialTheme {
                UiCommitScope {
                    SessionsScreen(state = state, onIntent = { intent ->
                        intents.add(intent)
                        if (intent is ClientIntent.UiCoverageChanged) state = state.copy(coverage = intent.coverage)
                    }, listState = listState,
                        // Inset so a pointer can leave the list sideways while staying in the window.
                        modifier = Modifier.padding(horizontal = 48.dp))
                }
            }
        }
        compose.waitForIdle()
    }

    private fun moves() = intents.filterIsInstance<ClientIntent.MoveSessionRow>()

    private val dragGeometry = ArrayDeque<String>()

    /** Bounded fixture facts travel with a failed assertion, not a new event stream. */
    private fun recordDragGeometry(phase: String, title: String, target: Offset) {
        val viewport = listBounds()
        val layout = compose.runOnIdle {
            val info = listState.layoutInfo
            "first=${listState.firstVisibleItemIndex}:${listState.firstVisibleItemScrollOffset} " +
                "range=${info.viewportStartOffset}..${info.viewportEndOffset} " +
                "items=" + info.visibleItemsInfo.take(6).joinToString { "${it.key}@${it.offset}+${it.size}" }
        }
        if (dragGeometry.size == 6) dragGeometry.removeFirst()
        dragGeometry.addLast("$phase $title pointer=$target viewport=$viewport $layout")
    }

    private fun assertOneMoveAfterA3() {
        assertEquals(
            "Drag geometry: ${dragGeometry.joinToString("; ")}",
            listOf(ClientIntent.MoveSessionRow(slot(hostA, "a1"), RemotePresentationMovePosition.AFTER,
                slot(hostA, "a3"))),
            moves(),
        )
    }

    /** Nothing but a move may come out of a drag: no selection, activation, or owner request. */
    private fun assertNoRowAction() {
        assertTrue(intents.none {
            it is ClientIntent.EnterTerminal || it is ClientIntent.RequestSessionClose ||
                it is ClientIntent.RequestSessionRename || it is ClientIntent.ShowSaved ||
                it is ClientIntent.UiCoverageChanged
        })
    }

    private fun list(): SemanticsNodeInteraction = compose.onNode(hasScrollToNodeAction())
    private fun listBounds(): Rect = list().fetchSemanticsNode().boundsInRoot

    /** The list's own viewport position, as it is actually laid out. */
    private fun listViewport(): Pair<Int, Int> = compose.runOnIdle {
        listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset
    }

    private fun bounds(text: String): Rect = compose.onNodeWithText(text).fetchSemanticsNode().boundsInRoot
    private fun inList(root: Offset): Offset = root - listBounds().topLeft

    /** Long-press the title of [title] and hold, leaving the pointer down. */
    private fun pressAndHold(title: String) {
        val list = listBounds()
        val start = inList(bounds(title).center)
        // The card must be drawn where it is pressed: a press clipped by the viewport starts
        // no drag at all, and every later "sends nothing" assertion would then be vacuous.
        assertTrue(
            "$title is not reachable at $start inside the ${list.width}x${list.height} list viewport",
            start.x in 0f..list.width && start.y in 0f..list.height,
        )
        list().performTouchInput {
            down(start)
            advanceEventTime(viewConfiguration.longPressTimeoutMillis * 2)
            moveBy(Offset(0f, 2f))
        }
        compose.waitForIdle()
    }

    /** Move the held pointer onto [title]'s card in the drawn list, upper or lower part. */
    private fun moveOnto(title: String, upper: Boolean) {
        val card = cardBounds(title)
        val y = if (upper) card.top + card.height * 0.2f else card.bottom - card.height * 0.2f
        val target = inList(Offset(card.center.x, y))
        val viewport = listViewport()
        recordDragGeometry("before-first card=$card", title, target)
        list().performTouchInput { moveTo(target) }
        compose.waitForIdle()
        recordDragGeometry("after-preview", title, target)
        // Drawing the preview must leave the viewport where it was. The pointer has not moved,
        // so a list that scrolled under it would re-resolve the same packet onto another card.
        assertEquals(
            "the preview moved the viewport out from under the held pointer",
            viewport,
            listViewport(),
        )
        // A second packet re-resolves against the frame drawn after the preview.
        list().performTouchInput { moveTo(target + Offset(0f, 1f)) }
        compose.waitForIdle()
        recordDragGeometry("after-second", title, target + Offset(0f, 1f))
        assertEquals(
            "re-resolving the still pointer drifted the viewport",
            viewport,
            listViewport(),
        )
    }

    private fun release() {
        list().performTouchInput { up() }
        compose.waitForIdle()
    }

    private fun cardNode(title: String) = compose.onNode(
        hasAnyDescendant(hasText(title)) and SemanticsMatcher.keyIsDefined(SemanticsActions.CustomActions),
    )

    private fun cardBounds(title: String): Rect = cardNode(title).fetchSemanticsNode().boundsInRoot

    /**
     * The title of a drawn card nearest the list's vertical centre.
     *
     * A press there starts inside neither auto-scroll edge band, so holding it must not
     * scroll the list and the drag must settle instead of asking for frame after frame.
     */
    private fun centeredTitle(titles: List<String>): String {
        val list = listBounds()
        val centre = list.top + list.height / 2f
        val drawn = titles.filter { compose.onAllNodesWithText(it).fetchSemanticsNodes().isNotEmpty() }
        assertTrue("none of $titles is drawn", drawn.isNotEmpty())
        val nearest = drawn.map { it to abs(bounds(it).center.y - centre) }.minBy { it.second }
        assertTrue(
            "${nearest.first} is not near the list centre (${nearest.second}px away in ${list.height}px)",
            nearest.second < list.height / 4f,
        )
        return nearest.first
    }

    /** The one card currently marked as the live drag's source. */
    private fun draggingCards() =
        compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Moving"))

    private val a1 = row(hostA, "a1")
    private val a2 = row(hostA, "a2")
    private val a3 = row(hostA, "a3")
    private val b1 = row(hostB, "b1")
    private fun base() = stateOf(listOf(a1, a2, a3), listOf(b1))

    // -- valid drops ---------------------------------------------------------------------

    @Test fun dropOnLowerHalfSendsOneAfterMoveAndNoActivation() {
        show(base())
        pressAndHold("Card a1")
        moveOnto("Card a3", upper = false)
        release()
        assertOneMoveAfterA3()
        assertNoRowAction()
    }

    @Test fun dropOnUpperHalfAcrossHostsSendsOneBeforeMove() {
        show(base())
        pressAndHold("Card b1")
        moveOnto("Card a2", upper = true)
        release()
        assertEquals(listOf(ClientIntent.MoveSessionRow(slot(hostB, "b1"), RemotePresentationMovePosition.BEFORE,
            slot(hostA, "a2"))), moves())
        assertNoRowAction()
    }

    @Test fun repeatedStatusAndCountUpdatesKeepAValidDrag() {
        show(base())
        pressAndHold("Card a1")
        moveOnto("Card a3", upper = false)
        repeat(4) { n ->
            compose.runOnIdle {
                state = stateOf(listOf(a1, a2, a3).map {
                    it.copy(rosterRevision = 2L + n, metadata = it.metadata.copy(busy = n % 2 == 0,
                        activeTasks = n.toLong(), backgroundShells = n.toLong()))
                }, listOf(b1))
            }
            compose.waitForIdle()
        }
        release()
        assertOneMoveAfterA3()
    }

    // -- nothing to drop -------------------------------------------------------------------

    @Test fun selfDropAndLongPressWithoutTargetSendNothing() {
        show(base())
        pressAndHold("Card a2")
        moveOnto("Card a2", upper = true)
        release()
        pressAndHold("Card a2")
        release()
        assertTrue(moves().isEmpty())
        assertNoRowAction()
    }

    @Test fun releaseOutsideTheViewportSendsNothing() {
        show(base())
        pressAndHold("Card a1")
        // The release above the list is only a non-drop when a drag was really held first.
        draggingCards().assertCountEquals(1)
        moveOnto("Card a3", upper = false)
        list().performTouchInput { moveTo(Offset(width / 2f, -200f)) }
        compose.waitForIdle()
        release()
        assertTrue(moves().isEmpty())
    }

    @Test fun releaseBesideTheListOnEitherSideSendsNothing() {
        show(base())
        for (side in listOf(-1, 1)) {
            intents.clear()
            pressAndHold("Card a1")
            // Only a held drag can exit the list sideways: without this the empty result
            // below would also be satisfied by a press that started nothing.
            draggingCards().assertCountEquals(1)
            moveOnto("Card a3", upper = false)
            // Vertically still level with a3, horizontally outside the list.
            val card = cardBounds("Card a3")
            val list = listBounds()
            val beside = if (side < 0) -24f else list.width + 24f
            val y = card.bottom - card.height * 0.2f - list.top
            list().performTouchInput { moveTo(Offset(beside, y)) }
            compose.waitForIdle()
            release()
            assertTrue("sideways exit $side produced a move: $intents", moves().isEmpty())
            assertNoRowAction()
        }
        // A sideways excursion that returns over the card before release still drops once.
        pressAndHold("Card a1")
        draggingCards().assertCountEquals(1)
        moveOnto("Card a3", upper = false)
        list().performTouchInput { moveTo(Offset(-24f, centerY)) }
        compose.waitForIdle()
        moveOnto("Card a3", upper = false)
        release()
        assertOneMoveAfterA3()
    }

    @Test fun membershipRunIdentityAndCoverageChangesCancelWithNoIntent() {
        val changes = listOf<(ClientUiState) -> ClientUiState>(
            { stateOf(listOf(a1, a2, a3, row(hostA, "a4")), listOf(b1)) },
            { stateOf(listOf(a1, a2, a3.copy(hostRunId = RUN_B)), listOf(b1)) },
            { stateOf(listOf(a1, a2, a3.copy(metadata = a3.metadata.copy(rosterSlotId = "slot-other"))), listOf(b1)) },
            { it.copy(coverage = UiCoverage.OPEN_MENU) },
        )
        for (change in changes) {
            show(base())
            intents.clear()
            pressAndHold("Card a1")
            moveOnto("Card a3", upper = false)
            compose.runOnIdle { state = change(state) }
            compose.waitForIdle()
            // Even if the change is reverted before release, the cancelled drag stays dead.
            compose.runOnIdle { state = base() }
            compose.waitForIdle()
            release()
            assertTrue("change produced a move: $intents", moves().isEmpty())
        }
    }

    @Test fun duplicateIdentitiesAreRefused() {
        val dupA = row(hostA, "d1", slot = "shared")
        val dupB = row(hostA, "d2", slot = "shared")
        show(stateOf(listOf(dupA, a2, dupB)))
        pressAndHold("Card d1")
        moveOnto("Card a2", upper = false)
        release()
        pressAndHold("Card a2")
        moveOnto("Card d2", upper = false)
        release()
        assertTrue(moves().isEmpty())
    }

    // -- a held drag that is not at an edge ------------------------------------------------

    @Test fun aStationaryHeldDragInsideTheListSettlesWithoutScrolling() {
        val rows = (0 until 8).map { row(hostA, "h%02d".format(it)) }
        show(stateOf(rows))
        pressAndHold(centeredTitle(rows.map { "Card ${it.rowId}" }))

        // The drag really is live: exactly its source card is marked, and both header
        // controls refuse while it is held.
        draggingCards().assertCountEquals(1)
        compose.onNodeWithText("New session").assertIsNotEnabled()
        compose.onNodeWithText("Saved conversations").assertIsNotEnabled()

        val before = compose.runOnIdle {
            listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset
        }
        // Frames stay available while the pointer is held down. A drag held away from
        // both edge bands must ask for none of them and must not move the list: an
        // unconditional frame loop would keep the screen busy for the whole hold.
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
        assertEquals(
            before,
            compose.runOnIdle { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset },
        )
        draggingCards().assertCountEquals(1)

        release()
        assertTrue(moves().isEmpty())
        assertNoRowAction()
    }

    // -- long lists -------------------------------------------------------------------------

    @Test fun holdingAtTheBottomEdgeScrollsToOffscreenRowsAndDropsOnce() {
        val rows = (0 until 30).map { row(hostA, "r%02d".format(it)) }
        show(stateOf(rows))
        pressAndHold("Card r00")
        val bottom = Offset(listBounds().width / 2f, listBounds().height - 4f)
        list().performTouchInput { moveTo(bottom) }
        repeat(60) {
            list().performTouchInput { moveBy(Offset(0f, 0.01f), delayMillis = 32) }
        }
        compose.waitForIdle()
        assertTrue("list did not scroll", compose.runOnIdle { listState.firstVisibleItemIndex } > 0)
        // Holding at the edge is bounded: scrolling stops once the list reaches its end,
        // so the hold settles rather than requesting a frame for every held moment.
        assertTrue(
            "the edge hold did not settle at the list's end",
            compose.runOnIdle { !listState.canScrollForward },
        )
        // Settle back onto a drawn card, away from the edge band, and drop there.
        list().performTouchInput { moveTo(Offset(bottom.x, listBounds().height / 2f)) }
        compose.waitForIdle()
        list().performTouchInput { moveBy(Offset(0f, 1f)) }
        compose.waitForIdle()
        release()
        val move = moves().single()
        assertEquals(slot(hostA, "r00"), move.identity)
        val target = rows.indexOfFirst { slot(hostA, it.rowId) == move.relativeTo }
        assertTrue("target $target was not offscreen at the start", target > 5)
        assertNoRowAction()
    }

    // -- presentation ----------------------------------------------------------------------

    @Test fun noVisibleSlotOrMoveMenuButAccessibleMovesRemain() {
        show(base())
        compose.onAllNodesWithText("slot-", substring = true).assertCountEquals(0)
        compose.onAllNodesWithText("Actions")[1].performClick()
        compose.onAllNodesWithText("Move up").assertCountEquals(0)
        compose.onAllNodesWithText("Move down").assertCountEquals(0)
        compose.onNodeWithText("Show details").performClick()
        compose.onAllNodesWithText("Roster slot").assertCountEquals(0)
        compose.onAllNodesWithText("slot-", substring = true).assertCountEquals(0)

        intents.clear()
        val actions = cardNode("Card a2").fetchSemanticsNode().config[SemanticsActions.CustomActions]
        assertEquals(listOf("Move up", "Move down"), actions.map { it.label })
        compose.runOnIdle { assertTrue(actions.first { it.label == "Move down" }.action()) }
        assertEquals(listOf(ClientIntent.MoveSessionRow(slot(hostA, "a2"), RemotePresentationMovePosition.AFTER,
            slot(hostA, "a3"))), moves())
        // The internal identity is unchanged.
        assertNotNull(a2.presentationIdentity)
        assertEquals(slot(hostA, "a2"), a2.presentationIdentity)
    }

    @Test fun backgroundChipsShowActivityCountsAndUnknownNeverZero() {
        show(stateOf(listOf(
            row(hostA, "n1", backgroundTasks = 4, backgroundShells = 5),
            row(hostA, "n2", activeTasks = 0, activeShells = null),
            row(hostA, "n3", activeTasks = 0, activeShells = 0, backgroundTasks = 7),
            row(hostA, "n4", activeTasks = 2, activeShells = 1),
        )))
        // Activity-intent counts are chips; a missing count is unknown, never zero.
        compose.onAllNodesWithText("bg tasks unknown").assertCountEquals(1)
        compose.onAllNodesWithText("bg shells unknown").assertCountEquals(2)
        compose.onAllNodesWithText("bg tasks 0").assertCountEquals(2)
        compose.onAllNodesWithText("bg shells 0").assertCountEquals(1)
        compose.onAllNodesWithText("bg tasks 2").assertCountEquals(1)
        compose.onAllNodesWithText("bg shells 1").assertCountEquals(1)
        // Ownership counts stay in details and are never presented as activity.
        compose.onAllNodesWithText("bg tasks 4", substring = true).assertCountEquals(0)
        compose.onAllNodesWithText("bg tasks 7", substring = true).assertCountEquals(0)
        // The retired plain line is not drawn alongside the native chips.
        listOf(
            "background unknown",
            "bg tasks 0 | shells unknown",
            "bg tasks 0 | shells 0",
            "bg tasks 2 | shells 1",
        ).forEach { text -> compose.onAllNodesWithText(text).assertCountEquals(0) }
    }
}
