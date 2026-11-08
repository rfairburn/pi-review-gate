package io.github.rfairburn.pireviewgate.ui

import android.graphics.Rect
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.ui.client.TerminalScreen
import io.github.rfairburn.pireviewgate.ui.terminal.FrameCommitReceipt
import io.github.rfairburn.pireviewgate.ui.terminal.InputUnavailableReason
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurface
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceListener
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceView
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Actual native commits must not resize or move the pane through readiness, status, or
 * Keys presentation. Docking the Keys panel is the one reservation the layout makes on
 * purpose: it takes real pane area once, and after that single real reflow settles,
 * nothing else in this screen moves the pane again.
 */
@RunWith(AndroidJUnit4::class)
class TerminalReadinessLayoutComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun realCommittedReadinessKeepsPanePixelsAndViewportRequestsInvariant() {
        var terminal by mutableStateOf(NativeUiFixtures.terminal())
        var binding by mutableStateOf(NativeUiFixtures.binding(sourced = true))
        var status by mutableStateOf<String?>(null)
        // The saved whole-app debug presentation. This test's existing assertions cover
        // the notice surface, so it starts enabled and flips it off only for the
        // suppression phase below.
        var debugNotices by mutableStateOf(true)
        var surface: TerminalSurfaceView? = null
        val viewports = CopyOnWriteArrayList<Pair<Int, Int>>()
        val receipts = CopyOnWriteArrayList<FrameCommitReceipt>()
        val listener = object : TerminalSurfaceListener {
            override fun onViewportRequested(cols: Int, rows: Int) {
                viewports += cols to rows
                assertTrue(cols >= 80 && rows >= 25)
                binding = NativeUiFixtures.binding(sourced = true, cols = cols, rows = rows,
                    revision = binding.geometry.revision + 1)
                surface?.setBinding(binding)
                // Same dependency as production: a genuine viewport change drops readiness.
                terminal = terminal.copy(inputReady = false)
            }
            override fun onFrameCommitted(receipt: FrameCommitReceipt) {
                val view = requireNotNull(surface)
                if (!view.verifyReceipt(receipt)) return
                receipts += receipt
                // No test-minted proof: only the real platform-committed native receipt.
                terminal = terminal.copy(inputReady = true)
            }
            override fun onInput(kind: NativeIoInputKind, bytes: ByteArray, receipt: FrameCommitReceipt) {
                error("This layout-only test must not submit input")
            }
            override fun onInputUnavailable(reason: InputUnavailableReason) = Unit
        }
        compose.setContent {
            TerminalScreen(
                terminal = terminal,
                terminalContent = {
                    TerminalSurface(binding, Modifier.fillMaxSize(), listener) { view ->
                        surface = view
                        view.post { view.requestFocus() }
                    }
                },
                onKey = { error("No key gesture in layout test") },
                onPaste = { error("No paste gesture in layout test") },
                // Keys panel and status dismissal are screen-local presentation:
                // neither may emit an intent (coverage, focus, or otherwise).
                onIntent = { error("No navigation gesture in layout test") },
                status = status,
                debugInputMessagingEnabled = debugNotices,
            )
        }
        compose.waitUntil(10_000) { terminal.inputReady && receipts.isNotEmpty() }
        compose.waitForIdle()
        val undocked = compose.runOnIdle { requireNotNull(surface).windowBounds() }
        fun assertPaneUnchanged(anchor: Rect, phase: String) = compose.runOnIdle {
            val view = requireNotNull(surface)
            assertEquals("Pane must not move or resize ($phase)", anchor, view.windowBounds())
            assertTrue(view.hasFocus())
            assertTrue(terminal.inputReady)
            assertTrue(view.verifyReceipt(requireNotNull(view.currentInputProof())))
        }
        val requestsBeforeDock = compose.runOnIdle { viewports.size }
        fun assertNoNewResize(from: Int, phase: String) = compose.runOnIdle {
            assertEquals("Nothing here must request another resize ($phase)", from, viewports.size)
        }

        // Status and debug presentation come first, with Keys closed: the notice is then
        // a single overlay copy, and no docked band is measuring it a second time.
        compose.runOnIdle { status = "Synthetic status notice" }
        compose.onNodeWithText("Synthetic status notice").assertIsDisplayed()
        assertPaneUnchanged(undocked, "status arrived")
        assertNoNewResize(requestsBeforeDock, "status arrived")
        compose.onNodeWithText("Dismiss").performClick()
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        assertPaneUnchanged(undocked, "status dismissed")
        assertNoNewResize(requestsBeforeDock, "status dismissed")
        // Debug off removes the whole notices surface, including its dismiss control.
        // A notice the producer publishes afterwards stays hidden, and the pane is
        // still never moved or resized by any of this.
        compose.runOnIdle { debugNotices = false }
        compose.runOnIdle { status = "Second synthetic status notice" }
        compose.onAllNodesWithText("Second synthetic status notice").assertCountEquals(0)
        compose.onAllNodesWithText("Dismiss").assertCountEquals(0)
        assertPaneUnchanged(undocked, "debug off")
        assertNoNewResize(requestsBeforeDock, "debug off")
        // Turning debugging back on returns the producer's current last value only.
        // The notice dismissed above is not resurrected and nothing is replayed.
        compose.runOnIdle { debugNotices = true }
        compose.onNodeWithText("Second synthetic status notice").assertIsDisplayed()
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        assertPaneUnchanged(undocked, "debug on again")
        assertNoNewResize(requestsBeforeDock, "debug on again")
        // The notice that arrived while debugging was off is dismissed by its own
        // control, the same user action that dismissed the first one, rather than by
        // clearing the producer's value. It is also cleared before docking, so the
        // band's own duplicate of a raw status cannot be mistaken for a reservation
        // change below.
        compose.onNodeWithText("Dismiss").performClick()
        compose.onAllNodesWithText("Second synthetic status notice").assertCountEquals(0)
        assertPaneUnchanged(undocked, "second notice dismissed")
        assertNoNewResize(requestsBeforeDock, "second notice dismissed")

        // Docked Keys is a real bottom band, not an overlay: it reserves actual pane
        // area, and the surface's own size change is what asks for a new grid.
        // The wait has to observe the reflow itself. `inputReady` plus a non-null proof
        // is already true before the band composes, so it would return on the pre-dock
        // state and leave the geometry assertions below racing. Here the pane's bottom
        // must have moved and a commit newer than the pre-dock one must be standing.
        val preDock = requireNotNull(compose.runOnIdle { surface?.currentInputProof() })
        compose.onNodeWithText("Keys").performClick()
        compose.waitUntil(10_000) {
            val observed = compose.runOnIdle {
                val view = requireNotNull(surface)
                Triple(view.windowBounds(), view.currentInputProof(), terminal.inputReady)
            }
            val proof = observed.second
            observed.third && proof != null && proof.commitSequence > preDock.commitSequence &&
                observed.first.bottom < undocked.bottom
        }
        compose.waitForIdle()
        val docked = compose.runOnIdle { requireNotNull(surface).windowBounds() }
        compose.runOnIdle {
            assertEquals("Docked Keys must not move the pane's top or sides",
                Triple(undocked.left, undocked.top, undocked.right),
                Triple(docked.left, docked.top, docked.right))
            assertTrue("Docked Keys must reserve real pane area: $undocked vs $docked",
                docked.bottom < undocked.bottom)
            assertTrue("A real reflow must have been requested", viewports.size > requestsBeforeDock)
            val view = requireNotNull(surface)
            assertFalse("The real resize must retire the pre-dock commit",
                view.verifyReceipt(preDock))
            val fresh = requireNotNull(view.currentInputProof())
            assertNotEquals("The standing proof is a new platform commit, not the pre-dock one",
                preDock.commitSequence, fresh.commitSequence)
            assertTrue("Only a fresh commit for the new geometry stands", view.verifyReceipt(fresh))
        }
        val requestsAfterDock = compose.runOnIdle { viewports.size }
        // From here the band stays open, so this is the one reservation the layout made
        // on purpose, and readiness churn has to leave that measured area alone.
        assertPaneUnchanged(docked, "docked")
        assertNoNewResize(requestsAfterDock, "docked")
        compose.onNodeWithText("Esc").assertIsDisplayed()
        repeat(3) {
            var oldSequence = 0L
            compose.runOnIdle {
                val view = requireNotNull(surface)
                val old = requireNotNull(view.currentInputProof())
                oldSequence = old.commitSequence
                view.invalidateCommittedFrame(InputUnavailableReason.POLICY_RETIRED)
                terminal = terminal.copy(inputReady = false)
                assertFalse(view.verifyReceipt(old))
                view.invalidate()
            }
            compose.waitUntil(10_000) {
                terminal.inputReady && (surface?.currentInputProof()?.commitSequence ?: 0L) > oldSequence
            }
            compose.waitForIdle()
            assertPaneUnchanged(docked, "readiness churn")
            assertNoNewResize(requestsAfterDock, "readiness churn")
        }
        // Closing the docked band gives the pane back exactly the area it held before.
        val dockedReceipt = requireNotNull(compose.runOnIdle { surface?.currentInputProof() })
        compose.onNodeWithText("Close keys").performClick()
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
        compose.waitUntil(10_000) {
            val observed = compose.runOnIdle {
                val view = requireNotNull(surface)
                Triple(view.windowBounds(), view.currentInputProof(), terminal.inputReady)
            }
            val proof = observed.second
            observed.third && proof != null && proof.commitSequence > dockedReceipt.commitSequence &&
                observed.first == undocked
        }
        compose.waitForIdle()
        compose.runOnIdle {
            val view = requireNotNull(surface)
            assertEquals("Closing docked Keys must return the reserved area",
                undocked, view.windowBounds())
            assertTrue(view.hasFocus())
            assertFalse("Giving the area back retires the band's commit",
                view.verifyReceipt(dockedReceipt))
            assertTrue(view.verifyReceipt(requireNotNull(view.currentInputProof())))
        }
    }

    private fun TerminalSurfaceView.windowBounds(): Rect {
        val location = IntArray(2).also(this::getLocationInWindow)
        return Rect(location[0], location[1], location[0] + width, location[1] + height)
    }
}
