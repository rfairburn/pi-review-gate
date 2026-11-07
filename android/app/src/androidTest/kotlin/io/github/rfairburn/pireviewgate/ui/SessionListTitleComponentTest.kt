package io.github.rfairburn.pireviewgate.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.RosterSnapshot
import io.github.rfairburn.pireviewgate.core.client.ui.SavedEntryControlProofs
import io.github.rfairburn.pireviewgate.core.client.ui.SavedEntryKey
import io.github.rfairburn.pireviewgate.core.client.ui.SavedRequestStatus
import io.github.rfairburn.pireviewgate.core.client.ui.SavedUiState
import io.github.rfairburn.pireviewgate.core.client.ui.SessionActionTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SessionRowKey
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.grantsAction
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteNativeSession
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import io.github.rfairburn.pireviewgate.ui.client.QuickSwitcherSheet
import io.github.rfairburn.pireviewgate.ui.client.SavedScreen
import io.github.rfairburn.pireviewgate.ui.client.SessionsScreen
import io.github.rfairburn.pireviewgate.ui.client.UiCommitScope
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * One visual line for list titles, with the complete stored string left to semantics,
 * search, details, and action targets.
 *
 * The fixtures are invented component inputs only: no owner, transport, storage, or
 * real terminal is installed. Width is the only variable between the narrow and wide
 * readings, so a changed number of visible characters is the layout's own response.
 */
@RunWith(AndroidJUnit4::class)
class SessionListTitleComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private companion object {
        const val RUN = "77777777-7777-4777-8777-777777777777"
        const val LONG_SESSION_TITLE =
            "A long live session title that stays complete for accessibility search details and every action target"
        const val LONG_SAVED_CAPTION =
            "A long saved conversation caption that stays complete for search details and every entry action"
        const val LONG_SWITCHER_TITLE =
            "A long quick switcher session title that stays complete for accessibility search and switching"
        val host: HostId = HostId.parse("title-host")
    }

    /** Narrow enough to force an ellipsis; the wide pass uses the full test window. */
    private val narrowWidth: Dp = 240.dp
    private var wide by mutableStateOf(false)

    private fun setWide() {
        compose.runOnIdle { wide = true }
        compose.waitForIdle()
    }

    private fun sessionsState(row: SessionUiState) = ClientUiState(hostStates = listOf(HostUiState(
        host = ConfiguredHost(host, HostLabel.parse("Title owner"), Endpoint("title.invalid", 8443)),
        connection = HostConnectionState.CONNECTED,
        roster = RosterSnapshot(RosterFreshness.CURRENT, RUN, 1, listOf(row)),
        capabilities = HostCapabilities.UNKNOWN,
    )))

    private fun sessionRow(title: String, proof: UiActionProof? = null) = SessionUiState(
        hostId = host, hostLabel = "Title owner", hostRunId = RUN, stale = false, rosterRevision = 1,
        selectProof = proof,
        metadata = RemoteSessionMetadata(
            id = "duplicate-row", label = title, workspace = "/synthetic/title/session",
            lifecycle = RosterLifecycle.ALIVE, hasLiveProcess = true, inputSurface = false,
            rosterSlotId = "slot-title", busy = false, pendingInput = false,
            nativeSession = RemoteNativeSession("native-title", 1, title),
        ),
    )

    private fun savedState(entry: OwnerSavedEntry, resumeProof: UiActionProof?) = ClientUiState(
        hostStates = listOf(HostUiState(
            host = ConfiguredHost(host, HostLabel.parse("Title owner"), Endpoint("title.invalid", 8443)),
            connection = HostConnectionState.CONNECTED,
            capabilities = HostCapabilities.fromAcknowledged(listOf(RosterWire.SAVED_CAPABILITY), 1),
        )),
        route = ClientRoute.Saved(host),
        saved = SavedUiState(
            selectedHostId = host, status = SavedRequestStatus.Ready, hostRunId = RUN,
            catalogId = "catalog-title", resultId = "result-title", requestId = "request-title",
            sequence = 1, total = 1, entries = listOf(entry), transferComplete = true,
            entryProofs = resumeProof?.let {
                mapOf(SavedEntryKey(RUN, "catalog-title", "result-title", entry.entryId) to
                    SavedEntryControlProofs(resume = it))
            } ?: emptyMap(),
        ),
    )

    private fun savedEntry(caption: String) = OwnerSavedEntry(
        entryId = "entry-title", sessionId = "native-title",
        file = "/synthetic/saved/title.jsonl", caption = caption,
        cwd = "/synthetic/title/workspace",
    )

    private fun awaitProof(proof: UiActionProof) {
        compose.waitUntil(10_000) { proof.grantsAction() }
    }

    /** One drawn line with the full string still in layout input and accessibility. */
    private fun oneLine(title: String): TextLayoutResult {
        val node = compose.onNodeWithText(title, useUnmergedTree = true).fetchSemanticsNode()
        val semantics = node.config[SemanticsProperties.Text]
        assertTrue("accessibility must keep the full string", semantics.any { it.text == title })
        val results = mutableListOf<TextLayoutResult>()
        val action = requireNotNull(node.config[SemanticsActions.GetTextLayoutResult].action) {
            "the title must expose its text layout"
        }
        assertTrue("text layout result must be available", action.invoke(results))
        val layout = results.single()
        assertEquals(title, layout.layoutInput.text.text)
        assertEquals(1, layout.layoutInput.maxLines)
        assertEquals(1, layout.lineCount)
        return layout
    }

    @Test fun sessionCardTitleEllipsizesOneLineAndKeepsFullActionTarget() {
        val proof = NativeUiFixtures.rowProof(host, RUN)
        val row = sessionRow(LONG_SESSION_TITLE, proof)
        val intents = CopyOnWriteArrayList<ClientIntent>()
        compose.setContent {
            MaterialTheme {
                Box(Modifier.fillMaxSize()) {
                    Box(
                        Modifier
                            .then(if (wide) Modifier.fillMaxWidth() else Modifier.width(narrowWidth))
                            .fillMaxHeight(),
                    ) {
                        UiCommitScope {
                            SessionsScreen(
                                state = sessionsState(row),
                                onIntent = { intents.add(it) },
                                listState = rememberLazyListState(),
                            )
                        }
                    }
                }
            }
        }
        compose.waitForIdle()

        val narrow = oneLine(LONG_SESSION_TITLE)
        assertTrue("the narrow title must be ellipsized", narrow.isLineEllipsized(0))
        val narrowVisible = narrow.getLineEnd(0, visibleEnd = true)
        assertTrue(narrowVisible < LONG_SESSION_TITLE.length)
        // Ellipsis is visual only: the title is not a new action target.
        compose.onNodeWithText(LONG_SESSION_TITLE, useUnmergedTree = true).assertHasNoClickAction()

        setWide()
        val widened = oneLine(LONG_SESSION_TITLE)
        assertTrue(
            "the wider list must show more of the same title",
            widened.getLineEnd(0, visibleEnd = true) > narrowVisible,
        )

        awaitProof(proof)
        compose.onNodeWithText("Open terminal").performClick()
        compose.runOnIdle {
            val captured = intents.single { it is ClientIntent.EnterTerminal } as ClientIntent.EnterTerminal
            assertEquals(SessionActionTarget.of(row), captured.target)
            assertEquals(LONG_SESSION_TITLE, captured.target.drawnTitle)
        }
    }

    @Test fun savedCaptionEllipsizesOneLineAndKeepsFullActionTarget() {
        val proof = NativeUiFixtures.savedProof(1, "entry-title")
        val entry = savedEntry(LONG_SAVED_CAPTION)
        val intents = CopyOnWriteArrayList<ClientIntent>()
        compose.setContent {
            MaterialTheme {
                Box(Modifier.fillMaxSize()) {
                    Box(
                        Modifier
                            .then(if (wide) Modifier.fillMaxWidth() else Modifier.width(narrowWidth))
                            .fillMaxHeight(),
                    ) {
                        UiCommitScope {
                            SavedScreen(
                                state = savedState(entry, proof),
                                onIntent = { intents.add(it) },
                                listState = rememberLazyListState(),
                            )
                        }
                    }
                }
            }
        }
        compose.waitForIdle()

        val narrow = oneLine(LONG_SAVED_CAPTION)
        assertTrue("the narrow caption must be ellipsized", narrow.isLineEllipsized(0))
        val narrowVisible = narrow.getLineEnd(0, visibleEnd = true)
        assertTrue(narrowVisible < LONG_SAVED_CAPTION.length)
        // The caption is display text, never a new action target.
        compose.onNodeWithText(LONG_SAVED_CAPTION, useUnmergedTree = true).assertHasNoClickAction()

        setWide()
        val widened = oneLine(LONG_SAVED_CAPTION)
        assertTrue(
            "the wider card must show more of the same caption",
            widened.getLineEnd(0, visibleEnd = true) > narrowVisible,
        )

        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText("Resume"))
        awaitProof(proof)
        compose.onNodeWithText("Resume").performClick()
        compose.runOnIdle {
            val captured = intents.single { it is ClientIntent.ResumeSavedEntry } as ClientIntent.ResumeSavedEntry
            assertEquals(LONG_SAVED_CAPTION, captured.target.caption)
        }
    }

    @Test fun quickSwitcherTitleEllipsizesOneLineAndKeepsFullActionTarget() {
        val base = NativeUiFixtures.row(NativeUiFixtures.hostA, proof = null)
        val row = base.copy(metadata = base.metadata.copy(
            nativeSession = RemoteNativeSession("native-title", 1, LONG_SWITCHER_TITLE),
        ))
        val proof = NativeUiFixtures.rowProof(NativeUiFixtures.hostA, NativeUiFixtures.RUN_A)
        val terminal = NativeUiFixtures.terminal(mapOf(SessionRowKey.of(row) to proof))
            .copy(quickSwitcherVisible = true)
        val state = NativeUiFixtures.sessions().copy(
            route = ClientRoute.Terminal(terminal),
            hostStates = listOf(
                NativeUiFixtures.host(NativeUiFixtures.hostA, "Owner A", NativeUiFixtures.RUN_A, listOf(row)),
            ),
        )
        val intents = CopyOnWriteArrayList<ClientIntent>()
        compose.setContent { MaterialTheme { QuickSwitcherSheet(state = state, onIntent = { intents.add(it) }) } }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(LONG_SWITCHER_TITLE, useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty()
        }

        val layout = oneLine(LONG_SWITCHER_TITLE)
        assertTrue("the switcher title must be ellipsized", layout.isLineEllipsized(0))

        awaitProof(proof)
        compose.onNode(hasText(LONG_SWITCHER_TITLE) and hasClickAction()).performClick()
        compose.runOnIdle {
            val captured = intents.single { it is ClientIntent.SwitchTerminalTarget }
                as ClientIntent.SwitchTerminalTarget
            assertEquals(SessionActionTarget.of(row), captured.target)
            assertEquals(LONG_SWITCHER_TITLE, captured.target.drawnTitle)
        }
    }
}
