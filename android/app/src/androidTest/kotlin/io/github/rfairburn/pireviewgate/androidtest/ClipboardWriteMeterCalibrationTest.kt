package io.github.rfairburn.pireviewgate.androidtest

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.rfairburn.pireviewgate.ui.UiVerificationActivity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Standalone calibration of the test-only clipboard-write meter: ONE real SDK
 * write counts 1, TWO identical back-to-back real writes count 2.
 *
 * WHY THIS EXISTS.  The native acceptance measurement counts entries of
 * `ClipboardManager.setPrimaryClip`, and a count is only worth anything if the
 * mechanism behind it has been shown — on the runtime it runs on — to count
 * calls rather than notifications, and to count them on every thread. This test
 * is that proof. It needs no owner fixture, no PTY child, no model, and no
 * pairing: it calls the real public SDK setter directly, from the app's own
 * process, and reads one continuous counter back.
 *
 * WHAT IS REAL HERE.  The writes go through the app's own
 * [ClipboardManager.getSystemService] instance — the same object production
 * gets — into the real system clipboard service, and the resulting clip is read
 * back out of the real clipboard. Nothing is mocked, proxied, injected, or
 * reflected on; the meter only observes the framework method the call already
 * enters.
 *
 * WHAT THE DIFFERENCES MEAN.  Each expectation is a difference between two reads
 * of the SAME uninterrupted counter, never a fresh window, a trace, a callback
 * count, or a timestamp. Between the two-write differential and the one-write
 * differential the counter never resets, so a mechanism that counted only the
 * first of two identical writes — the framework's notification de-duplication,
 * for instance — cannot pass.
 *
 * The listener arrivals are recorded as a DIAGNOSTIC ONLY. They are reported and
 * deliberately never asserted: they are the thing that must not be confused with
 * writes, and a passing or failing arrival count says nothing about the meter.
 */
@RunWith(AndroidJUnit4::class)
class ClipboardWriteMeterCalibrationTest {

    @get:Rule
    val compose = createAndroidComposeRule<UiVerificationActivity>()

    /** Diagnostic listener arrivals; never part of an assertion. */
    private val listenerArrivals = AtomicInteger(0)

    /** Latest clip text the listener happened to see; diagnostic only. */
    @Volatile
    private var lastNotifiedText: String? = null

    @Test
    fun oneRealSdkWriteCountsOneAndTwoIdenticalRealWritesCountTwo() {
        val meter = ClipWriteMeter.attach()
        report("meterAttached", "status" to meter.status(), "agentPath" to meter.agentPath)

        val clipboard = context().getSystemService(ClipboardManager::class.java)
        assertNotNull("the app's own clipboard service", clipboard)
        assertCountedSetterIsNotOverriddenBelowTheTarget(clipboard)

        val listener = ClipboardManager.OnPrimaryClipChangedListener {
            listenerArrivals.incrementAndGet()
            lastNotifiedText = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
        }
        clipboard.addPrimaryClipChangedListener(listener)
        // The last count seen while the meter was live, so the close can be checked
        // against it: closing must freeze that number, not move it or hide it.
        var lastLiveTotal = -1L
        var bodyCompleted = false
        try {
            awaitWindowFocus()

            // Differential 1: one real SDK write.
            val beforeOne = meter.total()
            writeCalibrationClip(clipboard)
            val afterOne = meter.total()
            val oneWriteDelta = afterOne - beforeOne
            assertEquals(
                "one real ClipboardManager.setPrimaryClip call must count exactly 1 entry " +
                    "on ${meter.agentPath}",
                1L,
                oneWriteDelta,
            )
            assertEquals(
                "the real clipboard must carry the text this test just wrote",
                CALIBRATION_TEXT,
                clipText(clipboard),
            )

            // Differential 2: two identical writes, back to back, on the same
            // uninterrupted counter. Same content, same label, no gap.
            val beforeTwo = meter.total()
            writeCalibrationClip(clipboard)
            writeCalibrationClip(clipboard)
            val afterTwo = meter.total()
            val twoWritesDelta = afterTwo - beforeTwo
            assertEquals(
                "two identical back-to-back real setPrimaryClip calls must count exactly 2 entries: " +
                    "the meter counts SDK calls, never de-duplicated notifications",
                2L,
                twoWritesDelta,
            )
            assertEquals(
                "the real clipboard still carries the same text",
                CALIBRATION_TEXT,
                clipText(clipboard),
            )

            // Differential 3: the same call from another thread, to show the count
            // is not limited to the thread that attached the agent.
            val beforeWorker = meter.total()
            writeCalibrationClipOnWorkerThread(clipboard)
            val afterWorker = meter.total()
            val workerDelta = afterWorker - beforeWorker
            assertEquals(
                "a real setPrimaryClip call on a different thread must also count exactly 1 entry",
                1L,
                workerDelta,
            )

            // The counter is one continuous sequence, not three windows.
            assertTrue("the counter never went backwards", afterOne >= beforeOne)
            assertTrue("the counter never went backwards", beforeTwo >= afterOne)
            assertTrue("the counter never went backwards", afterTwo >= beforeTwo)
            assertTrue("the counter never went backwards", afterWorker >= afterTwo)
            assertEquals(
                "no setPrimaryClip entry appeared outside the calls this test made",
                beforeOne + 1L + 2L + 1L,
                afterWorker,
            )
            lastLiveTotal = afterWorker

            report(
                "meterCalibrated",
                "oneWriteDelta" to oneWriteDelta.toString(),
                "twoWritesDelta" to twoWritesDelta.toString(),
                "workerThreadDelta" to workerDelta.toString(),
                "marks" to "$beforeOne,$afterOne,$beforeTwo,$afterTwo,$beforeWorker,$afterWorker",
                "listenerArrivals" to listenerArrivals.get().toString(),
                "lastNotifiedText" to (lastNotifiedText ?: "<none>"),
                "status" to meter.status(),
            )
            bodyCompleted = true
        } finally {
            clipboard.removePrimaryClipChangedListener(listener)
            val closedTotal = meter.requestStop()
            val closedStatus = meter.status()
            assertFalse("a closed meter reports no installed breakpoint", meter.breakpointInstalled())
            if (bodyCompleted) {
                assertEquals(
                    "closing freezes the count the continuous counter already carried",
                    lastLiveTotal,
                    closedTotal,
                )
            }
            val readAfterClose = try {
                meter.total()
                null
            } catch (refusal: AssertionError) {
                refusal.message
            }
            assertNotNull(
                "a closed meter reports no live count, so it cannot be read as still measuring",
                readAfterClose,
            )
            report(
                "meterStopped",
                "finalTotal" to closedTotal.toString(),
                "status" to closedStatus,
                "breakpointInstalled" to meter.breakpointInstalled().toString(),
            )
        }
    }

    /* ------------------------------------------------------------------ *
     * The real SDK calls under measurement
     * ------------------------------------------------------------------ */

    /** One real `ClipboardManager.setPrimaryClip(ClipData)` on the caller's thread. */
    private fun writeCalibrationClip(clipboard: ClipboardManager) {
        clipboard.setPrimaryClip(ClipData.newPlainText(CLIP_LABEL, CALIBRATION_TEXT))
    }

    /** The same real call, made on a thread the agent did not attach on. */
    private fun writeCalibrationClipOnWorkerThread(clipboard: ClipboardManager) {
        val done = CountDownLatch(1)
        val failure = AtomicLong(0)
        val thread = Thread({
            try {
                writeCalibrationClip(clipboard)
            } catch (problem: Throwable) {
                failure.set(problem.hashCode().toLong())
            } finally {
                done.countDown()
            }
        }, "prg-meter-calibration-worker")
        thread.start()
        assertTrue("the worker thread finished its real clipboard write", done.await(30, TimeUnit.SECONDS))
        assertEquals("the worker thread's write raised nothing", 0L, failure.get())
    }

    /**
     * The counted method must be the one the call actually enters.
     *
     * If any class between the service instance's own class and the framework
     * [ClipboardManager] declared its own `setPrimaryClip`, the framework entry
     * this meter breaks on would not be the frame the app's call runs through.
     */
    private fun assertCountedSetterIsNotOverriddenBelowTheTarget(clipboard: ClipboardManager) {
        var type: Class<*>? = clipboard.javaClass
        var hops = 0
        while (type != null && type != ClipboardManager::class.java) {
            assertTrue(
                "a class below the counted target overrides it (${type.name})",
                type.declaredMethods.none { method -> method.name == "setPrimaryClip" },
            )
            type = type.superclass
            hops += 1
        }
        assertTrue(
            "the clipboard service is not a ClipboardManager (${clipboard.javaClass.name})",
            type == ClipboardManager::class.java,
        )
    }

    private fun context(): Context = compose.activity.applicationContext

    private fun clipText(clipboard: ClipboardManager): String? = clipboard.primaryClip
        ?.takeIf { it.itemCount > 0 }
        ?.getItemAt(0)
        ?.text
        ?.toString()

    /**
     * The framework only accepts a clipboard write from the app that holds input
     * focus, so the calibration waits for that focus and fails rather than
     * measuring a write the system would have dropped.
     */
    private fun awaitWindowFocus(boundMs: Long = FOCUS_BOUND_MS) {
        val deadline = SystemClock.uptimeMillis() + boundMs
        while (!compose.runOnIdle { compose.activity.hasWindowFocus() }) {
            if (SystemClock.uptimeMillis() > deadline) {
                throw AssertionError(
                    "the calibration activity never took window focus within ${boundMs}ms; " +
                        "a clipboard write from an unfocused app is dropped by the framework",
                )
            }
            compose.waitForIdle()
            SystemClock.sleep(50)
        }
    }

    private fun report(event: String, vararg fields: Pair<String, String>) {
        val bundle = Bundle().apply {
            putString("prgMeterEvent", event)
            fields.forEach { putString(it.first, it.second) }
        }
        InstrumentationRegistry.getInstrumentation().sendStatus(1, bundle)
    }

    private companion object {
        /** Identical on every call: same content and same label, every time. */
        const val CALIBRATION_TEXT = "PRG-CLIPBOARD-METER-CALIBRATION"
        const val CLIP_LABEL = "PrgMeterCalibration"
        const val FOCUS_BOUND_MS = 30_000L
    }
}
