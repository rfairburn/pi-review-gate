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
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
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
import io.github.rfairburn.pireviewgate.ui.client.SessionsScreen
import io.github.rfairburn.pireviewgate.ui.client.UiCommitScope
import io.github.rfairburn.pireviewgate.ui.client.sessionStatusChipText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Desktop status color parity on actual native session cards.
 *
 * Only the observed value carries the status color and weight; the "Agent"/"Input"
 * labels stay neutral, the words stay readable, and exited/error cards show no input
 * status. Invented component inputs only; fixtures are local to this file.
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
        exitCode: Double? = null,
    ) = SessionUiState(
        hostId = host, hostLabel = "Status owner", hostRunId = run, stale = false, rosterRevision = 1,
        metadata = RemoteSessionMetadata(
            id = id, label = "Status $id", workspace = "/synthetic/status/$id",
            lifecycle = lifecycle, hasLiveProcess = lifecycle == RosterLifecycle.ALIVE, inputSurface = false,
            rosterSlotId = "slot-$id", busy = busy, pendingInput = pendingInput, exitCode = exitCode,
        ),
    )

    private val rows = listOf(
        row("running", busy = true, pendingInput = true),
        row("unknown"),
        row("starting", lifecycle = RosterLifecycle.STARTING),
        row("exited", lifecycle = RosterLifecycle.EXITED, pendingInput = true, exitCode = 0.0),
        row("error", lifecycle = RosterLifecycle.ERROR, pendingInput = false, exitCode = 2.0),
    )

    private var dark by mutableStateOf(true)

    private fun show() {
        val state = ClientUiState(hostStates = listOf(HostUiState(
            host = ConfiguredHost(host, HostLabel.parse("Status owner"), Endpoint("status-a.invalid", 8443)),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, run, 1, rows),
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
}
