package io.github.rfairburn.pireviewgate.ui

import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.RosterSnapshot
import io.github.rfairburn.pireviewgate.core.client.ui.SessionStatusStyle
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterMetadataRow
import io.github.rfairburn.pireviewgate.ui.client.SessionsScreen
import io.github.rfairburn.pireviewgate.ui.client.UiCommitScope
import io.github.rfairburn.pireviewgate.ui.client.sessionStatusChipText
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Desktop status color parity on actual native session cards, plus the delivered
 * activity line and activity-intent count chips.
 *
 * Only the observed value carries the status color and weight; the "Agent"/"Input"
 * labels stay neutral, the words stay readable, and exited/error cards show no input
 * status. Each count value carries the desktop card's band of its own number — 0
 * muted, 1-2 success, 3-6 warning, 7 or more the red highest-intensity band, which is
 * never an error status — while the count chips' surface, label, wording, and
 * non-interactivity stay neutral. Invented component inputs only; fixtures are local
 * to this file.
 */
@RunWith(AndroidJUnit4::class)
class SessionCardStatusComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private val host: HostId = HostId.parse("status-a")
    private val run = "55555555-5555-4555-8555-555555555555"

    private fun row(
        id: String,
        lifecycle: RosterLifecycle = RosterLifecycle.ALIVE,
        busy: Boolean? = null,
        pendingInput: Boolean? = null,
        activeTasks: Long? = null,
        activeShells: Long? = null,
        backgroundTasks: Long? = null,
        backgroundShells: Long? = null,
        exitCode: Double? = null,
        activity: List<String> = emptyList(),
    ) = SessionUiState(
        hostId = host, hostLabel = "Status owner", hostRunId = run, stale = false, rosterRevision = 1,
        metadata = RemoteSessionMetadata(
            id = id, label = "Status $id", workspace = "/synthetic/status/$id",
            lifecycle = lifecycle, hasLiveProcess = lifecycle == RosterLifecycle.ALIVE, inputSurface = false,
            rosterSlotId = "slot-$id", busy = busy, pendingInput = pendingInput,
            activeTasks = activeTasks, activeShells = activeShells,
            backgroundTasks = backgroundTasks, backgroundShells = backgroundShells,
            exitCode = exitCode, activity = activity,
        ),
    )

    /**
     * One row as the wire decoder delivers it, handed to the card unchanged exactly as
     * the client projection passes delivered metadata through.
     */
    private fun deliveredRow(
        id: String,
        activity: String = "[\"Ready\"]",
        activeTasks: String = "null",
        activeShells: String = "null",
        backgroundTasks: String = "null",
        backgroundShells: String = "null",
    ): SessionUiState {
        val metadata = requireNotNull(
            RosterMetadataRow.parse(
                Json.parseToJsonElement(
                    """{"id":"$id","rosterSlotId":"slot-$id","label":"Status $id",""" +
                        """"workspace":"/synthetic/status/$id","lifecycle":"alive","hasLiveProcess":true,""" +
                        """"busy":false,"pendingInput":false,"inputSurface":false,"activity":$activity,""" +
                        """"nativeSession":null,"backgroundTasks":$backgroundTasks,""" +
                        """"backgroundShells":$backgroundShells,"activeTasks":$activeTasks,""" +
                        """"activeShells":$activeShells}""",
                ),
            ),
        )
        return SessionUiState(
            hostId = host, hostLabel = "Status owner", hostRunId = run, stale = false, rosterRevision = 1,
            metadata = metadata,
        )
    }

    private val rows = listOf(
        row("running", busy = true, pendingInput = true),
        row("unknown", backgroundTasks = 13, backgroundShells = 14),
        row("starting", lifecycle = RosterLifecycle.STARTING),
        row("exited", lifecycle = RosterLifecycle.EXITED, pendingInput = true, exitCode = 0.0),
        row("error", lifecycle = RosterLifecycle.ERROR, pendingInput = false, exitCode = 2.0),
        row(
            "background-positive",
            activeTasks = 2, activeShells = 1, backgroundTasks = 20, backgroundShells = 10,
        ),
        row(
            "background-zero",
            activeTasks = 0, activeShells = 0, backgroundTasks = 8, backgroundShells = 9,
        ),
        row("task-unknown", activeShells = 1, backgroundTasks = 11, backgroundShells = 12),
        row("shell-unknown", activeTasks = 2, backgroundTasks = 15, backgroundShells = 16),
    )

    private var dark by mutableStateOf(true)

    private fun show(cards: List<SessionUiState> = rows) {
        val state = ClientUiState(hostStates = listOf(HostUiState(
            host = ConfiguredHost(host, HostLabel.parse("Status owner"), Endpoint("status-a.invalid", 8443)),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, run, 1, cards),
            capabilities = HostCapabilities.UNKNOWN,
        )))
        compose.setContent {
            MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                UiCommitScope {
                    SessionsScreen(state = state, onIntent = {}, listState = rememberLazyListState())
                }
            }
        }
        compose.waitForIdle()
    }

    private fun rgb(value: Int) = Color(0xFF000000.toInt() or value)

    private fun card(title: String) =
        hasAnyDescendant(hasText(title)) and SemanticsMatcher.keyIsDefined(SemanticsActions.CustomActions)

    private fun reveal(title: String) {
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(title))
        compose.waitForIdle()
    }

    /** The drawn chip text, with its spans (the first drawn chip when several cards share it). */
    private fun chip(text: String): AnnotatedString =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().first()
            .config[SemanticsProperties.Text].single { it.text == text }

    /** Exactly one painted span, covering exactly [value] at the end; everything before is neutral. */
    private fun assertPaintedValue(text: String, value: String, color: Int, bold: Boolean) {
        val chip = chip(text)
        assertEquals(text, chip.text)
        val span = chip.spanStyles.single()
        assertEquals(text.length - value.length, span.start)
        assertEquals(text.length, span.end)
        assertEquals(value, chip.text.substring(span.start, span.end))
        assertEquals(rgb(color), span.item.color)
        assertEquals(if (bold) FontWeight.Bold else FontWeight.Normal, span.item.fontWeight)
    }

    @Test fun builderLeavesTheLabelNeutralAndPaintsOnlyTheValue() {
        val style = SessionStatusStyle(0x68B78D, bold = true)
        val text = sessionStatusChipText("Agent", "running", style)
        assertEquals("Agent running", text.text)
        val span = text.spanStyles.single()
        assertEquals("running", text.text.substring(span.start, span.end))
        assertEquals(rgb(0x68B78D), span.item.color)
        assertEquals(FontWeight.Bold, span.item.fontWeight)
        // No style: the same words, nothing painted.
        assertEquals("Agent running", sessionStatusChipText("Agent", "running", null).text)
        assertTrue(sessionStatusChipText("Agent", "running", null).spanStyles.isEmpty())
        // No label: the value is the whole text.
        val whole = sessionStatusChipText(null, "Exited 0", SessionStatusStyle(0x7E888E, bold = false))
        assertEquals(0, whole.spanStyles.single().start)
        assertEquals("Exited 0".length, whole.spanStyles.single().end)
    }

    @Test fun darkSurfacePaintsDarkValuesWithNeutralLabels() {
        dark = true
        show()
        assertPaintedValue("Agent running", "running", 0x68B78D, bold = true)
        // Running is not overridden by pending input; input is painted independently.
        assertPaintedValue("Input pending", "pending", 0xCD9A22, bold = true)
        assertPaintedValue("Agent state unknown", "unknown", 0x7E888E, bold = false)
        assertPaintedValue("Input state unknown", "unknown", 0x7E888E, bold = false)
        compose.onAllNodesWithText("Agent idle").let { assertEquals(0, it.fetchSemanticsNodes().size) }
        reveal("Status starting")
        assertPaintedValue("Starting", "Starting", 0x69ADD0, bold = true)
        reveal("Status error")
        assertPaintedValue("Exited 0", "Exited 0", 0x7E888E, bold = false)
        assertPaintedValue("Error 2", "Error 2", 0xEA7F81, bold = true)
    }

    @Test fun lightSurfacePaintsLightValues() {
        dark = false
        show()
        assertPaintedValue("Agent running", "running", 0x337E58, bold = true)
        assertPaintedValue("Input pending", "pending", 0x8F6802, bold = true)
        assertPaintedValue("Agent state unknown", "unknown", 0x879095, bold = false)
        reveal("Status starting")
        // Starting is bold on dark only.
        assertPaintedValue("Starting", "Starting", 0x2F7899, bold = false)
        reveal("Status error")
        assertPaintedValue("Exited 0", "Exited 0", 0x879095, bold = false)
        assertPaintedValue("Error 2", "Error 2", 0xC8253D, bold = true)
    }

    /** The four desktop count-band colors of one native variant. */
    private data class CountBands(val muted: Int, val success: Int, val warning: Int, val intense: Int)

    private fun countBands(darkVariant: Boolean) = CountBands(
        muted = if (darkVariant) 0x9DA5A9 else 0x677176,
        success = if (darkVariant) 0x68B78D else 0x337E58,
        warning = if (darkVariant) 0xCD9A22 else 0x8F6802,
        intense = if (darkVariant) 0xEA7F81 else 0xC8253D,
    )

    /**
     * The count chips stay separate, neutral-surfaced, non-interactive, and fully
     * readable, so this keeps its name: the chip container and its label never take a
     * status color, and a missing count is a plain neutral "unknown" with no painted
     * span at all. Only an observed NUMBER carries a color, on its own span.
     */
    @Test fun backgroundCountsRenderAsSeparateAccessibleNeutralChips() {
        /**
         * One count chip of [title], addressed through its own card so the two counts
         * of a card never stand in for each other: displayed, never clickable, and
         * neutral apart from exactly the trailing [value], which must carry [color] and
         * [bold] weight when [color] is non-null. A null [color] means the whole chip
         * text — the value included — stays unpainted.
         */
        fun assertCountChip(title: String, text: String, value: String, color: Int?, bold: Boolean) {
            reveal(title)
            val node = compose.onNode(hasText(text) and hasAnyAncestor(card(title)))
            // Revealing the title can leave this lower row below the viewport.
            // Scroll the actual chip into view before asserting its presentation.
            node.performScrollTo().assertIsDisplayed().assertHasNoClickAction()
            val content = node.fetchSemanticsNode().config[SemanticsProperties.Text]
                .single { it.text == text }
            if (color == null) {
                assertTrue("$text must stay a plain neutral chip", content.spanStyles.isEmpty())
                return
            }
            val span = content.spanStyles.single()
            assertEquals(text, content.text)
            assertEquals(text.length - value.length, span.start)
            assertEquals(text.length, span.end)
            assertEquals(value, content.text.substring(span.start, span.end))
            assertEquals(rgb(color), span.item.color)
            assertEquals(if (bold) FontWeight.Bold else FontWeight.Normal, span.item.fontWeight)
        }

        val bandRows = listOf(
            row("band-zero", activeTasks = 0, activeShells = 0),
            row("band-one", activeTasks = 1, activeShells = 2),
            row("band-three", activeTasks = 3, activeShells = 6),
            row("band-seven", activeTasks = 7, activeShells = 0),
            row("band-large", activeTasks = 1_000_000, activeShells = 42),
            row("band-mixed", activeTasks = null, activeShells = 1),
            row("band-mixed-positive", activeTasks = 2, activeShells = 6),
        )
        dark = true
        // AndroidComposeTestRule allows setContent once per test. Keep all fixtures
        // in that one composition and switch only the existing theme state below.
        show(rows + bandRows)
        val darkBands = countBands(true)

        // Each number is independently painted, including equal and different bands.
        assertCountChip("Status background-positive", "bg tasks 2", "2", darkBands.success, bold = true)
        assertCountChip("Status background-positive", "bg shells 1", "1", darkBands.success, bold = true)
        // Zero is an observed number, never an unknown: it paints the muted band.
        assertCountChip("Status background-zero", "bg tasks 0", "0", darkBands.muted, bold = false)
        assertCountChip("Status background-zero", "bg shells 0", "0", darkBands.muted, bold = false)
        assertCountChip("Status task-unknown", "bg tasks unknown", "unknown", null, bold = false)
        assertCountChip("Status task-unknown", "bg shells 1", "1", darkBands.success, bold = true)
        assertCountChip("Status shell-unknown", "bg tasks 2", "2", darkBands.success, bold = true)
        assertCountChip("Status shell-unknown", "bg shells unknown", "unknown", null, bold = false)
        // Both counts missing: two plain unknown bubbles, nothing painted at all.
        assertCountChip("Status unknown", "bg tasks unknown", "unknown", null, bold = false)
        assertCountChip("Status unknown", "bg shells unknown", "unknown", null, bold = false)

        // The same bands in both native variants, with every 0 / 1-2 / 3-6 / 7+ boundary.
        for (variant in listOf(true, false)) {
            compose.runOnIdle { dark = variant }
            compose.waitForIdle()
            val bands = countBands(variant)
            assertCountChip("Status band-zero", "bg tasks 0", "0", bands.muted, bold = false)
            assertCountChip("Status band-zero", "bg shells 0", "0", bands.muted, bold = false)
            assertCountChip("Status band-one", "bg tasks 1", "1", bands.success, bold = true)
            assertCountChip("Status band-one", "bg shells 2", "2", bands.success, bold = true)
            assertCountChip("Status band-three", "bg tasks 3", "3", bands.warning, bold = true)
            assertCountChip("Status band-three", "bg shells 6", "6", bands.warning, bold = true)
            // The red band is intensity only: it paints a number, never a status.
            assertCountChip("Status band-seven", "bg tasks 7", "7", bands.intense, bold = true)
            assertCountChip("Status band-seven", "bg shells 0", "0", bands.muted, bold = false)
            assertCountChip("Status band-large", "bg tasks 1000000", "1000000", bands.intense, bold = true)
            assertCountChip("Status band-large", "bg shells 42", "42", bands.intense, bold = true)
            // A missing count stays a plain neutral unknown beside a painted number.
            assertCountChip("Status band-mixed", "bg tasks unknown", "unknown", null, bold = false)
            assertCountChip("Status band-mixed", "bg shells 1", "1", bands.success, bold = true)
            assertCountChip("Status band-mixed-positive", "bg tasks 2", "2", bands.success, bold = true)
            assertCountChip("Status band-mixed-positive", "bg shells 6", "6", bands.warning, bold = true)

            // Painting a count never changes what the card classifies: the red 7 is an
            // ordinary Running row, with no Error status on that card.
            reveal("Status band-seven")
            compose.onNode(hasText("Agent running") and hasAnyAncestor(card("Status band-seven")))
                .performScrollTo().assertIsDisplayed()
            assertEquals(0, compose.onAllNodes(
                hasText("Error", substring = true) and hasAnyAncestor(card("Status band-seven")),
            ).fetchSemanticsNodes().size)
        }

        // Background chips do not replace or alter the established accessible status chips.
        // Positive activity-intent counts mean running; input is a separate observation.
        compose.runOnIdle { dark = true }
        compose.waitForIdle()
        reveal("Status background-positive")
        compose.onNode(hasText("Agent running") and hasAnyAncestor(card("Status background-positive")))
            .performScrollTo().assertIsDisplayed()
        compose.onNode(hasText("Input state unknown") and hasAnyAncestor(card("Status background-positive")))
            .performScrollTo().assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithText("bg tasks 2 | shells 1").fetchSemanticsNodes().size)
    }

    @Test fun inputStatusIsShownOnlyForStartingAndAliveCards() {
        show()
        fun inputChips(title: String) = compose.onAllNodes(
            hasText("Input", substring = true) and hasAnyAncestor(card(title)),
        ).fetchSemanticsNodes().size
        assertEquals(1, inputChips("Status running"))
        assertEquals(1, inputChips("Status unknown"))
        reveal("Status starting")
        assertEquals(1, inputChips("Status starting"))
        reveal("Status exited")
        assertEquals(0, inputChips("Status exited"))
        reveal("Status error")
        assertEquals(0, inputChips("Status error"))
        // The exited/error lifecycle and agent chips are still drawn.
        compose.onNodeWithText("Exited 0").fetchSemanticsNode()
        compose.onNodeWithText("Error 2").fetchSemanticsNode()
        assertTrue(compose.onAllNodesWithText("No agent").fetchSemanticsNodes().isNotEmpty())
    }

    @Test fun collapsedCardsShowTheFirstDeliveredActivityLineInFull() {
        val long = "tool: read src/main/kotlin/io/github/rfairburn/pireviewgate/ui/client/SessionsScreen.kt now"
        val second = "Reading 12 files"
        show(
            listOf(
                row("activity-lines", activity = listOf("", "   ", long, second)),
                row("activity-blank", activity = listOf("", " \t ")),
            ),
        )
        reveal("Status activity-lines")
        // One width-ellipsized line: the semantics keep the whole delivered text, so the
        // ellipsis is a visual truncation and never the accessible fact.
        val line = compose.onNode(hasText(long) and hasAnyAncestor(card("Status activity-lines")))
        line.assertIsDisplayed()
        assertEquals(long, line.fetchSemanticsNode().config[SemanticsProperties.Text].single { it.text == long }.text)
        // One drawn line, truncated at the card width: the layout, not the string, is what
        // is short; the accessible text above stays complete. The node is fetched on the
        // test thread (it synchronizes with Compose idleness); only the layout action runs
        // on the UI thread.
        val layoutAction = line.fetchSemanticsNode()
            .config[SemanticsActions.GetTextLayoutResult].action
        val layouts = mutableListOf<TextLayoutResult>()
        compose.runOnIdle { requireNotNull(layoutAction).invoke(layouts) }
        assertEquals(1, layouts.size)
        val layout = layouts.single()
        assertEquals(1, layout.lineCount)
        assertEquals(1, layout.layoutInput.maxLines)
        assertEquals(TextOverflow.Ellipsis, layout.layoutInput.overflow)
        // Only the first nonblank line is on the collapsed card; the rest stay for details.
        assertEquals(0, compose.onAllNodesWithText(second).fetchSemanticsNodes().size)
        assertEquals(1, compose.onAllNodesWithText("tool: read", substring = true).fetchSemanticsNodes().size)
        // A blank-only activity adds no invented line and no details placeholder.
        assertEquals(0, compose.onAllNodesWithText("No activity lines reported.").fetchSemanticsNodes().size)
    }

    @Test fun expandedDetailsKeepEveryDeliveredActivityLineUnchanged() {
        show(listOf(row("activity-details", activity = listOf(" ", "tool: read", "Reading 12 files"))))
        reveal("Status activity-details")
        // Collapsed: the compact line only.
        assertEquals(1, compose.onAllNodesWithText("tool: read").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("Reading 12 files").fetchSemanticsNodes().size)

        compose.onNodeWithText("Actions").performClick()
        compose.onNodeWithText("Show details").performClick()
        compose.waitForIdle()
        // Expanded: the compact line gives way to the delivered list, so every delivered
        // line is present exactly as delivered and nothing is duplicated or dropped.
        compose.onNodeWithText("Activity").fetchSemanticsNode()
        assertEquals(1, compose.onAllNodesWithText("tool: read").fetchSemanticsNodes().size)
        assertEquals(1, compose.onAllNodesWithText("Reading 12 files").fetchSemanticsNodes().size)
    }

    @Test fun deliveredWireCountsReachTheCountChipsIndependently() {
        show(
            listOf(
                deliveredRow(
                    "wire-zero", activeTasks = "0", activeShells = "0",
                    backgroundTasks = "9", backgroundShells = "8",
                ),
                deliveredRow(
                    "wire-positive", activeTasks = "3", activeShells = "2",
                    backgroundTasks = "0", backgroundShells = "0",
                ),
                deliveredRow(
                    "wire-partial", activeTasks = "null", activeShells = "1",
                    backgroundTasks = "7", backgroundShells = "null",
                ),
            ),
        )
        fun chip(title: String, text: String) =
            compose.onNode(hasText(text) and hasAnyAncestor(card("Status $title")))

        reveal("Status wire-zero")
        chip("wire-zero", "bg tasks 0").assertIsDisplayed()
        chip("wire-zero", "bg shells 0").assertIsDisplayed()
        reveal("Status wire-positive")
        chip("wire-positive", "bg tasks 3").assertIsDisplayed()
        chip("wire-positive", "bg shells 2").assertIsDisplayed()
        // The delivered activity line reaches the same collapsed card.
        chip("wire-positive", "Ready").assertIsDisplayed()
        reveal("Status wire-partial")
        chip("wire-partial", "bg tasks unknown").assertIsDisplayed()
        chip("wire-partial", "bg shells 1").assertIsDisplayed()
        // Delivered ownership counts are a different fact and never become intent counts.
        listOf("bg tasks 9", "bg shells 8", "bg tasks 7").forEach { text ->
            assertEquals(0, compose.onAllNodesWithText(text).fetchSemanticsNodes().size)
        }
    }
}
