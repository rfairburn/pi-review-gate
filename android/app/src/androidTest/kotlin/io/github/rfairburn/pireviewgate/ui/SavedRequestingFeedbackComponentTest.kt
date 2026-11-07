package io.github.rfairburn.pireviewgate.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.application.OperationKey
import io.github.rfairburn.pireviewgate.core.client.application.SavedReadFeedback
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOperationKind
import io.github.rfairburn.pireviewgate.core.client.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The actual Saved screen through the pending-feedback transition: Requesting is drawn
 * only where it is control-neutral, and never moves, swaps or re-arms a drawn control.
 * Synthetic component fixture only; not a connected-app test.
 */
@RunWith(AndroidJUnit4::class)
class SavedRequestingFeedbackComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private val search = hasText("Search") and hasClickAction() and !hasSetTextAction()
    private val view = SavedReadFeedback.View(NativeUiFixtures.hostA, NativeUiFixtures.RUN_A, "", 1L, 1L, true)
    private val key = OperationKey(NativeUiFixtures.hostA, 1L, RosterOperationKind.SAVED_LIST, "request-pending")

    @Test fun neutralPickerShowsRequestingWithoutMovingOrReArmingSearch() {
        val list = NativeUiFixtures.savedProof(1)
        val base = NativeUiFixtures.saved(list, NativeUiFixtures.savedProof(2), NativeUiFixtures.savedProof(3, "entry-a"))
        // Empty picker with a multiline prior status: nothing actionable below the status line.
        val fixture = NativeUiFixture(base.copy(saved = SavedUiState(selectedHostId = NativeUiFixtures.hostA,
            status = SavedRequestStatus.Unknown, hostRunId = NativeUiFixtures.RUN_A, listProof = list)))
        compose.setContent { fixture.Content() }
        compose.waitUntil(10_000) { list.grantsAction() }
        val before = compose.onNode(search).fetchSemanticsNode().boundsInRoot
        compose.onNode(search).performClick()
        val captured = compose.runOnIdle {
            fixture.intents.single { it.intent is ClientIntent.RequestSavedList }.also { assertTrue(it.stillAuthorized) }
        }
        val feedback = SavedReadFeedback()
        compose.runOnIdle {
            val next = feedback.accepted(key, 1L, view, false, view, fixture.state.saved)
            assertEquals(SavedRequestStatus.Requesting, next.status)
            assertSame(list, next.listProof)
            fixture.state = fixture.state.copy(saved = next)
        }
        compose.onNodeWithText("Waiting for the host.").assertIsDisplayed()
        compose.onAllNodesWithText("The outcome of the last request is unknown. Nothing is resent.").assertCountEquals(0)
        assertEquals(before, compose.onNode(search).fetchSemanticsNode().boundsInRoot)
        compose.runOnIdle {
            // The queued writer's committed Search authority is untouched by the status change.
            assertTrue(list.isCurrent)
            assertTrue(captured.stillAuthorized)
        }
        compose.onAllNodesWithText("Resume").assertCountEquals(0)
        compose.onAllNodesWithText("Load more").assertCountEquals(0)
    }

    @Test fun populatedResultShowsRequestingWhileControlsStayPresentPlacedAndAuthorized() {
        val list = NativeUiFixtures.savedProof(1)
        val window = NativeUiFixtures.savedProof(2)
        val resume = NativeUiFixtures.savedProof(3, "entry-a")
        val base = NativeUiFixtures.saved(list, window, resume)
        // A result with more rows (Load More is a live button) and a multiline prior status.
        val fixture = NativeUiFixture(base.copy(saved = base.saved.copy(status = SavedRequestStatus.Unknown)))
        assertEquals(SavedMoreDecision.MAY_REQUEST, fixture.state.saved.moreDecision())
        compose.setContent { fixture.Content() }
        // Bring Load More into the composed viewport first; that scroll re-arms by itself.
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText("Load more"))
        compose.waitUntil(10_000) { list.grantsAction() && resume.grantsAction() && window.grantsAction() }
        val searchBefore = compose.onNode(search).fetchSemanticsNode().boundsInRoot
        val resumeBefore = compose.onNodeWithText("Resume").fetchSemanticsNode().boundsInRoot
        val moreBefore = compose.onNodeWithText("Load more").fetchSemanticsNode().boundsInRoot
        compose.onNode(search).performClick()
        val captured = compose.runOnIdle {
            fixture.intents.single { it.intent is ClientIntent.RequestSavedList }.also { assertTrue(it.stillAuthorized) }
        }
        val feedback = SavedReadFeedback()
        compose.runOnIdle {
            val next = feedback.accepted(key, 1L, view, false, view, fixture.state.saved)
            assertEquals(SavedRequestStatus.Requesting, next.status)
            assertEquals(SavedRequestStatus.Unknown, next.readFeedbackBaseStatus)
            assertEquals(SavedMoreDecision.MAY_REQUEST, next.moreDecision())
            assertSame(list, next.listProof); assertSame(window, next.windowProof)
            assertSame(fixture.state.saved.entryProofs, next.entryProofs)
            fixture.state = fixture.state.copy(saved = next)
        }
        compose.onNodeWithText("Waiting for the host.").assertIsDisplayed()
        // The drawn status keeps its reserved slot but is neither shown nor announced.
        compose.onAllNodesWithText("The outcome of the last request is unknown. Nothing is resent.").assertCountEquals(0)
        compose.onAllNodesWithText("Another window is already in flight.").assertCountEquals(0)
        compose.onNodeWithText("Load more").assertIsDisplayed()
        assertEquals(searchBefore, compose.onNode(search).fetchSemanticsNode().boundsInRoot)
        assertEquals(resumeBefore, compose.onNodeWithText("Resume").fetchSemanticsNode().boundsInRoot)
        assertEquals(moreBefore, compose.onNodeWithText("Load more").fetchSemanticsNode().boundsInRoot)
        compose.runOnIdle {
            // No drawn control was retired or re-armed, and the queued writer keeps its authority.
            assertTrue(list.isCurrent && resume.isCurrent && window.isCurrent)
            assertTrue(list.grantsAction() && resume.grantsAction() && window.grantsAction())
            assertTrue(captured.stillAuthorized)
        }
    }
}
