package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientHarness
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOperationKind
import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.client.ui.SavedRequestStatus
import io.github.rfairburn.pireviewgate.core.client.ui.SavedUiState
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.*

/**
 * The post-delete continuation's pending display is raised synchronously with its
 * refresh, before its LIST is admitted, so it never enters [SavedReadFeedback].
 * These are the controller's exact status-only retirement facts. No Android
 * controller or owner request is needed: query edits, dialogs and leaving all
 * cancel the same continuation, and only that cancellation is projected here.
 */
class SavedRefreshFeedbackTest {
    private val host = HostId.parse("host-1")
    private val ready = SavedUiState(
        selectedHostId = host,
        status = SavedRequestStatus.Ready,
        hostRunId = RosterClientHarness.RUN_ID,
        catalogId = RosterClientHarness.CATALOG_ID,
        resultId = RosterClientHarness.RESULT_ID,
        requestId = "request-1",
        sequence = 3L,
        total = 2L,
        issueCount = 0L,
        entries = listOf(RosterClientHarness.entry(0), RosterClientHarness.entry(1)),
        transferComplete = true,
        query = "needle",
    )

    /** The exact status-only display a successful confirmed Delete raises for its LIST. */
    private fun refreshDisplay() = ready.copy(
        status = SavedRequestStatus.Requesting,
        deletePreparation = null,
        listProof = null,
        windowProof = null,
        entryProofs = emptyMap(),
    )

    @Test fun canceledPostDeleteRefreshRetiresOnlyItsOwnRequesting() {
        for (reason in listOf("query edit", "modal", "leave", "owner/window loss")) {
            val live = AtomicBoolean(true)
            val continuation = RosterUiProof { live.get() }
            val feedback = SavedRefreshFeedback()
            val display = refreshDisplay()
            feedback.shown(continuation)
            // One live automatic read shows Requesting and owns exactly this display.
            assertSame(display, feedback.observe(display, trackedRead = false), reason)
            // A query edit replaces the draft; the other cancellations leave the same
            // drawn picker behind a dialog, a departed route, or lost owner facts.
            val shown = if (reason == "query edit") display.copy(query = "needle 2", listProof = null) else display
            live.set(false)
            val retired = feedback.observe(shown, trackedRead = false)
            assertEquals(SavedRequestStatus.Unknown, retired.status, reason)
            assertNull(retired.readFeedbackBaseStatus, reason)
            // Only the status moved: no result, entry, handle, proof or query was invented.
            assertEquals(shown.copy(status = SavedRequestStatus.Unknown, readFeedbackBaseStatus = null), retired, reason)
            assertSame(shown.entries, retired.entries, reason)
            // A late settlement for the canceled continuation revives nothing.
            feedback.settled(continuation)
            assertSame(retired, feedback.observe(retired, trackedRead = false), reason)
        }
    }

    @Test fun trackedReplacementReadKeepsItsOwnRequesting() {
        val reads = SavedReadFeedback()
        val feedback = SavedRefreshFeedback()
        // The post-delete continuation is already canceled when a genuinely new user
        // read has been admitted from the same picker view.
        feedback.shown(RosterUiProof { false })
        val view = SavedReadFeedback.View(host, RosterClientHarness.RUN_ID, "needle", 5L, 7L, true)
        val key = OperationKey(host, 7L, RosterOperationKind.SAVED_LIST, "replacement")
        val pending = reads.accepted(key, 9L, view, false, view, ready)
        assertEquals(SavedRequestStatus.Requesting, pending.status)
        assertEquals(SavedRequestStatus.Ready, pending.readFeedbackBaseStatus)
        assertEquals(key, reads.pending)
        // The canceled post-delete continuation may not end the replacement's Requesting.
        assertSame(pending, feedback.observe(pending, trackedRead = reads.pending != null))
        assertSame(pending, feedback.observe(pending, trackedRead = reads.pending != null))
        // Its canceled ownership is over and cannot retire a different pending display.
        val later = refreshDisplay()
        assertSame(later, feedback.observe(later, trackedRead = false))
        // Only that read's own settlement ends its pending status and base.
        val settled = reads.settled(key, view,
            pending.copy(status = SavedRequestStatus.Ready, readFeedbackBaseStatus = null))
        assertEquals(SavedRequestStatus.Ready, settled.status)
        assertNull(settled.readFeedbackBaseStatus)
        assertNull(reads.pending)
    }

    @Test fun nonRequestingAndOrdinaryStatesPassThroughUnchanged() {
        val live = AtomicBoolean(true)
        val continuation = RosterUiProof { live.get() }
        val feedback = SavedRefreshFeedback()
        feedback.shown(continuation)
        for (status in listOf(
            SavedRequestStatus.Idle,
            SavedRequestStatus.Ready,
            SavedRequestStatus.Unknown,
            SavedRequestStatus.Unavailable,
            SavedRequestStatus.Refused(),
        )) {
            val display = ready.copy(status = status)
            assertSame(display, feedback.observe(display, trackedRead = false))
        }
        // The live read's own settlement ends ownership without rewriting its status.
        feedback.settled(continuation)
        live.set(false)
        val edited = refreshDisplay().copy(query = "needle 2")
        assertSame(edited, feedback.observe(edited, trackedRead = false))
    }
}
