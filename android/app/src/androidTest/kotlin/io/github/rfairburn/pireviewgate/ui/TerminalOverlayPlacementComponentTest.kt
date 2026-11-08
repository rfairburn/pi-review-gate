package io.github.rfairburn.pireviewgate.ui

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Rect as AndroidRect
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect as ComposeRect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalControlKey
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalKeyRequest
import io.github.rfairburn.pireviewgate.core.client.ui.UiCoverage
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlay
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayOrientation
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPlacement
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPlacementWarning
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPosition
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.ui.client.TerminalScreen
import io.github.rfairburn.pireviewgate.ui.terminal.FrameCommitReceipt
import io.github.rfairburn.pireviewgate.ui.terminal.InputUnavailableReason
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurface
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceListener
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceView
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalViewBinding
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Synthetic component checks for the independently movable terminal overlays.
 *
 * No host, transport, identity, or owner result participates. The long-press drags
 * are real injected touches against the real Compose tree; the pane proof and viewport
 * facts come from the existing renderer's own public API.
 */
@RunWith(AndroidJUnit4::class)
class TerminalOverlayPlacementComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun allThreeOverlaysDragIndependentlyWithoutMovingPaneGridProofFocusOrPackets() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitInput(fixture)
        val pane = paneBounds(fixture)
        val grid = fixture.viewports.last()
        val requests = fixture.viewports.size
        val fontPx = requireNotNull(fixture.surface).textSizePx
        val touches = recordSurfaceTouches(fixture)
        val refusalBefore = fixture.lastRefusal

        compose.onNodeWithText("Keys").assertIsDisplayed().performClick()
        compose.onNodeWithText("Esc").assertExists()
        val controlsBefore = boundsOf("Back")
        val statusBefore = boundsOf("Synthetic status notice")
        val keysBefore = boundsOf("Conversation A")

        dragBy("Switch", dx = -180f, dy = 140f)
        assertFalse("Controls strip moved", controlsBefore == boundsOf("Back"))
        assertEquals("Moving Controls must not drag Status", statusBefore, boundsOf("Synthetic status notice"))
        assertEquals("Moving Controls must not drag Keys", keysBefore, boundsOf("Conversation A"))
        assertNotNull(fixture.placement.controlsPortrait)
        assertNull(fixture.placement.statusPortrait)
        assertNull(fixture.placement.keysPortrait)
        assertInvariant(fixture, pane, grid, requests, fontPx, anchor)

        val controlsAfter = boundsOf("Back")
        dragBy("Synthetic status notice", dx = -90f, dy = 120f)
        assertEquals("Moving Status must not drag Controls", controlsAfter, boundsOf("Back"))
        assertFalse("Status notice moved", statusBefore == boundsOf("Synthetic status notice"))
        assertNotNull(fixture.placement.controlsPortrait)
        assertNotNull(fixture.placement.statusPortrait)
        assertNull(fixture.placement.keysPortrait)
        assertInvariant(fixture, pane, grid, requests, fontPx, anchor)

        val controlsAfterStatus = boundsOf("Back")
        val statusAfter = boundsOf("Synthetic status notice")
        dragBy("Conversation A", dx = 0f, dy = -180f)
        assertEquals("Moving Keys must not drag Controls", controlsAfterStatus, boundsOf("Back"))
        assertEquals("Moving Keys must not drag Status", statusAfter, boundsOf("Synthetic status notice"))
        assertFalse("Keys panel moved", keysBefore == boundsOf("Conversation A"))
        assertNotNull(fixture.placement.keysPortrait)
        assertInvariant(fixture, pane, grid, requests, fontPx, anchor)

        compose.runOnIdle {
            assertTrue("Long-press drags never reach the terminal surface: $touches", touches.isEmpty())
            assertTrue("Drags are not key or paste requests", fixture.keys.isEmpty() && fixture.pastes == 0)
            assertEquals("Drags never submit a host input", 0, fixture.inputs)
            assertTrue("Drags never emit navigation, coverage, or keyboard intents", fixture.intents.isEmpty())
            assertEquals("Drags add no input-unavailable state", refusalBefore, fixture.lastRefusal)
        }

        // A normal short tap after all three drags still delivers its own action.
        compose.onNodeWithText("Switch").performClick()
        compose.runOnIdle {
            assertEquals(ClientIntent.ShowQuickSwitcher, fixture.intents.last().intent)
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            assertTrue("A short button tap is not a host key packet", fixture.keys.isEmpty())
        }
    }

    @Test fun keyboardIconKeepsFixedFootprintDynamicDescriptionAndReal48dpTarget() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val pane = paneBounds(fixture)
        val requests = fixture.viewports.size

        compose.onAllNodesWithText("Keyboard").assertCountEquals(0)
        compose.onAllNodesWithText("Hide keyboard").assertCountEquals(0)
        val button = compose.onNodeWithContentDescription("Keyboard")
            .assertIsDisplayed()
            .assertHasClickAction()
            .fetchSemanticsNode()
        val minimum = 48f * compose.activity.resources.displayMetrics.density
        assertTrue("Keyboard icon touch target must be at least 48dp: ${button.touchBoundsInRoot}",
            button.touchBoundsInRoot.width >= minimum && button.touchBoundsInRoot.height >= minimum)

        // The visible vector itself has one fixed footprint independent of either label.
        val icon = compose.onNodeWithContentDescription("Keyboard", useUnmergedTree = true).fetchSemanticsNode()
        val iconSide = 24f * compose.activity.resources.displayMetrics.density
        assertEquals("Icon width is one fixed 24dp footprint", iconSide, icon.boundsInRoot.width, 1f)
        assertEquals("Icon height is one fixed 24dp footprint", iconSide, icon.boundsInRoot.height, 1f)

        // The description follows observed visibility only; the request itself does not
        // rewrite it optimistically.
        compose.onNodeWithContentDescription("Keyboard").performClick()
        compose.runOnIdle {
            assertEquals(ClientIntent.SetTerminalKeyboardVisible(true), fixture.intents.last().intent)
        }
        compose.onAllNodesWithContentDescription("Hide keyboard").assertCountEquals(0)
        compose.runOnIdle { fixture.observedKeyboard = true }
        compose.onNodeWithContentDescription("Hide keyboard").assertIsDisplayed()
        compose.onAllNodesWithText("Hide keyboard").assertCountEquals(0)
        compose.runOnIdle {
            assertEquals(pane, paneBounds(fixture))
            assertEquals(requests, fixture.viewports.size)
            assertTrue(requireNotNull(fixture.surface).hasFocus())
        }
    }

    @Test fun compactKeysPanelStillExposesEveryKeyActionModifierAndExpandedAccess() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val pane = paneBounds(fixture)
        val requests = fixture.viewports.size
        val grid = fixture.viewports.last()

        compose.onNodeWithText("Keys").performClick()
        listOf("Ctrl", "Paste", "Esc").forEach(::assertTouchTarget)
        listOf("Ctrl", "Alt", "Shift", "Paste", "More keys", "Esc", "Tab", "Shift+Tab",
            "Home", "End", "PgUp", "PgDn", "←", "↑", "↓", "→").forEach { label ->
            compose.onNodeWithText(label).assertExists()
        }
        compose.onNodeWithText("More keys").performClick()
        compose.onNodeWithText("Fewer keys").assertExists()
        listOf("Ins", "Del", "F1", "F2", "F3", "F4", "F5", "F6",
            "F7", "F8", "F9", "F10", "F11", "F12").forEach { label ->
            compose.onNodeWithText(label).assertExists()
        }
        compose.onNodeWithText("F12").performScrollTo().assertIsDisplayed()
        assertTouchTarget("F12")
        compose.runOnIdle {
            assertEquals("Compact keys must not move or resize the pane", pane, paneBounds(fixture))
            assertEquals("Opening and expanding keys must not request a reflow", requests, fixture.viewports.size)
            assertEquals(grid, fixture.viewports.last())
            assertTrue("Opening keys must not emit any implicit IME intent",
                fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            assertEquals("Opening or expanding keys is not a completed drag", 0, fixture.commits)
            assertTrue(fixture.keys.isEmpty())
        }

        compose.onNodeWithText("Ctrl").performScrollTo().performClick()
        compose.onNodeWithText("↑").performScrollTo().performClick()
        listOf("Ins", "Del", "F1", "F12").forEach { compose.onNodeWithText(it).assertExists() }
        compose.runOnIdle {
            assertEquals(1, fixture.keys.size)
            assertTrue(fixture.keys.single().modifiers.ctrl)
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            assertEquals(pane, paneBounds(fixture))
            assertEquals(requests, fixture.viewports.size)
        }
        compose.onNodeWithText("Fewer keys").performScrollTo().performClick()
        compose.onNodeWithText("F12").assertDoesNotExist()
    }

    @Test fun shortVisibleKeysPanelKeepsEveryActionReachableForDefaultAndPersistedPlacement() {
        val fixture = Fixture()
        compose.setContent {
            // With the debug host's edge-to-edge system-bar insets this leaves the
            // same short visible layer an IME produces on a small window.
            Box(Modifier.fillMaxWidth().height(200.dp)) { fixture.Content() }
        }
        awaitInput(fixture)
        val pane = paneBounds(fixture)
        val requests = fixture.viewports.size

        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("More keys").performScrollTo().performClick()
        compose.runOnIdle {
            fixture.terminal = fixture.terminal.copy(coverage = UiCoverage.MODAL_DIALOG)
            fixture.warning = TerminalOverlayPlacementWarning.SAVE_FAILED
        }

        compose.onNodeWithText("Conversation A").performScrollTo()
        val controls = boundsOf("Close keys")
        val defaultHeader = boundsOf("Conversation A")
        assertTrue("A short Keys header must stay below the controls: $defaultHeader vs $controls",
            defaultHeader.top >= controls.bottom - 1f)
        assertTrue("A short Keys viewport must remain visible: $defaultHeader",
            defaultHeader.bottom > controls.bottom)
        assertEveryKeyActionScrolls()
        listOf("Ctrl", "Paste", "Esc", "F12").forEach { label ->
            compose.onNodeWithText(label).performScrollTo()
            assertTouchTarget(label)
        }
        compose.runOnIdle {
            assertEquals("Short Keys scrolling must not move or resize the pane", pane, paneBounds(fixture))
            assertEquals("Short Keys scrolling must not request a reflow", requests, fixture.viewports.size)
            assertEquals("Short Keys scrolling is not a placement save", 0, fixture.commits)
            assertTrue("Short Keys layout never changes IME authority",
                fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
        }

        // A remembered top-edge position is clamped into the same usable short-layer
        // viewport; the persisted slot itself is not rewritten by presentation.
        compose.runOnIdle {
            fixture.placement = TerminalOverlayPlacement.DEFAULT
                .withPosition(
                    TerminalOverlay.KEYS,
                    TerminalOverlayOrientation.PORTRAIT,
                    TerminalOverlayPosition(0, 0),
                )
                .withPosition(
                    TerminalOverlay.KEYS,
                    TerminalOverlayOrientation.LANDSCAPE,
                    TerminalOverlayPosition(0, 0),
                )
        }
        compose.onNodeWithText("Conversation A").performScrollTo()
        val persistedHeader = boundsOf("Conversation A")
        assertTrue("Persisted top-edge Keys must stay below the controls: $persistedHeader vs $controls",
            persistedHeader.top >= controls.bottom - 1f)
        assertEveryKeyActionScrolls()
        compose.runOnIdle {
            assertEquals(TerminalOverlayPosition(0, 0), fixture.placement.keysPortrait)
            assertEquals(TerminalOverlayPosition(0, 0), fixture.placement.keysLandscape)
            assertEquals("Presentation clipping never commits placement", 0, fixture.commits)
        }

        tapByTouch("Close keys")
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
    }

    @Test fun shortKeysPanelKeepsTargetsClearOfBottomAndIntermediateControls() {
        val fixture = Fixture()
        compose.setContent {
            Box(Modifier.fillMaxWidth().height(170.dp)) { fixture.Content() }
        }
        awaitInput(fixture)
        val pane = paneBounds(fixture)
        val requests = fixture.viewports.size
        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("More keys").performScrollTo().performClick()

        listOf(
            TerminalOverlayPosition(1000, 1000),
            TerminalOverlayPosition(500, 500),
        ).forEachIndexed { index, controlsPosition ->
            compose.runOnIdle {
                fixture.placement = fixture.placement
                    .withPosition(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, controlsPosition)
                    .withPosition(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.LANDSCAPE, controlsPosition)
            }
            assertKeyTargetClearOfControls("Esc")
            tapByTouch("Esc")
            compose.onNodeWithText("Paste").performScrollTo()
            tapByTouch("Paste")
            compose.runOnIdle {
                assertEquals(controlsPosition, fixture.placement.controlsPortrait)
                assertEquals(controlsPosition, fixture.placement.controlsLandscape)
                assertEquals(TerminalControlKey.ESCAPE, fixture.keys.last().key)
                assertEquals(index + 1, fixture.pastes)
                assertEquals("Moving Controls is presentation-only", 0, fixture.commits)
                assertEquals("Moved Controls must not move or resize the pane", pane, paneBounds(fixture))
                assertEquals("Moved Controls must not request a reflow", requests, fixture.viewports.size)
            }
        }
    }

    @Test fun narrowShortLayerScrollsWrappedControlsAndKeepsCompleteKeyTargets() {
        val fixture = Fixture()
        compose.setContent {
            val base = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(base.density, fontScale = 1.5f)) {
                Box(Modifier.width(160.dp).height(160.dp)) { fixture.Content() }
            }
        }
        awaitInput(fixture)
        val pane = paneBounds(fixture)
        val requests = fixture.viewports.size

        runCatching { compose.onNodeWithText("Keys").performScrollTo() }
        compose.onNodeWithText("Keys").assertIsDisplayed()
        tapByTouch("Keys")
        compose.onNodeWithText("More keys").performScrollTo().performClick()

        // The wrapped control strip is capped and scrollable while Keys is open, so
        // every control stays reachable even though it cannot all fit at once.
        listOf("Back", "Switch").forEach { label ->
            compose.onNodeWithText(label).performScrollTo().assertIsDisplayed()
        }
        compose.onNodeWithContentDescription("Keyboard").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Close keys").performScrollTo().assertIsDisplayed()

        assertEveryKeyActionScrolls()
        assertKeyTargetClearOfControls("F12")
        tapByTouch("F12")
        compose.onNodeWithText("Paste").performScrollTo()
        tapByTouch("Paste")
        compose.runOnIdle {
            assertEquals(TerminalControlKey.F12, fixture.keys.last().key)
            assertEquals(1, fixture.pastes)
            assertTrue("Short Keys layout never changes IME authority",
                fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            assertEquals("Scrolling is not a placement save", 0, fixture.commits)
            assertEquals("Short Keys layout must not move or resize the pane", pane, paneBounds(fixture))
            assertEquals("Short Keys layout must not request a reflow", requests, fixture.viewports.size)
        }

        compose.onNodeWithText("Close keys").performScrollTo()
        tapByTouch("Close keys")
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
    }

    @Test fun constrainedKeysPanelStaysBelowControlsAndReadinessWhileEveryKeyScrolls() {
        val fixture = Fixture()
        compose.setContent {
            Box(Modifier.fillMaxWidth().height(280.dp)) { fixture.Content() }
        }
        awaitInput(fixture)
        val pane = paneBounds(fixture)
        val requests = fixture.viewports.size

        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("More keys").performClick()
        compose.runOnIdle {
            fixture.terminal = fixture.terminal.copy(coverage = UiCoverage.MODAL_DIALOG)
        }
        compose.onNodeWithText("Terminal input is paused while this is open.").assertIsDisplayed()

        val controls = boundsOf("Close keys")
        val readiness = boundsOf("Terminal input is paused while this is open.")
        val keysHeader = boundsOf("Conversation A")
        assertTrue("Keys must stay below the control strip: $keysHeader vs $controls",
            keysHeader.top >= controls.bottom - 1f)
        assertTrue("Keys must stay below the required readiness notice: $keysHeader vs $readiness",
            keysHeader.top >= readiness.bottom - 1f)

        val allKeys = listOf("Ctrl", "Alt", "Shift", "Paste", "Fewer keys", "Esc", "Tab", "Shift+Tab",
            "Home", "End", "PgUp", "PgDn", "←", "↑", "↓", "→", "Ins", "Del",
            "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12")
        allKeys.forEach { label ->
            compose.onNodeWithText(label).performScrollTo().assertIsDisplayed()
        }
        compose.runOnIdle {
            assertEquals("Keys scrolling must not move or resize the pane", pane, paneBounds(fixture))
            assertEquals("Keys scrolling must not request a reflow", requests, fixture.viewports.size)
            assertEquals("Keys scrolling is not a placement save", 0, fixture.commits)
        }

        // A recognized drag against the bottom boundary saves an explicit position
        // without changing the panel's size or moving its header on release.
        compose.onNodeWithText("Conversation A").performScrollTo()
        val headerBeforeSave = boundsOf("Conversation A")
        dragBy("Conversation A", dx = 0f, dy = 80f)
        val headerAfterSave = boundsOf("Conversation A")
        assertEquals("Saving placement must not expand or jump Keys",
            headerBeforeSave.top, headerAfterSave.top, 1f)
        compose.runOnIdle {
            assertEquals(1, fixture.commits)
            assertNotNull(fixture.placement.keysPortrait)
        }

        // The constrained panel leaves the real control strip interactive to a real touch.
        tapByTouch("Close keys")
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
    }

    @Test fun overlayCompositionWaitsForCompletedPlacementLoad() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        compose.runOnIdle { fixture.placementReady = false }
        compose.onAllNodesWithText("Keys").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Keyboard").assertCountEquals(0)
        compose.onAllNodesWithText("Switch").assertCountEquals(0)
        compose.runOnIdle { fixture.placementReady = true }
        compose.onNodeWithText("Keys").assertIsDisplayed()
        compose.onNodeWithContentDescription("Keyboard").assertIsDisplayed()
    }

    @Test fun placementWarningsAreVisibleOverlaysWithoutTouchingThePaneOrStatusDismissal() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitInput(fixture)
        val pane = paneBounds(fixture)
        val requests = fixture.viewports.size
        val grid = fixture.viewports.last()

        compose.runOnIdle { fixture.warning = TerminalOverlayPlacementWarning.LOADED_DEFAULTS }
        compose.onNodeWithText(
            "Saved overlay positions could not be read. Default positions are in use until new positions are saved.",
        ).assertIsDisplayed()
        assertInvariant(fixture, pane, grid, requests, requireNotNull(fixture.surface).textSizePx, anchor)

        compose.runOnIdle { fixture.warning = TerminalOverlayPlacementWarning.SAVE_FAILED }
        compose.onNodeWithText("Overlay positions could not be saved. They apply now but may not be remembered.")
            .assertIsDisplayed()
        assertEquals("Warning presentation alone is not a placement save", 0, fixture.commits)
        // The existing raw status remains a separate dismissible notice.
        compose.onNodeWithText("Synthetic status notice").assertIsDisplayed()
        compose.onNodeWithText("Dismiss").performClick()
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        assertInvariant(fixture, pane, grid, requests, requireNotNull(fixture.surface).textSizePx, anchor)
    }

    @Test fun cancelledDragsAndRotationNeverSubmitPlacementSaves() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        UiVerificationActivity.contentForRecreation = { fixture.Content() }
        try {
            placementPhase("initial-commit") { awaitInput(fixture) }
            val pane = compose.runOnIdle { paneBounds(fixture) }
            val before = fixture.placement
            val beforeBounds = boundsOf("Back")
            placementPhase("cancel-drag") { cancelDragBy("Switch", dx = -120f, dy = 100f) }
            placementPhase("cancel-invariants") {
                val restoredBounds = boundsOf("Back")
                compose.runOnIdle {
                    assertEquals("A cancelled drag is not a completed drag", 0, fixture.commits)
                    assertEquals(before, fixture.placement)
                    assertEquals("A cancelled drag restores the overlay", beforeBounds, restoredBounds)
                    assertEquals(pane, paneBounds(fixture))
                }
            }

            placementPhase("landscape-recreation") {
                rotateTo(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, Configuration.ORIENTATION_LANDSCAPE, fixture)
            }
            placementPhase("landscape-invariants") {
                val snapshot = compose.runOnIdle {
                    assertEquals("Rotation itself is never a placement save", 0, fixture.commits)
                    assertEquals(TerminalOverlayPlacement.DEFAULT, fixture.placement)
                    val surface = requireNotNull(fixture.surface)
                    assertTrue(surface.hasFocus())
                    PlacementInvariantSnapshot(paneBounds(fixture), fixture.viewports.last(),
                        fixture.viewports.size, surface.textSizePx, requireNotNull(surface.currentInputProof()))
                }
                // This helper synchronizes itself; do not nest it in runOnIdle.
                assertInvariant(fixture, snapshot.pane, snapshot.grid, snapshot.requests, snapshot.fontPx, snapshot.anchor)
            }
        } finally {
            try {
                placementPhase("portrait-recreation") {
                    rotateTo(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, Configuration.ORIENTATION_PORTRAIT, fixture)
                }
            } finally {
                UiVerificationActivity.contentForRecreation = null
            }
        }
    }

    private data class PlacementInvariantSnapshot(
        val pane: AndroidRect,
        val grid: Pair<Int, Int>,
        val requests: Int,
        val fontPx: Float,
        val anchor: FrameCommitReceipt,
    )

    /** One bounded observation if an existing 10s phase wait stops returning.
     * Never interrupts the test, drives its clock, alters idleness or changes a deadline.
     */
    private fun <T> placementPhase(name: String, action: () -> T): T {
        val testThread = Thread.currentThread()
        val mainThread = Looper.getMainLooper().thread
        val observer = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "placement-phase-observer").apply { isDaemon = true }
        }
        Log.i("OverlayPlacementTest", "phase=$name begin")
        val pending = observer.schedule({
            listOf("main" to mainThread, "test" to testThread).forEach { (label, thread) ->
                Log.e("OverlayPlacementTest", "phase=$name still waiting; $label state=${thread.state}")
                runCatching { thread.stackTrace.take(16) }.onSuccess { stack ->
                    stack.forEach { Log.e("OverlayPlacementTest", "phase=$name $label at $it") }
                }.onFailure { error ->
                    Log.e("OverlayPlacementTest", "phase=$name $label stack unavailable: ${error.javaClass.simpleName}")
                }
            }
        }, 10, TimeUnit.SECONDS)
        try {
            return action().also { Log.i("OverlayPlacementTest", "phase=$name end") }
        } finally {
            pending.cancel(false)
            observer.shutdown()
        }
    }

    /**
     * Debug off removes the entire notice presentation: its text, its dismiss control,
     * its drag/touch region, and the Keys panel's duplicate of the raw status — and the
     * height that surface reserved stops being subtracted from the Keys band. Debug on
     * returns the same producer content, with nothing saved, reset, or replayed.
     */
    @Test fun debugOffRemovesEveryNoticePresentationItsTouchRegionAndReclaimsKeysHeight() {
        val fixture = Fixture()
        // Narrow and tall: the Keys panel's natural height then clearly exceeds the
        // available band, so it is capped by the notices height and the reclaimed band
        // is measurable, while the ordinary (non-short-layer) Keys layout still applies.
        compose.setContent { Box(Modifier.width(240.dp).height(360.dp)) { fixture.Content() } }
        awaitInput(fixture)
        val pane = paneBounds(fixture)
        val grid = fixture.viewports.last()
        val requests = fixture.viewports.size

        // Debug on: the raw status and its dismiss control form one notices surface.
        val notices = compose.onNodeWithText("Synthetic status notice")
            .assertIsDisplayed()
            .fetchSemanticsNode()
        compose.onNodeWithText("Dismiss").assertIsDisplayed().assertHasClickAction()
        val noticesBounds = notices.boundsInWindow
        // The notice text is a conservative lower bound on the surface's reserved
        // height; the reclaim assertion below must at least cover this much of it.
        val noticesHeightPx = noticesBounds.height
        assertTrue("The notices surface must have a measurable height: $noticesBounds", noticesHeightPx > 0f)

        // That surface owns every touch that lands on it, so the pane below sees none.
        val touches = recordSurfaceTouches(fixture)
        tapAt(noticesBounds.center)
        compose.runOnIdle {
            assertTrue("The notices surface owns its touches: $touches", touches.isEmpty())
        }

        // Debug off: no text, no dismiss control, and no touch region — the very same
        // point now reaches the terminal pane, so the hidden region consumes nothing.
        compose.runOnIdle { fixture.debugNotices = false }
        compose.waitForIdle()
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        compose.onAllNodesWithText("Dismiss").assertCountEquals(0)
        tapAt(noticesBounds.center)
        compose.runOnIdle {
            assertTrue("A hidden notices region must reserve no space and no touches: $touches",
                touches.contains(MotionEvent.ACTION_DOWN))
            touches.clear()
            assertEquals("Hiding notices must not move or resize the pane", pane, paneBounds(fixture))
            assertEquals(requests, fixture.viewports.size)
            assertEquals(grid, fixture.viewports.last())
            assertEquals("Presentation alone never saves a placement", 0, fixture.commits)
        }

        // Keys: no duplicate of the raw status, and the panel gets the band back.
        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("More keys").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        val headerHidden = boundsOf("Conversation A")
        // Deliberate baseline: expanding Keys is itself an intent. Toggling debug
        // visibility must add nothing to this list, rather than be judged against an
        // empty one.
        val intentBaseline = compose.runOnIdle { fixture.intents.toList() }
        assertEquals(1, intentBaseline.count { it.intent is ClientIntent.SetTerminalExtraKeysVisible })

        // Debug on again: the notices surface and the Keys copy both return, so the same
        // raw status is drawn twice, and the Keys band shrinks by the notices height.
        compose.runOnIdle { fixture.debugNotices = true }
        compose.waitForIdle()
        // Both copies must be counted before either is addressed: a single-node lookup
        // would fail on the duplicate.
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(2)
        compose.onNodeWithText("Dismiss").assertIsDisplayed()
        // The notices copy is the first matching node, the convention boundsOf uses.
        compose.onAllNodesWithText("Synthetic status notice").onFirst().assertIsDisplayed()
        val headerVisible = boundsOf("Conversation A")
        val reclaimed = headerVisible.top - headerHidden.top
        compose.runOnIdle {
            assertTrue("Hidden notices must not keep pushing Keys down: $headerHidden vs $headerVisible",
                reclaimed > 0f)
            assertTrue("Keys must get back the band the hidden notices surface reserved: $reclaimed vs $noticesHeightPx",
                reclaimed >= noticesHeightPx - 8f)
            assertEquals(pane, paneBounds(fixture))
            assertEquals(requests, fixture.viewports.size)
            assertEquals(grid, fixture.viewports.last())
            assertEquals("Presentation alone never saves a placement", 0, fixture.commits)
            assertEquals("Toggling debug visibility emits no intent", intentBaseline, fixture.intents)
            assertTrue("Toggling debug visibility submits nothing", fixture.keys.isEmpty() && fixture.pastes == 0)
        }
    }

    /** Real pointer injection at an absolute window point. */
    private fun tapAt(point: androidx.compose.ui.geometry.Offset) {
        val root = compose.onRoot()
        val origin = root.fetchSemanticsNode().boundsInWindow.topLeft
        root.performTouchInput { click(point - origin) }
    }

    private fun assertEveryKeyActionScrolls() {
        listOf("Ctrl", "Alt", "Shift", "Paste", "Fewer keys", "Esc", "Tab", "Shift+Tab",
            "Home", "End", "PgUp", "PgDn", "←", "↑", "↓", "→", "Ins", "Del",
            "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12")
            .forEach { label ->
                compose.onNodeWithText(label).performScrollTo().assertIsDisplayed()
                assertTouchTarget(label)
            }
    }

    private fun assertKeyTargetClearOfControls(label: String) {
        val key = compose.onNodeWithText(label).performScrollTo().assertIsDisplayed().fetchSemanticsNode()
        val keyTouchBounds = key.touchBoundsInRoot.translate(
            key.boundsInWindow.topLeft - key.boundsInRoot.topLeft,
        )
        val keyBounds = key.boundsInWindow
        val minimum = 48f * compose.activity.resources.displayMetrics.density
        assertTrue("$label must keep a complete 48dp target: $keyTouchBounds",
            keyTouchBounds.width >= minimum && keyTouchBounds.height >= minimum)
        val window = compose.activity.window.decorView
        assertTrue("$label must remain inside the visible window: $keyBounds",
            keyBounds.left >= 0f && keyBounds.top >= 0f &&
                keyBounds.right <= window.width.toFloat() && keyBounds.bottom <= window.height.toFloat())

        val controls = compose.onNodeWithText("Close keys").assertIsDisplayed().fetchSemanticsNode()
        val controlsBounds = controls.boundsInWindow
        assertFalse("$label must not be covered by the control strip: $keyBounds vs $controlsBounds",
            keyBounds.left < controlsBounds.right && keyBounds.right > controlsBounds.left &&
                keyBounds.top < controlsBounds.bottom && keyBounds.bottom > controlsBounds.top)
    }

    private fun assertTouchTarget(label: String) {
        val minimum = 48f * compose.activity.resources.displayMetrics.density
        val node = compose.onNodeWithText(label).assertExists().fetchSemanticsNode()
        assertTrue("$label keeps a real 48dp touch target: ${node.touchBoundsInRoot}",
            node.touchBoundsInRoot.width >= minimum && node.touchBoundsInRoot.height >= minimum)
    }

    private fun assertInvariant(
        fixture: Fixture,
        pane: AndroidRect,
        grid: Pair<Int, Int>,
        requests: Int,
        fontPx: Float,
        anchor: FrameCommitReceipt,
    ) {
        compose.runOnIdle {
            val surface = requireNotNull(fixture.surface)
            assertEquals("Overlay movement must not move or resize the pane", pane, paneBounds(fixture))
            assertEquals("Overlay movement must not request a reflow", requests, fixture.viewports.size)
            assertEquals(grid, fixture.viewports.last())
            assertEquals(fontPx, surface.textSizePx)
            assertTrue("Overlay movement keeps terminal focus", surface.hasFocus())
            assertTrue(surface.hasWindowFocus())
            assertTrue("Overlay movement grants no new proof", surface.verifyReceipt(anchor))
            assertEquals(anchor, surface.currentInputProof())
            assertTrue("Readiness stays as the real commit left it", fixture.terminal.inputReady)
        }
    }

    private fun awaitInput(fixture: Fixture): FrameCommitReceipt {
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

    private fun paneBounds(fixture: Fixture): AndroidRect {
        val surface = requireNotNull(fixture.surface)
        val location = IntArray(2).also(surface::getLocationInWindow)
        return AndroidRect(location[0], location[1], location[0] + surface.width, location[1] + surface.height)
    }

    /** First matching node is the notices copy; the Keys panel may show the same raw status. */
    private fun boundsOf(text: String): ComposeRect =
        compose.onAllNodesWithText(text).onFirst().fetchSemanticsNode().boundsInWindow

    /** Real pointer injection, so an overlapping overlay would intercept the tap. */
    private fun tapByTouch(label: String) {
        val node = compose.onNodeWithText(label).assertIsDisplayed().fetchSemanticsNode()
        val point = node.boundsInRoot.center
        val root = compose.onRoot()
        val origin = root.fetchSemanticsNode().boundsInRoot.topLeft
        root.performTouchInput { click(point - origin) }
    }

    /**
     * Real long-press-and-drag injection. A real timeout is allowed to elapse so the
     * long-press detector arms before movement; repeated moves cross the touch slop so
     * a child button's click is cancelled exactly once a drag is recognized.
     */
    private fun dragBy(label: String, dx: Float, dy: Float) {
        dispatchDrag(label, dx, dy, MotionEvent.ACTION_UP)
    }

    private fun cancelDragBy(label: String, dx: Float, dy: Float) {
        dispatchDrag(label, dx, dy, MotionEvent.ACTION_CANCEL)
    }

    private fun dispatchDrag(label: String, dx: Float, dy: Float, endAction: Int) {
        val center = compose.onAllNodesWithText(label).onFirst().fetchSemanticsNode().boundsInWindow.center
        val root = compose.activity.window.decorView
        val steps = 4
        val start = SystemClock.uptimeMillis()
        compose.runOnIdle {
            dispatchTouch(root, MotionEvent.ACTION_DOWN, start, start, center.x, center.y)
        }
        Thread.sleep(650L)
        for (step in 1..steps) {
            val eventTime = SystemClock.uptimeMillis()
            val x = center.x + dx * step / steps
            val y = center.y + dy * step / steps
            val action = if (step == steps) endAction else MotionEvent.ACTION_MOVE
            compose.runOnIdle { dispatchTouch(root, action, start, eventTime, x, y) }
        }
        compose.waitForIdle()
    }

    private fun dispatchTouch(
        root: android.view.View,
        action: Int,
        downTime: Long,
        eventTime: Long,
        x: Float,
        y: Float,
    ) {
        val event = MotionEvent.obtain(downTime, eventTime, action, x, y, 0)
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        try {
            root.dispatchTouchEvent(event)
        } finally {
            event.recycle()
        }
    }

    private fun rotateTo(requested: Int, expected: Int, fixture: Fixture) {
        val (previousView, needsRecreation) = compose.runOnIdle {
            fixture.surface to (compose.activity.resources.configuration.orientation != expected)
        }
        compose.activityRule.scenario.onActivity { it.requestedOrientation = requested }
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                compose.activity.resources.configuration.orientation == expected &&
                    (!needsRecreation || fixture.surface !== previousView) &&
                    fixture.surface?.isAttachedToWindow == true && fixture.surface?.hasWindowFocus() == true &&
                    fixture.surface?.hasFocus() == true
            }
        }
        awaitInput(fixture)
    }

    /** Test-local observer: records and swallows what actually reaches the View. */
    private fun recordSurfaceTouches(fixture: Fixture): MutableList<Int> {
        val touches = CopyOnWriteArrayList<Int>()
        compose.runOnIdle {
            requireNotNull(fixture.surface).setOnTouchListener { _, event -> touches += event.actionMasked; true }
        }
        return touches
    }

    private class Fixture {
        var terminal by mutableStateOf(NativeUiFixtures.terminal())
        var binding by mutableStateOf<TerminalViewBinding?>(NativeUiFixtures.binding(sourced = true))
        var placement by mutableStateOf(TerminalOverlayPlacement.DEFAULT)
        var warning by mutableStateOf<TerminalOverlayPlacementWarning?>(null)
        var placementReady by mutableStateOf(true)
        // The saved whole-app debug presentation. These placement checks depend on the
        // notice surface, so it starts enabled; one test flips it to cover the Off side.
        var debugNotices by mutableStateOf(true)
        var observedKeyboard by mutableStateOf(false)
        var commits = 0
        var surface: TerminalSurfaceView? = null
        val intents = CopyOnWriteArrayList<CapturedUiIntent>()
        val keys = CopyOnWriteArrayList<TerminalKeyRequest>()
        var pastes = 0
        var inputs = 0
        val viewports = CopyOnWriteArrayList<Pair<Int, Int>>()
        val receipts = CopyOnWriteArrayList<FrameCommitReceipt>()
        var lastRefusal: InputUnavailableReason? = null

        private val listener = object : TerminalSurfaceListener {
            override fun onViewportRequested(cols: Int, rows: Int) {
                viewports += cols to rows
                binding?.let { old ->
                    val next = NativeUiFixtures.binding(old.source != null, old.selectionGeneration,
                        cols, rows, old.geometry.revision + 1)
                    binding = next
                    surface?.setBinding(next)
                }
                terminal = terminal.copy(inputReady = false)
            }

            override fun onFrameCommitted(receipt: FrameCommitReceipt) {
                receipts += receipt
                terminal = terminal.copy(inputReady = surface?.verifyReceipt(receipt) == true)
            }

            override fun onInput(kind: NativeIoInputKind, bytes: ByteArray, receipt: FrameCommitReceipt) {
                inputs += 1
                Log.i("OverlayPlacementTest", "unexpected host input kind=$kind bytes=${bytes.size}")
            }

            override fun onInputUnavailable(reason: InputUnavailableReason) {
                lastRefusal = reason
            }
        }

        fun onIntent(intent: ClientIntent) {
            intents += CapturedUiIntent(intent, null, null)
            when (intent) {
                is ClientIntent.ToggleTerminalModifier ->
                    terminal = terminal.copy(modifiers = terminal.modifiers.toggled(intent.modifier))
                is ClientIntent.SetTerminalExtraKeysVisible ->
                    terminal = terminal.copy(extraKeysVisible = intent.visible)
                else -> Unit
            }
        }

        @Composable
        fun Content() {
            Box(Modifier.fillMaxSize()) {
                TerminalScreen(
                    terminal = terminal.copy(keyboardVisible = observedKeyboard),
                    terminalContent = {
                        TerminalSurface(binding, Modifier.fillMaxSize(), listener) { view ->
                            surface = view
                            view.post { view.requestFocus() }
                        }
                    },
                    onKey = { request -> keys += request },
                    onPaste = { pastes += 1 },
                    onIntent = ::onIntent,
                    status = "Synthetic status notice",
                    debugInputMessagingEnabled = debugNotices,
                    overlayPlacement = placement,
                    overlayPlacementWarning = warning,
                    overlayPlacementReady = placementReady,
                    onOverlayPlacementCommitted = { next ->
                        commits += 1
                        placement = next
                    },
                )
            }
        }
    }
}
