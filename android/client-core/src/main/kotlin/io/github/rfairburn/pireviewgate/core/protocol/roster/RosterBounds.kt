package io.github.rfairburn.pireviewgate.core.protocol.roster

/**
 * Explicit, finite roster metadata bounds.
 *
 * Every value must be a positive integer, page bytes must fit inside a frame,
 * and a snapshot must be able to hold at least one full page. There is no
 * unbounded "0 means disabled" mode, and nothing here raises the fixed
 * one-subscription, one-in-flight, or one-pending ceilings: those are protocol
 * constants, not configuration.
 */
class RosterBounds(
    /** Complete encoded frame; compatible with the transport message bound. */
    val maxFrameBytes: Long = 65_536,
    /** Rows in one page frame. */
    val maxRowsPerPage: Long = 32,
    /** Encoded page-frame budget; pages are packed by actual encoded bytes. */
    val maxPageBytes: Long = 65_536,
    /** Rows in one complete snapshot. */
    val maxSnapshotRows: Long = 4_096,
    /** Encoded row bytes across one complete snapshot. */
    val maxSnapshotBytes: Long = 8L * 1024L * 1024L,
    /** Capability identifiers in one hello. */
    val maxCapabilities: Long = 16,
    /** Bytes in one capability identifier. */
    val maxCapabilityIdBytes: Long = 64,
    /** Bytes in one subscription, transfer, host-run, request, catalog, or entry identifier. */
    val maxIdentifierBytes: Long = 64,
    /** How long the owner waits for the viewer's hello before refusing the channel. */
    val helloTimeoutMs: Long = 10_000,
    /** How long the viewer waits for `hello_ack`. */
    val handshakeTimeoutMs: Long = 5_000,
    /** How long the viewer waits for `snapshot_begin` after subscribing. */
    val snapshotStartTimeoutMs: Long = 15_000,
    /** How long the viewer waits for the next frame of an in-flight transfer. */
    val transferIdleTimeoutMs: Long = 30_000,
    /** How long the viewer waits for `unsubscribed` before completing a stop. */
    val stopAckTimeoutMs: Long = 2_000,
    /**
     * How long a requester waits for one `close_result` after the close frame was
     * handed to the transport. Exceeding it is an unknown outcome, never a retry.
     */
    val closeResultTimeoutMs: Long = 15_000,
    /** How long a requester waits for one `create_result`. */
    val createResultTimeoutMs: Long = 15_000,
    /** How long a requester waits for one `rename_result`. */
    val renameResultTimeoutMs: Long = 15_000,
) {
    init {
        val values = longArrayOf(
            maxFrameBytes, maxRowsPerPage, maxPageBytes, maxSnapshotRows, maxSnapshotBytes,
            maxCapabilities, maxCapabilityIdBytes, maxIdentifierBytes,
            helloTimeoutMs, handshakeTimeoutMs, snapshotStartTimeoutMs, transferIdleTimeoutMs,
            stopAckTimeoutMs, closeResultTimeoutMs, createResultTimeoutMs, renameResultTimeoutMs,
        )
        // The source accepts a positive safe integer here, not any positive Long: an
        // unsafe ceiling would let the derived Saved frame count overflow.
        for (value in values) {
            if (value <= 0L) fail(RosterFailureCode.INVALID_BOUNDS)
            if (value > MAX_SAFE_INTEGER) fail(RosterFailureCode.INVALID_BOUNDS)
        }
        if (maxPageBytes > maxFrameBytes) fail(RosterFailureCode.INVALID_BOUNDS)
        if (maxSnapshotRows < maxRowsPerPage) fail(RosterFailureCode.INVALID_BOUNDS)
        if (maxSnapshotBytes < maxPageBytes) fail(RosterFailureCode.INVALID_BOUNDS)
    }

    /**
     * Upper bound on frames (pages plus fragments) in one Saved window: every row
     * as a page, plus room for fragments of the window byte budget. It is a sanity
     * cap derived from the per-transfer bounds and is never used to size an
     * allocation; the sender never exceeds it and the receiver refuses beyond it.
     */
    val savedWindowMaxFrames: Long
        get() {
            val fragmentRoom = (2L * maxSnapshotBytes + 1023L) / 1024L
            val total = maxSnapshotRows + fragmentRoom
            return if (total > MAX_SAFE_INTEGER) MAX_SAFE_INTEGER else total
        }

    companion object {
        /** The fixed defaults; compatible with the transport message bound. */
        val DEFAULT: RosterBounds = RosterBounds()
    }
}
