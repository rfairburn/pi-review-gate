package io.github.rfairburn.pireviewgate.ui

import android.graphics.drawable.ColorDrawable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Text
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.core.view.WindowCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.RosterSnapshot
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.hosts.AppAppearance
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.input.CellColorResolution
import io.github.rfairburn.pireviewgate.core.input.SgrStyle
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalColorMode
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalColorSpec
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import io.github.rfairburn.pireviewgate.ui.client.ClientTheme
import io.github.rfairburn.pireviewgate.ui.client.ClientWindowAppearance
import io.github.rfairburn.pireviewgate.ui.client.NonTerminalStatusSlot
import io.github.rfairburn.pireviewgate.ui.client.RootUIScreen
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceView
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The saved Light / Dark appearance on real app-owned surfaces.
 *
 * Light is what the app paints with nothing saved; a saved choice repaints the
 * app's own screens, dialogs, and controls — the activity's diagnostic status band
 * included, whose notice must never fall back to an inherited default — and each
 * labeled option is one accessible control that asks for exactly its own preference.
 * The terminal is the boundary these tests exist to keep: the surface view's own
 * foreground and background defaults and a synthetic received cell resolve
 * identically under either appearance.
 *
 * Invented component inputs only. No transport, owner result, identity, or storage
 * adapter is installed here, and nothing is deployed to an app profile.
 */
@RunWith(AndroidJUnit4::class)
class AppAppearanceComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private companion object {
        const val STATUS_BAND = "status-band"
        const val BELOW_STATUS_BAND = "below-status-band"
    }

    private val host = HostId.parse("appearance-a")
    private val run = "66666666-6666-4666-8666-666666666666"

    /** One alive row whose observed agent value is running, so its card paints a status value. */
    private val runningRow = SessionUiState(
        hostId = host, hostLabel = "Appearance owner", hostRunId = run, stale = false, rosterRevision = 1,
        metadata = RemoteSessionMetadata(
            id = "running-row", label = "Appearance row", workspace = "/synthetic/appearance/row",
            lifecycle = RosterLifecycle.ALIVE, hasLiveProcess = true, inputSurface = false,
            rosterSlotId = "slot-running-row", busy = true, pendingInput = false,
            activeTasks = 1L, activeShells = 0L, backgroundTasks = 0L, backgroundShells = 0L,
            activity = listOf("Synthetic activity"),
        ),
    )

    private fun sessionsState(appearance: AppAppearance) = ClientUiState(
        settings = NetworkSettings(appearance = appearance),
        hostStates = listOf(HostUiState(
            host = ConfiguredHost(host, HostLabel.parse("Appearance owner"), Endpoint("appearance-a.invalid", 8443)),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, run, 1, listOf(runningRow)),
            capabilities = HostCapabilities.UNKNOWN,
        )),
    )

    /** The painted span of one drawn status value, and only that span. */
    private fun paintedValue(text: String, value: String): AnnotatedString.Range<SpanStyle> {
        val chip = compose.onAllNodesWithText(text).fetchSemanticsNodes().first()
            .config[SemanticsProperties.Text].single { it.text == text }
        val span = chip.spanStyles.single()
        assertEquals(text.length - value.length, span.start)
        assertEquals(text.length, span.end)
        assertEquals(value, chip.text.substring(span.start, span.end))
        return span
    }

    private fun rgb(value: Int) = Color(0xFF000000.toInt() or value)

    /** The drawn appearance options, in the order the screen draws them: Light, then Dark. */
    private fun radioOptions() =
        compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton))

    /**
     * The one drawn option labeled [label]: its label text, its radio role, and its
     * selected state all belong to a single control, not to separate nodes.
     */
    private fun appearanceOption(label: String) = compose.onNode(
        SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton) and hasText(label),
    )

    @Test
    fun settingsShowsLightSelectedByDefaultAndEachOptionEmitsOnlyThatPreference() {
        val fixture = NativeUiFixture(NativeUiFixtures.sessions().copy(route = ClientRoute.Settings))
        compose.setContent { fixture.Content() }
        compose.onNodeWithText("Appearance").performScrollTo()
        compose.onNodeWithText("Light").performScrollTo()
        compose.onNodeWithText("Dark").performScrollTo()

        // Two options, and each one is a single labeled control: the label, the radio
        // role, and the selection live on the same node, so an announced option always
        // names which appearance its tap selects. The saved default is the selected one.
        assertEquals(2, radioOptions().fetchSemanticsNodes().size)
        appearanceOption("Light").performScrollTo().assertExists().assertIsSelected()
        appearanceOption("Dark").performScrollTo().assertExists().assertIsNotSelected()

        // Tapping the labeled Dark option asks for that one saved preference and nothing else.
        appearanceOption("Dark").performClick()
        compose.runOnIdle {
            val requested = fixture.intents.filter { it.intent is ClientIntent.SetAppearance }
            assertEquals(ClientIntent.SetAppearance(AppAppearance.DARK), requested.single().intent)
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetAutoReconnectEnabled })
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetViewerRemoteInputEnabled })
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetDebugInputMessagingEnabled })
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetSavedFirstReplyTimeoutSeconds })
        }

        // The drawn selection is what was saved, not what was tapped: it stays on
        // Light until the producer republishes the stored setting.
        appearanceOption("Dark").assertIsNotSelected()
        compose.runOnIdle {
            fixture.state = fixture.state.copy(
                settings = fixture.state.settings.withAppearance(AppAppearance.DARK),
            )
        }
        appearanceOption("Light").assertIsNotSelected()
        appearanceOption("Dark").assertIsSelected()

        // Tapping the labeled Light option asks for Light only.
        appearanceOption("Light").performClick()
        compose.runOnIdle {
            val requested = fixture.intents.filter { it.intent is ClientIntent.SetAppearance }
            assertEquals(2, requested.size)
            assertEquals(ClientIntent.SetAppearance(AppAppearance.LIGHT), requested.last().intent)
        }
    }

    @Test
    fun theSavedAppearanceRepaintsTheAppOwnedSurfacesAndTheirStatusPalette() {
        var state by mutableStateOf(sessionsState(AppAppearance.LIGHT))
        compose.setContent {
            RootUIScreen(
                state = state,
                onIntent = {},
                onTerminalKey = {},
                onTerminalPaste = {},
                terminalContent = {},
            )
        }
        compose.waitForIdle()

        // Nothing saved: the app's light surfaces, and the light status palette
        // those surfaces pick — the same values the light app always painted.
        assertEquals(rgb(0x337E58), paintedValue("Agent running", "running").item.color)
        assertEquals(FontWeight.Bold, paintedValue("Agent running", "running").item.fontWeight)

        // A saved dark choice repaints the same card through the dark palette, so the
        // status distinctions stay distinct on the dark surface rather than dimming out.
        compose.runOnIdle { state = state.copy(settings = state.settings.withAppearance(AppAppearance.DARK)) }
        compose.waitForIdle()
        assertEquals(rgb(0x68B78D), paintedValue("Agent running", "running").item.color)
        assertEquals(FontWeight.Bold, paintedValue("Agent running", "running").item.fontWeight)

        // Back to light, the same values return.
        compose.runOnIdle { state = state.copy(settings = state.settings.withAppearance(AppAppearance.LIGHT)) }
        compose.waitForIdle()
        assertEquals(rgb(0x337E58), paintedValue("Agent running", "running").item.color)
    }

    @Test
    fun theWindowContrastAndBackingFollowTheSavedAppearanceAndLightKeepsItsOwnBacking() {
        val window = compose.activity.window
        val decor = window.decorView
        // The backing the activity's theme supplied, read before anything applies one.
        val themeBackground = decor.background
        var appearance by mutableStateOf(AppAppearance.LIGHT)
        compose.setContent { ClientWindowAppearance(appearance) }
        compose.waitForIdle()

        val contrast = WindowCompat.getInsetsController(window, decor)
        assertTrue("a light app asks for dark status icons", contrast.isAppearanceLightStatusBars)
        assertSame("light keeps the window background its own theme supplied", themeBackground, decor.background)

        compose.runOnIdle { appearance = AppAppearance.DARK }
        compose.waitForIdle()
        assertTrue("a dark app asks for light status icons", !contrast.isAppearanceLightStatusBars)
        val backing = decor.background
        assertTrue("the app-owned backing follows the dark scheme: $backing", backing is ColorDrawable)
        assertEquals(darkColorScheme().surface.toArgb(), (backing as ColorDrawable).color)

        compose.runOnIdle { appearance = AppAppearance.LIGHT }
        compose.waitForIdle()
        assertTrue(contrast.isAppearanceLightStatusBars)
        assertSame(themeBackground, decor.background)
    }

    @Test
    fun theDiagnosticStatusSlotPaintsWithTheSavedAppearanceAndKeepsItsBand() {
        var appearance by mutableStateOf(AppAppearance.LIGHT)
        compose.setContent {
            ClientTheme(appearance) {
                val scheme = MaterialTheme.colorScheme
                // The appearance-matched surface this band sits on: the same light or dark
                // backing the app's own window shows behind it in production.
                Column(Modifier.fillMaxSize().background(scheme.surface)) {
                    Box(Modifier.testTag(STATUS_BAND)) {
                        NonTerminalStatusSlot(
                            status = "Synthetic status notice",
                            debugInputMessagingEnabled = true,
                        )
                    }
                    Text(
                        text = "Synthetic content below the status slot",
                        color = scheme.onSurface,
                        modifier = Modifier.testTag(BELOW_STATUS_BAND),
                    )
                }
            }
        }
        compose.waitForIdle()

        val bandHeightPx = 40f * compose.density.density
        fun belowTop(): Float =
            compose.onNodeWithTag(BELOW_STATUS_BAND).fetchSemanticsNode().boundsInRoot.top

        // The notice is drawn and its fixed band is reserved exactly as before, in both
        // appearances: the appearance changes color only, never height or insets.
        compose.onNodeWithText("Synthetic status notice").assertExists()
        assertTrue("light must reserve the existing slot: ${belowTop()}", belowTop() >= bandHeightPx - 1f)
        assertNoticePaintsWith("light", lightColorScheme(), darkColorScheme())

        compose.runOnIdle { appearance = AppAppearance.DARK }
        compose.waitForIdle()
        compose.onNodeWithText("Synthetic status notice").assertExists()
        assertTrue("dark must reserve the same slot: ${belowTop()}", belowTop() >= bandHeightPx - 1f)
        assertNoticePaintsWith("dark", darkColorScheme(), lightColorScheme())
    }

    /**
     * The notice must paint with the selected scheme's own content color on that scheme's
     * surface — never with an inherited default. The band is captured as real pixels: its
     * empty right end must be the surface, and its strongest glyph pixel must land on the
     * selected scheme's onSurface and stay far from the other appearance's content color.
     *
     * [scheme] and [other] are passed in rather than derived from one another: a Material3
     * [ColorScheme] has no value equality, so two schemes are never compared as objects —
     * only their colors are.
     */
    private fun assertNoticePaintsWith(
        variant: String,
        scheme: ColorScheme,
        other: ColorScheme,
    ) {
        val image = compose.onNodeWithTag(STATUS_BAND).captureToImage()
        val pixels = image.toPixelMap()
        assertTrue("expected a captured status band: ${image.width}x${image.height}", image.width > 8 && image.height > 8)

        // The band's own surface, sampled past the notice text.
        val backing = pixels[image.width - 4, image.height / 2]
        val tolerance = 2f / 255f
        assertEquals("$variant band alpha", 1f, backing.alpha, tolerance)
        assertEquals("$variant band red", scheme.surface.red, backing.red, tolerance)
        assertEquals("$variant band green", scheme.surface.green, backing.green, tolerance)
        assertEquals("$variant band blue", scheme.surface.blue, backing.blue, tolerance)

        // The strongest glyph pixel in the band: the one furthest from its own surface.
        var strongest = backing
        var strongestDistance = -1f
        for (y in 0 until image.height) {
            for (x in 0 until image.width) {
                val actual = pixels[x, y]
                val distance = distance(actual, backing)
                if (distance > strongestDistance) {
                    strongestDistance = distance
                    strongest = actual
                }
            }
        }
        assertTrue(
            "$variant notice must be visible against its own surface, not an invisible " +
                "default: $strongest on $backing",
            strongestDistance > 1f,
        )
        assertTrue(
            "$variant notice must use the selected scheme's own content color: $strongest is " +
                "${distance(strongest, scheme.onSurface)} from ${scheme.onSurface} and " +
                "${distance(strongest, other.onSurface)} from the other appearance's ${other.onSurface}",
            distance(strongest, scheme.onSurface) < 0.45f,
        )
        assertTrue(
            "$variant notice must not inherit the other appearance's content color: $strongest",
            distance(strongest, scheme.onSurface) < distance(strongest, other.onSurface) / 3f,
        )
    }

    /** Summed RGB channel distance, in 0f..1f components. */
    private fun distance(from: Color, to: Color): Float =
        abs(from.red - to.red) + abs(from.green - to.green) + abs(from.blue - to.blue)

    @Test
    fun theTerminalDefaultsAndAReceivedCellIgnoreTheAppAppearance() {
        var appearance by mutableStateOf(AppAppearance.LIGHT)
        var scheme by mutableStateOf<ColorScheme?>(null)
        compose.setContent {
            ClientTheme(appearance) {
                val current = MaterialTheme.colorScheme
                SideEffect { scheme = current }
                Box(Modifier.fillMaxSize())
            }
        }
        compose.waitForIdle()
        val lightScheme = requireNotNull(scheme)
        // The light appearance is the unmodified Material3 light scheme: the shipped
        // look is not redefined by the choice existing. A ColorScheme has no value
        // equality, so the comparison is made on its colors.
        assertEquals(lightColorScheme().surface.toArgb(), lightScheme.surface.toArgb())
        assertEquals(lightColorScheme().onSurface.toArgb(), lightScheme.onSurface.toArgb())

        // A synthetic received cell: an explicit palette foreground over the surface's
        // own defaults, exactly as a delivered run reaches the renderer.
        val delivered = SgrStyle(
            fg = TerminalColorSpec(TerminalColorMode.PALETTE, 196),
            bg = null,
            dim = true,
        )
        val lightSurface = TerminalSurfaceView(compose.activity)
        val lightDefaults = lightSurface.defaultForegroundColor to lightSurface.defaultBackgroundColor
        val lightColors = CellColorResolution.resolve(delivered, lightDefaults.first, lightDefaults.second)

        compose.runOnIdle { appearance = AppAppearance.DARK }
        compose.waitForIdle()
        val darkScheme = requireNotNull(scheme)
        assertEquals(darkColorScheme().surface.toArgb(), darkScheme.surface.toArgb())
        assertEquals(darkColorScheme().onSurface.toArgb(), darkScheme.onSurface.toArgb())
        assertNotEquals(
            "the app-owned surfaces really did change appearance",
            lightScheme.surface.toArgb(),
            darkScheme.surface.toArgb(),
        )

        // The terminal did not: its own defaults are the same two colors, and the same
        // delivered cell resolves to the same resolved colors under either appearance.
        val darkSurface = TerminalSurfaceView(compose.activity)
        assertEquals(lightDefaults, darkSurface.defaultForegroundColor to darkSurface.defaultBackgroundColor)
        assertEquals(
            lightColors,
            CellColorResolution.resolve(delivered, darkSurface.defaultForegroundColor, darkSurface.defaultBackgroundColor),
        )
        assertEquals(0xFFE8E8E8.toInt(), darkSurface.defaultForegroundColor)
        assertEquals(0xFF101010.toInt(), darkSurface.defaultBackgroundColor)
        // A cell that records its own colors resolves to exactly those colors, under
        // either app appearance: nothing in the app's palette enters the resolution.
        val recorded = CellColorResolution.resolve(
            SgrStyle(fg = TerminalColorSpec(TerminalColorMode.RGB, 0x123456), bg = TerminalColorSpec(TerminalColorMode.RGB, 0x654321)),
            darkSurface.defaultForegroundColor,
            darkSurface.defaultBackgroundColor,
        )
        assertEquals(0xFF123456.toInt(), recorded.foreground)
        assertEquals(0xFF654321.toInt(), recorded.background)
    }
}
