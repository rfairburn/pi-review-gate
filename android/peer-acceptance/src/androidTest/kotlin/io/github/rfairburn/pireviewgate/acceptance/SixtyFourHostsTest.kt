package io.github.rfairburn.pireviewgate.acceptance

import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.view.WindowInsets
import android.widget.Button
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.hamcrest.Matchers.sameInstance
import org.junit.Test
import org.junit.runner.RunWith

/** Invoke exactly one method per instrumentation call; no automatic device work. */
@RunWith(AndroidJUnit4::class)
class SixtyFourHostsTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val args get() = InstrumentationRegistry.getArguments()
    private fun nonce(): String = checkedNonce(args.getString("nonce") ?: error("nonce required"))

    private fun emit(phase: String, status: String, nonce: String, key: String? = null, fingerprint: String? = null) {
        val payload = buildJsonObject {
            put("event", "peerAcceptance")
            put("version", 1)
            put("phase", phase)
            put("status", status)
            put("nonce", nonce)
            if (key != null) put("clientKeyId", key)
            if (fingerprint != null) put("clientFingerprint", fingerprint)
        }.toString()
        check(payload.toByteArray().size <= 4096)
        instrumentation.sendStatus(0, Bundle().apply { putString("peerAcceptance", payload) })
    }

    private fun diagnose(nonce: String, phase: String, error: Throwable, graph: AcceptanceGraph? = null) {
        AcceptanceDiagnostic.reportFailure(nonce, phase, error, { graph?.diagnosticEvidence() }) { payload ->
            instrumentation.sendStatus(0, Bundle().apply { putString(AcceptanceDiagnostic.BUNDLE_KEY, payload) })
        }
    }

    @Test fun prepareIdentity() = runBlocking {
        val nonce = nonce()
        emit("prepareIdentity", "starting", nonce)
        try {
            withTimeout(30_000) {
                runInterruptible(Dispatchers.IO) {
                    NonceResources.open(context, nonce, create = true).use { owned ->
                        // Production create-or-read lifecycle; no resets/repair or networking.
                        val key = owned.identity.use {
                            when (it.status()) {
                                PeerIdentityStatus.NeverInitialized -> it.initialize(HostLabel.parse(FIXTURE_LABEL)).key
                                is PeerIdentityStatus.Ready -> it.current().key
                                is PeerIdentityStatus.Refused -> error("fixture identity refused")
                            }
                        }
                        check(canonicalPublicKey(key.keyId) == key)
                        emit("prepareIdentity", "passed", nonce, key.keyId, key.fingerprint)
                    }
                }
            }
        } catch (error: Throwable) {
            emit("prepareIdentity", "failure", nonce)
            diagnose(nonce, "prepareIdentity", error)
            throw AssertionError("fixture prepareIdentity failed") // No platform/private diagnostics escape.
        }
    }

    @Test fun runSixtyFourHosts() = runBlocking {
        val nonce = nonce()
        emit("runSixtyFourHosts", "starting", nonce)
        var graphForDiagnostics: AcceptanceGraph? = null
        try {
            val manifest = AcceptanceManifest.parse(args.getString("manifestB64") ?: error("manifestB64 required"))
            check(manifest.nonce == nonce)
            NonceResources.open(context, nonce).use { owned ->
                ActivityScenario.launch<FixtureActivity>(Intent(context, FixtureActivity::class.java)).use { scenario ->
                    lateinit var activity: FixtureActivity
                    scenario.onActivity { activity = it }
                    var phase = "connect_action"
                    val graph = AcceptanceGraph(owned, manifest, activity) { nextPhase, status ->
                        phase = nextPhase
                        emit(nextPhase, status, nonce)
                    }
                    graphForDiagnostics = graph
                    try {
                        AcceptanceDiagnostic.observeFailure({ error -> diagnose(nonce, phase, error, graph) }) {
                            // Native fixture action, not a permission-shell grant or a fabricated callback.
                            // Check live view/window geometry, not a test-only layout or cached dimensions.
                            lateinit var button: Button
                            onView(withText("Connect")).check { view, missing ->
                                if (missing != null) throw missing
                                button = view as Button
                                check(button.rootView === activity.window.decorView)
                                check(activity.actionBar == null)
                                check(button.isAttachedToWindow && button.isShown && button.isEnabled && button.hasWindowFocus())
                                check(button.width > 0 && button.height > 0)
                                val visible = Rect()
                                check(button.getLocalVisibleRect(visible))
                                check(visible == Rect(0, 0, button.width, button.height))
                                val safe = Rect(activity.windowManager.currentWindowMetrics.bounds)
                                safe.inset(checkNotNull(button.rootWindowInsets).getInsets(
                                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
                                ))
                                val location = IntArray(2)
                                button.getLocationOnScreen(location)
                                check(safe.contains(location[0], location[1],
                                    location[0] + button.width, location[1] + button.height))
                            }
                            // Parent drives the real system Allow prompt on an owned AVD.
                            emit("native_connect_ready", "passed", nonce)
                            emit("connect_action", "starting", nonce)
                            onView(sameInstance(button)).perform(click())
                            scenario.onActivity { current ->
                                check(current === activity)
                                check(button.isAttachedToWindow && button.rootView === current.window.decorView)
                                // Only listener entry disables this same current button; injection alone is not delivery.
                                check(!button.isEnabled)
                            }
                            emit("connect_action", "passed", nonce)
                            withTimeout(600_000) { graph.run() }
                        }
                    } catch (error: Throwable) {
                        emit(phase, "failure", nonce)
                        throw error
                    } finally {
                        var cleanupPhase = "channel_cleanup"
                        try {
                            emit(cleanupPhase, "starting", nonce)
                            graph.closeAndAwait() // Uncertain closure throws; preserves root/alias.
                            emit(cleanupPhase, "passed", nonce)
                            cleanupPhase = "nonce_cleanup"
                            emit(cleanupPhase, "starting", nonce)
                            withContext(NonCancellable) {
                                withTimeout(15_000) { runInterruptible(Dispatchers.IO) { owned.deleteOwned() } }
                            }
                            emit(cleanupPhase, "passed", nonce)
                        } catch (error: Throwable) {
                            emit(cleanupPhase, "failure", nonce)
                            diagnose(nonce, cleanupPhase, error, graph)
                            throw error
                        }
                    }
                }
            }
            emit("runSixtyFourHosts", "passed", nonce)
        } catch (error: Throwable) {
            emit("runSixtyFourHosts", "failure", nonce)
            diagnose(nonce, "runSixtyFourHosts", error, graphForDiagnostics)
            throw AssertionError("fixture runSixtyFourHosts failed; inspect bounded phase statuses")
        }
    }

    @Test fun cleanupFixture() = runBlocking {
        val nonce = nonce()
        emit("cleanupFixture", "starting", nonce)
        try {
            withTimeout(15_000) { runInterruptible(Dispatchers.IO) { NonceResources.cleanup(context, nonce) } }
            emit("cleanupFixture", "passed", nonce)
        } catch (error: Throwable) {
            emit("cleanupFixture", "failure", nonce)
            diagnose(nonce, "cleanupFixture", error)
            throw AssertionError("fixture nonce cleanup unverified; preserve resources")
        }
    }
}
