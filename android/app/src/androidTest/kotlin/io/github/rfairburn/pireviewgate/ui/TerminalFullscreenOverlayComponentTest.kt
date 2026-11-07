package io.github.rfairburn.pireviewgate.ui

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Insets
import android.graphics.Rect
import android.view.MotionEvent
import android.view.WindowInsets
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.input.KeyboardModifiers
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.ui.terminal.FrameCommitReceipt
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The fullscreen terminal pane owns the whole stable app window; its controls are
 * same-window overlays. Synthetic component fixtures only: no host, transport, or
 * owner result is involved, and nothing here is native acceptance evidence.
 */
@RunWith(AndroidJUnit4::class)
class TerminalFullscreenOverlayComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private val overlayControls = listOf("Back", "Switch", "Keyboard", "Keys")

    @Test fun paneFillsStableWindowWithoutAppChromeInBothOrientations() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        UiVerificationActivity.contentForRecreation = { fixture.Content() }
        try {
            for ((requested, expected) in listOf(
                ActivityInfo.SCREEN_ORIENTATION_PORTRAIT to Configuration.ORIENTATION_PORTRAIT,
                ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE to Configuration.ORIENTATION_LANDSCAPE,
            )) {
                rotateTo(requested, expected, fixture)
                val pane = compose.runOnIdle { paneBounds(fixture) }
                assertEquals("Pane is the window minus only stable bars/cutout/waterfall",
                    compose.runOnIdle { stableWindowBounds() }, pane)
                val (cols, rows) = fixture.viewports.last()
                assertTrue("Adaptive grid stays >= 80x25, was ${cols}x$rows", cols >= 80 && rows >= 25)
                // No app heading, navigation, or permanent key rows exist to reserve space.
                listOf("Terminal", "Sessions", "Hosts", "Settings", "Esc", "Ctrl", "Paste").forEach {
                    compose.onAllNodesWithText(it).assertCountEquals(0)
                }
                // Controls are overlays drawn INSIDE the pane, not beside it.
                overlayControls.forEach { label ->
                    val bounds = control(label).assertIsDisplayed().fetchSemanticsNode().boundsInWindow
                    assertTrue("$label must overlay the pane", bounds.left >= pane.left - 1 &&
                        bounds.top >= pane.top - 1 && bounds.right <= pane.right + 1 && bounds.bottom <= pane.bottom + 1)
                }
                captureSyntheticScreen("fullscreen-overlay-$expected")
            }
        } finally {
            try {
                rotateTo(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, Configuration.ORIENTATION_PORTRAIT, fixture)
                compose.runOnIdle { fixture.state = fixture.state.copy(route = ClientRoute.Sessions) }
            } finally {
                UiVerificationActivity.contentForRecreation = null
            }
        }
    }

    @Test fun overlayControlsAreLabelledSafeTargetsThatOwnTheirTouches() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val touches = recordSurfaceTouches(fixture)
        overlayControls.forEach { label -> safeTouchBounds(label, fixture) }
        repeat(4) { edge ->
            tapIntentEdge("Back", edge, ClientIntent.LeaveTerminal, fixture)
            tapIntentEdge("Switch", edge, ClientIntent.ShowQuickSwitcher, fixture)
            tapControlEdge("Keys", edge, fixture)
            compose.onNodeWithText("Esc").assertIsDisplayed()
            // A tap on the panel's own non-button area is still the panel's.
            compose.onNodeWithText("Conversation A").performTouchInput { click(center) }
            tapControlEdge("Close keys", edge, fixture)
            compose.onAllNodesWithText("Esc").assertCountEquals(0)
        }
        compose.runOnIdle {
            assertTrue("Overlay taps must never reach the terminal: $touches", touches.isEmpty())
            assertTrue(fixture.packets.isEmpty())
        }
        // Positive control: the uncovered pane still receives its own touches.
        compose.onRoot().performTouchInput { click(center) }
        compose.runOnIdle { assertTrue(touches.contains(MotionEvent.ACTION_DOWN)) }
    }

    @Test fun narrowWindowWithLargeTextKeepsEveryControlReachableInBothLabelStates() {
        val fixture = terminalFixture()
        compose.setContent {
            val base = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(base.density, fontScale = 2f)) {
                Box(Modifier.width(320.dp).fillMaxHeight()) { fixture.Content() }
            }
        }
        awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val requests = fixture.viewports.size
        val touches = recordSurfaceTouches(fixture)
        fun assertReachable(vararg labels: String) {
            labels.forEach { label -> safeTouchBounds(label, fixture) }
            compose.runOnIdle {
                assertEquals("Overlay wrapping must not move or resize the pane", pane, paneBounds(fixture))
                assertEquals("Overlay wrapping must not request a reflow", requests, fixture.viewports.size)
            }
        }
        assertReachable("Back", "Switch", "Keyboard", "Keys")
        repeat(4) { edge ->
            tapIntentEdge("Back", edge, ClientIntent.LeaveTerminal, fixture)
            tapIntentEdge("Switch", edge, ClientIntent.ShowQuickSwitcher, fixture)
            tapControlEdge("Keys", edge, fixture)
            compose.onNodeWithText("Esc").assertExists()
            tapControlEdge("Close keys", edge, fixture)
            compose.onAllNodesWithText("Esc").assertCountEquals(0)
        }
        tapControlEdge("Keys", 0, fixture)
        // Observed keyboard state only (no IME is opened); exercises the longer label.
        setObservedKeyboard(fixture, true)
        assertReachable("Back", "Switch", "Hide keyboard", "Close keys")
        repeat(4) { edge ->
            tapIntentEdge("Back", edge, ClientIntent.LeaveTerminal, fixture)
            tapIntentEdge("Switch", edge, ClientIntent.ShowQuickSwitcher, fixture)
            tapControlEdge("Close keys", edge, fixture)
            compose.onAllNodesWithText("Esc").assertCountEquals(0)
            tapControlEdge("Keys", edge, fixture)
            compose.onNodeWithText("Esc").assertExists()
        }
        setObservedKeyboard(fixture, false)
        tapControlEdge("Close keys", 1, fixture)
        assertReachable("Back", "Switch", "Keyboard", "Keys")
        compose.runOnIdle {
            assertTrue("Large-text boundary taps must never reach the terminal: $touches", touches.isEmpty())
            assertTrue(fixture.packets.isEmpty())
        }
    }

    @Test fun keysPanelTogglesNeverResizeRefocusOrCoverThePane() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val before = awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val requests = fixture.viewports.size
        val grid = fixture.viewports.last()
        fun assertInvariant() {
            val proof = awaitInput(fixture)
            compose.runOnIdle {
                val surface = requireNotNull(fixture.surface)
                assertEquals("Overlay toggles must not move or resize the pane", pane, paneBounds(fixture))
                assertEquals("Overlay toggles must not request a reflow", requests, fixture.viewports.size)
                assertEquals(grid, proof.frameCols to proof.frameRows)
                assertTrue("Opening an in-window pop-out keeps terminal focus", surface.hasFocus())
                assertTrue(surface.hasWindowFocus())
                assertTrue("No pop-out may report coverage",
                    fixture.intents.none { it.intent is ClientIntent.UiCoverageChanged })
                assertEquals(before.layoutEpoch, proof.layoutEpoch)
            }
        }
        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("Esc").assertIsDisplayed()
        assertInvariant()
        compose.onNodeWithText("More keys").performClick()
        compose.onNodeWithText("F12").assertExists()
        assertInvariant()
        compose.onNodeWithText("Fewer keys").performClick()
        compose.onNodeWithText("Close keys").performClick()
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
        assertInvariant()
    }

    @Test fun constrainedKeysPanelScrollsByGradualRealDragAndItsKeysStillActivate() {
        val fixture = terminalFixture()
        // A short app window: the pane still fits a measured >=80x25 grid (the font
        // adapts), but the open Keys panel with function keys cannot fit and scrolls.
        compose.setContent { Box(Modifier.fillMaxWidth().height(280.dp)) { fixture.Content() } }
        awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val requests = fixture.viewports.size
        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("More keys").performClick()
        val touches = recordSurfaceTouches(fixture)
        compose.onNodeWithText("F12").assertExists().assertIsNotDisplayed()
        val panel = compose.onNode(hasScrollAction())
        var drags = 0
        while (!isDisplayed("F12")) {
            assertTrue("Gradual drags must scroll the constrained Keys panel", drags++ < 12)
            panel.performTouchInput {
                down(center)
                // Sub-slop first: an overlay that consumed these pre-slop moves
                // would make the scroll detector cancel before it ever starts.
                repeat(15) { moveBy(Offset(0f, -2f)) }
                repeat(20) { moveBy(Offset(0f, -4f)) }
                up()
            }
            compose.waitForIdle()
        }
        compose.runOnIdle {
            assertTrue("Panel drags must never reach the terminal: $touches", touches.isEmpty())
            assertTrue("A drag is not a key press", fixture.packets.isEmpty())
        }
        awaitInput(fixture)
        compose.onNodeWithText("F12").performClick()
        compose.runOnIdle {
            val packet = fixture.packets.single()
            assertEquals(NativeIoInputKind.KEYBOARD, packet.kind)
            assertTrue(packet.bytes.isNotEmpty() && packet.bytes[0] == 0x1b.toByte())
            assertTrue(packet.verifiedAtCapture)
            assertTrue(touches.isEmpty())
            assertEquals("Scrolling the overlay must not move or resize the pane", pane, paneBounds(fixture))
            assertEquals(requests, fixture.viewports.size)
        }
    }

    @Test fun keysPanelSubmitsTheSameProofGuardedRequestsAndBackClosesItBeforeLeaving() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("Ctrl").performClick()
        compose.runOnIdle { assertEquals(KeyboardModifiers.CTRL, fixture.surface!!.selectedMobileModifiers()) }
        compose.onNodeWithText("↑").performClick()
        compose.runOnIdle {
            val packet = fixture.packets.single()
            assertEquals(NativeIoInputKind.KEYBOARD, packet.kind)
            assertArrayEquals("\u001b[1;5A".toByteArray(Charsets.UTF_8), packet.bytes)
            assertTrue(packet.verifiedAtCapture)
            assertEquals("duplicate-row", packet.receipt.rowId)
        }
        compose.onNodeWithText("Paste").performClick()
        compose.runOnIdle {
            assertEquals(NativeIoInputKind.PASTE, fixture.packets.last().kind)
            assertTrue(fixture.packets.last().verifiedAtCapture)
        }
        val intentCount = compose.runOnIdle { fixture.intents.size }
        // First Back closes the pop-out locally; it never leaves the terminal.
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
        compose.runOnIdle { assertEquals(intentCount, fixture.intents.size) }
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.runOnIdle { assertEquals(ClientIntent.LeaveTerminal, fixture.intents.last().intent) }
    }

    @Test fun keyboardControlUsesOnlyTheIntentAndShowsObservedStateNotTheTap() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val requests = fixture.viewports.size
        val touches = recordSurfaceTouches(fixture)
        try {
            compose.onNodeWithText("Keys").performClick()
            tapIntentEdge("Keyboard", 0, ClientIntent.SetTerminalKeyboardVisible(true), fixture)
            // Not optimistic: the accessible description waits for observed visibility.
            compose.onAllNodesWithContentDescription("Hide keyboard").assertCountEquals(0)
            compose.waitUntil(10_000) { compose.runOnIdle {
                fixture.surface?.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
            } }
            setObservedKeyboard(fixture, true)
            control("Hide keyboard").assertIsDisplayed()
            awaitInput(fixture)
            // Native window/inset reads on the UI thread; semantics queries must
            // synchronize from the instrumentation thread, outside runOnIdle.
            val bottom = compose.runOnIdle {
                assertEquals("IME must not move or resize the pane", pane, paneBounds(fixture))
                assertEquals("IME must not request a reflow", requests, fixture.viewports.size)
                val insets = requireNotNull(fixture.surface?.rootWindowInsets)
                val window = compose.activity.window.decorView.height
                window - maxOf(insets.getInsets(WindowInsets.Type.ime()).bottom,
                    insets.getInsets(WindowInsets.Type.systemBars()).bottom)
            }
            val key = compose.onNodeWithText("↓").fetchSemanticsNode().boundsInWindow
            assertTrue("Keys panel stays above the IME", key.bottom <= bottom + 1f)
            tapIntentEdge("Hide keyboard", 1, ClientIntent.SetTerminalKeyboardVisible(false), fixture)
            // Still the observed description until the fixture reports the real insets again.
            control("Hide keyboard").assertIsDisplayed()
            compose.waitUntil(10_000) { compose.runOnIdle {
                fixture.surface?.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == false
            } }
            setObservedKeyboard(fixture, false)
            control("Keyboard").assertIsDisplayed()
            awaitInput(fixture)
            compose.runOnIdle {
                assertEquals(pane, paneBounds(fixture))
                assertTrue("Keyboard boundary taps must never reach the terminal: $touches", touches.isEmpty())
                assertTrue(fixture.packets.isEmpty())
            }
        } finally {
            compose.runOnIdle { fixture.surface?.windowInsetsController?.hide(WindowInsets.Type.ime()) }
        }
    }

    @Test fun realQuickSwitcherStillSuspendsInputWithKeysPanelOpen() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val old = awaitInput(fixture)
        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("↑").assertIsEnabled()
        compose.runOnIdle {
            val route = fixture.state.route as ClientRoute.Terminal
            fixture.state = fixture.state.copy(route = ClientRoute.Terminal(route.terminal.copy(quickSwitcherVisible = true)))
        }
        compose.waitUntil(10_000) { compose.runOnIdle {
            fixture.intents.any { it.intent == ClientIntent.UiCoverageChanged(UiCoverage.BOTTOM_SHEET) }
        } }
        compose.waitUntil(10_000) { compose.runOnIdle { !fixture.surface!!.verifyReceipt(old) } }
        compose.onNodeWithText("Terminal input is paused while this is open.").assertExists()
        compose.onNodeWithText("↑").assertIsNotEnabled()
        compose.runOnIdle { assertTrue(fixture.packets.isEmpty()) }
        compose.runOnIdle {
            val route = fixture.state.route as ClientRoute.Terminal
            fixture.state = fixture.state.copy(route = ClientRoute.Terminal(route.terminal.copy(quickSwitcherVisible = false)))
        }
        val fresh = awaitInput(fixture)
        assertNotEquals(old, fresh)
        compose.onNodeWithText("Esc").assertIsDisplayed()
        compose.onAllNodesWithText("Terminal input is paused while this is open.").assertCountEquals(0)
    }

    @Test fun nonTerminalRoutesKeepTheirHeadingNavigationAndNoOverlays() {
        val fixture = NativeUiFixture(NativeUiFixtures.sessions())
        compose.setContent { fixture.Content() }
        compose.onAllNodesWithText("Sessions").onFirst().assertIsDisplayed()
        compose.onNodeWithText("Hosts").assertIsDisplayed()
        compose.onAllNodesWithText("Settings").onFirst().assertIsDisplayed()
        listOf("Switch", "Keys").forEach { compose.onAllNodesWithText(it).assertCountEquals(0) }
        compose.onAllNodesWithContentDescription("Keyboard").assertCountEquals(0)
    }

    /** Material's painted TextButton can be 40dp; its interactive bounds must be >=48dp. */
    private fun safeTouchBounds(label: String, fixture: NativeUiFixture): androidx.compose.ui.geometry.Rect {
        val node = control(label).assertIsDisplayed().assertHasClickAction().fetchSemanticsNode()
        val bounds = node.touchBoundsInRoot
        val minimum = 48f * compose.activity.resources.displayMetrics.density
        assertTrue("$label touch width must be at least 48dp: $bounds", bounds.width >= minimum)
        assertTrue("$label touch height must be at least 48dp: $bounds", bounds.height >= minimum)
        val inWindow = bounds.translate(node.boundsInWindow.topLeft - node.boundsInRoot.topLeft)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        assertTrue("$label's whole touch target must lie inside the pane: $inWindow vs $pane",
            inWindow.left >= pane.left - 1 && inWindow.top >= pane.top - 1 &&
                inWindow.right <= pane.right + 1 && inWindow.bottom <= pane.bottom + 1)
        return bounds
    }

    /** Real pointer injection just inside each edge, including outside the painted button. */
    private fun tapControlEdge(label: String, edge: Int, fixture: NativeUiFixture) {
        val bounds = safeTouchBounds(label, fixture)
        val point = when (edge) {
            0 -> Offset(bounds.center.x, bounds.top + 1f)
            1 -> Offset(bounds.center.x, bounds.bottom - 1f)
            2 -> Offset(bounds.left + 1f, bounds.center.y)
            else -> Offset(bounds.right - 1f, bounds.center.y)
        }
        val root = compose.onRoot()
        val origin = root.fetchSemanticsNode().boundsInRoot.topLeft
        root.performTouchInput { click(point - origin) }
    }

    private fun tapIntentEdge(label: String, edge: Int, expected: ClientIntent, fixture: NativeUiFixture) {
        val before = compose.runOnIdle { fixture.intents.size }
        tapControlEdge(label, edge, fixture)
        compose.runOnIdle {
            assertEquals("$label boundary tap must activate exactly once", before + 1, fixture.intents.size)
            assertEquals(expected, fixture.intents.last().intent)
        }
    }

    private fun isDisplayed(text: String): Boolean =
        runCatching { compose.onNodeWithText(text).assertIsDisplayed() }.isSuccess

    /** The keyboard control is an icon with dynamic accessible content, not a text label. */
    private fun control(label: String) =
        if (label == "Keyboard" || label == "Hide keyboard") {
            compose.onNodeWithContentDescription(label)
        } else {
            compose.onNodeWithText(label)
        }

    private fun terminalFixture() = NativeUiFixture(NativeUiFixtures.sessions().copy(
        route = ClientRoute.Terminal(NativeUiFixtures.terminal()),
    )).apply { binding = NativeUiFixtures.binding(sourced = true) }

    private fun awaitInput(fixture: NativeUiFixture): FrameCommitReceipt {
        var committed: FrameCommitReceipt? = null
        compose.waitUntil(10_000) {
            committed = compose.runOnIdle {
                val surface = fixture.surface
                surface?.currentInputProof()?.also { assertTrue(surface.verifyReceipt(it)) }
            }
            committed != null
        }
        return requireNotNull(committed)
    }

    /** Test-local observer: records and swallows what actually reaches the View. */
    private fun recordSurfaceTouches(fixture: NativeUiFixture): MutableList<Int> {
        val touches = CopyOnWriteArrayList<Int>()
        compose.runOnIdle {
            requireNotNull(fixture.surface).setOnTouchListener { _, event -> touches += event.actionMasked; true }
        }
        return touches
    }

    private fun setObservedKeyboard(fixture: NativeUiFixture, visible: Boolean) = compose.runOnIdle {
        val route = fixture.state.route as ClientRoute.Terminal
        fixture.state = fixture.state.copy(route = ClientRoute.Terminal(route.terminal.copy(keyboardVisible = visible)))
    }

    private fun paneBounds(fixture: NativeUiFixture): Rect {
        val surface = requireNotNull(fixture.surface)
        val location = IntArray(2).also(surface::getLocationInWindow)
        return Rect(location[0], location[1], location[0] + surface.width, location[1] + surface.height)
    }

    /** The app window minus stable bars, cutout, and waterfall; never the IME. */
    private fun stableWindowBounds(): Rect {
        val root = compose.activity.window.decorView
        val insets = requireNotNull(root.rootWindowInsets)
        val stable = insets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val waterfall = insets.displayCutout?.waterfallInsets ?: Insets.NONE
        return Rect(maxOf(stable.left, waterfall.left), maxOf(stable.top, waterfall.top),
            root.width - maxOf(stable.right, waterfall.right), root.height - maxOf(stable.bottom, waterfall.bottom))
    }

    private fun rotateTo(requested: Int, expected: Int, fixture: NativeUiFixture) {
        val (previousView, needsRecreation) = compose.runOnIdle {
            fixture.surface to (compose.activity.resources.configuration.orientation != expected)
        }
        compose.activityRule.scenario.onActivity { it.requestedOrientation = requested }
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                compose.activity.resources.configuration.orientation == expected &&
                    (!needsRecreation || fixture.surface !== previousView) &&
                    fixture.surface?.isAttachedToWindow == true && fixture.surface?.hasWindowFocus() == true
            }
        }
        awaitInput(fixture)
    }
}
