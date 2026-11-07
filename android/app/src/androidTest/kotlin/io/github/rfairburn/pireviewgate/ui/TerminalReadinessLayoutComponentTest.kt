package io.github.rfairburn.pireviewgate.ui

import android.util.Size
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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

/** Actual native commits must not resize the pane through readiness presentation. */
@RunWith(AndroidJUnit4::class)
class TerminalReadinessLayoutComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun realCommittedReadinessKeepsPanePixelsAndViewportRequestsInvariant() {
        var terminal by mutableStateOf(NativeUiFixtures.terminal())
        var binding by mutableStateOf(NativeUiFixtures.binding(sourced = true))
        var surface: TerminalSurfaceView? = null
        val viewports = CopyOnWriteArrayList<Pair<Int, Int>>()
        val receipts = CopyOnWriteArrayList<FrameCommitReceipt>()
        var beforeReady: Pair<Size, Int>? = null
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
                if (beforeReady == null) beforeReady = Size(view.width, view.height) to viewports.size
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
                onIntent = { error("No navigation gesture in layout test") },
            )
        }
        compose.waitUntil(10_000) { terminal.inputReady && receipts.isNotEmpty() }
        compose.waitForIdle()
        fun assertStablePane() = compose.runOnIdle {
            val view = requireNotNull(surface)
            val (pixels, requests) = requireNotNull(beforeReady)
            assertEquals(pixels, Size(view.width, view.height))
            assertEquals("Readiness alone must not request another resize", requests, viewports.size)
            assertTrue(terminal.inputReady)
            assertTrue(view.verifyReceipt(requireNotNull(view.currentInputProof())))
        }
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
    }
}
