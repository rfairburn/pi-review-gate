package io.github.rfairburn.pireviewgate.androidtest

import org.junit.Assert.assertEquals

/**
 * Cumulative write accounting for one test phase measured by the clipboard meter.
 *
 * WHY THIS TYPE EXISTS. Sampling a fresh counter immediately before each expected
 * copy cannot see a write that arrives in between: a duplicate that lands during
 * the gap between two checkpoints is folded into the next baseline and never fails.
 * The same hole swallows a replay that arrives while a phase settles, and a trailing
 * write after the last assertion.
 *
 * So a phase keeps ONE baseline, read once when it starts, and a running expected
 * total of the writes it has committed to. Every checkpoint after that — including
 * the closed snapshot — is compared against everything the phase should have
 * produced since its own beginning, so an extra write is a failure at the next
 * checkpoint rather than a new normal.
 *
 * It counts clipboard writes taken from the meter, never listener notifications:
 * one write can produce more than one notification, and notifications say nothing
 * about how many writes happened.
 *
 * [currentTotal] is the live meter reading. It is a function rather than the meter
 * itself so the accounting can be exercised directly, with a counter a test moves
 * by hand, and those checks need no device.
 */
class ClipWritePhase(
    private val label: String,
    private val currentTotal: () -> Long,
) {
    /** The meter's count when this phase began. Read once; never resampled. */
    val baseline: Long = currentTotal()

    /** Writes this phase has committed to, cumulative from [baseline]. */
    var expectedSinceBaseline: Long = 0L
        private set

    /** The absolute count the meter must report at the next checkpoint. */
    val expectedTotal: Long get() = baseline + expectedSinceBaseline

    /** Writes seen at the last reporting checkpoint, so a report can name the delta. */
    private var observedAtLastCheckpoint: Long = baseline

    /**
     * Close the current reporting window, without touching the baseline or the
     * expected total.
     *
     * A write the phase commits to before its first report — such as a test's own
     * sentinel — belongs to the phase total but to no measured window, so the next
     * report would otherwise count it as a write inside that window. This advances
     * only the diagnostic watermark: the cumulative expectation, the baseline, and
     * every closed-total assertion stay exactly as they were.
     */
    fun markReported() {
        observedAtLastCheckpoint = currentTotal()
    }

    /**
     * Nothing may be written between now and here.
     *
     * This is the checkpoint that catches the write nobody asked for: a duplicate
     * from an earlier action, a replay that arrived during a settle, or anything the
     * phase never committed to.
     */
    fun expectQuiet(what: String) {
        val actual = currentTotal()
        assertTotal(
            actual,
            "$label: no clipboard write is allowed $what; the phase expected its cumulative total " +
                "and saw something else",
        )
    }

    /** Exactly one more write happened, counted from the phase baseline. */
    fun expectCopy(what: String) {
        expectedSinceBaseline += 1
        val actual = currentTotal()
        assertTotal(
            actual,
            "$label: exactly one clipboard write $what; a second write in this phase, or a missing " +
                "one, fails here rather than becoming the next baseline",
        )
    }

    /**
     * The closed snapshot is the phase's whole total.
     *
     * Checking the closed count is what closes the tail: a write that arrives after
     * the last in-test assertion still shows up here, because nothing was subtracted
     * from the baseline.
     */
    fun expectClosed(closedTotal: Long) {
        assertTotal(closedTotal, "$label: the closed meter snapshot is every write this phase allowed")
    }

    /** Fields for the run report: expected and observed cumulative totals, and the delta. */
    fun reportFields(window: String?): Map<String, String> {
        val actual = currentTotal()
        val delta = actual - observedAtLastCheckpoint
        observedAtLastCheckpoint = actual
        return mapOf(
            "phaseBaselineWrites" to baseline.toString(),
            "expectedTotalWrites" to expectedTotal.toString(),
            "observedTotalWrites" to actual.toString(),
            "writesSinceLastCheckpoint" to delta.toString(),
        ).let { fields -> if (window === null) fields else fields + ("window" to window) }
    }

    private fun assertTotal(actual: Long, message: String) {
        assertEquals("$message (expected cumulative $expectedTotal from baseline $baseline)", expectedTotal, actual)
    }
}
