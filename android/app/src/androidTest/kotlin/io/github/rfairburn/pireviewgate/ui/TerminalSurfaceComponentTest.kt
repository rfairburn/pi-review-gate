package io.github.rfairburn.pireviewgate.ui

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Rect
import android.graphics.Paint
import android.graphics.Typeface
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.os.SystemClock
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.view.inputmethod.EditorInfo
import androidx.test.platform.app.InstrumentationRegistry
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.util.Log
import android.view.ViewTreeObserver
import android.view.WindowInsets
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.input.ImeCommitEncoder
import io.github.rfairburn.pireviewgate.core.input.KeyboardEncoder
import io.github.rfairburn.pireviewgate.core.input.KeyboardModifiers
import io.github.rfairburn.pireviewgate.core.input.PasteEncoder
import io.github.rfairburn.pireviewgate.core.input.TerminalFunctionKey
import io.github.rfairburn.pireviewgate.core.input.TerminalKey
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoStartupSource
import io.github.rfairburn.pireviewgate.ui.terminal.FrameCommitReceipt
import io.github.rfairburn.pireviewgate.ui.terminal.InputUnavailableReason
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalInputConnection
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceView
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalViewBinding
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Real Canvas commits and renderer APIs, with explicitly synthetic immutable snapshots. */
@RunWith(AndroidJUnit4::class)
class TerminalSurfaceComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun sourceAbsentFrameReallyCommitsPixelsButNeverAuthorizesInput() {
        val fixture = terminalFixture(sourced = false)
        compose.setContent { fixture.Content() }
        try {
            compose.waitUntil(10_000) { fixture.receipts.isNotEmpty() }
        } catch (error: Throwable) {
            compose.runOnIdle { fixture.logTerminalState("display-commit-timeout") }
            captureSyntheticScreen("display-commit-timeout")
            throw error
        }
        compose.runOnIdle {
            val surface = requireNotNull(fixture.surface)
            val receipt = requireNotNull(surface.currentReceipt())
            assertNull(receipt.source)
            assertFalse(receipt.authorizesInput)
            assertTrue(receipt.drawnColumns > 0 && receipt.drawnRows > 0)
            assertFalse(surface.verifyReceipt(receipt))
            assertNull(surface.currentInputProof())
            assertFalse(surface.submitKey(TerminalKey(codepoint = 9)))
            assertFalse(surface.submitPastedText("fixed synthetic paste"))
            assertTrue(fixture.packets.isEmpty())
            assertTrue(fixture.refusals.contains(InputUnavailableReason.SOURCE_ABSENT))
        }
        compose.onNodeWithText("Keys").assertIsDisplayed().performClick()
        compose.onNodeWithText("Paste").performScrollTo().assertIsDisplayed().assertIsNotEnabled()
        compose.onNodeWithText("Esc").performScrollTo().assertIsDisplayed().assertIsNotEnabled()
        compose.runOnIdle {
            assertNull(fixture.surface!!.currentInputProof())
            assertTrue(fixture.packets.isEmpty())
        }
        captureSyntheticScreen("display-only-terminal")
    }

    @Test fun committedToolbarKeysModifiersAndFixedPasteUseRealRendererPacketsAndReceipt() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        compose.onNodeWithText("Keys").assertIsDisplayed().performClick()
        compose.onNodeWithText("Ctrl").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(KeyboardModifiers.CTRL, fixture.surface!!.selectedMobileModifiers()) }
        compose.onNodeWithText("↑").performScrollTo().performClick()
        compose.runOnIdle {
            val packet = fixture.packets.single()
            assertEquals(NativeIoInputKind.KEYBOARD, packet.kind)
            assertArrayEquals("\u001b[1;5A".toByteArray(Charsets.UTF_8), packet.bytes)
            assertTrue(packet.verifiedAtCapture)
            assertEquals(NativeUiFixtures.hostA.value, packet.receipt.hostId)
            assertEquals("duplicate-row", packet.receipt.rowId)
            assertEquals(1L, packet.receipt.selectionGeneration)
        }
        compose.onNodeWithText("Paste").performScrollTo().performClick()
        compose.runOnIdle {
            val packet = fixture.packets.last()
            assertEquals(NativeIoInputKind.PASTE, packet.kind)
            assertArrayEquals("\u001b[200~fixed synthetic paste\u001b[201~".toByteArray(Charsets.UTF_8), packet.bytes)
            assertTrue(packet.verifiedAtCapture)
            // A held Ctrl never rewrites a paste.
            assertEquals(KeyboardModifiers.CTRL, fixture.surface!!.selectedMobileModifiers())
        }
        captureSyntheticScreen("sourced-terminal")
    }

    @Test fun modalFocusLayoutAndTargetChangesFenceOldReceiptsUntilNewCommit() {
        val fixture = terminalFixture(sourced = true)
        var bottomInset by mutableStateOf(0.dp)
        compose.setContent {
            Box(Modifier.fillMaxSize().padding(bottom = bottomInset)) { fixture.Content() }
        }
        var old = awaitInput(fixture)
        val dialogProof = NativeUiFixtures.rowProof(generation = 2)
        compose.runOnIdle {
            fixture.state = fixture.state.copy(dialogs = ClientDialogs(closeSession =
                CloseSessionDialog(SessionActionTarget.of(fixture.state.sessions.first()), dialogProof)))
        }
        compose.waitUntil(10_000) { !fixture.surface!!.verifyReceipt(old) }
        compose.waitUntil(10_000) { dialogProof.grantsAction() }
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertFalse(surface.submitKey(TerminalKey(codepoint = 9)))
            assertTrue(fixture.packets.isEmpty())
            fixture.state = fixture.state.copy(dialogs = ClientDialogs.NONE)
        }
        val afterModal = awaitInput(fixture)
        assertNotEquals(old, afterModal)
        assertFalse(fixture.surface!!.verifyReceipt(old))
        old = afterModal
        compose.runOnIdle {
            val surface = fixture.surface!!
            surface.clearFocus()
            assertFalse(surface.hasFocus())
            assertFalse(surface.verifyReceipt(old))
            assertFalse(surface.submitKey(TerminalKey(codepoint = 9)))
            assertTrue(surface.requestFocus())
            assertFalse("Requesting focus is not a frame commit", surface.verifyReceipt(old))
        }
        val afterFocus = awaitInput(fixture)
        assertNotEquals(old, afterFocus)
        old = afterFocus
        val previousPane = compose.runOnIdle { paneBounds(fixture) }
        val previousRequests = fixture.viewports.size
        compose.onNodeWithText("Keys").assertIsDisplayed().performClick()
        compose.onNodeWithText("More keys").performScrollTo().performClick()
        compose.onNodeWithText("F12").assertExists()
        compose.runOnIdle {
            assertEquals("The extra-key overlay is not a layout change", previousPane, paneBounds(fixture))
            assertEquals(previousRequests, fixture.viewports.size)
            assertTrue(fixture.surface!!.verifyReceipt(old))
        }
        val connection = compose.runOnIdle {
            (fixture.surface!!.onCreateInputConnection(EditorInfo()) as TerminalInputConnection).also {
                assertTrue(it.setComposingText("未確定", 1))
            }
        }
        var observedLayoutRetirement = false
        val onResize = View.OnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) {
                // Observe the REAL native size change before its replacement draw can
                // commit. An overlay toggle cannot exercise this negative anymore.
                assertRetiredIme("real pane resize", fixture, connection, old)
                assertNull(fixture.surface!!.currentInputProof())
                assertFalse(fixture.surface!!.submitKey(TerminalKey(codepoint = 9)))
                observedLayoutRetirement = true
            }
        }
        compose.runOnIdle {
            fixture.surface!!.addOnLayoutChangeListener(onResize)
            bottomInset = 96.dp
        }
        val afterResize = try {
            compose.waitUntil(10_000) { compose.runOnIdle { observedLayoutRetirement } }
            awaitInput(fixture)
        } finally {
            compose.runOnIdle { fixture.surface!!.removeOnLayoutChangeListener(onResize) }
        }
        compose.runOnIdle {
            assertNotEquals(previousPane, paneBounds(fixture))
            assertTrue(fixture.viewports.size > previousRequests)
            assertRetiredIme("real pane resize stays retired", fixture, connection, old)
            assertTrue(afterResize.layoutEpoch > old.layoutEpoch)
        }
        captureSyntheticScreen("native-pane-resize")
        old = afterResize
        compose.runOnIdle {
            val surface = fixture.surface!!
            val (cols, rows) = fixture.viewports.last()
            val replacement = NativeUiFixtures.binding(sourced = true, selection = 2, cols = cols, rows = rows)
            // Real public renderer API: retire synchronously, before requesting a new draw.
            surface.setBinding(replacement)
            fixture.binding = replacement
            val route = fixture.state.route as ClientRoute.Terminal
            fixture.state = fixture.state.copy(route = ClientRoute.Terminal(
                route.terminal.rebasedTo(route.terminal.target.copy(selectionGeneration = 2))))
            assertFalse(surface.verifyReceipt(old))
            assertNull(surface.currentInputProof())
            assertFalse(surface.submitKey(TerminalKey(functionKey = TerminalFunctionKey.UP)))
            assertEquals(0, surface.selectedMobileModifiers())
        }
        val afterTarget = awaitInput(fixture)
        compose.runOnIdle {
            assertFalse(fixture.surface!!.verifyReceipt(old))
            assertEquals(2L, afterTarget.selectionGeneration)
            val current = requireNotNull(fixture.surface!!.currentInputProof())
            assertTrue(fixture.surface!!.verifyReceipt(current))
            assertTrue(fixture.surface!!.submitKey(TerminalKey(functionKey = TerminalFunctionKey.UP)))
            assertEquals(current, fixture.packets.single().receipt)
            assertTrue(fixture.packets.single().verifiedAtCapture)
        }
    }

    @Test fun codePointImeDeletionConsumesCompositionAndReportsBoundedRemoteDeliveryHonestly() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = compose.runOnIdle {
            fixture.surface!!.onCreateInputConnection(EditorInfo()) as TerminalInputConnection
        }
        compose.runOnIdle {
            assertTrue(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertArrayEquals(byteArrayOf(127), fixture.packets.single().bytes)
            assertEquals(proof, fixture.packets.single().receipt)
            assertTrue(fixture.packets.single().verifiedAtCapture)
            fixture.packets.clear()

            assertTrue(connection.setComposingText("A\uD83D\uDE00", 1))
            assertTrue(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertEquals("A", connection.composingText)
            assertTrue(fixture.packets.isEmpty())
            // No orphan surrogate: the surviving composition is a valid commit.
            assertTrue(connection.finishComposingText())
            assertArrayEquals("A".toByteArray(Charsets.UTF_8), fixture.packets.single().bytes)
            fixture.packets.clear()

            assertTrue(connection.setComposingText("\uD83D\uDE00", 1))
            assertTrue(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertEquals("", connection.composingText)
            assertTrue(fixture.packets.isEmpty())
            assertTrue(connection.setComposingText("\uD83D\uDE00", 1))
            assertTrue(connection.deleteSurroundingTextInCodePoints(3, 0))
            assertEquals("", connection.composingText)
            assertEquals(2, fixture.packets.size)
            fixture.packets.forEach { assertArrayEquals(byteArrayOf(127), it.bytes) }
            assertTrue(connection.finishComposingText())
            assertEquals(2, fixture.packets.size)
            fixture.packets.clear()

            // The full allowed batch leaves, never a silent clamp of an oversized one.
            assertTrue(connection.deleteSurroundingTextInCodePoints(ImeCommitEncoder.MAX_DELETION_REQUEST, 0))
            assertEquals(ImeCommitEncoder.MAX_DELETION_REQUEST, fixture.packets.size)
            fixture.packets.forEach {
                assertArrayEquals(byteArrayOf(127), it.bytes)
                assertEquals(proof, it.receipt)
                assertTrue(it.verifiedAtCapture)
            }
            fixture.packets.clear()
            assertFalse(connection.deleteSurroundingTextInCodePoints(ImeCommitEncoder.MAX_DELETION_REQUEST + 1, 0))
            assertEquals(InputUnavailableReason.COMMIT_TOO_LARGE, fixture.refusals.last())
            assertTrue(fixture.packets.isEmpty())
            assertTrue(connection.deleteSurroundingTextInCodePoints(0, 5))
            assertTrue(fixture.packets.isEmpty())

            // Ordinary output in the same input context keeps the committed proof: the
            // deletion is still delivered, attributed to that same genuine commit.
            installBinding(fixture, contentOnlyPublish(requireNotNull(fixture.binding)))
            assertTrue(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertArrayEquals(byteArrayOf(127), fixture.packets.single().bytes)
            assertEquals(proof, fixture.packets.single().receipt)
            assertTrue(fixture.packets.single().verifiedAtCapture)
            fixture.packets.clear()
        }
        val fresh = awaitInput(fixture)
        compose.runOnIdle {
            assertEquals("Same-context output never replaces the input anchor", proof, fresh)
            assertTrue(fixture.surface!!.verifyReceipt(proof))
            assertTrue(connection.finishComposingText())
            assertTrue("A finished empty composition sends nothing", fixture.packets.isEmpty())
            assertTrue(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertEquals(fresh, fixture.packets.single().receipt)
            // Replacing the InputConnection also permanently retires the old object.
            fixture.surface!!.onCreateInputConnection(EditorInfo())
            val count = fixture.packets.size
            assertFalse(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertEquals(count, fixture.packets.size)
        }
    }

    @Test fun sameContextPublishPreservesImeCompositionAndTheGenuineCommittedProof() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val old = awaitInput(fixture)
        val connection = compose.runOnIdle {
            fixture.surface!!.onCreateInputConnection(EditorInfo()) as TerminalInputConnection
        }
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(connection.setComposingText("ni", 1))
            assertTrue(surface.setMobileModifiers(KeyboardModifiers.SHIFT))
            val next = contentOnlyPublish(requireNotNull(fixture.binding))
            assertNotEquals(fixture.binding!!.frame.lines, next.frame.lines)
            installBinding(fixture, next)
            // Ordinary output: the newer pixels have no display commit yet, but the
            // input context's genuine commit keeps standing.
            assertNull(surface.currentReceipt())
            assertTrue(surface.verifyReceipt(old))
            assertEquals(old, surface.currentInputProof())
            assertEquals("ni", connection.composingText)
            assertEquals(KeyboardModifiers.SHIFT, surface.selectedMobileModifiers())
            surface.clearMobileModifiers()
            assertTrue(connection.commitText("中文", 1))
            val packet = fixture.packets.single()
            assertArrayEquals("中文".toByteArray(Charsets.UTF_8), packet.bytes)
            assertEquals(old, packet.receipt)
            assertTrue(packet.verifiedAtCapture)
            fixture.packets.clear()
            assertTrue(connection.setComposingText("zhong", 1))
        }
        // The newer binding still earns its own actual display commit.
        val shown = compose.runOnIdle { fixture.binding!!.publishSequence }
        compose.waitUntil(10_000) { fixture.receipts.any { it.publishSequence == shown } }
        compose.runOnIdle {
            val surface = fixture.surface!!
            val display = fixture.receipts.last { it.publishSequence == shown }
            assertTrue(display.commitSequence > old.commitSequence)
            assertEquals(display, surface.currentReceipt())
            assertTrue(surface.verifyReceipt(display))
            assertTrue(surface.verifyReceipt(old))
            assertEquals("A newer same-context commit never replaces the anchor", old, surface.currentInputProof())
            assertEquals("zhong", connection.composingText)
            assertTrue(connection.commitText("中", 1))
            val packet = fixture.packets.single()
            assertEquals(old, packet.receipt)
            assertTrue(packet.verifiedAtCapture)
        }
    }

    @Test fun meaningfulBindingChangesStillRetireImeConnectionsAndDiscardComposition() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val baseline = compose.runOnIdle { requireNotNull(fixture.binding) }
        val source = baseline.source as NativeIoSource
        val changes: List<Pair<String, (TerminalViewBinding) -> TerminalViewBinding>> = listOf(
            "host" to { it.copy(hostId = "other-host") },
            "connection" to { it.copy(connectionGeneration = it.connectionGeneration + 1) },
            "selection" to { it.copy(selectionGeneration = it.selectionGeneration + 1) },
            "subscription" to { it.copy(subscriptionId = "other-subscription") },
            "owner run" to { it.copy(ownerRun = "other-run", source = source.copy(hostRunId = "other-run")) },
            "owner row" to { it.copy(rowId = "other-row", source = source.copy(sessionId = "other-row")) },
            "geometry revision" to { it.copy(geometry = it.geometry.copy(revision = it.geometry.revision + 1)) },
            "geometry columns" to { it.copy(geometry = it.geometry.copy(cols = it.geometry.cols + 1)) },
            "geometry rows" to { it.copy(geometry = it.geometry.copy(rows = it.geometry.rows + 1)) },
            "frame columns" to { it.copy(frame = it.frame.copy(cols = it.frame.cols + 1)) },
            "frame rows" to { it.copy(frame = it.frame.copy(rows = it.frame.rows + 1,
                lines = it.frame.lines + "\u001b[0m${"".padEnd(it.frame.cols)}\u001b[0m")) },
            "modes" to { it.copy(modes = it.modes.copy(applicationCursorKeys = !it.modes.applicationCursorKeys)) },
            "policy" to { it.copy(policyGeneration = it.policyGeneration + 1) },
            "source absence" to { it.copy(source = null) },
            "source token" to { it.copy(source = source.copy(sourceToken = "other-source")) },
            "source viewer revision" to { it.copy(source = source.copy(viewerRevision = source.viewerRevision + 1)) },
            "source geometry" to { it.copy(source = source.copy(geometry = source.geometry.copy(revision = source.geometry.revision + 1))) },
            "native session" to { it.copy(source = source.copy(nativeSession = source.nativeSession.copy(sessionId = "other-native"))) },
            "native epoch" to { it.copy(source = source.copy(nativeSession = source.nativeSession.copy(epoch = source.nativeSession.epoch + 1))) },
            "native tuple absence" to { it.copy(source = NativeIoStartupSource(source.hostRunId, source.sessionId,
                source.geometry, source.viewerRevision, source.sourceToken)) },
            // An A -> B -> A return whose B emission was conflated away still differs here.
            "input generation" to { it.copy(inputGeneration = it.inputGeneration + 1) },
            "resize epoch" to { it.copy(resizeEpoch = it.resizeEpoch + 1) },
        )
        for ((label, change) in changes) {
            compose.runOnIdle { installBinding(fixture, baseline) }
            val proof = awaitInput(fixture)
            val connection = compose.runOnIdle {
                (fixture.surface!!.onCreateInputConnection(EditorInfo()) as TerminalInputConnection).also {
                    assertTrue(it.setComposingText("未確定", 1))
                }
            }
            compose.runOnIdle {
                installBinding(fixture, change(baseline).copy(publishSequence = baseline.publishSequence + 1))
                assertRetiredIme(label, fixture, connection, proof)
            }
            // Reinstalling the original context and earning a new commit cannot revive it.
            compose.runOnIdle { installBinding(fixture, baseline) }
            awaitInput(fixture)
            compose.runOnIdle { assertRetiredIme(label, fixture, connection, proof) }
        }
    }

    @Test fun focusCoverageLayoutAndDetachStillRetireImeComposition() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        fun checkRetirement(label: String, retire: (TerminalSurfaceView) -> Unit, resume: (TerminalSurfaceView) -> Unit) {
            val proof = awaitInput(fixture)
            val connection = compose.runOnIdle {
                (fixture.surface!!.onCreateInputConnection(EditorInfo()) as TerminalInputConnection).also {
                    assertTrue(it.setComposingText("未確定", 1))
                }
            }
            compose.runOnIdle {
                retire(fixture.surface!!)
                assertRetiredIme(label, fixture, connection, proof)
                resume(fixture.surface!!)
            }
            awaitInput(fixture)
            compose.runOnIdle { assertRetiredIme(label, fixture, connection, proof) }
        }
        checkRetirement("focus", { it.clearFocus() }, { assertTrue(it.requestFocus()) })
        checkRetirement("modal coverage", { it.setModalSuspended(true) }, { it.setModalSuspended(false) })
        checkRetirement("input disabled", { it.setUserInputEnabled(false) }, { it.setUserInputEnabled(true) })
        checkRetirement("policy invalidation", { it.invalidateCommittedFrame(InputUnavailableReason.POLICY_RETIRED) }, { it.invalidate() })
        checkRetirement("real metrics change", { it.textSizePx = it.textSizePx + 1f }, { })
        val proof = awaitInput(fixture)
        val (surface, connection) = compose.runOnIdle {
            val surface = fixture.surface!!
            surface to (surface.onCreateInputConnection(EditorInfo()) as TerminalInputConnection).also {
                assertTrue(it.setComposingText("未確定", 1))
            }
        }
        compose.runOnIdle { fixture.state = fixture.state.copy(route = ClientRoute.Sessions) }
        compose.waitUntil(10_000) { !surface.isAttachedToWindow }
        compose.runOnIdle {
            assertFalse(surface.verifyReceipt(proof))
            assertEquals("", connection.composingText)
            assertFalse(connection.commitText("stale", 1))
            assertFalse(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertTrue(fixture.packets.isEmpty())
        }
    }

    private fun assertRetiredIme(label: String, fixture: NativeUiFixture,
        connection: TerminalInputConnection, proof: FrameCommitReceipt) {
        assertFalse(label, fixture.surface!!.verifyReceipt(proof))
        assertEquals(label, "", connection.composingText)
        assertFalse(label, connection.setComposingText("stale", 1))
        assertFalse(label, connection.commitText("stale", 1))
        assertFalse(label, connection.finishComposingText())
        assertFalse(label, connection.deleteSurroundingText(1, 0))
        assertFalse(label, connection.deleteSurroundingTextInCodePoints(1, 0))
        assertTrue(label, fixture.packets.isEmpty())
    }

    private fun installBinding(fixture: NativeUiFixture, binding: TerminalViewBinding) {
        fixture.surface!!.setBinding(binding)
        fixture.binding = binding
    }

    private fun contentOnlyPublish(binding: TerminalViewBinding) = binding.copy(
        publishSequence = binding.publishSequence + 1,
        frame = binding.frame.copy(lines = binding.frame.lines.map {
            "\u001b[0m${"Publish ${binding.publishSequence + 1}".take(binding.frame.cols).padEnd(binding.frame.cols)}\u001b[0m"
        }),
    )

    @Test fun actualNativeImeOverlaysStableMeasuredPaneInBothOrientationsAndRotationRetiresProof() {
        val fixture = terminalFixture(sourced = true)
        val originalSoftInputMode = compose.runOnIdle { compose.activity.window.attributes.softInputMode }
        compose.setContent { fixture.Content() }
        // ActivityScenario performs actual recreation. Only the synthetic content
        // provider survives; the Activity, window, composition and View do not.
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val previousFlags = compose.runOnIdle {
            val info = automation.serviceInfo
            val flags = info.flags
            info.flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            automation.serviceInfo = info
            flags
        }
        UiVerificationActivity.contentForRecreation = { fixture.Content() }
        try {
            rotateTo(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, Configuration.ORIENTATION_PORTRAIT, fixture)
            assertImeOverlay("portrait", fixture)
            val oldView = compose.runOnIdle { requireNotNull(fixture.surface) }
            val oldProof = awaitInput(fixture)
            val oldPane = compose.runOnIdle { paneBounds(fixture) }
            val staleConnection = compose.runOnIdle { oldView.onCreateInputConnection(EditorInfo()) }
            val packetCount = fixture.packets.size
            rotateTo(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, Configuration.ORIENTATION_LANDSCAPE, fixture)
            val fresh = awaitInput(fixture)
            compose.runOnIdle {
                assertNotSame("Rotation must recreate the real View", oldView, fixture.surface)
                assertFalse(oldView.verifyReceipt(oldProof))
                assertFalse("Retired IME text must not replay after rotation", staleConnection.commitText("stale", 1))
                assertEquals(packetCount, fixture.packets.size)
                assertNotEquals(oldPane, paneBounds(fixture))
                assertTrue(requireNotNull(fixture.surface).verifyReceipt(fresh))
                assertEquals(fixture.viewports.last(), fresh.frameCols to fresh.frameRows)
            }
            assertImeOverlay("landscape", fixture)
        } finally {
            try {
                compose.runOnIdle {
                    fixture.surface?.windowInsetsController?.hide(WindowInsets.Type.ime())
                    val info = automation.serviceInfo
                    info.flags = previousFlags
                    automation.serviceInfo = info
                }
                // Restore portrait while the recreation provider is still installed.
                rotateTo(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, Configuration.ORIENTATION_PORTRAIT, fixture)
                compose.runOnIdle { fixture.state = fixture.state.copy(route = ClientRoute.Sessions) }
                compose.waitUntil(10_000) { compose.runOnIdle {
                    compose.activity.window.attributes.softInputMode == originalSoftInputMode
                } }
            } finally {
                UiVerificationActivity.contentForRecreation = null
            }
        }
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

    private fun paneBounds(fixture: NativeUiFixture): Rect {
        val surface = requireNotNull(fixture.surface)
        val location = IntArray(2).also(surface::getLocationInWindow)
        return Rect(location[0], location[1], location[0] + surface.width, location[1] + surface.height)
    }

    private fun assertImeOverlay(orientation: String, fixture: NativeUiFixture) {
        awaitInput(fixture)
        val bounds = compose.runOnIdle { paneBounds(fixture) }
        val grid = fixture.viewports.last()
        val requests = fixture.viewports.size
        assertTrue(grid.first >= 80 && grid.second >= 25)
        val seenBounds = mutableListOf<Rect>()
        val observer = compose.runOnIdle { requireNotNull(fixture.surface).viewTreeObserver }
        val onLayout = ViewTreeObserver.OnGlobalLayoutListener { seenBounds.add(paneBounds(fixture)) }
        compose.runOnIdle {
            observer.addOnGlobalLayoutListener(onLayout)
            assertEquals(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING,
                compose.activity.window.attributes.softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST)
            val surface = requireNotNull(fixture.surface)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.MONOSPACE; textSize = surface.textSizePx }
            val cellWidth = kotlin.math.ceil(paint.measureText("M")).toInt()
            val cellHeight = -paint.fontMetricsInt.ascent + paint.fontMetricsInt.descent + 1
            assertTrue(surface.textSizePx.isFinite() && surface.textSizePx > 0f && cellWidth > 0 && cellHeight > 0)
            assertEquals(grid.first, (surface.width / cellWidth).coerceAtMost(1000))
            assertEquals(grid.second, (surface.height / cellHeight).coerceAtMost(1000))
        }
        fun assertUnchanged() = compose.runOnIdle {
            assertTrue("No intermediate IME layout may move or resize the pane", seenBounds.all { it == bounds })
            assertEquals("IME must not move OR resize the pane", bounds, paneBounds(fixture))
            assertEquals(grid, fixture.viewports.last())
            assertEquals("IME must not request a reflow", requests, fixture.viewports.size)
            val receipt = requireNotNull(fixture.surface!!.currentInputProof())
            assertTrue(fixture.surface!!.verifyReceipt(receipt))
            assertEquals(grid, receipt.drawnColumns to receipt.drawnRows)
            Log.i("NativeUiInsets", "$orientation stable pane=$bounds grid=$grid fontPx=${fixture.surface!!.textSizePx}")
        }
        try {
            captureSyntheticScreen("ime-$orientation-before")
            compose.onNodeWithText("Keys").assertIsDisplayed().performClick()
            compose.onNodeWithContentDescription("Keyboard").assertIsDisplayed().performClick()
            compose.waitUntil(10_000) { compose.runOnIdle {
                fixture.surface?.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
            } }
            // Observe, do not infer visibility from the request. This also exercises
            // the real production accessible-description change without changing toolbar measurement.
            setObservedKeyboard(fixture, true)
            compose.onNodeWithContentDescription("Hide keyboard").assertIsDisplayed()
            awaitInput(fixture) // Focus loss, if any, must earn a genuinely fresh draw.
            compose.waitForIdle()
            assertUnchanged()
            val packetStart = fixture.packets.size
            tapNativeImeLetter("h")
            tapNativeImeLetter("i")
            compose.waitUntil(10_000) {
                fixture.packets.drop(packetStart).flatMap { it.bytes.asIterable() }.toByteArray()
                    .contentEquals("hi".toByteArray(Charsets.UTF_8))
            }
            compose.onNodeWithText("↓").performScrollTo().assertIsDisplayed().performClick()
            compose.runOnIdle {
                val packet = fixture.packets.last()
                assertArrayEquals("\u001b[B".toByteArray(Charsets.UTF_8), packet.bytes)
                assertTrue(packet.verifiedAtCapture)
                assertTrue(fixture.surface!!.verifyReceipt(packet.receipt))
            }
            recordWindowEvidence("ime-$orientation-visible", fixture)
            captureSyntheticScreen("ime-$orientation-visible")
            // Native Back still requests keyboard dismissal before navigation.
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            compose.runOnIdle {
                assertEquals(ClientIntent.SetTerminalKeyboardVisible(false), fixture.intents.last().intent)
            }
            compose.waitUntil(10_000) { compose.runOnIdle {
                fixture.surface?.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == false
            } }
            setObservedKeyboard(fixture, false)
            awaitInput(fixture)
            assertUnchanged()
            recordWindowEvidence("ime-$orientation-hidden", fixture)
            captureSyntheticScreen("ime-$orientation-hidden")
            compose.onNodeWithText("Close keys").assertIsDisplayed().performClick()
            assertUnchanged()
        } finally {
            compose.runOnIdle { if (observer.isAlive) observer.removeOnGlobalLayoutListener(onLayout) }
        }
    }

    private fun setObservedKeyboard(fixture: NativeUiFixture, visible: Boolean) = compose.runOnIdle {
        val route = fixture.state.route as ClientRoute.Terminal
        fixture.state = fixture.state.copy(route = ClientRoute.Terminal(route.terminal.copy(keyboardVisible = visible)))
    }

    /** Tap a key found in the installed OS IME's actual accessibility window.
     * No adb input text, direct commitText, or app-encoded substitute counts.
     */
    private fun tapNativeImeLetter(letter: String) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        var key: Rect? = null
        compose.waitUntil(10_000) {
            key = compose.runOnIdle {
                val roots = automation.windows.filter { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
                    .mapNotNull { it.root }
                val pending = java.util.ArrayDeque<AccessibilityNodeInfo>()
                roots.forEach(pending::add)
                var found: Rect? = null
                var visited = 0
                while (pending.isNotEmpty() && visited++ < 512) {
                    val node = pending.removeFirst()
                    if (node.isVisibleToUser && (node.text?.toString() == letter || node.contentDescription?.toString() == letter)) {
                        found = Rect().also(node::getBoundsInScreen)
                        break
                    }
                    for (child in 0 until node.childCount) node.getChild(child)?.let(pending::add)
                }
                found?.takeUnless { it.isEmpty }
            }
            key != null
        }
        val bounds = requireNotNull(key)
        val now = SystemClock.uptimeMillis()
        listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).forEach { action ->
            val event = MotionEvent.obtain(now, now + if (action == MotionEvent.ACTION_UP) 30 else 0,
                action, bounds.exactCenterX(), bounds.exactCenterY(), 0)
            try { assertTrue(automation.injectInputEvent(event, true)) } finally { event.recycle() }
        }
    }

    private fun recordWindowEvidence(phase: String, fixture: NativeUiFixture) {
        val toolbar = compose.onNodeWithText("↓").fetchSemanticsNode().boundsInWindow
        compose.runOnIdle {
            val surface = requireNotNull(fixture.surface)
            val insets = requireNotNull(surface.rootWindowInsets)
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            val window = compose.activity.windowManager.currentWindowMetrics.bounds
            val location = IntArray(2).also(surface::getLocationInWindow)
            val safeBottom = window.height() - maxOf(bars.bottom, ime.bottom)
            Log.i("NativeUiInsets", "$phase window=$window bars=$bars ime=$ime " +
                "imeVisible=${insets.isVisible(WindowInsets.Type.ime())} " +
                "pane=${location.toList()}/${surface.width}x${surface.height} " +
                "viewport=${fixture.viewports.lastOrNull()} toolbar=$toolbar safeBottom=$safeBottom")
            assertTrue("Toolbar must stay above system navigation / IME", toolbar.bottom <= safeBottom + 1f)
        }
    }

    @Test fun capturedRootCommitCannotAuthorizeAPaneThatNeverDrewItsCandidate() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val old = awaitInput(fixture)
        val platformCommitted = CountDownLatch(1)
        val root = compose.activity.window.decorView
        val signal = Runnable { platformCommitted.countDown() }
        var registered = false
        var suppressed = false
        val preDraw = ViewTreeObserver.OnPreDrawListener {
            if (!registered) {
                registered = true
                root.viewTreeObserver.registerFrameCommitCallback(signal)
            }
            true
        }
        val onDraw = ViewTreeObserver.OnDrawListener {
            if (!suppressed) {
                suppressed = true
                // Root already captured the renderer's callback, but the pane
                // has not drawn. Retire it before drawing any terminal cells.
                fixture.surface!!.setBinding(null)
                fixture.binding = null
            }
        }
        compose.runOnIdle {
            fixture.receipts.clear()
            root.viewTreeObserver.addOnPreDrawListener(preDraw)
            root.viewTreeObserver.addOnDrawListener(onDraw)
            fixture.surface!!.invalidateCommittedFrame(InputUnavailableReason.POLICY_RETIRED)
            fixture.surface!!.invalidate()
            assertFalse(fixture.surface!!.verifyReceipt(old))
        }
        try {
            compose.waitForIdle()
            assertTrue("Suppressed pass still needs a real root commit", platformCommitted.await(10, TimeUnit.SECONDS))
            compose.runOnIdle {
                assertTrue(suppressed)
                assertTrue(fixture.receipts.isEmpty())
                assertNull(fixture.surface!!.currentReceipt())
                assertNull(fixture.surface!!.currentInputProof())
                assertFalse(fixture.surface!!.submitKey(TerminalKey(codepoint = 9)))
                assertTrue(fixture.packets.isEmpty())
                val (cols, rows) = fixture.viewports.last()
                val replacement = NativeUiFixtures.binding(sourced = true, cols = cols, rows = rows)
                fixture.surface!!.setBinding(replacement)
                fixture.binding = replacement
            }
            val replacement = awaitInput(fixture)
            compose.runOnIdle {
                assertNotEquals(old, replacement)
                assertFalse(fixture.surface!!.verifyReceipt(old))
                assertTrue(fixture.surface!!.verifyReceipt(replacement))
            }
        } finally {
            compose.runOnIdle {
                val observer = root.viewTreeObserver
                if (observer.isAlive) {
                    observer.removeOnPreDrawListener(preDraw)
                    observer.removeOnDrawListener(onDraw)
                    observer.unregisterFrameCommitCallback(signal)
                }
            }
        }
    }

    @Test fun paneDrawingClipsSharedCanvasAndRestoresItsParentClip() {
        compose.runOnIdle {
            val pane = TerminalSurfaceView(compose.activity)
            pane.layout(0, 0, 120, 80)
            val bitmap = Bitmap.createBitmap(240, 200, Bitmap.Config.ARGB_8888)
            try {
                val canvas = Canvas(bitmap)
                canvas.drawColor(Color.MAGENTA)
                canvas.translate(40f, 50f)
                val saved = canvas.saveCount
                pane.draw(canvas)
                assertEquals(saved, canvas.saveCount)
                assertEquals(pane.defaultBackgroundColor, bitmap.getPixel(60, 70))
                assertEquals(Color.MAGENTA, bitmap.getPixel(10, 10))
                assertEquals(Color.MAGENTA, bitmap.getPixel(180, 150))
                // A following parent draw must still reach outside the pane.
                canvas.drawColor(Color.CYAN)
                assertEquals(Color.CYAN, bitmap.getPixel(10, 10))
                assertNull(pane.currentReceipt())
                assertNull(pane.currentInputProof())
            } finally {
                bitmap.recycle()
                pane.release()
            }
        }
    }

    /* ------------------------------------------------------------------ *
     * IME edit ledger: synthetic callback sequences. They prove app state and
     * byte order only; what Gboard really calls is established by hand on a device.
     * ------------------------------------------------------------------ */

    private fun newConnection(fixture: NativeUiFixture) = compose.runOnIdle {
        fixture.surface!!.onCreateInputConnection(EditorInfo()) as TerminalInputConnection
    }

    /** Every recorded packet as text, with backspace and Enter spelled by the real encoders. */
    private fun transcript(fixture: NativeUiFixture, proof: FrameCommitReceipt): List<String> {
        val backspace = requireNotNull(ImeCommitEncoder.encodeBackspaces(1, 0, proof.modes)).single()
        val enter = requireNotNull(ImeCommitEncoder.encodeEnter(0, proof.modes))
        return fixture.packets.map {
            assertEquals(NativeIoInputKind.KEYBOARD, it.kind)
            assertEquals(proof, it.receipt)
            assertTrue(it.verifiedAtCapture)
            when {
                it.bytes.contentEquals(backspace) -> "<BS>"
                it.bytes.contentEquals(enter) -> "<ENTER>"
                else -> String(it.bytes, Charsets.UTF_8)
            }
        }
    }

    private fun cursorOf(connection: TerminalInputConnection) = connection.reportedSelection[1]

    @Test fun imeLedgerCorrectsTheCurrentWordWithExactTranscriptsAndNoDuplicates() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        compose.runOnIdle {
            // i -> I: the working path is unchanged.
            assertTrue(connection.setComposingText("i", 1))
            assertTrue(fixture.packets.isEmpty())
            assertTrue(connection.commitText("I", 1))
            assertTrue(connection.commitText(" ", 1))
            assertEquals(listOf("I", " "), transcript(fixture, proof))
            fixture.packets.clear()

            // An unsent composition corrected on commit: sent once, no backspaces.
            for (prefix in listOf("d", "do", "don", "dont")) assertTrue(connection.setComposingText(prefix, 1))
            assertTrue(fixture.packets.isEmpty())
            assertEquals("I dont", connection.getTextBeforeCursor(100, 0).toString())
            assertTrue(connection.commitText("don't", 1))
            assertTrue(connection.commitText(" ", 1))
            assertEquals(listOf("don't", " "), transcript(fixture, proof))
            fixture.packets.clear()

            // A sent word re-marked and replaced: exactly don't, never dontdon't.
            assertTrue(connection.setComposingText("dont", 1))
            assertTrue(connection.finishComposingText())
            val end = cursorOf(connection)
            assertEquals("I don't dont", connection.getTextBeforeCursor(100, 0).toString())
            assertTrue(connection.setComposingRegion(end - 4, end))
            assertEquals(listOf(end, end, end - 4, end), connection.reportedSelection)
            assertTrue(connection.commitText("don't ", 1))
            assertEquals(listOf("dont", "<BS>", "'t "), transcript(fixture, proof))
            assertEquals("I don't don't ", connection.contextText)
            fixture.packets.clear()

            // A candidate tapped after a pause, through each tail range API.
            assertTrue(connection.commitText("dont", 1))
            var at = cursorOf(connection)
            assertTrue(connection.replaceText(at - 4, at, "don't", 1, null))
            assertTrue(connection.commitText("dont", 1))
            at = cursorOf(connection)
            assertTrue(connection.setSelection(at - 4, at))
            assertEquals("dont", connection.getSelectedText(0).toString())
            assertTrue(connection.commitText("don't", 1))
            assertEquals(listOf("dont", "<BS>", "'t", "dont", "<BS>", "'t"), transcript(fixture, proof))
            assertTrue(connection.contextText.endsWith("don'tdon't"))
            // The inherited Editable never acquired any of it.
            assertEquals(0, requireNotNull(connection.editable).length)
        }
    }

    @Test fun imeLedgerDeletionsCountKnownCodePointsAndRefuseUnsupportedRanges() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val face = "😀"
        compose.runOnIdle {
            assertTrue(connection.commitText("a$face", 1))
            fixture.packets.clear()
            // Two UTF-16 units of known emoji are one character, so one backspace.
            assertTrue(connection.deleteSurroundingText(2, 0))
            assertEquals(listOf("<BS>"), transcript(fixture, proof))
            fixture.packets.clear()
            assertTrue(connection.commitText(face, 1))
            fixture.packets.clear()
            assertTrue(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertEquals(listOf("<BS>"), transcript(fixture, proof))
            assertEquals("a", connection.contextText)
            fixture.packets.clear()
            // One known character, then two the ledger never knew: unchanged pass-through.
            assertTrue(connection.deleteSurroundingText(3, 0))
            assertEquals(listOf("<BS>", "<BS>", "<BS>"), transcript(fixture, proof))
            fixture.packets.clear()

            // Ranges that split a pair or do not end at the cursor send nothing.
            assertTrue(connection.commitText("b$face", 1))
            fixture.packets.clear()
            val end = cursorOf(connection)
            val reports = connection.selectionReports
            assertFalse(connection.setComposingRegion(end - 1, end))
            assertFalse(connection.replaceText(end - 1, end, "x", 1, null))
            assertFalse(connection.setSelection(end - 3, end - 2))
            assertFalse(connection.setComposingRegion(end - 3, end - 2))
            assertTrue(fixture.packets.isEmpty())
            assertEquals("Each refusal re-reports the true state", reports + 4, connection.selectionReports)
            assertEquals(listOf(end, end, -1, -1), connection.reportedSelection)
            assertEquals("b$face", connection.getTextBeforeCursor(10, 0).toString())

            // The ceiling bounds the backspaces that would leave: here two known characters
            // (three units) plus the unknown remainder would be 33, so none leave.
            assertFalse(connection.deleteSurroundingText(ImeCommitEncoder.MAX_DELETION_REQUEST + 2, 0))
            assertEquals(InputUnavailableReason.COMMIT_TOO_LARGE, fixture.refusals.last())
            assertTrue(fixture.packets.isEmpty())
            assertEquals("Known text stays known after a refusal", "b$face", connection.contextText)

            // With a selection active, the platform deletes before the selection, not at the
            // cursor. That is not supported in either unit: nothing leaves, the selection
            // stays, and the true state is re-reported.
            assertTrue(connection.commitText(" cd", 1))
            fixture.packets.clear()
            val tail = cursorOf(connection)
            assertTrue(connection.setSelection(tail - 2, tail))
            val beforeDelete = connection.selectionReports
            assertFalse(connection.deleteSurroundingText(1, 0))
            assertFalse(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertTrue(fixture.packets.isEmpty())
            assertEquals(beforeDelete + 2, connection.selectionReports)
            assertEquals(listOf(tail - 2, tail, -1, -1), connection.reportedSelection)
            assertEquals("cd", connection.getSelectedText(0).toString())
            assertEquals(0, requireNotNull(connection.editable).length)
        }
    }

    /**
     * A backspace that shrinks a re-marked word the connection already sent leaves as exactly
     * one backspace, and stays effective when that composition later ends by the input method's
     * own Enter or by a foreign key that makes the ledger forget its context. Nothing is
     * flushed, retyped, or repeated, no earlier word is touched, and deleting only what the
     * composition grew past the sent word still sends nothing.
     */
    @Test fun explicitBackspaceOnAReMarkedSentWordLeavesOnceAndSurvivesEnterAndForeignInput() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val face = "\uD83D\uDE00"
        compose.runOnIdle {
            val surface = fixture.surface!!
            // "dont" is sent, then re-marked by the input method, which sends nothing.
            assertTrue(connection.commitText("dont", 1))
            val end = cursorOf(connection)
            assertTrue(connection.setComposingRegion(end - 4, end))
            fixture.packets.clear()
            assertTrue(connection.deleteSurroundingText(1, 0))
            assertEquals("one backspace, no text, no Space, no Enter", listOf("<BS>"), transcript(fixture, proof))
            assertEquals("don", connection.contextText)
            assertEquals("don", connection.composingText)
            assertEquals("don", connection.getTextBeforeCursor(10, 0).toString())
            assertEquals("the composition covers exactly the shortened sent tail",
                listOf(end - 1, end - 1, end - 4, end - 1), connection.reportedSelection)
            fixture.packets.clear()
            assertTrue(connection.performEditorAction(EditorInfo.IME_ACTION_DONE))
            assertEquals(listOf("<ENTER>"), transcript(fixture, proof))
            assertEquals("", connection.composingText)
            assertEquals("Enter starts a new context", "", connection.getTextBeforeCursor(10, 0).toString())
            fixture.packets.clear()
            assertTrue(connection.commitText("dont", 1))
            fixture.packets.clear()
            val at = cursorOf(connection)
            assertTrue(connection.setComposingRegion(at - 4, at))
            assertTrue(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertEquals(listOf("<BS>"), transcript(fixture, proof))
            assertEquals("don", connection.contextText)
            fixture.packets.clear()
            val tab = requireNotNull(KeyboardEncoder.encode(TerminalKey(codepoint = 9), proof.modes))
            assertTrue(surface.submitKey(TerminalKey(codepoint = 9)))
            assertArrayEquals(tab, fixture.packets.single().bytes)
            fixture.packets.clear()
            assertTrue(connection.commitText("x", 1))
            assertEquals(listOf("x"), transcript(fixture, proof))
            assertEquals("x", connection.contextText)
            assertEquals("", connection.composingText)
            fixture.packets.clear()
            assertTrue(connection.commitText("dont", 1))
            val word = cursorOf(connection)
            assertTrue(connection.setComposingRegion(word - 4, word))
            assertTrue(connection.setComposingText("donts", 1))
            fixture.packets.clear()
            assertTrue(connection.deleteSurroundingText(1, 0))
            assertEquals("the unsent extension is not a remote deletion", 0, fixture.packets.size)
            // Only the unsent "s" went. Everything believed sent, including the "x" the
            // foreign key left behind, stays sent: the prefix is never rewritten.
            assertEquals("xdont", connection.contextText)
            assertEquals("dont", connection.composingText)
            assertTrue(connection.performEditorAction(EditorInfo.IME_ACTION_DONE))
            assertEquals(listOf("<ENTER>"), transcript(fixture, proof))
            fixture.packets.clear()
            assertTrue(connection.commitText("a$face", 1))
            val tail = cursorOf(connection)
            assertTrue(connection.setComposingRegion(tail - 3, tail))
            fixture.packets.clear()
            assertTrue(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertEquals(listOf("<BS>"), transcript(fixture, proof))
            assertEquals("a", connection.contextText)
            assertEquals("a", connection.composingText)
            assertEquals("a", connection.getTextBeforeCursor(10, 0).toString())
            assertEquals(0, requireNotNull(connection.editable).length)
        }
    }

    @Test fun imeLedgerCommitCeilingAppliesToTheSuppliedTextNotOnlyItsDiff() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val connection = newConnection(fixture)
        val max = ImeCommitEncoder.MAX_COMMIT_CODEPOINTS
        compose.runOnIdle {
            assertTrue(connection.commitText("a".repeat(max), 1))
            fixture.packets.clear()
            fixture.refusals.clear()
            val end = cursorOf(connection)
            // A replacement one past the ceiling shares all but one character with the
            // known text, so its diff alone would be tiny. It is still refused whole.
            assertTrue(connection.setSelection(end - max, end))
            assertFalse(connection.commitText("a".repeat(max + 1), 1))
            assertEquals(InputUnavailableReason.COMMIT_TOO_LARGE, fixture.refusals.last())
            assertFalse(connection.replaceText(end - max, end, "a".repeat(max + 1), 1, null))
            assertEquals(listOf(InputUnavailableReason.COMMIT_TOO_LARGE, InputUnavailableReason.COMMIT_TOO_LARGE),
                fixture.refusals.toList())
            assertTrue(connection.setComposingRegion(end - max, end))
            assertFalse(connection.commitText("a".repeat(max + 1), 1))
            assertEquals("", connection.composingText)
            assertTrue(fixture.packets.isEmpty())
            assertEquals("a".repeat(max), connection.contextText)
            assertEquals(0, requireNotNull(connection.editable).length)
        }
    }

    @Test fun imeLedgerReadersBatchNotificationsAndEditorInfoStayCoherent() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val info = EditorInfo()
        val connection = compose.runOnIdle {
            fixture.surface!!.onCreateInputConnection(info) as TerminalInputConnection
        }
        compose.runOnIdle {
            assertEquals(android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
                android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE, info.inputType)
            assertEquals(EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN, info.imeOptions)
            assertEquals(0, info.initialSelStart)
            assertEquals(0, info.initialSelEnd)

            // Empty context answers exactly what an empty editor does.
            assertEquals("", connection.getTextBeforeCursor(10, 0).toString())
            assertEquals("", connection.getTextAfterCursor(10, 0).toString())
            assertNull(connection.getSelectedText(0))
            val caps = android.text.TextUtils.CAP_MODE_SENTENCES
            assertEquals(caps, connection.getCursorCapsMode(caps))

            // Sends leave at call time; a batch edit holds back only the notification.
            assertTrue(connection.beginBatchEdit())
            val reports = connection.selectionReports
            assertTrue(connection.commitText("Hi.", 1))
            assertEquals(listOf("Hi."), transcript(fixture, proof))
            assertTrue(connection.setComposingText("x", 1))
            assertEquals(reports, connection.selectionReports)
            assertFalse(connection.endBatchEdit())
            assertEquals(reports + 1, connection.selectionReports)
            assertEquals(listOf(4, 4, 3, 4), connection.reportedSelection)

            assertTrue(connection.commitText(" ", 1))
            assertEquals(caps, connection.getCursorCapsMode(caps))
            assertTrue(connection.commitText("ok ", 1))
            assertEquals(0, connection.getCursorCapsMode(caps))
            val surrounding = requireNotNull(connection.getSurroundingText(3, 3, 0))
            assertEquals("ok ", surrounding.text.toString())
            assertEquals(3, surrounding.selectionStart)
            assertEquals(3, surrounding.selectionEnd)
            assertEquals(4, surrounding.offset)
            assertTrue(connection.setComposingText("go", 1))
            val snapshot = requireNotNull(connection.takeSnapshot())
            assertEquals(7, snapshot.compositionStart)
            assertEquals(9, snapshot.compositionEnd)
            assertEquals(9, snapshot.surroundingText.offset + snapshot.surroundingText.selectionEnd)

            // A newline is Enter, exactly once, and the context starts over after it.
            fixture.packets.clear()
            assertTrue(connection.commitText("a\nb", 1))
            assertEquals(listOf("a", "<ENTER>", "b"), transcript(fixture, proof))
            assertEquals("b", connection.contextText)
            assertEquals(0, requireNotNull(connection.editable).length)
        }
    }

    @Test fun imeLedgerForgetsContextForForeignInputButKeepsTheUnsentComposition() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(connection.commitText("dont", 1))
            assertTrue(connection.setComposingText("ab", 1))
            // A key the ledger did not produce.
            assertTrue(surface.submitKey(TerminalKey(codepoint = 9)))
            assertEquals("ab", connection.composingText)
            assertEquals("ab", connection.getTextBeforeCursor(10, 0).toString())
            assertEquals("", connection.contextText)
            fixture.packets.clear()
            assertTrue(connection.commitText("ab ", 1))
            assertEquals(listOf("ab "), transcript(fixture, proof))
            fixture.packets.clear()

            // A plain forwarded Backspace is followed, one character.
            assertTrue(connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL)))
            assertTrue(fixture.packets.isNotEmpty())
            assertEquals("ab", connection.contextText)
            connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL))
            assertEquals("ab", connection.getTextBeforeCursor(10, 0).toString())
            fixture.packets.clear()

            // Paste is not context.
            assertTrue(surface.submitPastedText("fixed synthetic paste"))
            assertEquals("", connection.getTextBeforeCursor(10, 0).toString())
            fixture.packets.clear()

            // With a chip held, commits leave as before and are never treated as context.
            assertTrue(connection.commitText("dont", 1))
            assertTrue(surface.setMobileModifiers(KeyboardModifiers.CTRL))
            assertTrue(connection.commitText("c", 1))
            assertEquals("", connection.contextText)
            assertTrue(surface.clearMobileModifiers())
            fixture.packets.clear()

            // The editor action still drops the composition and sends one Enter.
            assertTrue(connection.commitText("ls", 1))
            assertTrue(connection.setComposingText("pending", 1))
            assertTrue(connection.performEditorAction(EditorInfo.IME_ACTION_DONE))
            assertEquals(listOf("ls", "<ENTER>"), transcript(fixture, proof))
            assertEquals("", connection.composingText)
            assertEquals("", connection.getTextBeforeCursor(10, 0).toString())
            assertEquals(0, requireNotNull(connection.editable).length)
        }
    }

    @Test fun imeLedgerRefusalsAreCorrelatedToTheirOwnConnectionAndContextOnly() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        compose.runOnIdle {
            assertTrue(connection.commitText("xy", 1))
            val first = fixture.refusalNotices.last()
            assertTrue(connection.commitText("z", 1))
            assertEquals("xyz", connection.contextText)
            // A late not-sent report forgets the context that still holds that text.
            first.refused()
            assertEquals("", connection.contextText)
            assertTrue(connection.commitText("q", 1))
            // The same report again belongs to an older context and changes nothing.
            first.refused()
            assertEquals("q", connection.contextText)
            fixture.packets.clear()

            // A refusal during the hand-off stops the correction and keeps nothing.
            assertTrue(connection.commitText("dont", 1))
            val end = cursorOf(connection)
            assertTrue(connection.setComposingRegion(end - 4, end))
            fixture.packets.clear()
            fixture.afterInput = { fixture.refusalNotices.last().refused() }
            assertFalse(connection.commitText("don't", 1))
            fixture.afterInput = null
            assertEquals("The batch stopped after the refused packet", listOf("<BS>"), transcript(fixture, proof))
            assertEquals("", connection.contextText)
            assertEquals("", connection.composingText)
            fixture.packets.clear()
        }
        // A notice from a retired connection never touches its replacement.
        val replacement = compose.runOnIdle {
            val old = fixture.refusalNotices.last()
            val next = fixture.surface!!.onCreateInputConnection(EditorInfo()) as TerminalInputConnection
            assertTrue(next.commitText("kept", 1))
            old.refused()
            assertEquals("kept", next.contextText)
            assertFalse(connection.commitText("stale", 1))
            next
        }
        compose.runOnIdle { assertEquals("kept", replacement.contextText) }
    }

    @Test fun imeLedgerSurvivesSameContextOutputAndDiesWithRetirement() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        compose.runOnIdle {
            assertTrue(connection.commitText("dont", 1))
            repeat(3) { installBinding(fixture, contentOnlyPublish(requireNotNull(fixture.binding))) }
            assertEquals("Ordinary output never wipes the context", "dont", connection.contextText)
            fixture.packets.clear()
            val end = cursorOf(connection)
            assertTrue(connection.setComposingRegion(end - 4, end))
            assertTrue(connection.commitText("don't", 1))
            assertEquals(listOf("<BS>", "'t"), transcript(fixture, proof))
            fixture.packets.clear()

            // A proof retired in the middle of a correction stops it there and only the
            // original connection's context goes with it.
            assertTrue(connection.commitText(" dont", 1))
            val at = cursorOf(connection)
            assertTrue(connection.setComposingRegion(at - 4, at))
            fixture.packets.clear()
            fixture.afterInput = {
                fixture.afterInput = null
                fixture.surface!!.invalidateCommittedFrame(InputUnavailableReason.POLICY_RETIRED)
            }
            assertFalse(connection.commitText("don't", 1))
            assertEquals(1, fixture.packets.size)
            assertEquals("", connection.contextText)
            assertFalse(connection.commitText("stale", 1))
            assertEquals("", connection.getTextBeforeCursor(10, 0).toString())
            fixture.surface!!.invalidate()
        }
        awaitInput(fixture)
        val fresh = newConnection(fixture)
        compose.runOnIdle {
            assertEquals("A new connection starts with no context", "", fresh.getTextBeforeCursor(10, 0).toString())
            assertEquals(0, requireNotNull(fresh.editable).length)
        }
    }

    private fun terminalFixture(sourced: Boolean) = NativeUiFixture(NativeUiFixtures.sessions().copy(
        route = ClientRoute.Terminal(NativeUiFixtures.terminal()),
    )).apply { binding = NativeUiFixtures.binding(sourced) }

    /* -------------------------------------------------------------------- *
     * Keys actions, chip releases, and the input method's predictive context.
     *
     * Two things ask the input method for fresh context: a real Keys-panel action that
     * really left — every key in the catalog, inside its own press, right after its own
     * packet, plus an accepted paste — and the user releasing a Ctrl, Alt, or Shift chip.
     * Pressing a chip on, releasing nothing, the More/Fewer keys control, an ordinary Gboard
     * edit, a physical key, and the surface's own lifecycle clears ask nothing. The queued
     * cases below drive the command queue AOSP really uses, through [ImeCommandQueue], so the
     * ordering between an input method's command and the user's chip tap is decided in the
     * test rather than by a looper race.
     *
     * What these cases still cannot show is what a real keyboard makes of the request, or
     * how often the cancellation window is hit in real use. No latency and no failure rate
     * is asserted from these mocks, and a direct InputConnection call models only this
     * surface's own behaviour, never the platform's cancellation. The release trigger is
     * broader than the old Ctrl-handoff guard it replaces: an edit the input method issued
     * but had not yet run can now be cancelled by an ask no handed-off keystroke preceded,
     * and the cases below say so instead of claiming every pending edit survives.
     * ------------------------------------------------------------------ */

    /**
     * A test-only model of the app-side command queue between an input method and its
     * [android.view.inputmethod.InputConnection]. A command is stamped with the platform's
     * command-session id when the input method issues it, that id moves forward the moment
     * this app asks the input method to invalidate its context, and a command whose session
     * went stale is dropped when it finally runs. That mirrors AOSP's
     * `RemoteInputConnectionImpl`: `scheduleInvalidateInput()` increments `mCurrentSessionId`
     * synchronously, and every cancellable command returns `// cancelled` once its posted
     * runnable sees `header.mSessionId != mCurrentSessionId.get()`.
     *
     * It is a model of that ordering, not the platform: it exists so the queued cases are
     * deterministic in instrumentation. It claims nothing about Gboard and nothing about how
     * often the window is hit on a real device.
     */
    private class ImeCommandQueue {
        private var session = 0
        private val pending = ArrayList<Pair<Int, () -> Unit>>()

        /** Commands that ran because their session was still current when they reached it. */
        var delivered = 0
            private set

        /** Commands the platform would have cancelled: issued in an older session. */
        var cancelled = 0
            private set

        /** The input method issues a command: stamped now, executed on the app's thread later. */
        fun issue(command: () -> Unit) { pending += session to command }

        /** This app asked the input method for fresh context, so the session moved forward. */
        fun invalidated() { session += 1 }

        /** The app's thread runs what is queued. A stale session is cancelled, never retried. */
        fun drain() {
            while (pending.isNotEmpty()) {
                val (issuedIn, command) = pending.removeAt(0)
                if (issuedIn != session) cancelled += 1
                else {
                    command()
                    delivered += 1
                }
            }
        }
    }

    @Test fun aChipReleaseWithTheCommandStillQueuedAsksAndCancelsThatQueuedCommand() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val connection = newConnection(fixture)
        val queue = ImeCommandQueue()
        var delivered = false
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            // The input method issues the commit in the current session. It has not reached
            // the InputConnection yet, so no Ctrl keystroke has handed off.
            queue.issue { delivered = connection.commitText("c", 1) }
            val askedBefore = surface.imeContextInvalidations
            // The user taps Ctrl OFF before that request runs. The release is the trigger, so
            // it asks although nothing handed off: no 'a keystroke had to happen first'
            // requirement is allowed to quietly spare a real release.
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            if (surface.imeContextInvalidations > askedBefore) queue.invalidated()
            assertEquals("The release asks on its own, with nothing handed off",
                1, surface.imeContextInvalidations)
            assertTrue(fixture.packets.isEmpty())
            // And that ask moves the platform's command session forward, so the command the
            // input method had already issued in the older session is cancelled there. That is
            // the cost the release trigger accepts, modelled rather than hidden: no claim that
            // a pending edit survives, and no rate measured from these mocks.
            queue.drain()
            assertFalse("The queued command is cancelled by the session bump", delivered)
            assertEquals(0, queue.delivered)
            assertEquals(1, queue.cancelled)
            assertTrue("This surface sent nothing at all", fixture.packets.isEmpty())
        }
    }

    @Test fun ctrlReleaseAfterAHandedOffCommandAsksForFreshContextOnceAndSendsNothingItself() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val ctrlC = requireNotNull(ImeCommitEncoder.encode("c", KeyboardModifiers.CTRL, proof.modes)).single()
        compose.runOnIdle {
            val surface = fixture.surface!!
            val refusalsBefore = fixture.refusals.size
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertTrue(connection.commitText("c", 1))
            assertEquals("The command left with Ctrl held", 1, fixture.packets.size)
            assertArrayEquals(ctrlC, fixture.packets.single().bytes)
            // Counted after that handoff: the release itself must add nothing to it.
            val emissions = surface.inputEmissions
            assertEquals("Nothing is asked of the IME while the chip is still held",
                0, surface.imeContextInvalidations)

            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))

            assertEquals("One Ctrl release asks once", 1, surface.imeContextInvalidations)
            assertEquals("The request sends no packet of its own", emissions, surface.inputEmissions)
            assertEquals("The only bytes that left are still the original Ctrl+C bytes", 1, fixture.packets.size)
            assertArrayEquals(ctrlC, fixture.packets.single().bytes)
            assertEquals("The request reports no failure either", refusalsBefore, fixture.refusals.size)
            assertEquals("", connection.composingText)

            // A second hold that types nothing still asks: the user's release is the trigger,
            // not a keystroke that has to precede it. It asks once, and it sends nothing itself.
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertEquals("Each release asks once, an unused hold included",
                2, surface.imeContextInvalidations)
            assertEquals(1, fixture.packets.size)
        }
    }

    @Test fun ctrlReleaseAfterAHandedOffCommandBumpsThePlatformSessionAndCancelsWhatIsStillQueuedInIt() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val queue = ImeCommandQueue()
        val ctrlC = requireNotNull(ImeCommitEncoder.encode("c", KeyboardModifiers.CTRL, proof.modes)).single()
        var secondDelivered = false
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertTrue(connection.commitText("c", 1))
            val emissions = surface.inputEmissions
            // The user's next keystroke is issued in the same session and has not run yet.
            queue.issue { secondDelivered = connection.commitText("d", 1) }
            val askedBefore = surface.imeContextInvalidations
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            if (surface.imeContextInvalidations > askedBefore) queue.invalidated()
            assertEquals(1, surface.imeContextInvalidations)
            queue.drain()
            // The release asks whether or not a keystroke handed off, and it cannot prove the
            // queue was empty. AOSP does not pretend otherwise: the ask moves the platform's
            // command session forward, and a command still waiting in the older session is
            // cancelled there instead of running. That is the residual tradeoff this
            // candidate accepts, and this is the case that measures it.
            assertFalse("The old-session command is cancelled by the platform's session bump",
                secondDelivered)
            assertEquals(0, queue.delivered)
            assertEquals(1, queue.cancelled)
            // What already left is untouched: the bump cannot recall a packet that handed
            // off, and nothing is replayed, retried, or added.
            assertEquals(emissions, surface.inputEmissions)
            assertEquals(1, fixture.packets.size)
            assertArrayEquals(ctrlC, fixture.packets.single().bytes)
        }
    }

    @Test fun ordinaryTypingQueuedAroundTheResetIsCancelledButTypingInTheRefreshedSessionLeavesOnce() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val queue = ImeCommandQueue()
        var queuedBefore = false
        var typedAfter = false
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertTrue(connection.commitText("c", 1))
            fixture.packets.clear()
            // Ordinary typing already issued when the release lands: an older session.
            queue.issue { queuedBefore = connection.commitText("te", 1) }
            val askedBefore = surface.imeContextInvalidations
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            if (surface.imeContextInvalidations > askedBefore) queue.invalidated()
            assertEquals(1, surface.imeContextInvalidations)
            // Ordinary typing issued in the refreshed session, after the bump.
            queue.issue { typedAfter = connection.commitText("test", 1) }
            queue.drain()
            assertFalse("Typing queued in the older session is cancelled, not hidden",
                queuedBefore)
            assertTrue("Typing in the refreshed session is delivered normally", typedAfter)
            assertEquals(1, queue.delivered)
            assertEquals(1, queue.cancelled)
            // The one word that leaves does so once, through the normal path, and becomes
            // context as it always did. The request itself sent nothing.
            val typed = fixture.packets.single()
            assertEquals(NativeIoInputKind.KEYBOARD, typed.kind)
            assertArrayEquals("test".toByteArray(Charsets.UTF_8), typed.bytes)
            assertTrue(typed.verifiedAtCapture)
            assertEquals("test", connection.contextText)
            assertEquals(1, surface.imeContextInvalidations)
        }
    }

    /**
     * The chip rule the user asked for: releasing Ctrl, Alt, or Shift asks; pressing one on,
     * and a change that releases nothing, do not.
     *
     * An unused hold asks too — the release is the trigger, not a keystroke that has to have
     * happened — and a release that leaves another chip lit asks as well. One action that lets
     * go of two chips asks exactly once, because the ask belongs to the action, not to a bit.
     */
    @Test fun everyChipReleaseAsksOnceAndPressingAChipOnAsksNothing() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val ctrlShiftA = requireNotNull(
            ImeCommitEncoder.encode("a", KeyboardModifiers.CTRL or KeyboardModifiers.SHIFT, proof.modes)).single()
        val ctrlC = requireNotNull(ImeCommitEncoder.encode("c", KeyboardModifiers.CTRL, proof.modes)).single()
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertFalse("Nothing was held, so this release changes nothing",
                surface.clearMobileModifiers())
            assertEquals(0, surface.imeContextInvalidations)

            // Ctrl on, a Ctrl keystroke, Ctrl off: nothing while the chip is lit, one ask on
            // the release.
            assertTrue(surface.setMobileModifiers(KeyboardModifiers.CTRL))
            assertEquals("Pressing a chip on asks nothing", 0, surface.imeContextInvalidations)
            assertTrue(connection.commitText("c", 1))
            assertArrayEquals(ctrlC, fixture.packets.last().bytes)
            assertEquals(0, surface.imeContextInvalidations)
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertEquals("Releasing Ctrl asks once", 1, surface.imeContextInvalidations)

            // Alt on and off with nothing typed at all: an unused hold still clears.
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.ALT))
            assertEquals(1, surface.imeContextInvalidations)
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.ALT))
            assertEquals("Releasing an unused Alt hold still asks",
                2, surface.imeContextInvalidations)

            // Shift off while Ctrl stays lit, after a real Ctrl+Shift keystroke: a released
            // chip asks even when another one remains held, and the combined mask still
            // encodes exactly what the unchanged encoder produces for both chips.
            assertTrue(surface.setMobileModifiers(KeyboardModifiers.CTRL or KeyboardModifiers.SHIFT))
            assertEquals(2, surface.imeContextInvalidations)
            assertTrue(connection.commitText("a", 1))
            assertArrayEquals(ctrlShiftA, fixture.packets.last().bytes)
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.SHIFT))
            assertEquals(KeyboardModifiers.CTRL, surface.selectedMobileModifiers())
            assertEquals("A release with another chip still lit still asks",
                3, surface.imeContextInvalidations)

            // Ctrl off afterwards asks on its own too.
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertEquals(4, surface.imeContextInvalidations)

            // One action that lets go of two chips asks once, not once per bit; the last chip
            // going afterwards asks once more.
            assertTrue(surface.setMobileModifiers(
                KeyboardModifiers.CTRL or KeyboardModifiers.ALT or KeyboardModifiers.SHIFT))
            assertEquals(4, surface.imeContextInvalidations)
            assertTrue(surface.setMobileModifiers(KeyboardModifiers.CTRL))
            assertEquals("One action releasing Alt and Shift asks exactly once",
                5, surface.imeContextInvalidations)
            assertTrue(surface.setMobileModifiers(0))
            assertEquals(6, surface.imeContextInvalidations)

            // A change that releases nothing — the same mask again, and an unsupported bit
            // refused outright — asks nothing.
            assertTrue(surface.setMobileModifiers(0))
            assertFalse(surface.toggleMobileModifier(KeyboardModifiers.META))
            assertEquals(6, surface.imeContextInvalidations)

            // And every keystroke above still left exactly as it always did, once each.
            assertEquals(2, fixture.packets.size)
            assertArrayEquals(ctrlC, fixture.packets[0].bytes)
            assertArrayEquals(ctrlShiftA, fixture.packets[1].bytes)
        }
    }

    @Test fun aLifecycleChipClearAcquiresNoRefreshOfItsOwn() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val connection = newConnection(fixture)
        compose.runOnIdle {
            val surface = fixture.surface!!
            // The client lets go of the chips when it retires a terminal. That is not a release
            // the user chose, so it asks the input method for nothing.
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertTrue(connection.commitText("c", 1))
            assertTrue(surface.clearMobileModifiers())
            assertEquals(0, surface.selectedMobileModifiers())
            assertEquals("A clear the user did not choose asks nothing of the IME",
                0, surface.imeContextInvalidations)

            // The surface also lets go of them on its own once focus goes.
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertTrue(connection.commitText("c", 1))
            // The surface lets go of the chips for its own reasons. That must not acquire a
            // refresh of its own: no lifecycle retirement is a user chip release.
            surface.clearFocus()
            assertEquals(0, surface.selectedMobileModifiers())
            assertEquals(0, surface.imeContextInvalidations)
            assertFalse(surface.clearMobileModifiers())
            assertEquals(0, surface.imeContextInvalidations)
        }
    }

    @Test fun aChipReleaseWithNoLiveConnectionAsksForNothing() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val connection = newConnection(fixture)
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertTrue(connection.commitText("c", 1))
            assertEquals("The command left before the connection was replaced", 1, fixture.packets.size)
            // A configuration change replaces the connection underneath the still-held chip.
            surface.dispatchConfigurationChanged(Configuration(surface.resources.configuration))
            assertEquals("Replacing the connection asks the IME for nothing",
                0, surface.imeContextInvalidations)
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertEquals("The retirement left no live connection, so the release asks nothing",
                0, surface.imeContextInvalidations)
            assertEquals(0, surface.selectedMobileModifiers())
            assertEquals(1, fixture.packets.size)
        }
    }

    @Test fun aChipReleaseOnAReplacementConnectionAtTheSameEpochStillAsksAndCancelsItsQueuedCommand() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        awaitInput(fixture)
        val queue = ImeCommandQueue()
        val first = newConnection(fixture)
        var pendingDelivered = false
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertTrue(first.commitText("c", 1))
            // The input method reconnects: a different connection at the SAME generation.
            val replacement = surface.onCreateInputConnection(EditorInfo()) as TerminalInputConnection
            assertNotSame(first, replacement)
            queue.issue { pendingDelivered = replacement.commitText("d", 1) }
            val asked = surface.imeContextInvalidations
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            if (surface.imeContextInvalidations > asked) queue.invalidated()
            // The release asks against the live replacement connection: the trigger is the
            // user's release, and nothing about the retired connection is required or excused.
            assertEquals(1, surface.imeContextInvalidations)
            queue.drain()
            // The honest consequence: the ask bumps the platform's command session, and the
            // replacement's own queued command was issued in the older one. It is cancelled,
            // not hidden, and no 'every pending edit survives' claim is made anywhere.
            assertFalse("The old-session command is cancelled by the session bump", pendingDelivered)
            assertEquals(0, queue.delivered)
            assertEquals(1, queue.cancelled)
        }
    }

    @Test fun aPhysicalHardwareKeyPressAsksForNothingAndTheChipReleaseThatFollowsDoes() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val queue = ImeCommandQueue()
        var pendingDelivered = false
        val plainArrow = requireNotNull(
            KeyboardEncoder.encode(TerminalKey(functionKey = TerminalFunctionKey.UP), proof.modes),
        )
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            // A physical arrow arrives through the platform's own dispatch. It carries no
            // hardware Ctrl, and a lit chip is deliberately not folded into it: this packet
            // is not a Ctrl keystroke however the chip looks on screen.
            val press = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP, 0)
            assertTrue(surface.onKeyDown(KeyEvent.KEYCODE_DPAD_UP, press))
            val arrow = fixture.packets.single()
            assertEquals(NativeIoInputKind.KEYBOARD, arrow.kind)
            assertArrayEquals(plainArrow, arrow.bytes)
            assertEquals("A physical key is not a Keys-panel action, so it asks nothing of the IME",
                0, surface.imeContextInvalidations)
            // The first real Ctrl command is still queued, in the current session.
            queue.issue { pendingDelivered = connection.commitText("c", 1) }
            val asked = surface.imeContextInvalidations
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            if (surface.imeContextInvalidations > asked) queue.invalidated()
            // The physical key earned the ask nothing and forfeits it nothing either: the
            // release asks on its own, and its session bump cancels the queued command.
            assertEquals(1, surface.imeContextInvalidations)
            queue.drain()
            assertFalse("The old-session command is cancelled by the session bump", pendingDelivered)
            assertEquals(0, queue.delivered)
            assertEquals(1, queue.cancelled)
            assertArrayEquals(plainArrow, fixture.packets.single().bytes)
        }
    }

    @Test fun anUnsentCompositionIsPreservedAndBlocksTheRefreshThePlatformWouldOtherwiseFlush() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val ctrlC = requireNotNull(ImeCommitEncoder.encode("c", KeyboardModifiers.CTRL, proof.modes)).single()
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))
            assertTrue(connection.commitText("c", 1))
            assertEquals(1, fixture.packets.size)
            // The next word is being composed while the chip is still held: local, unsent.
            assertTrue(connection.setComposingText("te", 1))
            assertEquals("te", connection.composingText)
            assertEquals("Composing sends nothing", 1, fixture.packets.size)

            assertTrue(surface.toggleMobileModifier(KeyboardModifiers.CTRL))

            assertEquals("An unsent composition blocks the request: the platform's own cleanup" +
                " calls finishComposingText(), which would send it", 0, surface.imeContextInvalidations)
            assertEquals("te", connection.composingText)
            assertEquals("The composition was never flushed into the terminal", 1, fixture.packets.size)
            assertArrayEquals(ctrlC, fixture.packets.single().bytes)
        }
    }

    /**
     * The whole real Keys catalog, through the one public door the Keys panel's owner calls.
     *
     * [TerminalControlKey] carries exactly the panel's keys and no layout control — More/Fewer
     * keys is a [ClientIntent.SetTerminalExtraKeysVisible], never an entry here — so walking
     * the enum cannot skip a real key and cannot smuggle the panel toggle into the ask. Each
     * entry is asserted to hand off its own unchanged packet first and then ask exactly once,
     * inside the same press.
     */
    @Test fun everyRealKeysPanelKeyAsksForExactlyOneRefreshRightAfterItsOwnPacket() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        // A live connection, so the ask's own guards pass and a count of zero means 'not asked'
        // rather than 'no connection to ask'.
        newConnection(fixture)
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertEquals("The Keys catalog is Escape, Tab, Shift+Tab, four arrows, Home, End,"
                + " PgUp, PgDn, Ins, Del, and F1-F12, and no layout control",
                25, TerminalControlKey.values().size)
            var askedAtHandoff = -1
            // Runs as a real caller's intake does: right after the packet is recorded, while
            // submitKey has not returned. What it sees pins the order ask-after-handoff.
            fixture.afterInput = { askedAtHandoff = surface.imeContextInvalidations }
            for (control in TerminalControlKey.values()) {
                val key = TerminalKeyRequest(control, TerminalModifiers.NONE).asRendererKey()
                val expected = requireNotNull(KeyboardEncoder.encode(key, proof.modes)) {
                    "$control must encode"
                }
                val asked = surface.imeContextInvalidations
                val packets = fixture.packets.size
                val emissions = surface.inputEmissions
                askedAtHandoff = -1
                assertTrue("$control must leave", surface.submitKey(key))
                assertEquals("$control hands off exactly one packet", packets + 1, fixture.packets.size)
                assertEquals("$control's ask sends no packet of its own", 1L, surface.inputEmissions - emissions)
                assertEquals(NativeIoInputKind.KEYBOARD, fixture.packets.last().kind)
                assertArrayEquals("$control encodes unchanged", expected, fixture.packets.last().bytes)
                assertTrue(fixture.packets.last().verifiedAtCapture)
                assertEquals("$control's ask comes after its own handoff", asked, askedAtHandoff)
                assertEquals("$control asks exactly once, in its own press",
                    asked + 1, surface.imeContextInvalidations)
            }
            fixture.afterInput = null
            assertEquals(TerminalControlKey.values().size, fixture.packets.size)
            assertEquals(TerminalControlKey.values().size, surface.imeContextInvalidations)
        }
    }

    /**
     * An accepted paste is a real Keys action too: it asks once, after its own packet. A
     * refused action — a paste with no body, or a keystroke the owner's encoder refuses —
     * hands nothing off and never reaches the ask.
     *
     * The paste text is the fixture's fixed synthetic string. No live clipboard is read, so
     * the clipboard authority stays exactly where it is.
     */
    @Test fun anAcceptedPasteAsksOnceAfterItsPacketAndRefusedActionsAskNothing() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        newConnection(fixture)
        compose.runOnIdle {
            val surface = fixture.surface!!
            val expected = requireNotNull(
                PasteEncoder.encode("fixed synthetic paste", proof.modes.bracketedPaste))
            var askedAtHandoff = -1
            fixture.afterInput = { askedAtHandoff = surface.imeContextInvalidations }
            val asked = surface.imeContextInvalidations
            assertTrue(surface.submitPastedText("fixed synthetic paste"))
            fixture.afterInput = null
            assertEquals(1, fixture.packets.size)
            assertEquals(NativeIoInputKind.PASTE, fixture.packets.single().kind)
            assertArrayEquals("The paste bytes are unchanged by the ask",
                expected, fixture.packets.single().bytes)
            assertEquals("The ask comes after the paste handed off", asked, askedAtHandoff)
            assertEquals("One accepted paste asks once", asked + 1, surface.imeContextInvalidations)

            // A paste refused before any handoff: an empty body is not a paste.
            val refusals = fixture.refusals.size
            assertFalse(surface.submitPastedText(""))
            assertEquals("A refused paste sends no packet", 1, fixture.packets.size)
            assertEquals("A refused paste asks nothing", asked + 1, surface.imeContextInvalidations)
            assertTrue(fixture.refusals.size > refusals)

            // A keystroke the encoder refuses — Ctrl+Z in any spelling — likewise leaves nothing
            // and asks nothing, and its refusal is still reported the way it always was.
            assertFalse(surface.submitKey(TerminalKey(codepoint = 'z'.code, modifiers = KeyboardModifiers.CTRL)))
            assertEquals(1, fixture.packets.size)
            assertEquals(asked + 1, surface.imeContextInvalidations)
            assertTrue(fixture.refusals.contains(InputUnavailableReason.ENCODER_REFUSED))
        }
    }

    /**
     * The real panel and the real buttons, on the same live surface.
     *
     * One real key button asks once. The real More keys / Fewer keys control — a layout intent,
     * never a [TerminalControlKey] — never does, and it dispatches no key and sends no packet.
     * This drives the screen's own projection of that intent; the application controller also
     * retires the terminal for it, which is a lifecycle path and asks for nothing either.
     */
    @Test fun theRealKeysPanelAsksForItsKeysAndTheMoreKeysControlAsksForNothing() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val escape = requireNotNull(KeyboardEncoder.encode(TerminalKey(codepoint = 27), proof.modes))
        compose.onNodeWithText("Keys").assertIsDisplayed().performClick()
        val open = awaitInput(fixture)
        compose.runOnIdle { assertTrue(fixture.surface!!.verifyReceipt(open)) }
        compose.onNodeWithText("Esc").performScrollTo().performClick()
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertEquals("A real key button sends one packet", 1, fixture.packets.size)
            assertEquals(NativeIoInputKind.KEYBOARD, fixture.packets.single().kind)
            assertArrayEquals(escape, fixture.packets.single().bytes)
            assertEquals("A real key button asks once, in its own press",
                1, surface.imeContextInvalidations)
        }
        compose.onNodeWithText("More keys").performScrollTo().performClick()
        compose.onNodeWithText("F12").assertExists()
        compose.runOnIdle {
            assertEquals("More keys is not a key: it sends no packet", 1, fixture.packets.size)
            assertEquals("More keys asks nothing of the input method",
                1, fixture.surface!!.imeContextInvalidations)
        }
        compose.onNodeWithText("Fewer keys").performScrollTo().performClick()
        compose.onNodeWithText("F12").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("Fewer keys is not a key either", 1, fixture.packets.size)
            assertEquals("Fewer keys asks nothing of the input method",
                1, fixture.surface!!.imeContextInvalidations)
        }
    }

    /**
     * Ordinary Gboard work keeps its existing behavior exactly: committed text, an unsent
     * composition, the input method's own Enter, and a physical key the platform dispatched
     * neither ask for fresh context nor gain a packet or a changed byte.
     */
    @Test fun ordinaryImeTypingTheImesOwnEnterAndPhysicalKeysAcquireNoRefresh() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val plainArrow = requireNotNull(
            KeyboardEncoder.encode(TerminalKey(functionKey = TerminalFunctionKey.UP), proof.modes),
        )
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(connection.commitText("hello", 1))
            assertTrue(connection.setComposingText("wor", 1))
            assertTrue(connection.commitText("ld", 1))
            assertTrue(connection.performEditorAction(EditorInfo.IME_ACTION_DONE))
            val press = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP, 0)
            assertTrue(surface.onKeyDown(KeyEvent.KEYCODE_DPAD_UP, press))
            assertEquals("Text, text, the IME's Enter, and the physical key: four packets, as before",
                4, fixture.packets.size)
            assertArrayEquals(plainArrow, fixture.packets.last().bytes)
            assertEquals("None of them acquired the Keys-action or chip-release ask",
                0, surface.imeContextInvalidations)
        }
    }

    /**
     * A Keys action still leaves with its exact bytes while a composition is unsent; only the
     * ask is withheld, because the platform's own cleanup would finish that composition and
     * send text the user is still correcting. Nothing is flushed, dropped, or restarted.
     */
    @Test fun aKeysActionWithAnUnsentCompositionStillLeavesAndBlocksTheRefresh() {
        val fixture = terminalFixture(sourced = true)
        compose.setContent { fixture.Content() }
        val proof = awaitInput(fixture)
        val connection = newConnection(fixture)
        val tab = requireNotNull(KeyboardEncoder.encode(TerminalKey(codepoint = 9), proof.modes))
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertTrue(connection.setComposingText("te", 1))
            assertEquals("te", connection.composingText)
            assertTrue(fixture.packets.isEmpty())

            assertTrue(surface.submitKey(TerminalKey(codepoint = 9)))

            assertEquals("The key still leaves, on time", 1, fixture.packets.size)
            assertArrayEquals(tab, fixture.packets.single().bytes)
            assertEquals("The unsent composition blocks the ask", 0, surface.imeContextInvalidations)
            assertEquals("te", connection.composingText)
            assertEquals("The composition was never flushed into the terminal", 1, fixture.packets.size)
        }
    }

    private fun awaitInput(fixture: NativeUiFixture): FrameCommitReceipt {
        var committed: FrameCommitReceipt? = null
        try {
            compose.waitUntil(10_000) {
                // Insets can retire an intermediate receipt while runOnIdle
                // drains layout. Capture and verify after that drain, atomically
                // on main, instead of testing before idle and dereferencing later.
                committed = compose.runOnIdle {
                    val surface = fixture.surface
                    surface?.currentInputProof()?.also { assertTrue(surface.verifyReceipt(it)) }
                }
                committed != null
            }
        } catch (error: Throwable) {
            compose.runOnIdle { fixture.logTerminalState("input-commit-timeout") }
            captureSyntheticScreen("input-commit-timeout")
            throw error
        }
        return requireNotNull(committed)
    }
}
