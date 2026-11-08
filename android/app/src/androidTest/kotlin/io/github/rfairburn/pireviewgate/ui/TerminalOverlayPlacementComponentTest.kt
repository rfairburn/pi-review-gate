package io.github.rfairburn.pireviewgate.ui

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Rect as AndroidRect
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewConfiguration
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect as ComposeRect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalControlKey
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalKeyRequest
import io.github.rfairburn.pireviewgate.core.client.ui.UiCoverage
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalKeysFloatingSize
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
 * Synthetic component checks for the dock-aware terminal layout: the controls strip, the
 * notice surface, and a floating Keys panel are independently placed overlays, while a
 * docked Keys band and a reported occluding keyboard inset are real pane reservations.
 *
 * No host, transport, identity, or owner result participates. The long-press drags and
 * the resize drag are real injected touches against the real Compose tree; the pane
 * proof and viewport facts come from the existing renderer's own public API. A real
 * platform on-screen keyboard is not simulated here at all: only the app's own docking
 * is exercised, so nothing in this file is evidence about real IME float or dock modes.
 */
@RunWith(AndroidJUnit4::class)
class TerminalOverlayPlacementComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun controlsAndStatusDragIndependentlyAndNeverMoveThePaneOrDockedKeys() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitInput(fixture)
        val dockRequests = compose.runOnIdle { fixture.viewports.size }
        val paneBeforeDock = compose.runOnIdle { paneBounds(fixture) }
        val touches = recordSurfaceTouches(fixture)
        val refusalBefore = fixture.lastRefusal

        compose.onNodeWithText("Keys").assertIsDisplayed().performClick()
        compose.onNodeWithText("Esc").assertExists()
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.viewports.size > dockRequests } }
        val docked = awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val grid = fixture.viewports.last()
        val requests = fixture.viewports.size
        val dockedFont = compose.runOnIdle { requireNotNull(fixture.surface).textSizePx }
        compose.runOnIdle {
            assertTrue("Docked Keys must reserve real pane area: $paneBeforeDock vs $pane",
                pane.bottom < paneBeforeDock.bottom)
        }

        val controlsBefore = boundsOf("Back")
        val statusBefore = boundsOf("Synthetic status notice")
        val keysBefore = boundsOf("Conversation A")

        dragBy("Switch", dx = -300f, dy = 0f)
        assertFalse("Controls strip moved", controlsBefore == boundsOf("Back"))
        assertEquals("Moving Controls must not drag Status", statusBefore, boundsOf("Synthetic status notice"))
        assertEquals("Moving Controls must not drag the docked Keys band", keysBefore, boundsOf("Conversation A"))
        assertNotNull(fixture.placement.controlsPortrait)
        assertNull(fixture.placement.statusPortrait)
        assertNull(fixture.placement.keysPortrait)
        assertEquals("Moving an overlay never changes docking", true, fixture.placement.keysPortraitLayout.docked)
        assertInvariant(fixture, pane, grid, requests, dockedFont, docked, "docked Keys")

        val controlsAfter = boundsOf("Back")
        dragBy("Synthetic status notice", dx = -90f, dy = 120f)
        assertEquals("Moving Status must not drag Controls", controlsAfter, boundsOf("Back"))
        assertEquals("Moving Status must not drag the docked Keys band", keysBefore, boundsOf("Conversation A"))
        assertFalse("Status notice moved", statusBefore == boundsOf("Synthetic status notice"))
        assertNotNull(fixture.placement.statusPortrait)
        assertNull(fixture.placement.keysPortrait)
        assertInvariant(fixture, pane, grid, requests, dockedFont, docked, "docked Keys")

        // Only a floating panel can move, so popping it out is the deliberate first step.
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.viewports.size > requests } }
        val undocked = awaitInput(fixture)
        val floatingPane = compose.runOnIdle { paneBounds(fixture) }
        val floatingKeysBefore = keysPanelBounds()
        val floatingGrid = compose.runOnIdle { fixture.viewports.last() }
        val floatingRequests = compose.runOnIdle { fixture.viewports.size }
        val floatingFont = compose.runOnIdle { requireNotNull(fixture.surface).textSizePx }
        compose.runOnIdle {
            assertEquals("Two completed moves plus pop-out save three times", 3, fixture.commits)
            assertEquals(false, fixture.placement.keysPortraitLayout.docked)
            assertEquals("Popping out must give the pane back the reserved area",
                paneBeforeDock, floatingPane)
        }
        compose.onNodeWithText("Esc").assertIsDisplayed()

        val controlsAfterStatus = boundsOf("Back")
        val statusAfter = boundsOf("Synthetic status notice")
        dragBy("Conversation A", dx = 0f, dy = -180f)
        assertEquals("Moving Keys must not drag Controls", controlsAfterStatus, boundsOf("Back"))
        assertEquals("Moving Keys must not drag Status", statusAfter, boundsOf("Synthetic status notice"))
        assertFalse("Floating Keys panel moved", floatingKeysBefore == keysPanelBounds())
        assertNotNull(fixture.placement.keysPortrait)
        assertInvariant(fixture, floatingPane, floatingGrid, floatingRequests, floatingFont, undocked, "floating Keys")

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

    @Test fun dockingControlIsIconOnlyInsideTheExistingFootprintAndChangesNothingElse() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val density = compose.activity.resources.displayMetrics.density
        val minimum = 48f * density

        compose.onNodeWithText("Keys").performClick()
        val docked = awaitInput(fixture)
        val dockedPanel = keysPanelBounds()
        val popOut = compose.onNodeWithContentDescription("Pop keys out")
            .assertIsDisplayed()
            .assertHasClickAction()
            .fetchSemanticsNode()
        assertTrue("Docking control keeps a real 48dp target: ${popOut.touchBoundsInRoot}",
            popOut.touchBoundsInRoot.width >= minimum && popOut.touchBoundsInRoot.height >= minimum)
        // The control lives inside the panel it belongs to: it adds no row and no height.
        assertTrue("Docking control must sit inside the Keys band: $popOut vs $dockedPanel",
            popOut.boundsInWindow.top >= dockedPanel.top - 1f &&
                popOut.boundsInWindow.bottom <= dockedPanel.bottom + 1f &&
                popOut.boundsInWindow.left >= dockedPanel.left - 1f &&
                popOut.boundsInWindow.right <= dockedPanel.right + 1f)
        val glyph = compose.onNodeWithContentDescription("Pop keys out", useUnmergedTree = true)
            .fetchSemanticsNode()
        assertEquals("The corner control is one fixed 24dp icon", 24f * density, glyph.boundsInRoot.width, 1f)
        assertEquals("The corner control is one fixed 24dp icon", 24f * density, glyph.boundsInRoot.height, 1f)
        // Icon only: no word was added anywhere for it.
        compose.onAllNodesWithText("Pop keys out").assertCountEquals(0)
        compose.onAllNodesWithText("Dock keys").assertCountEquals(0)

        compose.runOnIdle {
            assertEquals("Docking is not an IME or navigation action", 0,
                fixture.intents.count { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            assertTrue(fixture.keys.isEmpty() && fixture.pastes == 0)
            assertEquals(docked, fixture.surface?.currentInputProof())
            assertTrue("Presentation of the band never emits a navigation intent",
                fixture.intents.none { it.intent is ClientIntent.LeaveTerminal })
        }
    }

    @Test fun compactKeysPanelStillExposesEveryKeyActionModifierAndExpandedAccess() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val requestsBeforeDock = fixture.viewports.size
        val stablePane = compose.runOnIdle { paneBounds(fixture) }

        compose.onNodeWithText("Keys").performClick()
        // The docked band is a real reservation, so every content change to it goes
        // through the surface's own resize and a genuinely fresh commit.
        val docked = awaitInput(fixture)
        val dockedPane = compose.runOnIdle { paneBounds(fixture) }
        compose.runOnIdle {
            assertTrue("Opening docked Keys must reserve real pane area: $stablePane vs $dockedPane",
                dockedPane.bottom < stablePane.bottom)
            // A real reservation is a real reflow. The count is not pinned: the layout
            // measures the band it actually got, and what matters is that the pane's
            // new area is the one the returned commit was measured at.
            assertTrue("Opening docked Keys must request a real reflow: $requestsBeforeDock -> ${fixture.viewports.size}",
                fixture.viewports.size > requestsBeforeDock)
            assertEquals("The fresh commit is the grid the reserved pane measured",
                docked.frameCols to docked.frameRows, fixture.viewports.last())
            assertEquals("Opening keys must not emit any implicit IME intent",
                0, fixture.intents.count { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            assertEquals("Opening keys is not a completed drag or docking action", 0, fixture.commits)
            assertTrue(fixture.keys.isEmpty())
            assertTrue(fixture.surface!!.verifyReceipt(docked))
        }
        // The reservation is the band's own measured height, not a rule about the pane:
        // whatever the pane gave up is exactly what the band occupies.
        val dockedBand = keysPanelBounds()
        compose.runOnIdle {
            assertEquals("The pane gave up exactly the band's measured height: $stablePane vs $dockedPane vs $dockedBand",
                (stablePane.height() - dockedPane.height()).toFloat(), dockedBand.height, 2f)
        }
        listOf("Ctrl", "Paste", "Esc").forEach(::assertTouchTarget)
        listOf("Ctrl", "Alt", "Shift", "Paste", "More keys", "Esc", "Tab", "Shift+Tab",
            "Home", "End", "PgUp", "PgDn", "←", "↑", "↓", "→").forEach { label ->
            compose.onNodeWithText(label).assertExists()
        }
        compose.onNodeWithText("More keys").performClick()
        val expanded = awaitInput(fixture)
        val expandedPane = compose.runOnIdle { paneBounds(fixture) }
        compose.onNodeWithText("Fewer keys").assertExists()
        listOf("Ins", "Del", "F1", "F2", "F3", "F4", "F5", "F6",
            "F7", "F8", "F9", "F10", "F11", "F12").forEach { label ->
            compose.onNodeWithText(label).assertExists()
        }
        compose.onNodeWithText("F12").performScrollTo().assertIsDisplayed()
        assertTouchTarget("F12")
        compose.runOnIdle {
            // Added function-key rows make the band taller, and an uncapped band measures
            // that height, so expansion legitimately reserves more until the cap binds.
            assertEquals("Expanded keys must not move the pane's top or sides",
                Triple(dockedPane.left, dockedPane.top, dockedPane.right),
                Triple(expandedPane.left, expandedPane.top, expandedPane.right))
            assertTrue("Expansion may reserve more band height until capped: $dockedPane vs $expandedPane",
                expandedPane.bottom <= dockedPane.bottom)
            assertEquals("The fresh commit is the grid the expanded pane measured",
                expanded.frameCols to expanded.frameRows, fixture.viewports.last())
            assertTrue("Expansion is backed by the fresh real commit", fixture.surface!!.verifyReceipt(expanded))
            assertEquals("Expanding keys is not a placement save", 0, fixture.commits)
        }
        // The opening and expansion resizes are over: the awaited commit above is the one
        // the expanded pane measured. These anchors are taken after that genuine reflow, so
        // they constrain what follows — key actions inside an already reserved band — and
        // never the reservation itself.
        val expandedRequests = compose.runOnIdle { fixture.viewports.size }
        val expandedGrid = compose.runOnIdle { fixture.viewports.last() }
        val expandedFontPx = compose.runOnIdle { requireNotNull(fixture.surface).textSizePx }

        compose.onNodeWithText("Ctrl").performScrollTo().performClick()
        compose.onNodeWithText("↑").performScrollTo().performClick()
        listOf("Ins", "Del", "F1", "F12").forEach { compose.onNodeWithText(it).assertExists() }
        compose.runOnIdle {
            assertEquals(1, fixture.keys.size)
            assertTrue(fixture.keys.single().modifiers.ctrl)
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            assertEquals("Key actions must not move the expanded pane", expandedPane, paneBounds(fixture))
            assertEquals("Key actions in the expanded band must not request another reflow",
                expandedRequests, fixture.viewports.size)
            assertEquals("Key actions in the expanded band must not change the committed grid",
                expandedGrid, fixture.viewports.last())
            assertEquals("Key actions in the expanded band must not change the measured font",
                expandedFontPx, requireNotNull(fixture.surface).textSizePx, 0f)
            assertTrue("The expansion's commit still stands after a key action",
                fixture.surface!!.verifyReceipt(expanded))
            assertEquals("A key action grants no new proof", expanded,
                requireNotNull(fixture.surface).currentInputProof())
        }
        compose.onNodeWithText("Fewer keys").performScrollTo().performClick()
        compose.onNodeWithText("F12").assertDoesNotExist()
        // Collapsing gives back exactly the reservation the compact band measured.
        compose.waitUntil(10_000) { compose.runOnIdle { paneBounds(fixture) } == dockedPane }
        awaitInput(fixture)
        compose.runOnIdle { assertEquals(dockedPane, paneBounds(fixture)) }
    }

    @Test fun popOutAndPopInChangeOnlyDockingAndPreserveTheRememberedPositionAndSize() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val stablePane = compose.runOnIdle { paneBounds(fixture) }
        compose.onNodeWithText("Keys").performClick()
        val docked = awaitInput(fixture)
        val dockedPane = compose.runOnIdle { paneBounds(fixture) }
        assertTrue("Docked Keys reserves real area", dockedPane.bottom < stablePane.bottom)

        compose.onNodeWithContentDescription("Pop keys out").performClick()
        val floating = awaitInput(fixture)
        val floatingPane = compose.runOnIdle { paneBounds(fixture) }
        compose.runOnIdle {
            assertEquals("Pop out is the only save so far", 1, fixture.commits)
            assertEquals(false, fixture.placement.keysPortraitLayout.docked)
            assertEquals("A floating panel reserves nothing", stablePane, floatingPane)
        }
        compose.onNodeWithText("Esc").assertIsDisplayed()
        assertTrue("A floating panel keeps terminal focus", fixture.surface!!.hasFocus())

        // A completed move and a completed resize are both remembered. A floating panel
        // never shrinks below its own logical footprint, so the frame is first grown and
        // the measured resize then takes a genuinely non-uniform bite out of that
        // enlarged frame: narrower and taller at the same time.
        dragBy("Conversation A", dx = -60f, dy = -120f)
        resizeKeysPanel(dx = 150f, dy = 150f)
        val moved = keysPanelBounds()
        resizeKeysPanel(dx = -120f, dy = 120f)
        val resized = keysPanelBounds()
        compose.runOnIdle {
            assertEquals("The pop-out, the completed move, and two completed resizes are four saves",
                4, fixture.commits)
            assertNotNull(fixture.placement.keysPortrait)
            assertNotNull(fixture.placement.keysPortraitLayout.floatingSize)
        }
        assertTrue("The resize changed the panel: $moved vs $resized",
            resized.width < moved.width - 20f && resized.height > moved.height + 20f)
        compose.runOnIdle {
            assertEquals("A floating move or resize never reflows the pane",
                floatingPane, paneBounds(fixture))
            assertEquals(floating, fixture.surface?.currentInputProof())
        }

        compose.onNodeWithContentDescription("Dock keys").performClick()
        val dockedAgain = awaitInput(fixture)
        val dockedAgainPane = compose.runOnIdle { paneBounds(fixture) }
        compose.runOnIdle {
            assertEquals("Pop in is a docking save", 5, fixture.commits)
            assertEquals(true, fixture.placement.keysPortraitLayout.docked)
            assertNotNull("Pop in must not clear the remembered position", fixture.placement.keysPortrait)
            assertNotNull("Pop in must not clear the remembered size",
                fixture.placement.keysPortraitLayout.floatingSize)
            assertEquals("Pop in restores the reservation", dockedPane, dockedAgainPane)
            assertTrue(fixture.surface!!.verifyReceipt(dockedAgain))
        }
        compose.onNodeWithText("Esc").assertIsDisplayed()

        // Popping back out returns the same floating placement, not a fresh default.
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        compose.waitForIdle()
        val restored = keysPanelBounds()
        compose.runOnIdle {
            assertEquals(6, fixture.commits)
            assertEquals("Position and size survive docking", resized.left, restored.left, 2f)
            assertEquals(resized.top, restored.top, 2f)
            assertEquals(resized.width, restored.width, 2f)
            assertEquals(resized.height, restored.height, 2f)
        }
        compose.onNodeWithText("Close keys").performClick()
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
        compose.waitUntil(10_000) { compose.runOnIdle { paneBounds(fixture) == stablePane } }
        awaitInput(fixture)
    }

    @Test fun floatingMoveAndResizeNeverReflowThePaneWhileDockingDoes() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val stablePane = compose.runOnIdle { paneBounds(fixture) }
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val requests = fixture.viewports.size
        val anchor = compose.runOnIdle { requireNotNull(fixture.surface?.currentInputProof()) }
        val touches = recordSurfaceTouches(fixture)

        resizeKeysPanel(dx = 60f, dy = 80f)
        dragBy("Conversation A", dx = 40f, dy = 40f)
        compose.runOnIdle {
            assertEquals("Floating gestures never ask for a new grid", requests, fixture.viewports.size)
            assertEquals(pane, paneBounds(fixture))
            assertTrue("A floating panel grants no new proof", fixture.surface!!.verifyReceipt(anchor))
            assertEquals(anchor, fixture.surface!!.currentInputProof())
            assertTrue("Floating gestures never reach the terminal: $touches", touches.isEmpty())
            assertTrue(fixture.keys.isEmpty() && fixture.pastes == 0)
            assertTrue(fixture.intents.isEmpty())
        }

        compose.onNodeWithContentDescription("Dock keys").performClick()
        val reflowed = awaitInput(fixture)
        compose.runOnIdle {
            assertTrue("Docking is a real reservation, so it reflows",
                fixture.viewports.size > requests)
            assertTrue(paneBounds(fixture).bottom < pane.bottom)
            assertNotEquals(anchor, reflowed)
        }
        // And the pane is still the same stable area it had before the panel ever opened.
        compose.onNodeWithText("Close keys").performClick()
        compose.waitUntil(10_000) { compose.runOnIdle { paneBounds(fixture) == stablePane } }
    }

    @Test fun cancelledResizeNeverSavesAndRestoresTheRememberedSize() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        resizeKeysPanel(dx = 80f, dy = 80f)
        val saved = keysPanelBounds()
        val placementBeforeCancel = compose.runOnIdle { fixture.placement }

        cancelResizeKeysPanel(dx = -120f, dy = -120f)

        // Semantics are read on the instrumentation thread: fetchSemanticsNode must never
        // run inside runOnIdle. Only View and fixture facts are read inside the block.
        val restored = keysPanelBounds()
        val placementAfterCancel = compose.runOnIdle { fixture.placement }
        compose.runOnIdle {
            assertEquals("A cancelled resize is not a completed resize", 2, fixture.commits)
            assertEquals(placementBeforeCancel, placementAfterCancel)
            assertEquals("A cancelled resize restores the panel", saved, restored)
            assertEquals(pane, paneBounds(fixture))
        }
    }

    /**
     * The first pop-out of a panel that has never been placed or resized. It must be a
     * window the operator can actually pick up: detached from the bottom edge with free
     * space beside it rather than full-width and bottom-anchored where the docked band was,
     * and moved by the same header long-press that moves the Back/Switch/Keyboard/Keys
     * strip. Both the pop-out and the move are real injected touches. Only that panel
     * moves. Handing the docked reservation back is itself a real reflow with a genuinely
     * new proof, so the invariance the move must not disturb is measured from the settled
     * floating state, not from the docked one it already replaced: the pane keeps the area,
     * grid, measured font, and proof it settled on, the completed drag is the only further
     * save, and neither gesture invents a size the user never resized.
     */
    @Test fun firstPopOutIsDetachedAndMovesByItsOwnHeaderLongPress() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val stablePane = compose.runOnIdle { paneBounds(fixture) }
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        val dockedPane = compose.runOnIdle { paneBounds(fixture) }
        val dockedRequests = compose.runOnIdle { fixture.viewports.size }
        val dockedProof = compose.runOnIdle { requireNotNull(fixture.surface?.currentInputProof()) }
        val touches = recordSurfaceTouches(fixture)
        compose.runOnIdle {
            assertNull("Nothing has been placed yet", fixture.placement.keysPortrait)
            assertNull("Nothing has been resized yet", fixture.placement.keysPortraitLayout.floatingSize)
        }

        // The initial corner pop-out is a real injected touch, not a synthesized click.
        tapControlByTouch("Pop keys out")
        compose.runOnIdle {
            assertEquals("Pop out changes docking only", 1, fixture.commits)
            assertEquals(false, fixture.placement.keysPortraitLayout.docked)
            assertNull("A pop-out invents no remembered position", fixture.placement.keysPortrait)
            assertNull("A pop-out invents no remembered size", fixture.placement.keysPortraitLayout.floatingSize)
            assertTrue("The initial corner pop-out is a real touch and never reaches the " +
                "terminal: $touches", touches.isEmpty())
        }
        // Popping out hands the docked reservation back to the pane, which is a real resize
        // with a genuinely new proof. The pop-out is over once the pane is back to the area
        // it had before Keys ever opened and a newer proof has been committed; that settled
        // floating state is the baseline the move must not disturb.
        compose.waitUntil(10_000) {
            val observed = compose.runOnIdle {
                paneBounds(fixture) to fixture.surface?.currentInputProof()?.commitSequence
            }
            observed.first == stablePane && (observed.second ?: 0L) > dockedProof.commitSequence
        }
        val released = awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val requests = compose.runOnIdle { fixture.viewports.size }
        val grid = compose.runOnIdle { fixture.viewports.last() }
        val fontPx = compose.runOnIdle { requireNotNull(fixture.surface).textSizePx }
        val frame = floatingKeysFrameBounds()
        val density = compose.activity.resources.displayMetrics.density
        val controlsBefore = boundsOf("Back")
        val statusBefore = boundsOf("Synthetic status notice")
        compose.runOnIdle {
            assertTrue("Popping out releases the docked reservation, and that is a real " +
                "reflow: $dockedPane vs $pane, $dockedRequests requests vs $requests",
                dockedPane.bottom < pane.bottom && requests > dockedRequests)
            assertEquals("A floating panel reserves nothing", stablePane, pane)
            assertTrue("The released reservation produced a genuinely new proof: " +
                "${dockedProof.commitSequence} vs ${released.commitSequence}",
                released.commitSequence > dockedProof.commitSequence)
        }
        // Detached rather than bottom-anchored, and genuinely narrower than the pane with
        // free space on both sides: room to move, not a second full-width band.
        assertTrue("A never-placed panel must be detached from the bottom edge: $frame vs $pane",
            pane.bottom - frame.bottom >= 48f * density)
        assertTrue("A never-placed panel must be narrower than the pane it floats over: " +
            "$frame vs $pane", frame.width < pane.width() * 0.95f)
        assertTrue("A never-placed panel must leave free space on both sides: $frame vs $pane",
            frame.left > pane.left.toFloat() && frame.right < pane.right.toFloat())

        // The existing header long-press is the move handle, driven by a real injected
        // touch — the same interaction that moves the control strip.
        dragBy("Conversation A", dx = 0f, dy = -120f)
        val moved = floatingKeysFrameBounds()
        compose.runOnIdle {
            assertTrue("The header long-press must actually move the detached panel: " +
                "$frame vs $moved", moved.top < frame.top - 20f)
            assertEquals("Moving Keys must not drag Controls", controlsBefore, boundsOf("Back"))
            assertEquals("Moving Keys must not drag Status", statusBefore, boundsOf("Synthetic status notice"))
            assertEquals("A floating move never reflows the pane", pane, paneBounds(fixture))
            assertEquals("A floating move never asks for a new grid", requests, fixture.viewports.size)
            assertEquals(grid, fixture.viewports.last())
            assertEquals("A floating move never changes the measured font", fontPx,
                requireNotNull(fixture.surface).textSizePx, 0f)
            assertEquals("A completed move is the only save after the pop-out", 2, fixture.commits)
            assertNotNull("The move is numeric placement data", fixture.placement.keysPortrait)
            assertNull("A move never invents a floating size",
                fixture.placement.keysPortraitLayout.floatingSize)
            assertEquals(released, fixture.surface?.currentInputProof())
            assertTrue(fixture.surface!!.verifyReceipt(released))
            assertTrue("A floating move never reaches the terminal surface: $touches", touches.isEmpty())
            assertTrue(fixture.keys.isEmpty() && fixture.pastes == 0)
            assertTrue(fixture.intents.isEmpty())
        }
    }

    /**
     * One logical Keys layout, stretched by independent horizontal and vertical factors.
     * Every key's rectangle and size, normalized into the panel's own frame, must be
     * identical before and after a deliberately non-uniform resize: nothing re-wraps into
     * another row, each key grows by its own axis's factor, and the contents still tile the
     * frame edge to edge instead of letterboxing inside it. The pane never reflows. Then a
     * real injected touch on that scaled panel reaches the key it names, exactly once, and
     * never the terminal underneath.
     */
    @Test fun nonUniformResizeScalesOneLogicalLayoutAndScaledTouchesStillLand() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        awaitInput(fixture)
        compose.onNodeWithText("More keys").performClick()
        awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val requests = compose.runOnIdle { fixture.viewports.size }
        val anchor = compose.runOnIdle { requireNotNull(fixture.surface?.currentInputProof()) }
        val touches = recordSurfaceTouches(fixture)

        val labels = listOf("Ctrl", "Alt", "Shift", "Paste", "Fewer keys", "Esc", "Tab",
            "Shift+Tab", "Home", "End", "PgUp", "PgDn", "←", "↑", "↓", "→", "Ins", "Del",
            "F1", "F6", "F12")
        // Every key plus both interior corner controls — the docking toggle and the real 48dp
        // grip container — because they belong to the same scaled layout and must scale with
        // it exactly as the keys do.
        val probes = linkedMapOf<String, () -> ComposeRect>()
        labels.forEach { label -> probes[label] = { controlNode(label).boundsInWindow } }
        probes["docking control"] = { controlNode("Dock keys").boundsInWindow }
        probes["resize grip container"] = { gripContainer().boundsInWindow }
        val beforeFrame = floatingKeysFrameBounds()
        val before = probes.mapValues { (_, read) -> normalizedRect(read(), beforeFrame) }
        val beforeAbsolute = probes.mapValues { (_, read) -> read() }
        val beforeRows = keyRows(labels)

        // A deliberately non-uniform frame: widen it by half the free space and lengthen it
        // by a fixed amount, so the two axes move by clearly different factors.
        resizeKeysPanel(
            dx = ((pane.width() - beforeFrame.width) / 2f).coerceAtMost(200f),
            dy = ((pane.height() - beforeFrame.height) / 2f).coerceAtMost(300f),
        )

        val afterFrame = floatingKeysFrameBounds()
        val widthFactor = afterFrame.width / beforeFrame.width
        val heightFactor = afterFrame.height / beforeFrame.height
        assertTrue("The frame must grow on both axes: $beforeFrame vs $afterFrame",
            widthFactor > 1.02f && heightFactor > 1.02f)
        assertTrue("The resize must be non-uniform: width x$widthFactor vs height x$heightFactor",
            kotlin.math.abs(widthFactor - heightFactor) > 0.05f)
        val after = probes.mapValues { (_, read) -> normalizedRect(read(), afterFrame) }
        probes.keys.forEach { name ->
            assertEquals("$name must hold its normalized position and size across a " +
                "non-uniform resize: ${before.getValue(name)} vs ${after.getValue(name)}",
                0f, before.getValue(name).maximumDeviation(after.getValue(name)), 0.02f)
            val absolute = probes.getValue(name).invoke()
            assertEquals("$name must scale by the frame's own horizontal factor",
                widthFactor, absolute.width / beforeAbsolute.getValue(name).width, 0.05f)
            assertEquals("$name must scale by the frame's own vertical factor",
                heightFactor, absolute.height / beforeAbsolute.getValue(name).height, 0.05f)
        }
        assertEquals("A non-uniform resize must not re-wrap a single key into another row",
            beforeRows, keyRows(labels))
        // Filled rather than letterboxed: the scrollable viewport spans the grown frame's
        // whole width, and the viewport plus the grip's own band tile its whole height.
        val viewport = keysPanelBounds()
        val grip = gripContainer().boundsInWindow
        assertEquals("The scaled viewport must span the frame's whole width: $viewport vs $afterFrame",
            afterFrame.width, viewport.width, 1f)
        assertEquals("The scaled viewport and grip band must tile the frame's height: " +
            "$viewport vs $grip vs $afterFrame", afterFrame.height, viewport.height + grip.height, 2f)
        compose.runOnIdle {
            assertEquals("Only the pop-out and the completed resize save", 2, fixture.commits)
            assertEquals("A non-uniform resize never reflows the pane", pane, paneBounds(fixture))
            assertEquals("A non-uniform resize never asks for a new grid", requests, fixture.viewports.size)
            assertEquals(anchor, fixture.surface?.currentInputProof())
        }

        // A real injected touch on the scaled panel must land on the key it names, at its
        // scaled position, and must not leak through to the terminal.
        compose.onNodeWithText("PgDn").performScrollTo().assertIsDisplayed()
        tapByTouch("PgDn")
        compose.runOnIdle {
            assertEquals(listOf(TerminalControlKey.PAGE_DOWN), fixture.keys.map { it.key })
            assertEquals("A scaled Keys touch never reaches the terminal surface", 0, fixture.inputs)
            assertEquals("A scaled Keys tap grants no new proof", anchor,
                requireNotNull(fixture.surface).currentInputProof())
            assertTrue("No touch landed on the terminal: $touches", touches.isEmpty())
        }
    }

    /**
     * A scaled panel's own detectors report pointer deltas in the layout's logical units, so
     * both gestures have to be converted back through the same factors. Measured on a panel
     * held at a clearly non-unit scale — the scale is read off how much a key button grew,
     * never assumed — a physical header drag moves the panel by the pointer's own travel and
     * a physical grip drag changes the frame by the pointer's own travel, in each axis,
     * rather than by a magnified or shrunken transformation of it. The vertical axis is the
     * magnification-sensitive one on a phone-width panel: a floating frame cannot grow much
     * wider than the pane, so its factor there stays close to one.
     */
    @Test fun moveAndResizeGesturesTrackThePointerUnderNonUnitScale() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val unscaled = floatingKeysFrameBounds()
        val unscaledKey = controlNode("Esc").boundsInWindow

        // Grow the frame by half the free space on each axis, so both factors are clearly
        // above one on any phone while the grip stays inside the window.
        resizeKeysPanel(
            dx = ((pane.width() - unscaled.width) / 2f).coerceAtMost(200f),
            dy = ((pane.height() - unscaled.height) / 2f).coerceAtMost(420f),
        )
        val scaled = floatingKeysFrameBounds()
        val scaledKey = controlNode("Esc").boundsInWindow
        val scaleX = scaledKey.width / unscaledKey.width
        val scaleY = scaledKey.height / unscaledKey.height
        assertTrue("The panel must be held at a non-unit scale: x$scaleX, y$scaleY",
            scaleY > 1.2f && scaleX >= 1f)
        // Every injected move now carries its share of the requested travel, so the only
        // travel a panel cannot apply is what its own detector consumes before it arms.
        // That is accounted for, not widened: the header's long-press move never applies
        // the whole steps before its accumulated physical distance passes the platform
        // slop, and the grip's detector consumes exactly one slop of the path in the
        // layout's own logical units. Both start from the genuine ViewConfiguration value
        // Compose reads and from scale factors measured off this panel, and the residual
        // left is only the permille round trip a completed gesture is committed through.
        val slopPx = touchSlopPx()
        val roundingPx = commitRoundingPx()
        val moveSteps = 8
        // Half the free space was just taken by the grow, so a third of it keeps every
        // gesture clear of the clamp to the visible extent. Each travel is floored to whole
        // steps so every injected move is an exact pixel delta: the overlay applies each
        // event's delta rounded to a pixel, and whole steps keep that application from
        // accumulating rounding of its own.
        val moveX = kotlin.math.floor(((pane.width() - scaled.width) / 3f).coerceAtMost(60f) / moveSteps) * moveSteps
        val moveY = kotlin.math.floor(((pane.height() - scaled.height) / 3f).coerceAtMost(220f) / moveSteps) * moveSteps
        val headerLoss = headerArmingLossPx(Offset(moveX, moveY), moveSteps, slopPx)

        val beforeMove = floatingKeysFrameBounds()
        dragBy("Conversation A", dx = moveX, dy = moveY, steps = moveSteps)
        val afterMove = floatingKeysFrameBounds()
        assertTrue("A header drag must move a scaled panel by its own vertical travel less " +
            "what its detector consumes before arming ($beforeMove vs $afterMove, travel " +
            "$moveY, arming loss ${headerLoss.y}, slop $slopPx)",
            kotlin.math.abs((afterMove.top - beforeMove.top) - (moveY - headerLoss.y)) <= roundingPx)
        assertTrue("A header drag must move a scaled panel by its own horizontal travel less " +
            "what its detector consumes before arming ($beforeMove vs $afterMove, travel " +
            "$moveX, arming loss ${headerLoss.x}, slop $slopPx)",
            kotlin.math.abs((afterMove.left - beforeMove.left) - (moveX - headerLoss.x)) <= roundingPx)
        assertEquals("A move must not resize the scaled frame", scaled.width, afterMove.width, 2f)
        assertEquals("A move must not resize the scaled frame", scaled.height, afterMove.height, 2f)
        compose.runOnIdle {
            assertEquals("The pop-out, the grow, and the completed move are three saves",
                3, fixture.commits)
            assertNotNull(fixture.placement.keysPortrait)
        }

        // The grip sits inside the same scaled layout, so its deltas arrive scaled too:
        // shrinking the grown frame must still track the pointer, axis by axis. The slop
        // that detector arms on is measured in the layout's units, so the scale that turns
        // it into physical travel is read off the panel again here — the factors in force
        // when the gesture arms — rather than reused from the grow above.
        val shrinkX = ((scaled.width - unscaled.width) / 2f).coerceAtMost(120f)
        val shrinkY = ((scaled.height - unscaled.height) / 2f).coerceAtMost(240f)
        val keyBeforeShrink = controlNode("Esc").boundsInWindow
        val shrinkScaleX = keyBeforeShrink.width / unscaledKey.width
        val shrinkScaleY = keyBeforeShrink.height / unscaledKey.height
        val shrinkTravel = Offset(-shrinkX, -shrinkY)
        val gripLoss = gripArmingLossPx(shrinkTravel, shrinkScaleX, shrinkScaleY, slopPx)
        val beforeResize = floatingKeysFrameBounds()
        resizeKeysPanel(dx = -shrinkX, dy = -shrinkY, steps = 12)
        val afterResize = floatingKeysFrameBounds()
        assertTrue("The resize must actually shrink the grown frame: $beforeResize vs $afterResize",
            afterResize.height < beforeResize.height - 20f)
        assertTrue("A grip drag must change the frame by its own vertical travel less the " +
            "logical slop its detector consumes ($beforeResize vs $afterResize, travel " +
            "$shrinkY, arming loss ${-gripLoss.y} at scale x$shrinkScaleX/y$shrinkScaleY, " +
            "slop $slopPx)",
            kotlin.math.abs((afterResize.height - beforeResize.height) -
                (shrinkTravel.y - gripLoss.y)) <= roundingPx)
        assertTrue("A grip drag must change the frame by its own horizontal travel less the " +
            "logical slop its detector consumes ($beforeResize vs $afterResize, travel " +
            "$shrinkX, arming loss ${-gripLoss.x} at scale x$shrinkScaleX/y$shrinkScaleY, " +
            "slop $slopPx)",
            kotlin.math.abs((afterResize.width - beforeResize.width) -
                (shrinkTravel.x - gripLoss.x)) <= roundingPx)
        compose.runOnIdle {
            assertEquals("The completed resize is the only new save", 4, fixture.commits)
            assertNotNull(fixture.placement.keysPortraitLayout.floatingSize)
            assertTrue(fixture.keys.isEmpty() && fixture.pastes == 0)
        }
    }

    /**
     * A corner-grip drag delivered as twenty real motion events. The panel must follow the
     * pointer's total movement: an implementation that applied each per-event delta to the
     * size the gesture started from would move it by roughly one step instead, and the
     * saved size would depend on how often the platform happened to deliver a move.
     */
    @Test fun completedResizeAppliesTheDraggedTotalAcrossManyEvents() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        // A floating panel stops shrinking at its own logical footprint, which is the frame
        // a never-resized panel shows, so the frame is grown first and the measured drag
        // then takes a proportional bite out of that growth: only there does the travel have
        // a shrink to apply rather than a clamp.
        val footprint = floatingKeysFrameBounds()
        val footprintKey = controlNode("Esc").boundsInWindow
        resizeKeysPanel(dx = 200f, dy = 260f)
        val before = floatingKeysFrameBounds()
        val beforeKey = controlNode("Esc").boundsInWindow
        val shrinkX = ((before.width - footprint.width) * 0.6f).coerceAtMost(150f)
        val shrinkY = ((before.height - footprint.height) * 0.6f).coerceAtMost(200f)

        // The slop the 20-event detector consumes before it arms is measured in the grown
        // panel's own logical units, so its physical cost is taken from the scale factors
        // read off this panel rather than assumed. What is left after that accounting is
        // only the permille round trip the finished size is committed through.
        val slopPx = touchSlopPx()
        val roundingPx = commitRoundingPx()
        val travel = Offset(-shrinkX, -shrinkY)
        val loss = gripArmingLossPx(
            travel,
            beforeKey.width / footprintKey.width,
            beforeKey.height / footprintKey.height,
            slopPx,
        )

        resizeKeysPanel(dx = -shrinkX, dy = -shrinkY, steps = 20)

        val after = floatingKeysFrameBounds()
        assertTrue("The measured drag must actually shrink the grown frame: $before vs $after",
            after.width < before.width - 20f && after.height < before.height - 20f)
        val widthDelta = before.width - after.width
        val heightDelta = before.height - after.height
        assertTrue("A 20-event resize must apply its horizontal travel less the slop its " +
            "detector consumes ($before vs $after, travel $shrinkX, arming loss ${-loss.x}, " +
            "slop $slopPx)",
            kotlin.math.abs(widthDelta - (shrinkX + loss.x)) <= roundingPx)
        assertTrue("A 20-event resize must apply its vertical travel less the slop its " +
            "detector consumes ($before vs $after, travel $shrinkY, arming loss ${-loss.y}, " +
            "slop $slopPx)",
            kotlin.math.abs(heightDelta - (shrinkY + loss.y)) <= roundingPx)
        compose.runOnIdle {
            assertEquals("The grow and the completed drag are two saves", 3, fixture.commits)
            assertNotNull(fixture.placement.keysPortraitLayout.floatingSize)
            assertEquals("A floating resize never reflows the pane", pane, paneBounds(fixture))
        }
    }

    /**
     * A deliberately short host is how this suite produces a reduced visible extent without
     * pretending to a real platform IME. A floating Keys panel that was never resized lays
     * its one logical layout out at the extent the pane actually leaves, so it never
     * measures past that extent and its contents still fill the frame it was given: the
     * scrollable viewport and the grip's own reserved band tile the frame from edge to edge
     * instead of leaving a blank strip, and what does not fit stays scroll-reachable inside
     * it. Adapting to the reduced extent is display-only: the remembered floating size
     * stays absent and nothing is saved.
     */
    @Test fun neverResizedFloatingKeysFillTheVisibleExtentAndNeverSaveAnAdaptedSize() {
        val fixture = Fixture()
        compose.setContent { Box(Modifier.fillMaxWidth().height(200.dp)) { fixture.Content() } }
        awaitInput(fixture)
        val fullPane = compose.runOnIdle { paneBounds(fixture) }
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        val dockedPane = compose.runOnIdle { paneBounds(fixture) }
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        awaitInput(fixture)
        val visible = compose.runOnIdle { paneBounds(fixture) }

        val frame = floatingKeysFrameBounds()
        val viewport = keysPanelBounds()
        val grip = gripContainer().boundsInWindow
        // The reduced extent has to bind for anything below to be evidence, and it is
        // measured rather than assumed: a panel fitted to a 200dp host cannot be taller
        // than it, and the scroll below proves content really sits past that viewport.
        assertTrue("A never-resized panel must not measure past the visible extent: $frame vs $visible",
            frame.height <= visible.height() + 1f && frame.bottom <= visible.bottom + 1f)
        assertTrue("A never-resized panel stays inside the visible width: $frame vs $visible",
            frame.right <= visible.right + 1f && frame.left >= visible.left - 1f)
        // Filled, not letterboxed: the scrollable viewport and the grip's own band tile the
        // frame's whole height, and the grip sits on the frame's own bottom edge.
        assertEquals("The viewport and the grip band must tile the frame's height: " +
            "$viewport vs $grip vs $frame", frame.height, viewport.height + grip.height, 2f)
        assertEquals("The grip sits on the frame's bottom edge: $grip vs $frame",
            frame.bottom, grip.bottom, 1f)
        assertEquals("The frame and its viewport share one leading edge: $frame vs $viewport",
            frame.left, viewport.left, 1f)
        // The content is taller than the extent it was fitted to, so its own scroll is what
        // keeps the rest reachable inside that frame — measured, not assumed.
        val headerBeforeCapScroll = boundsOf("Conversation A")
        keysPanelScrollNode().performTouchInput { swipeUp() }
        compose.waitForIdle()
        val headerAfterCapScroll = boundsOf("Conversation A")
        assertTrue("A panel taller than the extent it was fitted to must scroll inside it: " +
            "$headerBeforeCapScroll vs $headerAfterCapScroll",
            headerAfterCapScroll.bottom < headerBeforeCapScroll.bottom)
        // Fitted is not truncated: what the extent hides stays scroll-reachable inside it
        // with a complete target, rather than sitting behind it.
        compose.onNodeWithText("→").performScrollTo().assertIsDisplayed()
        assertTouchTarget("→")
        compose.onNodeWithText("Paste").performScrollTo().assertIsDisplayed()
        assertTouchTarget("Paste")
        compose.runOnIdle {
            assertTrue("Docking reserved, and popping out returned it: $fullPane vs $dockedPane vs $visible",
                dockedPane.bottom < fullPane.bottom && visible == fullPane)
            assertNull("Fitting the visible extent never writes a floating size",
                fixture.placement.keysPortraitLayout.floatingSize)
            assertEquals("Only the deliberate pop-out saves; adapting to the reduced extent saves nothing",
                1, fixture.commits)
        }
    }

    /**
     * The resize grip belongs to the floating panel's one scaled layout, so it keeps its
     * corner and its reserved band at any frame size: on a grown, scaled panel the grip
     * still sits below the scrollable viewport, covers no key, and every key and interior
     * control keeps a complete 48dp physical target — measured on the scaled panel, not
     * asserted from a constant. A real injected tap still reaches its key and never the
     * terminal underneath. A grown frame on a full host never has to scroll, so the other
     * half of "at any scroll position" — that a panel taller than the extent it was fitted
     * to genuinely has to scroll, and keeps the same clearance once it does — is witnessed
     * on a measured short host in
     * [shortHostFloatingKeysScrollsForRealAndItsDockingControlGoesWithTheHeader].
     */
    @Test fun floatingGripKeepsItsCornerAndEveryKeyTargetStaysClearOfIt() {
        val fixture = Fixture()
        // Every step is tagged with the existing placementPhase observer, so a replay names
        // the last phase reached and dumps the main and test stacks through that observer's
        // existing 10s observation. The wrapper adds no deadline, changes no idleness wait,
        // and tolerates nothing: the gestures, waits, and assertions below are unchanged.
        placementPhase("grip-setup") {
            compose.setContent { fixture.Content() }
            awaitInput(fixture)
        }
        placementPhase("grip-open-keys") {
            compose.onNodeWithText("Keys").performClick()
            awaitInput(fixture)
        }
        placementPhase("grip-pop-out") {
            compose.onNodeWithContentDescription("Pop keys out").performClick()
            awaitInput(fixture)
        }
        placementPhase("grip-more-keys") {
            compose.onNodeWithText("More keys").performClick()
            awaitInput(fixture)
        }
        // A grown frame is the honest case: grip and keys scale together, so what follows
        // is measured on a scaled panel rather than only on a scale-1 one.
        placementPhase("grip-resize") {
            resizeKeysPanel(dx = 150f, dy = 150f)
        }

        placementPhase("grip-measure") {
            val frame = floatingKeysFrameBounds()
            val viewport = keysPanelBounds()
            val grip = gripContainer().boundsInWindow
            assertTrue("The grip occupies its own band below the scrollable viewport: $grip vs $viewport",
                grip.top >= viewport.bottom - 1f)
            assertEquals("A scaled panel's viewport and grip band still tile its frame: " +
                "$viewport vs $grip vs $frame", frame.height, viewport.height + grip.height, 2f)
            listOf("Esc", "→", "F12").forEach { label ->
                val key = compose.onNodeWithText(label).performScrollTo().assertIsDisplayed()
                    .fetchSemanticsNode()
                val keyBounds = key.boundsInWindow
                val keyTouch = key.touchBoundsInRoot.translate(
                    keyBounds.topLeft - key.boundsInRoot.topLeft,
                )
                val minimum = 48f * compose.activity.resources.displayMetrics.density
                assertTrue("$label keeps a complete 48dp target on the scaled panel: $keyTouch",
                    keyTouch.width >= minimum && keyTouch.height >= minimum)
                assertFalse("The grip must never cover a key: $keyBounds vs $grip",
                    keyBounds.left < grip.right && keyBounds.right > grip.left &&
                        keyBounds.top < grip.bottom && keyBounds.bottom > grip.top)
            }
        }

        placementPhase("grip-tap-f12") {
            tapByTouch("F12")
            compose.runOnIdle {
                assertEquals(TerminalControlKey.F12, fixture.keys.last().key)
                assertEquals("A floating panel's tap never reaches the terminal surface", 0, fixture.inputs)
            }
        }
    }

    /**
     * Two witnesses a scaled panel must not lose: that scrolling was genuinely required,
     * and that the corner docking toggle belongs to the panel header.
     *
     * A measured short host is how this suite forces that condition. A floating panel
     * stops shrinking at the measured footprint of its one logical layout, so shrinking
     * the frame can no longer push content out of view — only an extent shorter than that
     * footprint can, and it does so without pretending to a real platform IME. The last
     * function key therefore starts outside the viewport the panel was fitted to, the
     * header really moves when the panel is scrolled to it, and the complete 48dp target
     * and the grip-band clearance below are measured on a panel that first had to scroll
     * before that row appeared on screen at all.
     *
     * The toggle is then measured against its own header across one real swipe. Its travel
     * is read from unclipped origins, because `SemanticsNode.boundsInWindow` is clipped to
     * the bounds of every ancestor: once the toggle rides its header out of the clip box
     * it lives in, its rectangle no longer reports where it went. The clipped rectangle is
     * used for what only it can show — that the visible portion is being cut away — while
     * the origins show that the toggle travels with its header and leaves the panel's own
     * top edge with it, so it can never stay pinned where key rows scroll up underneath
     * it. No frame size, header height, or slop allowance is assumed anywhere here.
     */
    @Test fun shortHostFloatingKeysScrollsForRealAndItsDockingControlGoesWithTheHeader() {
        val fixture = Fixture()
        // The same measured short host this suite already uses for a reduced visible
        // extent: the panel is fitted to what the pane leaves, never to a rule.
        compose.setContent { Box(Modifier.fillMaxWidth().height(200.dp)) { fixture.Content() } }
        awaitInput(fixture)
        val visible = compose.runOnIdle { paneBounds(fixture) }
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        awaitInput(fixture)
        compose.onNodeWithText("More keys").performScrollTo().performClick()
        awaitInput(fixture)

        val frame = floatingKeysFrameBounds()
        val viewport = keysPanelBounds()
        val grip = gripContainer().boundsInWindow
        // The short host has to bind, or nothing below is evidence about scrolling.
        assertTrue("A never-resized panel must not measure past the visible extent: $frame vs $visible",
            frame.height <= visible.height() + 1f && frame.bottom <= visible.bottom + 1f)
        assertEquals("The viewport and the grip band must tile the frame's height: " +
            "$viewport vs $grip vs $frame", frame.height, viewport.height + grip.height, 2f)

        // Scrolling is genuinely required, and measured that way: the last function key is
        // in the layout and starts outside the viewport the panel was fitted to. The header
        // is tracked by its unclipped origin, which keeps reporting the content's travel
        // even where a clipped rectangle would only report what is left on screen.
        compose.onNodeWithText("F12").assertExists().assertIsNotDisplayed()
        val headerTopBeforeScroll = compose.onAllNodesWithText("Conversation A").onFirst()
            .fetchSemanticsNode().positionInWindow.y
        compose.onNodeWithText("F12").performScrollTo().assertIsDisplayed()
        val headerTopAfterScroll = compose.onAllNodesWithText("Conversation A").onFirst()
            .fetchSemanticsNode().positionInWindow.y
        assertTrue("Scrolling to the last row must actually move the panel's content: header " +
            "top $headerTopBeforeScroll -> $headerTopAfterScroll",
            headerTopAfterScroll < headerTopBeforeScroll)

        // So every clear-target claim above is about a panel that really had to scroll.
        val last = compose.onNodeWithText("F12").fetchSemanticsNode()
        val lastBounds = last.boundsInWindow
        val lastTouch = last.touchBoundsInRoot.translate(lastBounds.topLeft - last.boundsInRoot.topLeft)
        val minimum = 48f * compose.activity.resources.displayMetrics.density
        assertTrue("The last key keeps a complete 48dp target after a real scroll: $lastTouch",
            lastTouch.width >= minimum && lastTouch.height >= minimum)
        assertFalse("The grip must never cover a key, at any scroll position: $lastBounds vs $grip",
            lastBounds.left < grip.right && lastBounds.right > grip.left &&
                lastBounds.top < grip.bottom && lastBounds.bottom > grip.top)

        tapByTouch("F12")
        compose.runOnIdle {
            assertEquals(TerminalControlKey.F12, fixture.keys.last().key)
            assertEquals("A floating panel's tap never reaches the terminal surface", 0, fixture.inputs)
            assertNull("Fitting and scrolling a panel never write a floating size",
                fixture.placement.keysPortraitLayout.floatingSize)
            assertEquals("Only the deliberate pop-out saves", 1, fixture.commits)
        }

        // Back to the header's own end of the content, so the swipe below has real
        // distance to travel and its effect is measured rather than inferred.
        compose.onNodeWithText("Conversation A").performScrollTo()
        compose.waitForIdle()
        val frameBeforeToggleScroll = floatingKeysFrameBounds()
        val headerBeforeToggle = compose.onAllNodesWithText("Conversation A").onFirst()
            .fetchSemanticsNode().positionInWindow.y
        val controlBeforeToggle = controlNode("Dock keys")
        val controlBeforeTop = controlBeforeToggle.positionInWindow.y
        val controlBeforeVisible = controlBeforeToggle.boundsInWindow.height
        keysPanelScrollNode().performTouchInput { swipeUp() }
        compose.waitForIdle()
        val frameAfterToggleScroll = floatingKeysFrameBounds()
        val panelTop = keysPanelScrollNode().fetchSemanticsNode().positionInWindow.y
        val headerAfterToggle = compose.onAllNodesWithText("Conversation A").onFirst()
            .fetchSemanticsNode().positionInWindow.y
        val controlAfterToggle = controlNode("Dock keys")
        val controlAfterTop = controlAfterToggle.positionInWindow.y
        val controlAfterVisible = controlAfterToggle.boundsInWindow.height

        assertEquals("Scrolling the panel must not move its frame: $frameBeforeToggleScroll " +
            "vs $frameAfterToggleScroll", frameBeforeToggleScroll.top, frameAfterToggleScroll.top, 1f)
        assertEquals("Scrolling the panel must not move its frame: $frameBeforeToggleScroll " +
            "vs $frameAfterToggleScroll", frameBeforeToggleScroll.left, frameAfterToggleScroll.left, 1f)
        assertTrue("The swipe must actually scroll the panel's content: header top " +
            "$headerBeforeToggle -> $headerAfterToggle", headerAfterToggle < headerBeforeToggle)
        assertTrue("The docking control must scroll with the header it belongs to: top " +
            "$controlBeforeTop -> $controlAfterTop", controlAfterTop < controlBeforeTop)
        assertTrue("The docking control must travel with its header rather than stand still " +
            "while key rows scroll up underneath it: header moved " +
            "${headerAfterToggle - headerBeforeToggle}, control moved " +
            "${controlAfterTop - controlBeforeTop}",
            kotlin.math.abs((controlAfterTop - controlBeforeTop) -
                (headerAfterToggle - headerBeforeToggle)) <= 1f)
        assertTrue("A scrolled docking control must leave the panel's own top edge with its " +
            "header — the edge its clip box cuts it at — rather than stay pinned inside the " +
            "frame over the content that scrolled past it: control top $controlAfterTop, " +
            "panel top $panelTop", controlAfterTop < panelTop)
        // What only the clipped rectangle can show: the visible portion of the toggle is
        // cut away as its header scrolls up, while the frame it belongs to does not move.
        assertTrue("The panel's own scroll must clip the docking control away: visible " +
            "height $controlBeforeVisible -> $controlAfterVisible",
            controlAfterVisible < controlBeforeVisible)
        compose.runOnIdle {
            assertEquals("Scrolling and presenting the toggle saves nothing", 1, fixture.commits)
            assertEquals("Scrolling a floating panel never reflows the pane", visible, paneBounds(fixture))
            assertEquals("The swipe reaches no key: only the deliberate tap above pressed one",
                1, fixture.keys.size)
            assertTrue(fixture.pastes == 0)
        }
    }

    /**
     * The floating panel's resize floor is the measured footprint of its one logical
     * layout, not a named constant. Starting from a deliberately enlarged frame — a shrink
     * from the never-resized footprint would be clamped away and prove nothing — the panel
     * really shrinks, a second overshoot cannot shrink it further, and at that floor every
     * measured interactive target (key buttons, the corner docking toggle, and the resize
     * grip itself) still holds a complete 48dp physical target. A real injected tap still
     * reaches a key and never the terminal.
     */
    @Test fun floatingResizeFloorStopsShrinkingAndKeepsEveryTargetAtLeast48dp() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        compose.onNodeWithContentDescription("Pop keys out").performClick()
        awaitInput(fixture)
        compose.onNodeWithText("More keys").performClick()
        awaitInput(fixture)
        // Enlarge first, so the shrink below is real rather than a clamp doing nothing.
        resizeKeysPanel(dx = 250f, dy = 250f)
        val enlarged = floatingKeysFrameBounds()

        // Overshoot the drag so the floor lands the panel on its own footprint while the
        // injected pointer stays inside the window.
        resizeKeysPanel(dx = -900f, dy = -700f)
        val floored = floatingKeysFrameBounds()
        assertTrue("The resize must actually shrink the enlarged panel: $enlarged vs $floored",
            floored.height < enlarged.height - 1f && floored.width < enlarged.width - 1f)
        resizeKeysPanel(dx = -900f, dy = -700f)
        val again = floatingKeysFrameBounds()
        assertEquals("A second overshoot drag cannot go below the floor: $floored vs $again",
            floored.height, again.height, 2f)
        assertEquals("A second overshoot drag cannot go below the floor: $floored vs $again",
            floored.width, again.width, 2f)

        // What that floor guarantees is real physical size, read off the panel itself.
        listOf("Ctrl", "Esc", "F12").forEach { label ->
            compose.onNodeWithText(label).performScrollTo()
            assertTouchTarget(label)
        }
        // The interior corner controls scale with the layout too, so the floor is what
        // keeps them whole. Neither sits inside the panel's scroll container: the grip is
        // its own band below the viewport, and the docking toggle rides that container's
        // scroll offset so it travels and clips with the header instead of standing still —
        // the witness for that behavior is
        // [shortHostFloatingKeysScrollsForRealAndItsDockingControlGoesWithTheHeader]. What
        // this floor guarantees here is complete physical size: the toggle measured as its
        // own target, the grip as its real 48dp container rather than the 24dp glyph
        // inside it.
        assertTouchTarget("Dock keys")
        val gripBounds = gripContainer().boundsInWindow
        val minimumTarget = 48f * compose.activity.resources.displayMetrics.density
        assertTrue("The resize grip keeps a complete 48dp target at the floor: $gripBounds",
            gripBounds.width >= minimumTarget && gripBounds.height >= minimumTarget)
        // The layout is still the one logical layout tiled by its viewport and grip band.
        val viewport = keysPanelBounds()
        assertEquals("The floored frame is still tiled by its viewport and grip band: " +
            "$viewport vs $gripBounds vs $floored", floored.height, viewport.height + gripBounds.height, 2f)

        tapByTouch("F12")
        compose.runOnIdle {
            assertEquals(TerminalControlKey.F12, fixture.keys.last().key)
            assertEquals("A floating panel's tap never reaches the terminal surface", 0, fixture.inputs)
        }
    }

    @Test fun dockedKeysBandKeepsEveryActionReachableAndNeverRewritesARememberedPosition() {
        val fixture = Fixture()
        // Short enough that the expanded band cannot show every key at once, so the band
        // scrolls, while the reserved pane still measures a real grid.
        compose.setContent { Box(Modifier.fillMaxWidth().height(560.dp)) { fixture.Content() } }
        awaitInput(fixture)
        val paneBeforeDock = compose.runOnIdle { paneBounds(fixture) }

        // A remembered Keys position is placement data for the floating panel only: a
        // docked band must not normalize it, and presentation must not save anything.
        compose.runOnIdle {
            fixture.placement = TerminalOverlayPlacement.DEFAULT
                .withPosition(TerminalOverlay.KEYS, TerminalOverlayOrientation.PORTRAIT, TerminalOverlayPosition(0, 0))
                .withPosition(TerminalOverlay.KEYS, TerminalOverlayOrientation.LANDSCAPE, TerminalOverlayPosition(0, 0))
        }
        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("More keys").performScrollTo().performClick()
        val pane = awaitInputThenPane(fixture)
        // Docking and expanding are the one real reservation this screen makes, and the
        // awaited commit above is the one that band's pane measured. The anchors below are
        // taken after that reflow, so they cover scrolling and presentation only.
        val bandRequests = compose.runOnIdle { fixture.viewports.size }
        val bandGrid = compose.runOnIdle { fixture.viewports.last() }
        val bandFontPx = compose.runOnIdle { requireNotNull(fixture.surface).textSizePx }
        val bandProof = compose.runOnIdle { requireNotNull(fixture.surface).currentInputProof() }
        compose.runOnIdle {
            fixture.terminal = fixture.terminal.copy(coverage = UiCoverage.MODAL_DIALOG)
            fixture.warning = TerminalOverlayPlacementWarning.SAVE_FAILED
        }
        compose.onNodeWithText("Terminal input is paused while this is open.").assertIsDisplayed()

        val controls = boundsOf("Close keys")
        val header = boundsOf("Conversation A")
        assertTrue("A docked band starts below the control strip: $header vs $controls",
            header.top >= controls.bottom - 1f)
        assertTrue("A docked band stays below the control strip: $header vs $controls",
            header.bottom > controls.bottom)
        assertEveryKeyActionScrolls()
        listOf("Ctrl", "Paste", "Esc", "F12").forEach { label ->
            compose.onNodeWithText(label).performScrollTo()
            assertTouchTarget(label)
        }
        compose.runOnIdle {
            assertTrue("Docking must reserve real pane area: $paneBeforeDock vs $pane",
                pane.bottom < paneBeforeDock.bottom)
            assertEquals("Presentation and scrolling never save placement", 0, fixture.commits)
            assertEquals("A docked band never normalizes a remembered Keys position",
                TerminalOverlayPosition(0, 0), fixture.placement.keysPortrait)
            assertEquals(TerminalOverlayPosition(0, 0), fixture.placement.keysLandscape)
            assertEquals(true, fixture.placement.keysPortraitLayout.docked)
            assertTrue("A docked band never changes IME authority",
                fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            assertEquals("Scrolling a docked band must not request another reflow",
                bandRequests, fixture.viewports.size)
            assertEquals("Scrolling a docked band must not change the grid it committed at",
                bandGrid, fixture.viewports.last())
            assertEquals("Scrolling a docked band must not change the measured font",
                bandFontPx, requireNotNull(fixture.surface).textSizePx, 0f)
            assertTrue("Scrolling keeps the band's own commit standing",
                fixture.surface!!.verifyReceipt(bandProof))
            assertEquals("Scrolling grants no new proof", bandProof,
                requireNotNull(fixture.surface).currentInputProof())
        }

        tapByTouch("Close keys")
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
    }

    @Test fun overlayControlsNeverCoverTheDockedKeysBandInAnyRememberedSlot() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        compose.onNodeWithText("Keys").performClick()
        val anchor = awaitInput(fixture)
        val pane = compose.runOnIdle { paneBounds(fixture) }
        val requests = fixture.viewports.size

        listOf(
            TerminalOverlayPosition(1000, 1000),
            TerminalOverlayPosition(500, 500),
            TerminalOverlayPosition(0, 0),
        ).forEachIndexed { index, controlsPosition ->
            compose.runOnIdle {
                fixture.placement = fixture.placement
                    .withPosition(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, controlsPosition)
                    .withPosition(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.LANDSCAPE, controlsPosition)
            }
            val controls = compose.onNodeWithText("Close keys").assertIsDisplayed().fetchSemanticsNode()
            val keys = compose.onNodeWithText("Esc").assertIsDisplayed().fetchSemanticsNode()
            assertFalse("A moved Controls strip must not cover the docked Keys band: $controls vs $keys",
                controls.boundsInWindow.left < keys.boundsInWindow.right &&
                    controls.boundsInWindow.right > keys.boundsInWindow.left &&
                    controls.boundsInWindow.top < keys.boundsInWindow.bottom &&
                    controls.boundsInWindow.bottom > keys.boundsInWindow.top)
            assertTouchTarget("Close keys")
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
                assertTrue(fixture.surface!!.verifyReceipt(anchor))
            }
        }
    }

    /**
     * A short, narrow layer. The control strip is measured against the space currently
     * available to the layout, less the usable Keys viewport it must leave a docked band,
     * and the band is capped by what that measurement leaves — no fixed pane floor and no
     * half split is asserted anywhere here. What is measured instead: the pane gives up
     * exactly the band's own height, the band keeps room for one complete 48dp target,
     * the pane keeps the strip's measured viewport, and every control and Keys action
     * stays reachable to a real injected touch with a complete 48dp target.
     */
    @Test fun shortLayerKeepsControlsAndDockedKeysActionsReachableUnderRealTouch() {
        val fixture = Fixture()
        compose.setContent {
            val base = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(base.density, fontScale = 1.5f)) {
                Box(Modifier.width(160.dp).height(160.dp)) { fixture.Content() }
            }
        }
        awaitInput(fixture)
        val paneBeforeDock = compose.runOnIdle { paneBounds(fixture) }
        val requests = fixture.viewports.size

        // Keys closed: every control is laid out inside the available extent, so each one
        // is reachable with no remembered short-layer mode.
        listOf("Back", "Switch", "Keys").forEach { label ->
            scrollIntoViewIfScrollable(label)
            compose.onNodeWithText(label).assertIsDisplayed()
            assertTouchTarget(label)
        }
        scrollIntoViewIfScrollable("Keyboard")
        compose.onNodeWithContentDescription("Keyboard").assertIsDisplayed()

        scrollIntoViewIfScrollable("Keys")
        tapByTouch("Keys")
        awaitInput(fixture)
        val reserved = compose.runOnIdle { paneBounds(fixture) }
        val band = keysPanelBounds()
        // The strip's own measured viewport, read from the scroll container that owns its
        // controls: this is the footprint the band's reservation was bounded by.
        val stripViewport = scrollOwnerFor("Back")
            ?: error("The capped control strip must own a scroll viewport in a short layer")
        val stripViewportBounds = stripViewport.boundsInWindow
        compose.runOnIdle {
            assertEquals("Docked Keys must not move the pane's top or sides",
                Triple(paneBeforeDock.left, paneBeforeDock.top, paneBeforeDock.right),
                Triple(reserved.left, reserved.top, reserved.right))
            assertTrue("Even a short layer reserves real pane area: $paneBeforeDock vs $reserved",
                reserved.bottom < paneBeforeDock.bottom)
            // Reservation equality, not a pane constant: what the pane gave up is exactly
            // the band's own measured height...
            assertEquals("The pane gave up exactly the band's measured height: " +
                "$paneBeforeDock vs $reserved vs $band",
                (paneBeforeDock.height() - reserved.height()).toFloat(), band.height, 2f)
            // ...the band keeps room for one complete 48dp target, which is what makes the
            // Keys actions reachable by scrolling from here...
            val minimumTarget = 48f * compose.activity.resources.displayMetrics.density
            assertTrue("The docked band must keep room for one complete 48dp target: $band",
                band.height >= minimumTarget)
            // ...and the pane keeps the strip's own measured viewport, so the chrome that
            // clamps into the pane is never squeezed out of it.
            assertTrue("The pane keeps the strip's measured viewport: $reserved vs $stripViewportBounds",
                reserved.height().toFloat() >= stripViewportBounds.height - 2f)
            assertTrue("The reservation reflows the surface", fixture.viewports.size > requests)
        }

        // The docking control stays inside the band, and the control strip's own box
        // stays above the band rather than painting and hit-testing over the Keys actions.
        // The strip's scroll viewport is its clip box: content past it is clipped, so the
        // box is what paints and receives touches, and each control's own target is
        // asserted below.
        compose.onNodeWithContentDescription("Pop keys out").assertIsDisplayed()
        assertTouchTarget("Pop keys out")
        val bandTop = iconBoundsOf("Pop keys out").top
        val stripBox = scrollOwnerFor("Back")?.boundsInWindow
            ?: error("The capped control strip must own a scroll viewport in a short layer")
        assertTrue("The control strip's own box must stay clear of the docked Keys band: " +
            "$stripBox vs bandTop=$bandTop", stripBox.bottom <= bandTop + 1f)
        listOf("Back", "Switch", "Close keys").forEach { label ->
            scrollIntoViewIfScrollable(label)
            compose.onNodeWithText(label).assertIsDisplayed()
            assertTouchTarget(label)
        }

        // Real injected touch reaches the Keys actions through the band, and the existing
        // expansion keeps every added action scroll-reachable in it.
        compose.onNodeWithText("Esc").performScrollTo()
        tapByTouch("Esc")
        compose.onNodeWithText("More keys").performScrollTo().assertIsDisplayed()
        tapByTouch("More keys")
        compose.onNodeWithText("F12").performScrollTo().assertIsDisplayed()
        tapByTouch("F12")
        // The two taps above are not the whole contract: every modifier, special, arrow,
        // and function action in the expanded band has to be scroll-reachable with a
        // complete 48dp target in this short layer, and a real injected Paste tap has to
        // reach its callback exactly once.
        assertEveryKeyActionScrolls()
        compose.onNodeWithText("Paste").performScrollTo().assertIsDisplayed()
        tapByTouch("Paste")
        compose.runOnIdle {
            assertEquals(listOf(TerminalControlKey.ESCAPE, TerminalControlKey.F12),
                fixture.keys.map { it.key })
            assertEquals("A real Paste tap in the short layer invokes the callback once",
                1, fixture.pastes)
            assertEquals("Scrolling and tapping never save placement", 0, fixture.commits)
            assertTrue("Short-layer layout never changes IME authority",
                fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
        }

        scrollIntoViewIfScrollable("Close keys")
        compose.onNodeWithText("Close keys").assertIsDisplayed()
        tapByTouch("Close keys")
        compose.waitUntil(10_000) { compose.runOnIdle { paneBounds(fixture) == paneBeforeDock } }
    }

    @Test fun overlayCompositionWaitsForCompletedPlacementLoad() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        // Keys is already open when the placement load is still in flight, so the docked
        // band and its pop-out control are the surfaces the gate has to cover too.
        compose.onNodeWithText("Keys").performClick()
        awaitInput(fixture)
        val openPane = compose.runOnIdle { paneBounds(fixture) }
        val bandProof = requireNotNull(
            compose.runOnIdle { fixture.surface?.currentInputProof()?.commitSequence },
        )
        val commitsBeforeGate = compose.runOnIdle { fixture.commits }

        compose.runOnIdle { fixture.placementReady = false }
        compose.waitForIdle()
        compose.onAllNodesWithText("Keys").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Keyboard").assertCountEquals(0)
        compose.onAllNodesWithText("Switch").assertCountEquals(0)
        compose.onAllNodesWithText("Close keys").assertCountEquals(0)
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Pop keys out").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Dock keys").assertCountEquals(0)
        compose.runOnIdle {
            assertEquals("Nothing interactive composes while placement loads, so nothing can commit",
                commitsBeforeGate, fixture.commits)
        }

        compose.runOnIdle { fixture.placementReady = true }
        compose.onNodeWithText("Close keys").assertIsDisplayed()
        compose.onNodeWithContentDescription("Pop keys out").assertIsDisplayed()
        compose.onNodeWithText("Esc").assertExists()
        // Gating the layer off took the docked band out of composition, so the pane grew;
        // gating it back on reserves that area again. That is a real resize, so the return
        // to the band's own reservation is waited for — with a commit newer than the band's
        // pre-gate one standing — instead of reading a size that may still be mid-resize.
        compose.waitUntil(10_000) {
            val observed = compose.runOnIdle {
                paneBounds(fixture) to fixture.surface?.currentInputProof()?.commitSequence
            }
            observed.first == openPane && (observed.second ?: 0L) > bandProof
        }
        compose.runOnIdle {
            assertEquals("The gated band returns to the same reservation", openPane, paneBounds(fixture))
            assertEquals(commitsBeforeGate, fixture.commits)
        }
    }

    @Test fun placementWarningsAreVisibleOverlaysWithoutTouchingThePaneOrStatusDismissal() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitInput(fixture)
        val pane = paneBounds(fixture)
        val requests = fixture.viewports.size
        val grid = fixture.viewports.last()
        val fontPx = compose.runOnIdle { requireNotNull(fixture.surface).textSizePx }

        compose.runOnIdle { fixture.warning = TerminalOverlayPlacementWarning.LOADED_DEFAULTS }
        compose.onNodeWithText(
            "Saved overlay positions could not be read. Default positions are in use until new positions are saved.",
        ).assertIsDisplayed()
        assertInvariant(fixture, pane, grid, requests, fontPx, anchor, "warning")

        compose.runOnIdle { fixture.warning = TerminalOverlayPlacementWarning.SAVE_FAILED }
        compose.onNodeWithText("Overlay positions could not be saved. They apply now but may not be remembered.")
            .assertIsDisplayed()
        assertEquals("Warning presentation alone is not a placement save", 0, fixture.commits)
        // The existing raw status remains a separate dismissible notice.
        compose.onNodeWithText("Synthetic status notice").assertIsDisplayed()
        compose.onNodeWithText("Dismiss").performClick()
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        assertInvariant(fixture, pane, grid, requests, fontPx, anchor, "warning")
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
                assertInvariant(fixture, snapshot.pane, snapshot.grid, snapshot.requests, snapshot.fontPx,
                    snapshot.anchor, "after rotation")
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

    @Test fun keysDockingAndFloatingSizeAreRememberedIndependentlyPerOrientation() {
        val fixture = Fixture()
        compose.setContent { fixture.Content() }
        UiVerificationActivity.contentForRecreation = { fixture.Content() }
        // Declared outside the try so the finally block can check them after the last
        // recreation: they are the numeric placement each orientation saved.
        var portraitPosition: TerminalOverlayPosition? = null
        var portraitSize: TerminalKeysFloatingSize? = null
        var landscapePosition: TerminalOverlayPosition? = null
        var landscapeSize: TerminalKeysFloatingSize? = null
        // The first assertion to fail names the defect, so it is recorded rather than
        // replaced: the cleanup and the post-recreation checks below still have to run, and
        // any failure they add travels as suppressed on the primary one.
        var primaryFailure: Throwable? = null
        try {
            placementPhase("portrait-load") { awaitInput(fixture) }
            assertEquals(TerminalOverlayPlacement.DEFAULT, fixture.placement)
            placementPhase("portrait-open") {
                compose.onNodeWithText("Keys").performClick()
                awaitInput(fixture)
            }
            placementPhase("portrait-pop-out") {
                val beforePopOut = compose.runOnIdle { fixture.commits }
                compose.onNodeWithContentDescription("Pop keys out").performClick()
                awaitInput(fixture)
                assertOneCommit(fixture, "portrait-pop-out", beforePopOut)
            }
            // A completed move and a completed resize give this orientation numbers to
            // carry across the recreations below.
            placementPhase("portrait-shape") {
                val beforeMove = compose.runOnIdle { fixture.commits }
                dragBy("Conversation A", dx = -60f, dy = -90f)
                assertOneCommit(fixture, "portrait-move", beforeMove)
                val beforeResize = compose.runOnIdle { fixture.commits }
                resizeKeysPanel(dx = 120f, dy = 140f)
                assertOneCommit(fixture, "portrait-resize", beforeResize)
                awaitInput(fixture)
            }
            portraitPosition = compose.runOnIdle { fixture.placement.keysPortrait }
            portraitSize = compose.runOnIdle { fixture.placement.keysPortraitLayout.floatingSize }
            placementPhase("portrait-claims") {
                compose.runOnIdle {
                    assertEquals("Pop-out plus a completed move and resize are three saves",
                        3, fixture.commits)
                    assertEquals(false, fixture.placement.keysPortraitLayout.docked)
                    assertEquals("The other orientation keeps its own default",
                        TerminalOverlayPlacement.DEFAULT.keysLandscapeLayout, fixture.placement.keysLandscapeLayout)
                }
            }
            assertNotNull("The portrait move is numeric placement data", portraitPosition)
            assertNotNull("The portrait resize is numeric placement data", portraitSize)
            placementPhase("landscape-recreation") {
                rotateTo(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, Configuration.ORIENTATION_LANDSCAPE, fixture)
            }
            placementPhase("landscape-is-docked") {
                // Keys stays open through the real recreation, and the landscape slot is
                // still docked, so the band reserves area again.
                compose.onNodeWithText("Esc").assertIsDisplayed()
                compose.onNodeWithContentDescription("Pop keys out").assertIsDisplayed()
                compose.runOnIdle {
                    assertEquals("Recreation is never a placement save", 3, fixture.commits)
                    assertEquals(true, fixture.placement.keysLandscapeLayout.docked)
                    assertEquals(false, fixture.placement.keysPortraitLayout.docked)
                    // The numbers the portrait panel saved survive the recreation
                    // untouched, and the landscape default did not write over them.
                    assertEquals(portraitPosition, fixture.placement.keysPortrait)
                    assertEquals(portraitSize, fixture.placement.keysPortraitLayout.floatingSize)
                    assertNull("Landscape has saved no position of its own yet",
                        fixture.placement.keysLandscape)
                }
            }
            val landscapeDocked = compose.runOnIdle { paneBounds(fixture) }
            placementPhase("landscape-pop-out") {
                val beforePopOut = compose.runOnIdle { fixture.commits }
                compose.onNodeWithContentDescription("Pop keys out").performClick()
                awaitInput(fixture)
                assertOneCommit(fixture, "landscape-pop-out", beforePopOut)
            }
            placementPhase("landscape-band-gave-its-area-back") {
                val landscapeFloating = compose.runOnIdle { paneBounds(fixture) }
                compose.runOnIdle {
                    assertEquals("Popping out in landscape is the only new save", 4, fixture.commits)
                    assertEquals("A landscape docked band must not move the pane's top or sides",
                        Triple(landscapeFloating.left, landscapeFloating.top, landscapeFloating.right),
                        Triple(landscapeDocked.left, landscapeDocked.top, landscapeDocked.right))
                    assertTrue("A landscape docked band must reserve real pane area: " +
                        "$landscapeDocked vs $landscapeFloating",
                        landscapeDocked.bottom < landscapeFloating.bottom)
                    assertEquals(portraitPosition, fixture.placement.keysPortrait)
                    assertEquals(portraitSize, fixture.placement.keysPortraitLayout.floatingSize)
                }
            }
            placementPhase("landscape-shape") {
                // A completed move and a completed resize give landscape its own numbers:
                // a position and a size, each independent of what portrait saved.
                val beforeMove = compose.runOnIdle { fixture.commits }
                dragBy("Conversation A", dx = -50f, dy = -60f)
                assertOneCommit(fixture, "landscape-move", beforeMove)
                val beforeResize = compose.runOnIdle { fixture.commits }
                resizeKeysPanel(dx = 140f, dy = 120f)
                assertOneCommit(fixture, "landscape-resize", beforeResize)
                awaitInput(fixture)
            }
            landscapePosition = compose.runOnIdle { fixture.placement.keysLandscape }
            landscapeSize = compose.runOnIdle { fixture.placement.keysLandscapeLayout.floatingSize }
            placementPhase("landscape-claims") {
                compose.runOnIdle {
                    assertEquals("Portrait's three saves plus landscape's pop-out, completed " +
                        "move, and completed resize", 6, fixture.commits)
                    assertEquals(false, fixture.placement.keysLandscapeLayout.docked)
                    assertEquals(false, fixture.placement.keysPortraitLayout.docked)
                    assertNotNull("The landscape move is numeric placement data",
                        landscapePosition)
                    assertNotNull("The landscape resize is its own numeric placement data",
                        landscapeSize)
                    // Portrait is still exactly what portrait saved, while landscape now
                    // carries its own position and size.
                    assertEquals(portraitPosition, fixture.placement.keysPortrait)
                    assertEquals(portraitSize, fixture.placement.keysPortraitLayout.floatingSize)
                }
            }
        } catch (failure: Throwable) {
            primaryFailure = failure
        }

        try {
            placementPhase("portrait-recreation") {
                rotateTo(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, Configuration.ORIENTATION_PORTRAIT, fixture)
            }
            placementPhase("portrait-numbers-survive-both-recreations") {
                compose.runOnIdle {
                    assertEquals("Neither recreation is a placement save", 6, fixture.commits)
                    assertEquals(false, fixture.placement.keysPortraitLayout.docked)
                    assertEquals(portraitPosition, fixture.placement.keysPortrait)
                    assertEquals(portraitSize, fixture.placement.keysPortraitLayout.floatingSize)
                    assertEquals("Landscape keeps its own popped-out docking state", false,
                        fixture.placement.keysLandscapeLayout.docked)
                    // Landscape's own saved position and size survive the second
                    // recreation too, each orientation carrying its own numbers.
                    assertEquals(landscapePosition, fixture.placement.keysLandscape)
                    assertEquals(landscapeSize, fixture.placement.keysLandscapeLayout.floatingSize)
                }
            }
        } catch (failure: Throwable) {
            // A cleanup or post-recreation failure never overwrites the primary failure;
            // it is attached to it below instead.
            val primary = primaryFailure
            if (primary == null) primaryFailure = failure
            else if (primary !== failure) primary.addSuppressed(failure)
        } finally {
            UiVerificationActivity.contentForRecreation = null
        }

        primaryFailure?.let { throw it }
    }

    /**
     * Debug off removes the entire notice presentation: its text, its dismiss control,
     * its drag/touch region, and the Keys panel's duplicate of the raw status. Nothing is
     * saved, reset, or replayed, and no notice text or dismiss control survives anywhere.
     */
    @Test fun debugOffRemovesEveryNoticePresentationAndItsTouchRegion() {
        val fixture = Fixture()
        compose.setContent { Box(Modifier.width(240.dp).height(520.dp)) { fixture.Content() } }
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

        // Debug on again: the notices surface returns exactly as it was, with nothing
        // replayed, before the Keys panel gets a chance to duplicate it.
        compose.runOnIdle { fixture.debugNotices = true }
        compose.waitForIdle()
        compose.onNodeWithText("Synthetic status notice").assertIsDisplayed()
        compose.onNodeWithText("Dismiss").assertIsDisplayed()

        // Docked Keys: the panel's own copy of the raw status follows the same flag, and
        // a hidden copy reserves no band height, so the pane gets that area back.
        compose.onNodeWithText("Keys").performClick()
        val reservedPane = awaitInputThenPane(fixture)
        // Both copies are counted before either is addressed: a single-node lookup would
        // fail on the duplicate the panel intentionally shows.
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(2)
        compose.onNodeWithText("Dismiss").assertIsDisplayed()
        // The height the band loses is the panel's own copy of the raw status, measured
        // inside the band. The notices overlay above the pane reserves nothing, so its
        // height would be the wrong proxy for a docked band's reservation.
        val bandWithCopy = keysPanelBounds()
        val keysCopyHeight = boundsInside(bandWithCopy, "Synthetic status notice").height
        assertTrue("The Keys panel's own status copy must have a measurable height: $keysCopyHeight",
            keysCopyHeight > 0f)

        compose.runOnIdle { fixture.debugNotices = false }
        compose.waitForIdle()
        val shrunkBandPane = compose.runOnIdle { paneBounds(fixture) }
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        compose.onAllNodesWithText("Dismiss").assertCountEquals(0)
        compose.onNodeWithText("Esc").assertIsDisplayed()
        compose.runOnIdle {
            val reclaimed = (shrunkBandPane.bottom - reservedPane.bottom).toFloat()
            assertTrue("A hidden notice copy must not keep reserving band height: " +
                "$reservedPane vs $shrunkBandPane", reclaimed > 0f)
            // The magnitude is the removed content's own height (plus the gap it took),
            // not merely a nonzero change.
            assertTrue("The band must give back the height its own status copy measured: " +
                "$reclaimed vs $keysCopyHeight", reclaimed >= keysCopyHeight - 2f)
            assertEquals("Presentation alone never saves a placement", 0, fixture.commits)
            assertTrue(fixture.keys.isEmpty() && fixture.pastes == 0)
        }

        // Debug on a second time: both copies return, and the band reserves that height again.
        compose.runOnIdle { fixture.debugNotices = true }
        compose.waitForIdle()
        val restoredBandPane = compose.runOnIdle { paneBounds(fixture) }
        // Both copies must be counted before either is addressed: a single-node lookup
        // would fail on the duplicate.
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(2)
        compose.onNodeWithText("Dismiss").assertIsDisplayed()
        compose.onAllNodesWithText("Synthetic status notice").onFirst().assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("The band reserves the same height the copy was measured at",
                reservedPane, restoredBandPane)
            assertEquals("Toggling debug visibility emits no intent", emptyList<ClientIntent>(),
                fixture.intents.map { it.intent })
            assertTrue(fixture.keys.isEmpty() && fixture.pastes == 0)
        }
    }

    /**
     * Which Keys pop-out is open, and which notice was dismissed, belong to one instance
     * of the terminal route and to no store: the screen reads them from a lifecycle-retained
     * owner and claims them for its own route instance with a saved random token.
     *
     * A fresh owner is what a cold start hands the screen, so the closed, undismissed start
     * is asserted directly. The same owner and the same route instance keep both across a
     * teardown and rebuild of the screen's overlay layer, which is the retention a
     * configuration change relies on. Removing the whole terminal screen from composition
     * and adding it back — what leaving the terminal and entering it again does, while the
     * owner stays alive — closes the panel and un-dismisses the notice again.
     *
     * Dismissal is asserted honestly: suppressing the notice overlay also removes its
     * `Dismiss` control, while an open docked panel keeps showing its own copy of the raw
     * status, exactly as production does. The remembered docking stays docked throughout,
     * because only the open flag is ephemeral — the placement document still carries nothing
     * but docking and an (absent) size for the Keys slot, and no open flag of any kind.
     *
     * This is not OS process death: nothing here kills and relaunches the process. It
     * exercises the owner and the route claim a restarted process would find fresh.
     */
    @Test fun keysOpenAndDismissedStateBelongToOneTerminalRouteInstance() {
        val fixture = Fixture()
        var owner by mutableStateOf<ViewModelStoreOwner>(EphemeralOwner())
        var onTheTerminalRoute by mutableStateOf(true)
        compose.setContent {
            CompositionLocalProvider(LocalViewModelStoreOwner provides owner) {
                // Off the route the entire terminal screen leaves composition, which is
                // what LeaveTerminal does in RootUIScreen. The owner survives it.
                if (onTheTerminalRoute) fixture.Content() else Box(Modifier.fillMaxSize())
            }
        }
        awaitInput(fixture)
        val closedPane = compose.runOnIdle { paneBounds(fixture) }

        // A fresh route instance starts closed: no panel, no band, and the producer's
        // notice is undismissed with its own control present.
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
        compose.onNodeWithText("Synthetic status notice").assertIsDisplayed()
        compose.onNodeWithText("Dismiss").assertIsDisplayed()

        compose.onNodeWithText("Keys").performClick()
        compose.waitUntil(10_000) { compose.runOnIdle { paneBounds(fixture).bottom < closedPane.bottom } }
        awaitInput(fixture)
        val dockedPane = compose.runOnIdle { paneBounds(fixture) }
        // Docked Keys duplicates the raw status, so the overlay notice and the band's own
        // copy are both on screen before anything is dismissed.
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(2)
        boundsInside(keysPanelBounds(), "Synthetic status notice")

        compose.onNodeWithText("Dismiss").performClick()
        // Dismiss removes the overlay notice and its control. The open docked panel keeps
        // its own copy of the raw status — preserved production behavior — so the
        // remaining copy is asserted inside the band rather than counted as zero.
        compose.onAllNodesWithText("Dismiss").assertCountEquals(0)
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(1)
        boundsInside(keysPanelBounds(), "Synthetic status notice")
        val commitsAfterDocking = compose.runOnIdle {
            assertEquals("Opening the default-docked panel is presentation and saves nothing", 0, fixture.commits)
            assertEquals("The Keys placement slot carries docking and an absent size, and " +
                "no open flag of any kind",
                TerminalOverlayPlacement.DEFAULT.keysPortraitLayout.copy(docked = true),
                fixture.placement.keysPortraitLayout)
            fixture.commits
        }

        // The same owner and the same route instance retain the open panel and the
        // dismissal across a full teardown and rebuild of the overlay layer — the retention
        // a rotation uses.
        compose.runOnIdle { fixture.placementReady = false }
        compose.waitForIdle()
        compose.runOnIdle { fixture.placementReady = true }
        compose.waitUntil(10_000) { compose.runOnIdle { paneBounds(fixture) == dockedPane } }
        awaitInput(fixture)
        compose.onNodeWithText("Esc").assertIsDisplayed()
        compose.onAllNodesWithText("Dismiss").assertCountEquals(0)
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(1)
        boundsInside(keysPanelBounds(), "Synthetic status notice")
        compose.runOnIdle {
            assertEquals("Rebuilding against the same owner saves nothing",
                commitsAfterDocking, fixture.commits)
        }

        // Leaving the terminal and entering it again is a new route instance while the
        // owner stays alive: the panel is closed and the notice is undismissed again, which
        // is the exit/reentry scope this presentation had as screen-local state.
        val previousSurface = compose.runOnIdle { requireNotNull(fixture.surface) }
        compose.runOnIdle { onTheTerminalRoute = false }
        compose.waitForIdle()
        compose.runOnIdle { onTheTerminalRoute = true }
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                val view = fixture.surface
                view !== previousSurface && view?.isAttachedToWindow == true &&
                    view.currentInputProof() != null
            }
        }
        compose.waitUntil(10_000) { compose.runOnIdle { paneBounds(fixture) == closedPane } }
        awaitInput(fixture)
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
        compose.onNodeWithText("Synthetic status notice").assertIsDisplayed()
        compose.onNodeWithText("Dismiss").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("Re-entry is presentation, never a placement save",
                commitsAfterDocking, fixture.commits)
            assertEquals("Only the open flag is ephemeral; the docking stays remembered",
                true, fixture.placement.keysPortraitLayout.docked)
        }

        // Open and dismiss once more, then hand the screen a new owner — what a new
        // process gives it — and expect a closed panel with nothing dismissed. Without the
        // route claim this is exactly where a stale open panel would survive.
        compose.onNodeWithText("Keys").performClick()
        compose.waitUntil(10_000) { compose.runOnIdle { paneBounds(fixture).bottom < closedPane.bottom } }
        awaitInput(fixture)
        compose.onNodeWithText("Dismiss").performClick()
        compose.onAllNodesWithText("Dismiss").assertCountEquals(0)
        owner = EphemeralOwner()
        compose.waitUntil(10_000) { compose.runOnIdle { paneBounds(fixture) == closedPane } }
        awaitInput(fixture)
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
        compose.onNodeWithText("Synthetic status notice").assertIsDisplayed()
        compose.onNodeWithText("Dismiss").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("Starting closed is presentation, never a placement save",
                commitsAfterDocking, fixture.commits)
            assertEquals("Only the open flag is ephemeral; the docking stays remembered",
                true, fixture.placement.keysPortraitLayout.docked)
        }
    }

    /** A bare lifecycle owner: what the screen reads its ephemeral Keys state from. */
    private class EphemeralOwner : ViewModelStoreOwner {
        override val viewModelStore: ViewModelStore = ViewModelStore()
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

    /** Icon-only controls have no text, so a target check matches either presentation. */
    private fun assertTouchTarget(label: String) {
        val minimum = 48f * compose.activity.resources.displayMetrics.density
        val node = compose.onNode(hasText(label) or hasContentDescription(label))
            .assertExists().fetchSemanticsNode()
        assertTrue("$label keeps a real 48dp touch target: ${node.touchBoundsInRoot}",
            node.touchBoundsInRoot.width >= minimum && node.touchBoundsInRoot.height >= minimum)
    }

    /**
     * Pane, grid, viewport requests, and proof must be exactly what the caller anchored
     * them at. Every argument is a fact the renderer itself published, never a fixture's
     * own hope about what an overlay should do.
     */
    private fun assertInvariant(
        fixture: Fixture,
        pane: AndroidRect,
        grid: Pair<Int, Int>,
        requests: Int,
        fontPx: Float,
        anchor: FrameCommitReceipt,
        phase: String,
    ) {
        compose.runOnIdle {
            val surface = requireNotNull(fixture.surface)
            assertEquals("Overlay movement must not move or resize the pane ($phase)", pane, paneBounds(fixture))
            assertEquals("Overlay movement must not request a reflow ($phase)", requests, fixture.viewports.size)
            assertEquals(grid, fixture.viewports.last())
            assertEquals("Overlay movement must not change the measured font ($phase)",
                fontPx, surface.textSizePx, 0f)
            assertTrue("Overlay movement keeps terminal focus", surface.hasFocus())
            assertTrue(surface.hasWindowFocus())
            assertTrue("Overlay movement grants no new proof", surface.verifyReceipt(anchor))
            assertEquals(anchor, surface.currentInputProof())
            assertTrue("Readiness stays as the real commit left it", fixture.terminal.inputReady)
        }
    }

    /**
     * One completed gesture publishes exactly one placement save, tagged with the phase that
     * owned it. The aggregate counts stay where they are; this only names which pop-out,
     * move, or resize failed to commit, and logs the observed counts for the same phase.
     */
    private fun assertOneCommit(fixture: Fixture, phase: String, before: Int) {
        val after = compose.runOnIdle { fixture.commits }
        Log.i("OverlayPlacementTest", "commits phase=$phase before=$before after=$after")
        assertEquals("$phase must publish exactly one placement save (commits $before -> $after)",
            before + 1, after)
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

    /** Await the next genuine commit, then read the pane it was committed at. */
    private fun awaitInputThenPane(fixture: Fixture): AndroidRect {
        awaitInput(fixture)
        return compose.runOnIdle { paneBounds(fixture) }
    }

    private fun paneBounds(fixture: Fixture): AndroidRect {
        val surface = requireNotNull(fixture.surface)
        val location = IntArray(2).also(surface::getLocationInWindow)
        return AndroidRect(location[0], location[1], location[0] + surface.width, location[1] + surface.height)
    }

    /** First matching node is the notices copy; the Keys panel may show the same raw status. */
    private fun boundsOf(text: String): ComposeRect =
        compose.onAllNodesWithText(text).onFirst().fetchSemanticsNode().boundsInWindow

    /** An icon-only control has no text, so its bounds come from its description. */
    private fun iconBoundsOf(description: String): ComposeRect =
        compose.onAllNodesWithContentDescription(description).onFirst().fetchSemanticsNode().boundsInWindow

    /** A control's semantics node, whether it presents as text or as an icon description. */
    private fun controlNode(label: String): SemanticsNode =
        compose.onAllNodes(hasText(label) or hasContentDescription(label))
            .onFirst().fetchSemanticsNode()

    /**
     * The scroll container that owns a control, or null when that control's strip does
     * not scroll at all in the current layout.
     */
    private fun scrollOwnerFor(label: String): SemanticsNode? {
        val node = controlNode(label)
        return compose.onAllNodes(hasScrollAction()).fetchSemanticsNodes()
            .firstOrNull { ownsNode(it, node) }
    }

    /**
     * Scrolls a control into view when its own strip really scrolls. A strip the band
     * reservation leaves room for needs no scrolling, and asking a node that has no
     * scroll owner to scroll would fail on the helper rather than on the layout.
     */
    private fun scrollIntoViewIfScrollable(label: String) {
        if (scrollOwnerFor(label) != null) {
            compose.onAllNodes(hasText(label) or hasContentDescription(label)).onFirst().performScrollTo()
        }
    }

    /**
     * The Keys panel's own scrollable area. A short layer can make the control strip a
     * second scroll container in the same composition, so the panel is identified by the
     * header only it owns, never by being the only scrollable node.
     */
    private fun keysPanelScrollNode(): SemanticsNodeInteraction {
        val header = compose.onAllNodesWithText("Conversation A").onFirst().fetchSemanticsNode()
        val owner = compose.onAllNodes(hasScrollAction()).fetchSemanticsNodes()
            .singleOrNull { ownsNode(it, header) }
            ?: error("No scroll container owns the Keys header")
        return interactionFor(owner)
    }

    /**
     * An interaction bound to exactly this semantics node by identity. Scroll containers
     * are found by what they own rather than by being the only scrollable node, and the
     * test API exposes no public interaction constructor, so the identity travels in a
     * matcher on the node's unique id.
     */
    private fun interactionFor(node: SemanticsNode): SemanticsNodeInteraction =
        compose.onNode(SemanticsMatcher("node ${node.id}") { it.id == node.id })

    /** The Keys panel's own measured area: its scrollable content fills the panel. */
    private fun keysPanelBounds(): ComposeRect =
        keysPanelScrollNode().fetchSemanticsNode().boundsInWindow

    /**
     * The floating panel's real 48dp resize-grip container — the pointer-input box, not the
     * 24dp glyph inside it. The tag is the one `TerminalScreen` puts on that container.
     */
    private fun gripContainer(): SemanticsNode =
        compose.onNodeWithTag("terminal-keys-resize-grip").assertIsDisplayed().fetchSemanticsNode()

    /**
     * The floating Keys panel's own frame: the outer bounds its contents tile. The
     * scrollable viewport carries its top and leading edges and the 48dp grip container,
     * aligned to the opposite corner, carries its bottom and trailing edges, so the union is
     * the frame the panel was resized to rather than a fixture's guess at it.
     */
    private fun floatingKeysFrameBounds(): ComposeRect {
        val viewport = keysPanelBounds()
        val grip = gripContainer().boundsInWindow
        return ComposeRect(
            left = minOf(viewport.left, grip.left),
            top = minOf(viewport.top, grip.top),
            right = maxOf(viewport.right, grip.right),
            bottom = maxOf(viewport.bottom, grip.bottom),
        )
    }

    /**
     * A control's window rectangle normalized into the floating panel's own frame, so the
     * same logical position reads the same at any frame size and any independent per-axis
     * scale. A re-wrap or a letterbox inside the frame moves these numbers.
     */
    private fun normalizedRect(bounds: ComposeRect, frame: ComposeRect): NormRect = NormRect(
        left = (bounds.left - frame.left) / frame.width,
        top = (bounds.top - frame.top) / frame.height,
        width = bounds.width / frame.width,
        height = bounds.height / frame.height,
    )

    /**
     * Which keys share a row, in top-to-bottom order, read from normalized positions so a
     * scaled layout reports the same rows it had unscaled. This is the reflow witness: a
     * re-wrapped panel moves a key into another row.
     */
    private fun keyRows(labels: List<String>): List<List<String>> {
        val frame = floatingKeysFrameBounds()
        val tops = labels.associateWith { (controlNode(it).boundsInWindow.top - frame.top) / frame.height }
        return labels.sortedBy { tops.getValue(it) }
            .fold(mutableListOf<MutableList<String>>()) { rows, label ->
                val top = tops.getValue(label)
                val row = rows.firstOrNull { kotlin.math.abs(tops.getValue(it.first()) - top) <= 0.01f }
                if (row != null) row += label else rows += mutableListOf(label)
                rows
            }
    }

    /** A rectangle in fractions of the floating panel's own frame. */
    private data class NormRect(val left: Float, val top: Float, val width: Float, val height: Float) {
        /** The largest single-component difference between two normalized rectangles. */
        fun maximumDeviation(other: NormRect): Float = maxOf(
            kotlin.math.abs(left - other.left),
            kotlin.math.abs(top - other.top),
            kotlin.math.abs(width - other.width),
            kotlin.math.abs(height - other.height),
        )
    }

    /** True when [node] sits inside [container]'s semantics subtree. */
    private fun ownsNode(container: SemanticsNode, node: SemanticsNode): Boolean =
        container.id == node.id || container.children.any { ownsNode(it, node) }

    /**
     * The measured height of one node inside the docked Keys band, used where the band's
     * own content — not the notice overlay above the pane — is what a presentation
     * toggle adds or removes.
     */
    private fun boundsInside(container: ComposeRect, text: String): ComposeRect {
        val matches = compose.onAllNodesWithText(text).fetchSemanticsNodes()
            .filter { container.contains(it.boundsInWindow.center) }
        assertEquals("Exactly one \"$text\" copy sits inside $container: " +
            matches.map { it.boundsInWindow }, 1, matches.size)
        return matches.single().boundsInWindow
    }

    /** Real pointer injection, so an overlapping overlay would intercept the tap. */
    private fun tapByTouch(label: String) {
        val node = compose.onNodeWithText(label).assertIsDisplayed().fetchSemanticsNode()
        val point = node.boundsInRoot.center
        val root = compose.onRoot()
        val origin = root.fetchSemanticsNode().boundsInRoot.topLeft
        root.performTouchInput { click(point - origin) }
    }

    /**
     * Real pointer injection for a control that presents as text or as an icon description,
     * so an icon-only corner control is pressed by an actual touch rather than a synthesized
     * click.
     */
    private fun tapControlByTouch(label: String) {
        val point = controlNode(label).boundsInRoot.center
        val root = compose.onRoot()
        val origin = root.fetchSemanticsNode().boundsInRoot.topLeft
        root.performTouchInput { click(point - origin) }
    }

    /** Real pointer injection at an absolute window point. */
    private fun tapAt(point: Offset) {
        val root = compose.onRoot()
        val origin = root.fetchSemanticsNode().boundsInWindow.topLeft
        root.performTouchInput { click(point - origin) }
    }

    /**
     * Real long-press-and-drag injection. A real timeout is allowed to elapse so the
     * long-press detector arms before movement; repeated moves cross the touch slop so
     * a child button's click is cancelled exactly once a drag is recognized.
     */
    private fun dragBy(label: String, dx: Float, dy: Float, steps: Int = 6) {
        dispatchDrag(label, dx, dy, MotionEvent.ACTION_UP, steps)
    }

    private fun cancelDragBy(label: String, dx: Float, dy: Float) {
        dispatchDrag(label, dx, dy, MotionEvent.ACTION_CANCEL, steps = 6)
    }

    private fun dispatchDrag(label: String, dx: Float, dy: Float, endAction: Int, steps: Int) {
        dispatchDragAt(boundsOf(label).center, dx, dy, endAction, steps)
    }

    /** A completed corner-grip drag: the panel follows and only then is the size saved. */
    private fun resizeKeysPanel(dx: Float, dy: Float, steps: Int = 6) {
        val center = gripContainer().boundsInWindow
        dispatchDragAt(center.center, dx, dy, MotionEvent.ACTION_UP, steps)
    }

    private fun cancelResizeKeysPanel(dx: Float, dy: Float) {
        val center = gripContainer().boundsInWindow
        dispatchDragAt(center.center, dx, dy, MotionEvent.ACTION_CANCEL)
    }

    private fun dispatchDragAt(start: Offset, dx: Float, dy: Float, endAction: Int, steps: Int = 6) {
        val root = compose.activity.window.decorView
        val downTime = SystemClock.uptimeMillis()
        compose.runOnIdle {
            dispatchTouch(root, MotionEvent.ACTION_DOWN, downTime, downTime, start.x, start.y)
        }
        Thread.sleep(650L)
        for (step in 1..steps) {
            val eventTime = SystemClock.uptimeMillis()
            val x = start.x + dx * step / steps
            val y = start.y + dy * step / steps
            compose.runOnIdle { dispatchTouch(root, MotionEvent.ACTION_MOVE, downTime, eventTime, x, y) }
        }
        // The requested travel is completed by the last MOVE above, and the terminal up or
        // cancel is delivered at that same point. Compose ends a drag on the release event
        // without reporting its position change: `drag` and `awaitDragOrCancellation` hand
        // the up change straight to `onDragEnd`, and both `detectDragGestures` and
        // `detectDragGesturesAfterLongPress` go through that loop. Delivering the last
        // increment only in the terminal event would therefore make every gesture one step
        // shorter than the travel it names, which is exactly what the travel checks here
        // measure. Zero movement on the terminal event keeps the requested total real while
        // the event sequence, the long-press timeout, and the idleness handling stay as
        // they were.
        compose.runOnIdle {
            dispatchTouch(root, endAction, downTime, SystemClock.uptimeMillis(), start.x + dx, start.y + dy)
        }
        compose.waitForIdle()
    }

    /**
     * The platform slop the drag detectors actually compare against. Compose reads exactly
     * [android.view.ViewConfiguration.getScaledTouchSlop] through its own
     * `ViewConfiguration.touchSlop`, so this is the value a detector arms on and not a
     * guessed allowance. The events this suite injects are touchscreen-sourced, so no
     * mouse-slop adjustment participates.
     */
    private fun touchSlopPx(): Float = ViewConfiguration.get(compose.activity).scaledTouchSlop.toFloat()

    /**
     * The pointer travel a corner-grip drag cannot report, in physical pixels.
     *
     * `detectDragGestures` arms on the platform slop compared against the displacement the
     * detector accumulated in the scaled layout's own units, and the arming event reports
     * `total − slop · unit(total)`: exactly one slop of the path is discarded before any
     * `dragAmount` exists. The gesture multiplies every reported delta back through the
     * same per-axis factors, so that discarded logical slop costs `slop × travel ÷
     * |travel ÷ scale|` on each axis — scale-aware because the slop is logical while the
     * pointer, and the frame it resizes, are physical.
     */
    private fun gripArmingLossPx(travel: Offset, scaleX: Float, scaleY: Float, slopPx: Float): Offset {
        val logicalLength = kotlin.math.hypot(travel.x / scaleX, travel.y / scaleY)
        if (logicalLength == 0f) return Offset.Zero
        return Offset(slopPx * travel.x / logicalLength, slopPx * travel.y / logicalLength)
    }

    /**
     * The pointer travel a header long-press move cannot report, in physical pixels.
     *
     * `detectDragGesturesAfterLongPress` reports every move once the long press has armed
     * and consumes no slop of its own, but the overlay only begins applying once its
     * accumulated physical distance passes the platform slop, and the first applied event
     * carries only its own delta. The whole steps before that one are therefore never
     * applied, so they are subtracted here rather than hidden inside a widened tolerance.
     */
    private fun headerArmingLossPx(travel: Offset, steps: Int, slopPx: Float): Offset {
        val stepLength = kotlin.math.hypot(travel.x, travel.y) / steps
        val dropped = kotlin.math.floor(slopPx / stepLength).toInt().coerceIn(0, steps - 1)
        return Offset(travel.x * dropped / steps, travel.y * dropped / steps)
    }

    /**
     * The only difference left between a gesture's accounted travel and the panel's
     * measured response: a completed move or resize is committed as permille of the stable
     * layer and resolved back to whole pixels. The bound is taken from the display's own
     * extent, which is never smaller than the stable layer or the free space the permille
     * is taken against, plus a pixel for integer layout rounding.
     */
    private fun commitRoundingPx(): Float {
        val display = compose.activity.resources.displayMetrics
        return maxOf(display.widthPixels, display.heightPixels) / 1000f + 2f
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
                        // Synthetic placement facts only: the count, the docking states, the
                        // remembered sizes, and the permille positions. No input, host,
                        // session, or clipboard value is logged here.
                        Log.i("OverlayPlacementTest", "commit n=$commits placement=$next")
                        placement = next
                    },
                )
            }
        }
    }
}
