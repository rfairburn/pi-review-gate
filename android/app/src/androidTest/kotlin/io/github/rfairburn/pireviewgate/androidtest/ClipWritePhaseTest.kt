package io.github.rfairburn.pireviewgate.androidtest

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Regressions for the accounting a clipboard-write phase relies on.
 *
 * These exercise [ClipWritePhase] against a counter the test moves by hand, which is
 * the point: the escape routes are about WHEN a write appears relative to a
 * checkpoint, and that is exactly what a hand-moved counter can reproduce. Each one
 * is a sequence the acceptance test must reject; the last one is the honest sequence,
 * so the rejections above cannot pass by construction.
 *
 * No clipboard, UI, or meter is involved: these are the phase rules, not the device.
 */
@RunWith(AndroidJUnit4::class)
class ClipWritePhaseTest {

    /** The meter, as far as the accounting is concerned: one readable counter. */
    private class FakeMeter(start: Long) {
        var total: Long = start
    }

    private fun phase(meter: FakeMeter) = ClipWritePhase("test phase") { meter.total }

    /** A message that proves WHICH checkpoint rejected the sequence. */
    private fun rejection(block: () -> Unit): String {
        val failure = assertThrows("the phase accepted a write sequence it must reject", AssertionError::class.java, block)
        return failure.message ?: "<no message>"
    }

    /**
     * A duplicate from the first backend that lands while the second backend is being
     * set up must fail. Resampling a baseline before the second copy is what used to
     * hide this.
     */
    @Test
    fun interBackendDuplicateFailsTheNextCopyCheckpoint() {
        val meter = FakeMeter(0)
        val subject = phase(meter)

        subject.expectQuiet("before the first copy")
        meter.total += 1
        subject.expectCopy("carried by the first copy")

        // The delayed duplicate from backend one, arriving during backend two's setup.
        meter.total += 1

        // The gate before backend two even types: the phase is one write ahead.
        val quiet = rejection { subject.expectQuiet("before the second copy trigger") }
        assertTrue("the pre-trigger gate should reject the duplicate: $quiet", quiet.contains("no clipboard write is allowed"))

        // Backend two's real copy then makes three writes, against two expected.
        meter.total += 1
        val message = rejection { subject.expectCopy("carried by the second copy") }
        assertTrue("the rejection should name the cumulative expectation: $message", message.contains("expected cumulative 2"))
    }

    /**
     * A write after the last in-test assertion must fail the closed snapshot. A phase
     * that only compared deltas never saw this at all.
     */
    @Test
    fun trailingDuplicateAfterTheLastCopyFailsTheClosedSnapshot() {
        val meter = FakeMeter(0)
        val subject = phase(meter)

        meter.total += 1
        subject.expectCopy("carried by the first copy")
        meter.total += 1
        subject.expectCopy("carried by the second copy")

        // Nobody asserted here, and then the meter closed.
        meter.total += 1

        val message = rejection { subject.expectClosed(meter.total) }
        assertTrue("the closed snapshot should be checked against the whole phase: $message", message.contains("closed meter snapshot"))
    }

    /**
     * A replay that arrives during the settle interval after re-enabling must fail
     * before the fresh input, and must still fail as a cumulative mismatch afterwards.
     */
    @Test
    fun replayDuringTheReEnableSettleIntervalFailsBeforeFreshInput() {
        val meter = FakeMeter(7)
        val subject = phase(meter)

        meter.total += 1
        subject.expectCopy("is this test's own sentinel write")
        subject.expectQuiet("while the viewer policy is Off")
        subject.expectQuiet("after re-enabling")

        // The replay that slipped in during the settle between re-enable and the
        // fresh input — same content as the real copy, so no content check sees it.
        meter.total += 1

        val message = rejection { subject.expectQuiet("during the settle after re-enabling") }
        assertTrue("the quiet checkpoint should reject the replay: $message", message.contains("no clipboard write is allowed"))

        // And the fresh copy afterwards is still measured from the phase baseline, so
        // the replay cannot be absorbed as a new starting point.
        meter.total += 1
        val second = rejection { subject.expectCopy("is the fresh copy after a fresh actual input") }
        assertTrue("the fresh copy must be cumulative, not rebaselined: $second", second.contains("expected cumulative 9 from baseline 7"))
    }

    /**
     * The honest sequence: sentinel, a quiet Off window, one fresh copy, closed
     * snapshot. This must pass, or the rejections above prove nothing.
     *
     * It also pins what the phase REPORTS, not only what it asserts: the sentinel is
     * the phase's own write and must not appear as a write inside the Off window,
     * while the cumulative totals stay where the baseline put them.
     */
    @Test
    fun honestPhasePassesEveryCheckpoint() {
        val meter = FakeMeter(7)
        val subject = phase(meter)

        meter.total += 1
        subject.expectCopy("is this test's own sentinel write")
        // The sentinel belongs to the phase total but to no measured window.
        subject.markReported()
        subject.expectQuiet("while the viewer policy is Off")
        subject.expectQuiet("during the settle after re-enabling")
        val offReport = subject.reportFields(window = "policyOffThroughReEnable")
        assertEquals("0", offReport["writesSinceLastCheckpoint"])
        assertEquals("8", offReport["observedTotalWrites"])
        assertEquals("8", offReport["expectedTotalWrites"])
        assertEquals("7", offReport["phaseBaselineWrites"])
        meter.total += 1
        subject.expectCopy("is the fresh copy after a fresh actual input")
        val freshReport = subject.reportFields(window = "freshCopyAfterReEnable")
        assertEquals("1", freshReport["writesSinceLastCheckpoint"])
        assertEquals("9", freshReport["observedTotalWrites"])
        assertEquals("9", freshReport["expectedTotalWrites"])
        subject.expectClosed(meter.total)
    }

    /**
     * A watermark is not a reset. Advancing it must leave the baseline, the expected
     * total, and the closed-snapshot check exactly where they were, so the reporting
     * fix cannot quietly reintroduce the rebaselining hole it exists to avoid.
     */
    @Test
    fun markReportedMovesOnlyTheReportingWatermark() {
        val meter = FakeMeter(7)
        val subject = phase(meter)

        meter.total += 1
        subject.expectCopy("is this test's own sentinel write")
        subject.markReported()

        assertEquals(7L, subject.baseline)
        assertEquals(1L, subject.expectedSinceBaseline)
        assertEquals(8L, subject.expectedTotal)

        // A write after the watermark is still a violation of the cumulative total...
        meter.total += 1
        rejection { subject.expectQuiet("while the viewer policy is Off") }
        // ...and the closed snapshot still sees it.
        rejection { subject.expectClosed(meter.total) }
    }
}
