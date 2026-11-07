package io.github.rfairburn.pireviewgate.ui

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewTreeObserver
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute
import io.github.rfairburn.pireviewgate.core.input.TerminalFunctionKey
import io.github.rfairburn.pireviewgate.core.input.TerminalKey
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.ui.terminal.FrameCommitReceipt
import io.github.rfairburn.pireviewgate.ui.terminal.InputUnavailableReason
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalInputConnection
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceView
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalViewBinding
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real Canvas commits under ordinary terminal output, with explicitly synthetic
 * immutable snapshots: a genuine platform commit of one input context keeps backing
 * input while same-context publications keep arriving and keep being drawn, a pass
 * that genuinely drew can still earn its commit after newer output, and an undrawn
 * one never can. Taps take focus without raising the soft keyboard.
 */
@RunWith(AndroidJUnit4::class)
class TerminalOutputContinuityComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun burstsOfSameContextOutputKeepTheCommittedProofImeAndEmittedPackets() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitInput(fixture)
        val connection = compose.runOnIdle {
            (fixture.surface!!.onCreateInputConnection(EditorInfo()) as TerminalInputConnection).also {
                assertTrue(it.setComposingText("未確定", 1))
            }
        }
        repeat(5) { burst ->
            compose.runOnIdle {
                val surface = fixture.surface!!
                // Ten publications inside one main-thread turn: no pass can run between them.
                repeat(10) { install(fixture, output(requireNotNull(fixture.binding))) }
                assertTrue("burst $burst", surface.verifyReceipt(anchor))
                assertEquals("burst $burst", anchor, surface.currentInputProof())
                assertEquals("burst $burst", "未確定", connection.composingText)
                // Typed against the standing proof, between output bursts.
                assertTrue("burst $burst", surface.submitKey(TerminalKey(functionKey = TerminalFunctionKey.UP)))
                val packet = fixture.packets.last()
                assertEquals(NativeIoInputKind.KEYBOARD, packet.kind)
                assertEquals(anchor, packet.receipt)
                assertTrue(packet.verifiedAtCapture)
            }
        }
        assertEquals(5, fixture.packets.size)
        // Later output is still actually drawn and committed by the platform.
        val newest = compose.runOnIdle { fixture.binding!!.publishSequence }
        compose.waitUntil(10_000) { fixture.receipts.any { it.publishSequence == newest } }
        compose.runOnIdle {
            val surface = fixture.surface!!
            val display = fixture.receipts.last()
            assertEquals(newest, display.publishSequence)
            assertTrue(display.commitSequence > anchor.commitSequence)
            assertTrue(surface.verifyReceipt(display))
            assertTrue(surface.verifyReceipt(anchor))
            // An intermediate commit that was superseded is not accepted as structurally plausible.
            fixture.receipts.filter { it != anchor && it != display }.forEach { assertFalse(surface.verifyReceipt(it)) }
            assertEquals(anchor, surface.currentInputProof())
            assertEquals("未確定", connection.composingText)
            assertTrue(connection.commitText("確定", 1))
            val packet = fixture.packets.last()
            assertArrayEquals("確定".toByteArray(Charsets.UTF_8), packet.bytes)
            assertEquals(anchor, packet.receipt)
            assertTrue(packet.verifiedAtCapture)
        }
    }

    @Test fun aGenuinelyDrawnFirstPassStillEarnsItsCommitAfterSameContextOutput() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val root = compose.activity.window.decorView
        var drawnSequence = 0L
        var installedSequence = 0L
        var installedBeforeCommit = false
        var armed = false
        // Registered after the pane's own pre-draw listener, so the pane's candidate for
        // this pass already exists. The posted install runs after this traversal has drawn
        // the candidate and before the platform's commit can be delivered to main.
        val preDraw = ViewTreeObserver.OnPreDrawListener {
            if (armed) {
                armed = false
                drawnSequence = fixture.binding!!.publishSequence
                root.post {
                    val surface = fixture.surface!!
                    installedBeforeCommit = surface.currentInputProof() == null
                    val next = output(requireNotNull(fixture.binding))
                    install(fixture, next)
                    installedSequence = next.publishSequence
                }
            }
            true
        }
        compose.runOnIdle {
            root.viewTreeObserver.addOnPreDrawListener(preDraw)
            fixture.receipts.clear()
            // An entry that has not earned its first commit yet.
            fixture.surface!!.invalidateCommittedFrame(InputUnavailableReason.POLICY_RETIRED)
            assertNull(fixture.surface!!.currentInputProof())
            armed = true
            fixture.surface!!.invalidate()
        }
        try {
            val first = awaitInput(fixture)
            compose.runOnIdle {
                assertTrue("The same-context output landed before the commit", installedBeforeCommit)
                assertTrue(installedSequence > drawnSequence)
                // Built from what the candidate actually drew, never from the newest binding.
                assertEquals(drawnSequence, first.publishSequence)
                assertTrue(fixture.surface!!.verifyReceipt(first))
                assertTrue(fixture.surface!!.submitKey(TerminalKey(codepoint = 9)))
                assertEquals(first, fixture.packets.last().receipt)
                assertTrue(fixture.packets.last().verifiedAtCapture)
            }
            // The newer binding is drawn and committed afterwards; the anchor stays.
            compose.waitUntil(10_000) { fixture.receipts.any { it.publishSequence == installedSequence } }
            compose.runOnIdle { assertEquals(first, fixture.surface!!.currentInputProof()) }
        } finally {
            compose.runOnIdle { if (root.viewTreeObserver.isAlive) root.viewTreeObserver.removeOnPreDrawListener(preDraw) }
        }
    }

    @Test fun anUndrawnCandidateSupersededBySameContextOutputIsNeverAttested() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val root = compose.activity.window.decorView
        var undrawnSequence = 0L
        var replacementSequence = 0L
        var armed = false
        // Runs after the pane's pre-draw created its candidate and before anything is drawn.
        val onDraw = ViewTreeObserver.OnDrawListener {
            if (armed) {
                armed = false
                undrawnSequence = fixture.binding!!.publishSequence
                val next = output(requireNotNull(fixture.binding))
                install(fixture, next)
                replacementSequence = next.publishSequence
            }
        }
        compose.runOnIdle {
            root.viewTreeObserver.addOnDrawListener(onDraw)
            fixture.receipts.clear()
            fixture.surface!!.invalidateCommittedFrame(InputUnavailableReason.POLICY_RETIRED)
            armed = true
            fixture.surface!!.invalidate()
        }
        try {
            val earned = awaitInput(fixture)
            compose.runOnIdle {
                assertTrue(replacementSequence > undrawnSequence)
                assertEquals(replacementSequence, earned.publishSequence)
                assertTrue("The undrawn candidate attested nothing",
                    fixture.receipts.none { it.publishSequence == undrawnSequence })
            }
        } finally {
            compose.runOnIdle { if (root.viewTreeObserver.isAlive) root.viewTreeObserver.removeOnDrawListener(onDraw) }
        }
    }

    @Test fun genuineContextChangesAmidOutputRetireTheProofAndTheImeConnection() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitInput(fixture)
        val connection = compose.runOnIdle {
            (fixture.surface!!.onCreateInputConnection(EditorInfo()) as TerminalInputConnection).also {
                assertTrue(it.setComposingText("未確定", 1))
            }
        }
        compose.runOnIdle {
            val surface = fixture.surface!!
            repeat(5) { install(fixture, output(requireNotNull(fixture.binding))) }
            assertTrue(surface.verifyReceipt(anchor))
            val current = requireNotNull(fixture.binding)
            // A -> B -> A whose B emission was conflated: only the generation moved.
            install(fixture, output(current).copy(inputGeneration = current.inputGeneration + 1))
            assertFalse(surface.verifyReceipt(anchor))
            assertNull(surface.currentInputProof())
            assertEquals("", connection.composingText)
            assertFalse(connection.commitText("stale", 1))
            assertFalse(surface.submitKey(TerminalKey(codepoint = 9)))
            assertTrue(fixture.packets.isEmpty())
        }
        val fresh = awaitInput(fixture)
        compose.runOnIdle {
            assertNotEquals(anchor, fresh)
            assertFalse(fixture.surface!!.verifyReceipt(anchor))
            assertFalse("A retired connection never revives", connection.commitText("stale", 1))
            assertTrue(fixture.packets.isEmpty())
        }
    }

    @Test fun aTapTakesFocusWithoutRaisingTheKeyboardWhileTheExplicitControlStillDoes() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        fun imeVisible(): Boolean = compose.runOnIdle {
            fixture.surface?.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
        }
        try {
            assertFalse(imeVisible())
            compose.runOnIdle {
                val surface = fixture.surface!!
                surface.clearFocus()
                tap(surface)
                assertTrue("A tap still takes focus", surface.hasFocus())
                assertTrue(fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            }
            // Bounded observation window: the platform would have shown an IME requested
            // by the tap well within it. This is a negative check, so it must time out.
            val raised = runCatching { compose.waitUntil(1_500) { imeVisible() } }.isSuccess
            assertFalse("A terminal tap must not raise the soft keyboard", raised)
            // The explicit keyboard control remains the one path that opens it.
            compose.onNodeWithText("Keyboard").performScrollTo().performClick()
            compose.runOnIdle {
                assertEquals(ClientIntent.SetTerminalKeyboardVisible(true), fixture.intents.last().intent)
            }
            compose.waitUntil(10_000) { imeVisible() }
        } finally {
            compose.runOnIdle {
                fixture.surface?.windowInsetsController?.hide(WindowInsets.Type.ime())
                fixture.state = fixture.state.copy(route = ClientRoute.Sessions)
            }
        }
    }

    private fun tap(surface: TerminalSurfaceView) {
        val now = SystemClock.uptimeMillis()
        val x = surface.width / 2f
        val y = surface.height / 2f
        listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).forEach { action ->
            val event = MotionEvent.obtain(now, now + if (action == MotionEvent.ACTION_UP) 30 else 0, action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try { surface.dispatchTouchEvent(event) } finally { event.recycle() }
        }
    }

    private fun install(fixture: NativeUiFixture, binding: TerminalViewBinding) {
        fixture.surface!!.setBinding(binding)
        fixture.binding = binding
    }

    /** Ordinary output: same context, newer publish, different displayed text. */
    private fun output(binding: TerminalViewBinding): TerminalViewBinding {
        val sequence = binding.publishSequence + 1
        return binding.copy(
            publishSequence = sequence,
            frame = binding.frame.copy(lines = binding.frame.lines.mapIndexed { row, _ ->
                "\u001b[0m${"Output $sequence row $row".take(binding.frame.cols).padEnd(binding.frame.cols)}\u001b[0m"
            }),
        )
    }

    private fun terminalFixture() = NativeUiFixture(NativeUiFixtures.sessions().copy(
        route = ClientRoute.Terminal(NativeUiFixtures.terminal()),
    )).apply { binding = NativeUiFixtures.binding(sourced = true) }

    private fun awaitInput(fixture: NativeUiFixture): FrameCommitReceipt {
        var committed: FrameCommitReceipt? = null
        try {
            compose.waitUntil(10_000) {
                committed = compose.runOnIdle {
                    val surface = fixture.surface
                    surface?.currentInputProof()?.also { assertTrue(surface.verifyReceipt(it)) }
                }
                committed != null
            }
        } catch (error: Throwable) {
            compose.runOnIdle { fixture.logTerminalState("continuity-commit-timeout") }
            throw error
        }
        return requireNotNull(committed)
    }
}
