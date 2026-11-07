package io.github.rfairburn.pireviewgate.ui

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Rect
import android.graphics.Paint
import android.graphics.Typeface
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
import io.github.rfairburn.pireviewgate.core.input.KeyboardModifiers
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
            compose.onNodeWithText("Keyboard").assertIsDisplayed().performClick()
            compose.waitUntil(10_000) { compose.runOnIdle {
                fixture.surface?.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
            } }
            // Observe, do not infer visibility from the request. This also exercises
            // the real production label change without changing toolbar measurement.
            setObservedKeyboard(fixture, true)
            compose.onNodeWithText("Hide keyboard").assertIsDisplayed()
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

    private fun terminalFixture(sourced: Boolean) = NativeUiFixture(NativeUiFixtures.sessions().copy(
        route = ClientRoute.Terminal(NativeUiFixtures.terminal()),
    )).apply { binding = NativeUiFixtures.binding(sourced) }

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
