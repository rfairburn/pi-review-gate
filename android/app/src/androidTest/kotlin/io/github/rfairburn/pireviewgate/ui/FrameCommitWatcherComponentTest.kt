package io.github.rfairburn.pireviewgate.ui

import android.os.Handler
import android.os.Looper
import android.view.ViewTreeObserver
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.ui.render.FrameCommitWatcher
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class FrameCommitWatcherComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun supersededPlatformDeliveryCannotConsumeReplacementRegistration() {
        var drawnLabel by mutableStateOf("Synthetic initial commit window")
        compose.setContent { Text(drawnLabel) }
        val platformDispatched = CountDownLatch(1)
        val replacementDelivered = CountDownLatch(1)
        val reports = CopyOnWriteArrayList<Long>()
        val failure = AtomicReference<Throwable?>(null)
        val view = compose.activity.window.decorView
        lateinit var watcher: FrameCommitWatcher
        var firstDraw = true
        val mainHandler = Handler(Looper.getMainLooper())
        val supersede = Runnable {
            try {
                watcher.awaitCommit(2)
                drawnLabel = "Synthetic replacement commit window"
            } catch (error: Throwable) {
                failure.set(error)
                replacementDelivered.countDown()
            }
        }
        val signal = Runnable {
            platformDispatched.countDown()
            // Register this callback first, so its main-thread work supersedes
            // epoch 1 before that callback's queued main-thread delivery. Never
            // block the UI thread waiting for a callback the platform may itself
            // dispatch on the UI thread.
            if (Looper.myLooper() == Looper.getMainLooper()) supersede.run()
            else mainHandler.post(supersede)
        }
        val onPreDraw = ViewTreeObserver.OnPreDrawListener {
            if (firstDraw) {
                firstDraw = false
                view.viewTreeObserver.registerFrameCommitCallback(signal)
                watcher.awaitCommit(1)
            }
            true
        }
        compose.runOnIdle {
            watcher = FrameCommitWatcher(view) { epoch ->
                reports.add(epoch)
                if (epoch == 2L) replacementDelivered.countDown()
            }
            assertTrue(watcher.isCommitReportingAvailable)
            // ViewRootImpl captures frame callbacks before dispatchOnDraw.
            view.viewTreeObserver.addOnPreDrawListener(onPreDraw)
            // A real changed display list, not an unchanged decor invalidation.
            drawnLabel = "Synthetic first commit window"
        }
        try {
            // Advance Compose's test clock to draw the changed label before
            // awaiting the real callback on this non-UI instrumentation thread.
            compose.waitForIdle()
            assertTrue("Initial real platform commit not dispatched", platformDispatched.await(10, TimeUnit.SECONDS))
            // The raw event changes Compose state too; drive that second real
            // display list rather than waiting with the test clock paused.
            compose.waitForIdle()
            assertTrue("Replacement real commit not delivered", replacementDelivered.await(10, TimeUnit.SECONDS))
            failure.get()?.let { throw AssertionError("Platform callback barrier failed", it) }
            compose.waitForIdle()
            assertEquals(listOf(2L), reports.toList())
        } finally {
            compose.runOnIdle {
                watcher.cancel()
                val observer = view.viewTreeObserver
                if (observer.isAlive) {
                    observer.removeOnPreDrawListener(onPreDraw)
                    observer.unregisterFrameCommitCallback(signal)
                }
            }
        }
    }
}
