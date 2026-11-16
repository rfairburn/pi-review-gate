package io.github.rfairburn.pireviewgate.androidtest

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.rfairburn.pireviewgate.ClientActivity
import io.github.rfairburn.pireviewgate.PiReviewGateApplication
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.ui.terminal.FrameCommitReceipt
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real-device acceptance driver for hosted provider PTY input and text copy.
 *
 * PROOF LEVEL. This drives the real production app: [ClientActivity] inside the
 * real [io.github.rfairburn.pireviewgate.PiReviewGateApplication] graph, on the
 * app's own default Keystore identity and private storage, on one owned private
 * emulator. A separate Node owner process (the test-only fixture) runs the
 * unchanged production peer coordinator, owning-host service, and
 * `InstanceManager` over REAL PTY children of a synthetic interactive CLI for the
 * canonical `claude` and `codex` backends.
 *
 * Everything asserted here is observed through real paths:
 * - this device's own identity fingerprint is read off the real Settings screen
 *   once the real Connect has initialized that identity, and is reported to the
 *   runner, which approves only a pending pairing key equal to it;
 * - the host is added, connected, and approved through the actual UI, and the
 *   first-use consent is asserted against the fingerprint the owner reported;
 * - the app's local-network rationale and the system permission dialog are answered
 *   with real injected UI taps (never `pm grant`, never a pre-grant);
 * - typed input goes through the installed OS IME into the focused real terminal,
 *   which only submits from an actual written-frame receipt;
 * - display progress and input authority are read separately: `currentReceipt()` is
 *   the newest attested commit, while `currentInputProof()` is the standing input
 *   authority, and the two are never conflated;
 * - the copy lands in the real Android clipboard, and what proves the write is the
 *   test-only clipboard-write meter: a JVMTI breakpoint on the entry of exactly
 *   `ClipboardManager.setPrimaryClip(Landroid/content/ClipData;)V`, read as a
 *   continuous cumulative count across the whole phase. The real clipboard is read
 *   back for content, and a real `ClipboardManager.OnPrimaryClipChangedListener` is
 *   kept as an observer of framework notifications — notifications are never used as
 *   evidence of a write, because one write can produce more than one.
 *
 * It proves nothing about a real Claude or Codex model, provider authentication, a
 * physical machine, Windows, or two physical computers: the PTY child is a
 * synthetic program, exactly as documented. The child's own journal — read by the
 * runner, which correlates it with the events this test reports — is what proves
 * the bytes reached the child's TTY and that the owner forwarded the copy.
 */
@RunWith(AndroidJUnit4::class)
class NativeDeviceAcceptanceTest {

    @get:Rule
    val compose = createAndroidComposeRule<ClientActivity>()

    private val runToken: String by lazy { FixtureEnvironment.requireArgument("fixtureRun") }
    private val ownerPort: Int by lazy { FixtureEnvironment.requireIntArgument("fixturePort") }
    private val ownerFingerprint: String by lazy { FixtureEnvironment.requireArgument("fixtureHostFingerprint") }
    private val marker: String by lazy { FixtureEnvironment.requireArgument("fixtureMarker") }
    private val hostLabel: String by lazy { FixtureEnvironment.argumentOrDefault("fixtureHostLabel", "prg-owner") }
    private val claudeRow: String by lazy { FixtureEnvironment.requireArgument("fixtureClaudeRow") }

    /** Advanced by every [openTerminalForRow]: one value per pane this run opened. */
    private var paneGeneration = 0

    /** The pane, and its surface, that last received its own real Keyboard action. */
    private var keyboardPaneGeneration = -1
    private var keyboardSurface: TerminalSurfaceView? = null

    /** One real typed input and one real text copy on each canonical backend row. */
    @Test
    fun typedInputAndTextCopyReachTheRealOwnerOnBothBackends() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val previousFlags = enableInteractiveWindows(automation)
        // One continuous counter for the whole phase, and one baseline for the whole
        // phase. Every checkpoint below is a cumulative expectation from that
        // baseline, so a write in the gap between two actions is a failure rather
        // than a new starting point, and a write after the last assertion is still
        // caught by the closed snapshot.
        val meter = ClipWriteMeter.attach()
        val phase = ClipWritePhase("happy path") { meter.total() }
        reportEvent(
            "clipboardWriteMeterReady",
            "target" to ClipWriteMeter.TARGET_METHOD,
            "meterStatus" to meter.attachStatus,
            "phaseBaselineWrites" to phase.baseline.toString(),
        )
        var phaseCompleted = false
        try {
            pairWithTheOwner()
            for (backend in listOf("claude", "codex")) {
                val rowId = FixtureEnvironment.requireArgument("fixture${backend.replaceFirstChar { it.uppercase() }}Row")
                openTerminalForRow("prg-$backend-$runToken")
                val surface = awaitInputAuthority(rowId)
                val recorder = ClipRecorder(context())
                recorder.attach()
                try {
                    val commitBefore = requireNotNull(displayCommit(surface))
                    typeThroughNativeIme(marker + backend.take(1))
                    // Display progress, not authority: the input anchor stays put
                    // across ordinary output, so only a newer attested commit shows
                    // that the child answered.
                    awaitUi("a newer attested frame commit after typing") {
                        val commit = displayCommit(surface)
                        commit != null && commit > commitBefore
                    }
                    compose.runOnIdle {
                        assertTrue("the activity stays resumed while it types", isResumed())
                        val proof = requireNotNull(surface.currentInputProof())
                        assertTrue("the standing proof still authorizes input", surface.verifyReceipt(proof))
                        assertEquals(rowId, proof.rowId)
                    }
                    reportEvent("typedInputObserved", "backend" to backend)
                    // The pane's own typed trigger asks that child for a text copy.
                    // Before it, the phase must still be where the last checkpoint
                    // left it: this is what rejects a duplicate that arrives during
                    // the gap between backends instead of being rebaselined away.
                    phase.expectQuiet("before the $backend copy trigger")
                    var landedLabel: String? = null
                    var landedText: String? = null
                    typeThroughNativeIme(COPY_TRIGGER)
                    awaitUi("the real clipboard to carry this backend's copy") {
                        clipText()?.startsWith(copyPrefix(backend)) == true
                    }
                    compose.runOnIdle {
                        assertTrue("the activity is still resumed when the copy lands", isResumed())
                        // Cumulative, not a fresh delta: exactly one write more than
                        // everything this phase has produced so far.
                        phase.expectCopy("is the $backend copy")
                        val clip = currentClip()
                        landedLabel = clip?.first
                        landedText = clip?.second
                        assertEquals(
                            "the real clipboard carries this copy under the app's own label",
                            CLIP_LABEL,
                            landedLabel,
                        )
                        assertTrue(
                            "the real clipboard text is this run's copy for $backend",
                            landedText?.startsWith(copyPrefix(backend)) == true,
                        )
                    }
                    reportEvent("copyLanded", "backend" to backend, "text" to (landedText ?: "<none>"))
                    reportEvent(
                        "clipboardWrites",
                        "backend" to backend,
                        "expectedWrites" to "1",
                        "listenerNotifications" to recorder.notifications.toString(),
                        "meterStatus" to meter.status(),
                        *phase.reportFields(window = null).map { (key, value) -> key to value }.toTypedArray(),
                    )
                } finally {
                    recorder.detach()
                }
                leaveTerminal()
            }
            phaseCompleted = true
        } finally {
            var closedTotal = -1L
            var closeFailure: Throwable? = null
            try {
                closedTotal = meter.requestStop()
            } catch (failure: Throwable) {
                closeFailure = failure
            }
            reportEvent(
                "clipboardWriteMeterClosed",
                "finalTotalWrites" to closedTotal.toString(),
                "expectedFinalTotalWrites" to phase.expectedTotal.toString(),
                "meterStatus" to meter.status(),
            )
            restoreInteractiveWindows(automation, previousFlags)
            closeFailure?.let {
                throw AssertionError("the clipboard write meter did not close cleanly: ${meter.status()}", it)
            }
            // Only when the phase itself succeeded, so a real failure is never masked
            // by this one. This is the tail check: a write after the last assertion
            // still has to appear in the closed snapshot.
            if (phaseCompleted) phase.expectClosed(closedTotal)
        }
    }

    /**
     * Viewer policy Off: typed input never reaches the owner, an out-of-band child
     * copy never reaches this clipboard, and re-enabling replays nothing before a
     * fresh actual input and copy.
     *
     * Every `SNAPSHOT_SETTLE_MS` pause exists so the runner's journal read for the
     * event that just happened lands inside the interval it is meant to measure.
     */
    @Test
    fun viewerPolicyOffBlocksTypedInputAndOutOfBandCopy() {
        val sentinel = "PRGSENTINEL-$runToken"
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val previousFlags = enableInteractiveWindows(automation)
        // One continuous counter for the whole phase, and one baseline for the whole
        // phase, read before this test writes anything. The sentinel is the first
        // write the phase commits to; every later checkpoint — including the settle
        // after re-enabling and the closed snapshot — is cumulative from that same
        // baseline, so no rebaselining can swallow a replay or a trailing write.
        val meter = ClipWriteMeter.attach()
        val phase = ClipWritePhase("policy Off") { meter.total() }
        reportEvent(
            "clipboardWriteMeterReady",
            "target" to ClipWriteMeter.TARGET_METHOD,
            "meterStatus" to meter.attachStatus,
            "phaseBaselineWrites" to phase.baseline.toString(),
        )
        var phaseCompleted = false
        try {
            pairWithTheOwner()

            // A journal-confirmed real input BEFORE any policy change, so the whole
            // Off interval is measured against a live, accepted phone input.
            openTerminalForRow("prg-claude-$runToken")
            val surface = awaitInputAuthority(claudeRow)
            val commitBeforeBaseline = requireNotNull(displayCommit(surface))
            typeThroughNativeIme(marker)
            awaitUi("the child to answer the baseline input") {
                val commit = displayCommit(surface)
                commit != null && commit > commitBeforeBaseline
            }
            reportEvent("baselineInputObserved", "backend" to "claude")
            settle(SNAPSHOT_SETTLE_MS)
            leaveTerminal()

            // The sentinel is written and confirmed BEFORE the recorder exists, so
            // every recorded write below is one the production copy path caused.
            compose.runOnIdle {
                context().getSystemService(ClipboardManager::class.java)
                    .setPrimaryClip(ClipData.newPlainText(CLIP_LABEL, sentinel))
            }
            compose.waitForIdle()
            assertEquals(sentinel, clipText())
            // The meter counts this test's own sentinel too, so it is committed to
            // here as the phase's first write rather than subtracted out of it.
            phase.expectCopy("is this test's own sentinel write")
            // The sentinel belongs to the phase total but to no measured window, so
            // only the reporting watermark moves. The baseline, the cumulative
            // expectation, and the closed-total assertions are untouched: the Off
            // window still reports zero writes of its own.
            phase.markReported()

            setViewerRemoteInput(enabled = false)
            openTerminalForRow("prg-claude-$runToken")
            val offSurface = awaitAttachedSurface()
            compose.runOnIdle {
                assertNull(
                    "a terminal opened while the viewer policy is Off carries no input authority",
                    offSurface.currentInputProof(),
                )
            }
            reportEvent("policyDisabled", "backend" to "claude")
            settle(SNAPSHOT_SETTLE_MS)

            val recorder = ClipRecorder(context())
            recorder.attach()
            try {
                reportEvent("beforeTypedAttemptWithPolicyOff", "backend" to "claude")
                typeThroughNativeIme(marker)
                // A bounded settle for a would-be write. The positive witness is the
                // owner journal the runner reads after this event; the negative one is
                // the meter, which counts SDK calls and not listener notifications.
                settle(SETTLE_MS)
                phase.expectQuiet("while the viewer policy is Off")
                reportEvent("afterTypedAttemptWithPolicyOff", "backend" to "claude")
                settle(SNAPSHOT_SETTLE_MS)

                // The typed trigger must also stay local while the policy is Off.
                typeThroughNativeIme(COPY_TRIGGER)
                settle(SETTLE_MS)
                phase.expectQuiet("after typing the copy trigger with the policy Off")
                reportEvent("requestOutOfBandCopy", "backend" to "claude")
                settle(SNAPSHOT_SETTLE_MS)
                reportEvent("afterOutOfBandCopyWhileOff", "backend" to "claude")
                settle(SNAPSHOT_SETTLE_MS)

                compose.runOnIdle {
                    phase.expectQuiet("while the viewer policy is Off")
                    assertEquals(
                        "the clipboard still holds the sentinel this test wrote itself",
                        sentinel,
                        clipText(),
                    )
                    assertNull(
                        "the out-of-band copy never created input authority",
                        offSurface.currentInputProof(),
                    )
                }
                // Local input Off deliberately prevents commit attestation as well as
                // input proof publication. Inspect the current pane, not a cached view;
                // its installed binding is not evidence of an attested display commit.
                // Re-enabling below must earn a fresh real receipt before input resumes.
                compose.runOnIdle {
                    val currentOffSurface = requireNotNull(findTerminalSurface(compose.activity.window.decorView))
                    assertEquals("the Off pane is still bound to the fixture row", claudeRow, currentOffSurface.currentBinding()?.rowId)
                    assertNull("the policy-Off pane attests no display receipt", currentOffSurface.currentReceipt())
                    assertNull("the policy-Off pane publishes no input authority", currentOffSurface.currentInputProof())
                }

                setViewerRemoteInput(enabled = true)
                openTerminalForRow("prg-claude-$runToken")
                awaitInputAuthority(claudeRow)
                compose.runOnIdle {
                    assertEquals("re-enabling replayed nothing into the clipboard", sentinel, clipText())
                    phase.expectQuiet("after re-enabling viewer input")
                }
                reportEvent("afterReEnableBeforeFreshInput", "backend" to "claude")
                reportEvent(
                    "clipboardWrites",
                    "backend" to "claude",
                    "expectedWrites" to "0",
                    "listenerNotifications" to recorder.notifications.toString(),
                    "meterStatus" to meter.status(),
                    *phase.reportFields(window = "policyOffThroughReEnable")
                        .map { (key, value) -> key to value }.toTypedArray(),
                )
                settle(SNAPSHOT_SETTLE_MS)

                // The settle above is an interval a replay could hide in, so it is a
                // checkpoint and not dead time: the phase must still be exactly where
                // the Off window left it, and the sentinel must still be the clip.
                compose.runOnIdle {
                    phase.expectQuiet("during the settle after re-enabling")
                    assertEquals(
                        "the sentinel is still the current clip when the fresh input begins",
                        sentinel,
                        clipText(),
                    )
                }

                var landedText: String? = null
                typeThroughNativeIme(COPY_TRIGGER)
                awaitUi("a fresh copy after a fresh actual input") {
                    clipText()?.startsWith(copyPrefix("claude")) == true
                }
                compose.runOnIdle {
                    // Measured from the phase baseline, so a replay that arrived during
                    // the settle above cannot become the new starting point.
                    phase.expectCopy("is the fresh copy after a fresh actual input")
                    assertTrue(
                        "nothing out of band was replayed before a fresh actual input",
                        recorder.seen.none { it.contains("-out-of-band-") },
                    )
                    landedText = clipText()
                    assertTrue(
                        "the real clipboard carries the fresh copy",
                        landedText?.startsWith(copyPrefix("claude")) == true,
                    )
                }
                reportEvent("freshCopyAfterReEnable", "backend" to "claude", "text" to (landedText ?: "<none>"))
                reportEvent(
                    "clipboardWrites",
                    "backend" to "claude",
                    "expectedWrites" to "1",
                    "listenerNotifications" to recorder.notifications.toString(),
                    "meterStatus" to meter.status(),
                    *phase.reportFields(window = "freshCopyAfterReEnable")
                        .map { (key, value) -> key to value }.toTypedArray(),
                )
            } finally {
                recorder.detach()
            }
            phaseCompleted = true
        } finally {
            var closedTotal = -1L
            var closeFailure: Throwable? = null
            try {
                closedTotal = meter.requestStop()
            } catch (failure: Throwable) {
                closeFailure = failure
            }
            reportEvent(
                "clipboardWriteMeterClosed",
                "finalTotalWrites" to closedTotal.toString(),
                "expectedFinalTotalWrites" to phase.expectedTotal.toString(),
                "meterStatus" to meter.status(),
            )
            restoreInteractiveWindows(automation, previousFlags)
            closeFailure?.let {
                throw AssertionError("the clipboard write meter did not close cleanly: ${meter.status()}", it)
            }
            // The tail check: a write after the last assertion is still in the closed
            // snapshot, and the closed snapshot is the whole phase.
            if (phaseCompleted) phase.expectClosed(closedTotal)
        }
    }

    /* ------------------------------------------------------------------ *
     * This device's own identity, read through the real Settings screen
     * ------------------------------------------------------------------ */

    /**
     * Read this app's own Keystore identity fingerprint off the real Settings screen
     * and report it, so the runner binds the pairing it approves to the device
     * actually under test rather than to a shared display label.
     */
    private fun reportDeviceIdentity() {
        val fingerprint = readDeviceIdentityFingerprint()
        assertTrue(
            "the Settings screen reported a canonical fingerprint",
            Regex("^[A-Za-z0-9_-]{43}$").matches(fingerprint),
        )
        reportEvent("deviceIdentity", "fingerprint" to fingerprint)
    }

    private fun readDeviceIdentityFingerprint(): String {
        openDestination(NAV_SETTINGS)
        awaitUi("the identity section") { nodeExists(IDENTITY_FINGERPRINT_LABEL) }
        // The fingerprint is rendered as its own text node next to the label; read
        // the real tree rather than assuming a position inside it.
        val found = collectDisplayedTexts().filter { Regex("^[A-Za-z0-9_-]{43}$").matches(it) }.distinct()
        assertEquals("the Settings screen shows exactly one canonical device fingerprint", 1, found.size)
        return found.single()
    }

    /** Every text this composition reports, walked out of the real semantics tree. */
    private fun collectDisplayedTexts(): List<String> {
        val out = mutableListOf<String>()
        val pending = ArrayDeque(listOf(compose.onRoot().fetchSemanticsNode()))
        var visited = 0
        while (pending.isNotEmpty() && visited++ < 2_048) {
            val node = pending.removeFirst()
            node.config.valueOrNull(SemanticsProperties.Text)?.forEach { out.add(it.toString().trim()) }
            pending.addAll(node.children)
        }
        return out
    }

    /** This Compose version exposes `get`, `getOrElse`, and `contains` only. */
    private fun <T> SemanticsConfiguration.valueOrNull(key: androidx.compose.ui.semantics.SemanticsPropertyKey<T>): T? =
        if (contains(key)) get(key) else null

    /* ------------------------------------------------------------------ *
     * Real UI: pairing, connection, consent, and opening a row
     * ------------------------------------------------------------------ */

    private fun context(): Context = compose.activity.applicationContext

    private fun isResumed(): Boolean =
        compose.activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

    /** Add the owner once, connect, answer the permission UI, and approve its key. */
    private fun pairWithTheOwner() {
        awaitUi("the app to draw its first screen") { nodeExists(NAV_SESSIONS) }
        openDestination(NAV_HOSTS)
        if (savedOwnerRecords() == 0) {
            clickText(ACTION_ADD_HOST)
            awaitUi("the Add host dialog") { nodeExists(ADD_HOST_SUBMIT) && addHostDialogOpen() }
            enterTextField(FIELD_LABEL, hostLabel)
            enterTextField(FIELD_ADDRESS, EMULATOR_LOOPBACK)
            enterTextField(FIELD_PORT, ownerPort.toString())
            // The IME window covers the bottom of the dialog's own window, where the
            // Save control sits, so a tap that lands there is not a tap on the control.
            dismissInstalledIme()
            saveTheOwnerHost()
        }
        // Production leaves a saved Add host form open, so closing it is a separate,
        // explicit step and never the witness that the save happened.
        closeAddHostDialog()
        assertNoFixtureDialogOpen("dialling the saved host")
        openDestination(NAV_HOSTS)
        // This driver dials the first card, so the record it dials must be the one it
        // saved; the card and its full endpoint are then confirmed on screen.
        assertEquals(
            "the owned device must hold exactly the one host this run saved",
            1,
            requirePublishedUiState().hostStates.size,
        )
        val endpointDisplay = "$EMULATOR_LOOPBACK:$ownerPort"
        awaitUi("the saved host card and its real endpoint $endpointDisplay") {
            nodeExists(hostLabel) && nodeExists(endpointDisplay)
        }
        clickTextInList(ACTION_CONNECT, 0)
        answerLocalNetworkPermission()
        awaitUi("the first-use server-key consent or a live connection") {
            nodeExists(CONSENT_TITLE) || nodeExists(CONNECTION_CONNECTED)
        }
        if (nodeExists(CONSENT_TITLE)) {
            // The dialog must carry the fingerprint the owner process reported.
            assertTrue(
                "the consent dialog carries the owner's reported fingerprint",
                nodeExists(ownerFingerprint),
            )
            clickText(CONSENT_APPROVE)
        }
        awaitUi("the server-key consent to close") { !nodeExists(CONSENT_TITLE) }
        // Explicit Connect is what initializes the production identity, so this is
        // the first moment the real Settings screen can show it. The owner runner
        // still withholds its pairing approval until this fingerprint is reported.
        reportDeviceIdentity()
        openDestination(NAV_HOSTS)
        awaitUi("the owner connection") { nodeExists(CONNECTION_CONNECTED) }
        reportEvent("connected", "fingerprint" to ownerFingerprint)
    }

    /**
     * The app's own rationale, then the real system permission dialog. Both are answered
     * with injected UI taps on the actual controls; nothing is granted out of band and no
     * permission is pre-granted by the runner.
     *
     * A foreground system permission dialog can legitimately take the app's Compose
     * hierarchy away, so the OS windows are read FIRST and Compose is only consulted
     * through [nodeExistsDuringOsHandoff], which reports "not observed" while the system
     * owns the screen instead of claiming the control is absent. The grant is witnessed
     * by the injected tap on the real control, by that control then stopping being
     * offered, and by the app's own Compose root coming back; the caller still has to
     * reach the next real step (server-key consent or a live connection). A vanished app
     * is never treated as permission granted.
     */
    private fun answerLocalNetworkPermission() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val deadline = SystemClock.uptimeMillis() + PERMISSION_BOUND_MS
        var allowTapped = false
        var grantControlSeen = false
        while (SystemClock.uptimeMillis() < deadline) {
            val allow = findNativePermissionGrant(automation)
            if (allow != null) {
                grantControlSeen = true
                tapBounds(automation, allow)
                allowTapped = true
                awaitWithin(
                    deadline,
                    "the system permission control to stop being offered and the app's own "
                        + "Compose root to return after the grant (windows: " +
                        "${osWindowSummary(automation)})",
                ) {
                    findNativePermissionGrant(automation) == null &&
                        appComposeRootObserved()
                }
                continue
            }
            if (nodeExistsDuringOsHandoff(CONSENT_TITLE) == true) return
            if (nodeExistsDuringOsHandoff(CONNECTION_CONNECTED) == true) return
            if (nodeExistsDuringOsHandoff(PERMISSION_RATIONALE) == true) {
                clickDuringOsHandoff(PERMISSION_CONTINUE)
            }
            SystemClock.sleep(50)
        }
        // Bound reached. The message carries read-only observations, because a crashed or
        // backgrounded app and a permission UI that never arrived look the same here.
        assertTrue(
            "the app offered no local-network rationale, no system permission dialog, and "
                + "no server-key consent within ${PERMISSION_BOUND_MS}ms; allowTapped=$allowTapped "
                + "grantControlSeen=$grantControlSeen "
                + "activity=${compose.activity.lifecycle.currentState} "
                + "windows=${osWindowSummary(automation)} ime=${imeWindowPresent()} "
                + "observed consent=${nodeExistsDuringOsHandoff(CONSENT_TITLE)} "
                + "connected=${nodeExistsDuringOsHandoff(CONNECTION_CONNECTED)} "
                + "rationale=${nodeExistsDuringOsHandoff(PERMISSION_RATIONALE)} "
                + "addHostDialog=${nodeExistsDuringOsHandoff(ADD_HOST_SUBMIT)} "
                + "hostCard=${nodeExistsDuringOsHandoff(hostLabel)} "
                + "(null means no Compose root was observed, not that the control was absent)",
            nodeExistsDuringOsHandoff(CONSENT_TITLE) == true ||
                nodeExistsDuringOsHandoff(CONNECTION_CONNECTED) == true,
        )
    }

    /**
     * One Compose text query inside the OS permission handoff only.
     *
     * `null` means "not observed": the app currently exposes no Compose hierarchy, so
     * nothing may be concluded about its controls. Only the specific
     * `No compose hierarchies found in the app` failure is translated this way; every
     * other throwable propagates. Outside this handoff, callers keep using [nodeExists],
     * which stays strict so that no negative assertion can pass on a missing Activity.
     */
    private fun nodeExistsDuringOsHandoff(text: String): Boolean? = try {
        nodeExists(text)
    } catch (failure: IllegalStateException) {
        if (!isTransientComposeRootGone(failure)) throw failure
        null
    }

    /** One Compose click inside the handoff; false means it was not performed. */
    private fun clickDuringOsHandoff(text: String): Boolean = try {
        clickText(text)
        true
    } catch (failure: IllegalStateException) {
        if (!isTransientComposeRootGone(failure)) throw failure
        false
    }

    /**
     * True only for the exact transient Compose failure raised when the app has no
     * composition to query — the one condition a system dialog can cause. Anything else,
     * including a destroyed Activity surfacing differently, is rethrown by the caller.
     */
    private fun isTransientComposeRootGone(failure: IllegalStateException): Boolean =
        failure.message?.contains("No compose hierarchies found in the app") == true

    /** True only when a real Compose query succeeded, i.e. the app's own root is back. */
    private fun appComposeRootObserved(): Boolean = nodeExistsDuringOsHandoff(NAV_HOSTS) != null

    /**
     * Bounded wait for an OS-owned transition. It deliberately never calls Compose's own
     * idle, which is the very thing unavailable while the system dialog holds the screen.
     */
    private fun awaitWithin(deadline: Long, what: String, condition: () -> Boolean) {
        while (!condition()) {
            if (SystemClock.uptimeMillis() > deadline) throw AssertionError("timed out waiting for $what")
            SystemClock.sleep(50)
        }
    }

    /** Read-only, bounded view of which OS windows exist and which holds focus. */
    private fun osWindowSummary(automation: UiAutomation): String =
        automation.windows.take(OS_WINDOW_SUMMARY_LIMIT).joinToString("; ") { window ->
            "type=${window.type} active=${window.isActive} focused=${window.isFocused} " +
                "pkg=${window.root?.packageName}"
        }


    /* ------------------------------------------------------------------ *
     * Setup that proves its own effect
     * ------------------------------------------------------------------ */

    /**
     * The live client graph's published view state, read through the same production
     * accessors its own screens use (`PiReviewGateApplication.controller` then
     * `ClientApplicationController.ui`).
     *
     * This is an observation of what the app already publishes, not a seam: nothing here
     * writes to the graph, and no proof, receipt, or runtime state is read or touched.
     */
    private fun publishedUiState(): ClientUiState? =
        (context().applicationContext as PiReviewGateApplication).controller.value?.ui?.value

    private fun requirePublishedUiState(): ClientUiState {
        val state = publishedUiState()
        assertTrue("the client graph never published a view state", state != null)
        return state!!
    }

    /** Saved host records carrying this run's own label AND its real endpoint. */
    private fun savedOwnerRecords(): Int = requirePublishedUiState().hostStates.count { view ->
        view.host.label.value == hostLabel &&
            view.host.endpoint.host == EMULATOR_LOOPBACK &&
            view.host.endpoint.port == ownerPort
    }

    /** Whether the published dialog model still holds the Add host form. */
    private fun addHostDialogOpen(): Boolean = requirePublishedUiState().dialogs.addHost != null

    /**
     * Save the owner host with exactly one real Save activation and prove the save.
     *
     * Production `SubmitNewHost` (`ClientApplicationController.kt:851-865`) adds the
     * host to the registry and reports the outcome, but never closes the Add host form:
     * `dialogs.addHost` is nulled only by an explicit dismiss or by leaving the route.
     * So a closed dialog would prove nothing about the save, and a second Save tap
     * would be granted and create a second host — the catalog enforces unique ids only,
     * and each tap mints a fresh one. The positive witness is therefore the published
     * host list gaining exactly one record with this run's label and endpoint.
     */
    private fun saveTheOwnerHost() {
        val before = savedOwnerRecords()
        assertTrue(
            "this run's owner host record already existed $before times before the form was filled",
            before == 0,
        )
        clickText(ADD_HOST_SUBMIT)
        awaitUi("the published host list to gain this run's owner record") { savedOwnerRecords() > before }
        assertEquals(
            "one Save activation must create exactly one host record",
            before + 1,
            savedOwnerRecords(),
        )
    }

    /**
     * Close the Add host form with its own Dismiss control — the only real way
     * production closes it — and assert the modal is gone from both the published
     * dialog model and the semantics tree before anything behind it is touched.
     */
    private fun closeAddHostDialog() {
        if (!addHostDialogOpen()) return
        clickText(ADD_HOST_DISMISS)
        awaitUi("the Add host dialog to close") { !addHostDialogOpen() && !nodeExists(ADD_HOST_DISMISS) }
    }

    /**
     * Put the installed IME away through its own action key, then observe that it is
     * gone. No `adb input`, no key-code guess, and no assumption: the IME window's
     * disappearance is the assertion.
     */
    private fun dismissInstalledIme() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        if (!imeWindowPresent()) return
        tapBounds(automation, awaitImeControl(automation, IME_ACTION_LABELS))
        val deadline = SystemClock.uptimeMillis() + IME_KEY_BOUND_MS
        while (imeWindowPresent() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
        assertFalse(
            "the installed IME window is still present after its own action key was tapped",
            imeWindowPresent(),
        )
    }

    private fun imeWindowPresent(): Boolean = InstrumentationRegistry.getInstrumentation()
        .uiAutomation.windows
        .any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }

    /** Wait for one named control inside the real IME window and return its bounds. */
    private fun awaitImeControl(automation: UiAutomation, labels: Set<String>): Rect {
        val deadline = SystemClock.uptimeMillis() + IME_KEY_BOUND_MS
        while (SystemClock.uptimeMillis() < deadline) {
            val found = automation.windows
                .filter { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
                .mapNotNull { it.root }
                .firstNotNullOfOrNull { root -> labels.mapNotNull { findNodeByText(root, it) }.firstOrNull() }
            if (found != null) return found
            SystemClock.sleep(25)
        }
        throw AssertionError(
            "the installed IME offered none of ${IME_ACTION_LABELS} to dismiss itself",
        )
    }

    /**
     * Refuse to act on a control that could be behind a modal.
     *
     * A semantics query reaches the activity's root while a dialog keeps its own
     * window, and production `ClientWindow.connect` drops a connect outright when the
     * activity does not hold window focus — which a Material dialog owns instead. So
     * every control this driver taps outside a dialog is checked against the dialogs
     * it opens, and a still-open one fails here rather than looking like a permission
     * problem later.
     */
    private fun assertNoFixtureDialogOpen(what: String) {
        val open = listOf(ADD_HOST_SUBMIT, CONSENT_APPROVE, PERMISSION_CONTINUE).filter { nodeExists(it) }
        assertTrue("$what: refusing to act while a dialog is still open ($open)", open.isEmpty())
    }

    /* ------------------------------------------------------------------ *
     * Navigation that matches the real navigation graph
     * ------------------------------------------------------------------ */

    /**
     * Select a bottom-bar destination through its own selectable semantics.
     *
     * On a non-terminal screen the same words also appear as the header title and,
     * for Settings, as a header action, so text alone is ambiguous. The
     * NavigationBarItem is the bottom-most match and the only one reporting
     * `Selected`, and the selection is asserted after the click.
     */
    private fun openDestination(label: String) {
        if (destinationSelected(label)) return
        val nodes = compose.onAllNodesWithText(label).fetchSemanticsNodes()
        assertTrue("the UI offers a '$label' control", nodes.isNotEmpty())
        val index = nodes.indices.maxByOrNull { nodes[it].boundsInWindow.center.y } ?: 0
        compose.onAllNodesWithText(label)[index].performClick()
        compose.waitForIdle()
        assertTrue("'$label' is the selected destination", destinationSelected(label))
    }

    private fun destinationSelected(label: String): Boolean {
        val nodes = compose.onAllNodesWithText(label).fetchSemanticsNodes()
        if (nodes.isEmpty()) return false
        val index = nodes.indices.maxByOrNull { nodes[it].boundsInWindow.center.y } ?: return false
        return nodes[index].config.valueOrNull(SemanticsProperties.Selected) == true
    }

    /** Leave the fullscreen terminal through its own Back control, then go to Sessions. */
    private fun leaveTerminal() {
        if (findTerminalSurface(compose.activity.window.decorView) != null) {
            assertTrue("the terminal offers its own Back control", nodeExists(ACTION_BACK))
            clickText(ACTION_BACK)
            compose.waitForIdle()
        }
        openDestination(NAV_SESSIONS)
    }

    /** Click one text control that is already laid out (a dialog button, say). */
    private fun clickText(text: String) {
        compose.onAllNodesWithText(text)[0].performClick()
        compose.waitForIdle()
    }

    /** Click a control that lives inside a list, scrolling it into view first. */
    private fun clickTextInList(text: String, index: Int) {
        assertTrue(
            "the screen offers a scroll container for '$text'",
            compose.onAllNodes(hasScrollAction()).fetchSemanticsNodes().isNotEmpty(),
        )
        val interaction = compose.onAllNodesWithText(text)[index]
        interaction.performScrollTo()
        interaction.assertIsDisplayed()
        interaction.performClick()
        compose.waitForIdle()
    }

    /**
     * Fill one real text field of the Add host dialog by position, then read the
     * value back out of that field. A label's Text node is not the field, so the
     * editable nodes are addressed directly and the entered value is verified.
     */
    private fun enterTextField(label: String, value: String) {
        val fields = compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes()
        assertTrue(
            "the Add host dialog offers its three text fields",
            fields.size >= listOf(FIELD_LABEL, FIELD_ADDRESS, FIELD_PORT).size,
        )
        val index = listOf(FIELD_LABEL, FIELD_ADDRESS, FIELD_PORT).indexOf(label)
        assertTrue("'$label' is one of the Add host fields", index >= 0)
        compose.onAllNodes(hasSetTextAction())[index].performTextInput(value)
        compose.waitForIdle()
        val entered = compose.onAllNodes(hasSetTextAction())[index]
            .fetchSemanticsNode().config.valueOrNull(SemanticsProperties.EditableText)
            ?.toString()
        assertEquals("the '$label' field holds what was typed", value, entered)
    }

    /**
     * Open the terminal for the card whose caption is [caption].
     *
     * Every call opens a NEW pane, so it advances [paneGeneration]: the keyboard binding
     * of any earlier pane no longer counts, even when the OS keyboard stayed on screen.
     */
    private fun openTerminalForRow(caption: String) {
        paneGeneration += 1
        openDestination(NAV_SESSIONS)
        awaitUi("the roster row '$caption'") { nodeExists(caption) }
        val captionTop = compose.onAllNodesWithText(caption)[0].fetchSemanticsNode().boundsInWindow.top
        val buttons = compose.onAllNodesWithText(ACTION_OPEN_TERMINAL).fetchSemanticsNodes()
        assertTrue("the roster offers an Open terminal action", buttons.isNotEmpty())
        val index = buttons.indices.minByOrNull { kotlin.math.abs(buttons[it].boundsInWindow.top - captionTop) } ?: 0
        clickTextInList(ACTION_OPEN_TERMINAL, index)
    }

    /* ------------------------------------------------------------------ *
     * Display progress and input authority, read separately
     * ------------------------------------------------------------------ */

    /** The newest attested display commit, or null when none stands. UI thread only. */
    private fun displayCommit(surface: TerminalSurfaceView): Long? =
        compose.runOnIdle { surface.currentReceipt()?.commitSequence }

    /**
     * Wait for a committed frame that carries the fixture row and authorizes input.
     *
     * The surface only attests a commit while it holds view focus, and production hands
     * the pane that focus from one thing only: a real user action on the pane. So the
     * driver does what a user does before typing — wait for the surface to attach, then
     * press the pane's own Keyboard control, whose real handler requests focus and the
     * IME. That is not `requestFocus()`, not an injected proof, and not a policy change;
     * the keyboard control is not gated on input readiness. An OS keyboard still on
     * screen from an earlier pane is never taken as this pane's input connection: see
     * [bindPaneKeyboard]. `typeThroughNativeIme` then finds this same pane already bound
     * and does not toggle the keyboard again. Opening the keyboard can also resize the
     * surface; whether the owner then republishes a frame or a source is the owner's own
     * observed behaviour, claimed separately and not assumed here.
     *
     * Only the positive paths call this. While viewer policy is Off the driver uses
     * `awaitAttachedSurface` and never reaches for the keyboard here.
     */
    private fun awaitInputAuthority(rowId: String): TerminalSurfaceView {
        awaitAttachedSurface()
        bindPaneKeyboard()
        awaitUi("a written terminal frame that authorizes input") {
            val surface = findTerminalSurface(compose.activity.window.decorView)
            surface?.currentInputProof()?.rowId == rowId
        }
        val surface = requireNotNull(findTerminalSurface(compose.activity.window.decorView))
        compose.runOnIdle {
            val proof: FrameCommitReceipt = requireNotNull(surface.currentInputProof())
            assertTrue("the drawn frame's own receipt authorizes input", surface.verifyReceipt(proof))
            assertTrue("the frame actually drew cells", proof.drawnColumns > 0 && proof.drawnRows > 0)
            assertNotNull("the drawn frame carries an input source", proof.source)
            assertTrue("the receipt says it authorizes input", proof.authorizesInput)
            assertEquals("the drawn frame belongs to the fixture row", rowId, proof.rowId)
        }
        return surface
    }

    /** Wait for the real terminal surface to be attached, without demanding authority. */
    private fun awaitAttachedSurface(): TerminalSurfaceView {
        awaitUi("the terminal surface to attach") {
            findTerminalSurface(compose.activity.window.decorView) != null
        }
        return requireNotNull(findTerminalSurface(compose.activity.window.decorView))
    }

    /* ------------------------------------------------------------------ *
     * The real Settings switch
     * ------------------------------------------------------------------ */

    /** Flip the real "Remote input and copy" switch on the real Settings screen. */
    private fun setViewerRemoteInput(enabled: Boolean) {
        // The fullscreen terminal has no navigation bar at all: Settings can only be
        // reached after leaving it through its own Back control.
        leaveTerminal()
        openDestination(NAV_SETTINGS)
        awaitUi("the Settings screen") { nodeExists(SETTING_VIEWER_INPUT) }
        val title = compose.onAllNodesWithText(SETTING_VIEWER_INPUT)[0].fetchSemanticsNode()
        val toggles = compose.onAllNodes(isToggleable()).fetchSemanticsNodes()
        assertTrue("the Settings screen offers switches", toggles.isNotEmpty())
        val index = toggles.indices.minByOrNull {
            kotlin.math.abs(toggles[it].boundsInWindow.center.y - title.boundsInWindow.center.y)
        } ?: 0
        val switch = compose.onAllNodes(isToggleable())[index]
        if (switchIsOn(switch) != enabled) {
            switch.performClick()
            compose.waitForIdle()
        }
        assertEquals("the real Settings switch now reads $enabled", enabled, switchIsOn(switch))
    }

    /** Reads a real switch through the test framework's own toggle assertions. */
    private fun switchIsOn(switch: SemanticsNodeInteraction): Boolean = try {
        switch.assertIsOn()
        true
    } catch (_: AssertionError) {
        switch.assertIsOff()
        false
    }

    /* ------------------------------------------------------------------ *
     * Real IME typing and clipboard observation
     * ------------------------------------------------------------------ */

    /**
     * Tap each character inside the installed OS IME's own accessibility window.
     * No `adb input text`, no direct `commitText`, and no app-encoded substitute.
     *
     * The keys go to the pane on screen NOW: [bindPaneKeyboard] makes sure this pane
     * received its own Keyboard action first. That holds on the policy-Off pane too —
     * the Keyboard control is not gated on input readiness and creates no authority, so
     * the Off negatives are measured against keys that really reached the Off pane
     * rather than an input connection left over from an earlier one. Each key is
     * located afresh, right before its own tap, by [awaitImeKey]; there is no
     * per-character delay and no retyping.
     */
    private fun typeThroughNativeIme(text: String) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        bindPaneKeyboard()
        for (character in text) {
            tapBounds(automation, awaitImeKey(automation, character))
        }
    }

    /**
     * The IME window and system dialogs are only listed once this flag is on. The
     * caller restores the previous flags.
     */
    private fun enableInteractiveWindows(automation: UiAutomation): Int = compose.runOnIdle {
        val info = automation.serviceInfo
        val previous = info.flags
        info.flags = previous or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        automation.serviceInfo = info
        previous
    }

    private fun restoreInteractiveWindows(automation: UiAutomation, previousFlags: Int) {
        compose.runOnIdle {
            val info = automation.serviceInfo
            info.flags = previousFlags
            automation.serviceInfo = info
        }
    }

    /**
     * Give the pane on screen its own real Keyboard action, once.
     *
     * A visible OS keyboard says nothing about WHICH view holds its input connection:
     * after leaving one pane and opening another, the keyboard can stay on screen while
     * the new pane was never focused. So visibility alone never satisfies this; only a
     * Keyboard action taken on this pane (same [paneGeneration], same surface) does.
     *
     * The production control is a toggle (`SetTerminalKeyboardVisible(!keyboardVisible)`)
     * whose description is the app's own `key_hide_keyboard` while it observes an IME and
     * `key_show_keyboard` otherwise; only the Show handler focuses the pane and asks for
     * the IME. So the step follows what the control actually offers on this pane, read
     * from those resource strings, never IME visibility alone: when it offers Show, the
     * driver presses Show; when it offers Hide, the driver presses Hide, observes the
     * keyboard gone and the control offering Show, and presses Show. Each is one
     * ordinary tap on the real control, never repeated blind; nothing here calls
     * `requestFocus`, `restartInput`, or `commitText`, or touches a proof, a receipt, or
     * a source flag. Within the same pane, a keyboard that is still up is not cycled.
     */
    private fun bindPaneKeyboard() {
        val surface = requireNotNull(findTerminalSurface(compose.activity.window.decorView))
        val boundToThisPane = keyboardPaneGeneration == paneGeneration && keyboardSurface === surface
        val imeUp = compose.runOnIdle { imeVisible(surface) }
        when (paneKeyboardStep(boundToThisPane, imeUp, awaitKeyboardControlOffer())) {
            PaneKeyboardStep.NONE -> return
            PaneKeyboardStep.HIDE_THEN_SHOW -> {
                pressPaneKeyboardControl(hideKeyboardLabel)
                awaitUi("the OS keyboard to go away through this pane's own Hide control") {
                    compose.runOnIdle { !imeVisible(surface) } && keyboardControlOffer() == KeyboardControlOffer.SHOW
                }
                pressPaneKeyboardControl(showKeyboardLabel)
            }
            PaneKeyboardStep.SHOW -> pressPaneKeyboardControl(showKeyboardLabel)
        }
        awaitUi("the OS keyboard to become visible for this pane") { compose.runOnIdle { imeVisible(surface) } }
        keyboardPaneGeneration = paneGeneration
        keyboardSurface = surface
    }

    /** The app's own descriptions for the pane keyboard control's two states. */
    private val showKeyboardLabel: String by lazy { compose.activity.getString(R.string.key_show_keyboard) }
    private val hideKeyboardLabel: String by lazy { compose.activity.getString(R.string.key_hide_keyboard) }

    /** What the one keyboard control offers right now, or null unless exactly one state is shown. */
    private fun keyboardControlOffer(): KeyboardControlOffer? {
        val show = compose.onAllNodesWithContentDescription(showKeyboardLabel).fetchSemanticsNodes().size
        val hide = compose.onAllNodesWithContentDescription(hideKeyboardLabel).fetchSemanticsNodes().size
        return when {
            show == 1 && hide == 0 -> KeyboardControlOffer.SHOW
            hide == 1 && show == 0 -> KeyboardControlOffer.HIDE
            else -> null
        }
    }

    private fun awaitKeyboardControlOffer(): KeyboardControlOffer {
        var offer: KeyboardControlOffer? = null
        awaitUi("this pane's keyboard control to offer exactly one of Show or Hide") {
            offer = keyboardControlOffer()
            offer != null
        }
        return requireNotNull(offer)
    }

    /** One real tap on the pane's keyboard control while it offers exactly [description]. */
    private fun pressPaneKeyboardControl(description: String) {
        compose.onNodeWithContentDescription(description).performClick()
        compose.waitForIdle()
    }

    private fun imeVisible(surface: TerminalSurfaceView): Boolean =
        surface.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true

    /**
     * The bounds of the one real key labelled [character] in the installed IME's own
     * window, read live for this tap.
     *
     * Only an exact-label node that is visible to the user, enabled, offers the public
     * click action, and has non-empty bounds can be a key ([selectImeKey]); a preview or
     * any other node merely sharing the label does not qualify. No eligible node, or
     * more than one, is refused, and the wait fails closed at the existing bound. The
     * failure carries counts only.
     */
    private fun awaitImeKey(automation: UiAutomation, character: Char): Rect {
        val label = character.toString()
        val deadline = SystemClock.uptimeMillis() + IME_KEY_BOUND_MS
        var refused: ImeKeySelection.Refused? = null
        while (SystemClock.uptimeMillis() < deadline) {
            val scans = automation.windows
                .filter { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
                .mapNotNull { it.root }
                .map(::imeNodeFacts)
            val selection = selectImeKey(
                nodes = scans.flatMap { it.nodes },
                label = label,
                complete = scans.all { it.complete },
            )
            when (selection) {
                is ImeKeySelection.Unique -> return selection.bounds
                is ImeKeySelection.Refused -> refused = selection
            }
            SystemClock.sleep(25)
        }
        throw AssertionError(
            "the installed IME never presented exactly one visible, enabled, clickable key " +
                "labelled '$character' (eligible=${refused?.eligible} labelMatches=${refused?.labelMatches} " +
                "scanComplete=${refused?.complete})",
        )
    }

    /**
     * Public facts of every labelled node under [root], within the usual walk budget.
     * The scan is complete only when no node was left unvisited at that budget.
     */
    private fun imeNodeFacts(root: AccessibilityNodeInfo): ImeScan {
        val out = mutableListOf<ImeNodeFacts>()
        val pending = ArrayDeque<AccessibilityNodeInfo>()
        pending.add(root)
        var visited = 0
        while (pending.isNotEmpty() && visited++ < 1_024) {
            val node = pending.removeFirst()
            val text = node.text?.toString()
            val description = node.contentDescription?.toString()
            if (text != null || description != null) {
                out.add(
                    ImeNodeFacts(
                        text = text,
                        contentDescription = description,
                        visibleToUser = node.isVisibleToUser,
                        enabled = node.isEnabled,
                        offersClick = node.actionList.any {
                            it.id == AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK.id
                        },
                        bounds = Rect().also(node::getBoundsInScreen),
                    ),
                )
            }
            for (index in 0 until node.childCount) node.getChild(index)?.let(pending::add)
        }
        return ImeScan(nodes = out, complete = pending.isEmpty())
    }

    private fun findNodeByText(root: AccessibilityNodeInfo, text: String): Rect? {
        val pending = ArrayDeque<AccessibilityNodeInfo>()
        pending.add(root)
        var visited = 0
        while (pending.isNotEmpty() && visited++ < 1_024) {
            val node = pending.removeFirst()
            if (node.isVisibleToUser
                && (node.text?.toString() == text || node.contentDescription?.toString() == text)
            ) {
                val bounds = Rect().also(node::getBoundsInScreen)
                if (!bounds.isEmpty) return bounds
            }
            for (index in 0 until node.childCount) node.getChild(index)?.let(pending::add)
        }
        return null
    }

    private fun findClickableSystemLabel(automation: UiAutomation, labels: Set<String>): Rect? {
        for (root in automation.windows.mapNotNull { it.root }) {
            val pending = ArrayDeque<AccessibilityNodeInfo>()
            pending.add(root)
            var visited = 0
            while (pending.isNotEmpty() && visited++ < 1_024) {
                val node = pending.removeFirst()
                val label = (node.text ?: node.contentDescription)?.toString()?.trim()
                if (node.isVisibleToUser && node.isClickable && label != null && labels.contains(label)) {
                    val bounds = Rect().also(node::getBoundsInScreen)
                    if (!bounds.isEmpty) return bounds
                }
                for (index in 0 until node.childCount) node.getChild(index)?.let(pending::add)
            }
        }
        return null
    }

    /**
     * The real grant control of the system permission dialog, identified by its own
     * resource id inside the focused permission-controller window.
     *
     * The API 37 dialog is owned by `com.android.permissioncontroller`, and its two
     * buttons are `…:id/permission_allow_button` (labelled `ALLOW`) and
     * `…:id/permission_deny_button` (labelled `DON’T ALLOW`). Identity is therefore taken
     * from the resource id, which cannot be confused with the reject control, while the
     * window's root package and focus fence out any lookalike the app itself draws — a
     * label test would have neither of those properties, and a substring test would match
     * the reject label as well. The node must additionally be visible, clickable, enabled,
     * and non-empty bounded, and the walk stays within the same fixed budget as the other
     * accessibility walks here. This is an ordinary injected UI tap on the real control,
     * performed through the existing [tapBounds]; nothing is granted out of band.
     */
    private fun findNativePermissionGrant(automation: UiAutomation): Rect? {
        for (window in automation.windows) {
            val root = window.root ?: continue
            if (!window.isFocused || root.packageName?.toString() != PERMISSION_CONTROLLER_PACKAGE) {
                continue
            }
            val pending = ArrayDeque<AccessibilityNodeInfo>()
            pending.add(root)
            var visited = 0
            while (pending.isNotEmpty() && visited++ < 1_024) {
                val node = pending.removeFirst()
                if (node.viewIdResourceName?.toString() == PERMISSION_ALLOW_BUTTON_ID &&
                    node.isVisibleToUser && node.isClickable && node.isEnabled
                ) {
                    val bounds = Rect().also(node::getBoundsInScreen)
                    if (!bounds.isEmpty) return bounds
                }
                for (index in 0 until node.childCount) node.getChild(index)?.let(pending::add)
            }
        }
        return null
    }

    private fun tapBounds(automation: UiAutomation, bounds: Rect) {
        val now = SystemClock.uptimeMillis()
        listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).forEach { action ->
            val event = MotionEvent.obtain(
                now,
                now + if (action == MotionEvent.ACTION_UP) 30L else 0L,
                action,
                bounds.exactCenterX(),
                bounds.exactCenterY(),
                0,
            )
            try {
                assertTrue("the injected tap was accepted", automation.injectInputEvent(event, true))
            } finally {
                event.recycle()
            }
        }
    }

    private fun clipText(): String? = context().getSystemService(ClipboardManager::class.java)
        .primaryClip
        ?.takeIf { it.itemCount > 0 }
        ?.getItemAt(0)
        ?.text
        ?.toString()

    /**
     * What the real clipboard holds right now: the description label and the first
     * item's text, read directly rather than remembered from a notification.
     */
    private fun currentClip(): Pair<String?, String?>? =
        context().getSystemService(ClipboardManager::class.java)
            .primaryClip
            ?.takeIf { it.itemCount > 0 }
            ?.let { clip -> clip.description?.label?.toString() to clip.getItemAt(0)?.text?.toString() }

    /** Bounded settle used only where the assertion is that nothing happened. */
    private fun settle(millis: Long) {
        val deadline = SystemClock.uptimeMillis() + millis
        while (SystemClock.uptimeMillis() < deadline) {
            compose.waitForIdle()
            SystemClock.sleep(50)
        }
    }

    private fun reportEvent(event: String, vararg fields: Pair<String, String>) {
        val bundle = Bundle().apply {
            putString("prgEvent", event)
            putString("fixtureRun", runToken)
            fields.forEach { putString(it.first, it.second) }
        }
        InstrumentationRegistry.getInstrumentation().sendStatus(1, bundle)
    }

    /**
     * One owned clipboard observer.
     *
     * WHAT IT COUNTS. `notifications` is the number of times the framework told this
     * listener that the primary clip changed. That is NOT a write count: one app
     * write can produce more than one notification, and the framework may fold or
     * repeat deliveries for its own reasons. The write count comes from the
     * test-only clipboard-write meter, which counts entries of the SDK setter itself.
     *
     * It keeps every arrival and the clip text it saw, in order, with no
     * de-duplication, so a run can be inspected afterwards; it is attached only after
     * this test's own sentinel write, so nothing it records predates the phase.
     */
    private inner class ClipRecorder(context: Context) {
        private val clipboard = context.getSystemService(ClipboardManager::class.java)
        private val listener = ClipboardManager.OnPrimaryClipChangedListener { record() }
        val seen = mutableListOf<String>()
        val matches = mutableListOf<Pair<String?, String>>()

        /** Framework notifications received, not clipboard writes performed. */
        var notifications = 0
            private set

        fun attach() {
            clipboard.addPrimaryClipChangedListener(listener)
        }

        fun detach() {
            clipboard.removePrimaryClipChangedListener(listener)
        }

        private fun record() {
            notifications += 1
            val clip = clipboard.primaryClip ?: return
            if (clip.itemCount == 0) return
            val text = clip.getItemAt(0).text?.toString() ?: return
            seen.add(text)
            matches.add(clip.description?.label?.toString() to text)
        }

        fun matches(prefix: String): Boolean = matches.any { it.second.startsWith(prefix) }
    }

    /* ------------------------------------------------------------------ *
     * Bounded UI waiting and real production surface discovery
     * ------------------------------------------------------------------ */

    private fun nodeExists(text: String): Boolean =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

    private fun awaitUi(what: String, boundMs: Long = UI_BOUND_MS, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + boundMs
        while (!condition()) {
            if (SystemClock.uptimeMillis() > deadline) throw AssertionError("timed out waiting for $what")
            compose.waitForIdle()
            SystemClock.sleep(50)
        }
    }

    private fun findTerminalSurface(view: View): TerminalSurfaceView? {
        if (view is TerminalSurfaceView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findTerminalSurface(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }

    private fun copyPrefix(backend: String): String = "PRGCOPY-$backend-$runToken"

    private companion object {
        const val EMULATOR_LOOPBACK = "10.0.2.2"
        const val COPY_TRIGGER = "prgcopy"
        const val CLIP_LABEL = "Pi Review Gate"
        const val SETTLE_MS = 2_000L
        const val SNAPSHOT_SETTLE_MS = 4_000L
        const val UI_BOUND_MS = 60_000L
        const val PERMISSION_BOUND_MS = 30_000L
        /** Cap for the read-only OS window summary in permission failure messages. */
        const val OS_WINDOW_SUMMARY_LIMIT = 8
        const val IME_KEY_BOUND_MS = 30_000L

        const val NAV_SESSIONS = "Sessions"
        const val NAV_HOSTS = "Hosts"
        const val NAV_SETTINGS = "Settings"
        const val ACTION_CONNECT = "Connect"
        const val ACTION_ADD_HOST = "Add host"
        const val ACTION_BACK = "Back"
        const val ACTION_OPEN_TERMINAL = "Open terminal"
        const val ADD_HOST_SUBMIT = "Save host"
        const val ADD_HOST_DISMISS = "Dismiss"
        const val FIELD_LABEL = "Label"
        const val FIELD_ADDRESS = "Address"
        const val FIELD_PORT = "Port"
        const val CONSENT_TITLE = "Verify this server key"
        const val CONSENT_APPROVE = "Approve key"
        const val CONNECTION_CONNECTED = "Connected"
        const val PERMISSION_RATIONALE = "Local network access needed"
        const val PERMISSION_CONTINUE = "Continue"
        const val SETTING_VIEWER_INPUT = "Remote input and copy"
        const val IDENTITY_FINGERPRINT_LABEL = "This device's fingerprint"
        val PERMISSION_ALLOW_LABELS = setOf("Allow", "While using the app", "Allow while using the app")
        /** The stock API 37 permission controller and its grant control's resource id. */
        const val PERMISSION_CONTROLLER_PACKAGE = "com.android.permissioncontroller"
        const val PERMISSION_ALLOW_BUTTON_ID = "com.android.permissioncontroller:id/permission_allow_button"
        /** The action key the installed IME presents for a single-line field. */
        val IME_ACTION_LABELS = setOf("Done")
    }
}

/** What the driver must do on the pane's keyboard control before typing there. */
internal enum class PaneKeyboardStep { NONE, SHOW, HIDE_THEN_SHOW }

/** Which state the pane's real keyboard toggle currently offers. */
internal enum class KeyboardControlOffer { SHOW, HIDE }

/**
 * The pane-keyboard rule, kept pure so its negatives can be tested without a device.
 *
 * [boundToThisPane] is true only when this very pane already received its own Show
 * action; IME visibility never substitutes for it. Otherwise the step follows what the
 * real toggle [offer]s: Show is pressed directly, even with an IME on screen, and a Hide
 * offer must be taken first, because only the Show handler focuses the pane.
 */
internal fun paneKeyboardStep(
    boundToThisPane: Boolean,
    imeVisible: Boolean,
    offer: KeyboardControlOffer,
): PaneKeyboardStep = when {
    boundToThisPane && imeVisible -> PaneKeyboardStep.NONE
    offer == KeyboardControlOffer.HIDE -> PaneKeyboardStep.HIDE_THEN_SHOW
    else -> PaneKeyboardStep.SHOW
}

/** Public accessibility facts of one labelled node in the real IME window, read live. */
internal data class ImeNodeFacts(
    val text: String?,
    val contentDescription: String?,
    val visibleToUser: Boolean,
    val enabled: Boolean,
    /** The node lists the public `ACTION_CLICK` action. */
    val offersClick: Boolean,
    val bounds: Rect,
)

/** One IME window's labelled nodes; [complete] is false when the walk budget left nodes unvisited. */
internal data class ImeScan(val nodes: List<ImeNodeFacts>, val complete: Boolean)

internal sealed class ImeKeySelection {
    /** Exactly one eligible key; [bounds] are that node's own screen bounds, unaltered. */
    data class Unique(val bounds: Rect) : ImeKeySelection()

    /**
     * No tap is authorized: zero or several eligible keys among [labelMatches] exact-label
     * nodes, or a scan that was not [complete] and so cannot rule out another match.
     */
    data class Refused(val eligible: Int, val labelMatches: Int, val complete: Boolean) : ImeKeySelection()
}

internal fun imeNodeHasLabel(node: ImeNodeFacts, label: String): Boolean =
    node.text == label || node.contentDescription == label

/** An exact-label node that is visible, enabled, clickable, and really laid out. */
internal fun isEligibleImeKey(node: ImeNodeFacts, label: String): Boolean =
    imeNodeHasLabel(node, label) && node.visibleToUser && node.enabled && node.offersClick && !node.bounds.isEmpty

/**
 * The single key a tap may target, or a refusal; never a guess between candidates.
 *
 * Uniqueness is only knowable over a [complete] scan: a truncated walk that found one
 * eligible key cannot rule out a second one beyond the budget, so it authorizes nothing.
 */
internal fun selectImeKey(nodes: List<ImeNodeFacts>, label: String, complete: Boolean): ImeKeySelection {
    val eligible = nodes.filter { isEligibleImeKey(it, label) }
    return if (complete && eligible.size == 1) {
        ImeKeySelection.Unique(Rect(eligible.single().bounds))
    } else {
        ImeKeySelection.Refused(
            eligible = eligible.size,
            labelMatches = nodes.count { imeNodeHasLabel(it, label) },
            complete = complete,
        )
    }
}
