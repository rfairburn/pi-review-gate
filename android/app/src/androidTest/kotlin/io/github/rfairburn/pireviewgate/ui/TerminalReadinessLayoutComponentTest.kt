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
 * Actual native commits must not resize or move the pane through readiness,
 * status, or Keys-panel presentation: all of them are overlays on a full pane.
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
        var beforeReady: Pair<Rect, Int>? = null
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
                if (beforeReady == null) beforeReady = view.windowBounds() to viewports.size
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
        fun assertStablePane() = compose.runOnIdle {
            val view = requireNotNull(surface)
            val (pixels, requests) = requireNotNull(beforeReady)
            assertEquals("Pane must not move or resize", pixels, view.windowBounds())
            assertTrue(view.hasFocus())
            assertEquals("Readiness alone must not request another resize", requests, viewports.size)
            assertTrue(terminal.inputReady)
            assertTrue(view.verifyReceipt(requireNotNull(view.currentInputProof())))
        }
        assertStablePane()
        // Status arrives and is dismissed as an overlay, never a reserved slot.
        compose.runOnIdle { status = "Synthetic status notice" }
        compose.onNodeWithText("Synthetic status notice").assertIsDisplayed()
        assertStablePane()
        compose.onNodeWithText("Dismiss").performClick()
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        assertStablePane()
        // Debug off removes the whole notices surface, including its dismiss control.
        // A notice the producer publishes afterwards stays hidden, and the pane is
        // still never moved or resized by any of this.
        compose.runOnIdle { debugNotices = false }
        compose.runOnIdle { status = "Second synthetic status notice" }
        compose.onAllNodesWithText("Second synthetic status notice").assertCountEquals(0)
        compose.onAllNodesWithText("Dismiss").assertCountEquals(0)
        assertStablePane()
        // Turning debugging back on returns the producer's current last value only.
        // The notice dismissed above is not resurrected and nothing is replayed.
        compose.runOnIdle { debugNotices = true }
        compose.onNodeWithText("Second synthetic status notice").assertIsDisplayed()
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        assertStablePane()
        compose.onNodeWithText("Dismiss").performClick()
        compose.onAllNodesWithText("Second synthetic status notice").assertCountEquals(0)
        assertStablePane()
        // The Keys panel stays open through the readiness churn below.
        compose.onNodeWithText("Keys").performClick()
        compose.onNodeWithText("Esc").assertIsDisplayed()
        assertStablePane()
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
            assertStablePane()
        }
        compose.onNodeWithText("Close keys").performClick()
        compose.onAllNodesWithText("Esc").assertCountEquals(0)
        assertStablePane()
    }

    private fun TerminalSurfaceView.windowBounds(): Rect {
        val location = IntArray(2).also(this::getLocationInWindow)
        return Rect(location[0], location[1], location[0] + width, location[1] + height)
    }
}
