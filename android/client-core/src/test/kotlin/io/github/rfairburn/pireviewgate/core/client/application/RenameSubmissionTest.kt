package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEvent
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientHarness
import io.github.rfairburn.pireviewgate.core.client.roster.RosterDispatchDecision
import io.github.rfairburn.pireviewgate.core.client.roster.RosterNotSentReason
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOperationKind
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOwnerOutcome
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRequestResult
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSendDisposition
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSendRefusal
import io.github.rfairburn.pireviewgate.core.client.roster.lastRequestOf
import io.github.rfairburn.pireviewgate.core.client.roster.settled
import io.github.rfairburn.pireviewgate.core.client.ui.CapabilityStatus
import io.github.rfairburn.pireviewgate.core.client.ui.ClientDialogs
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiFixtures
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.MutableUiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.RenameSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.RenameTarget
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.RosterSnapshot
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionTargetToken
import io.github.rfairburn.pireviewgate.core.client.ui.UiProofInvalidationReason
import io.github.rfairburn.pireviewgate.core.client.ui.UiProofScreen
import io.github.rfairburn.pireviewgate.core.client.ui.grantsAction
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerRenameFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import kotlin.test.*

/**
 * The production rename submission driven through the real roster endpoint.
 *
 * Every case opens a real form over a real committed [MutableUiActionProof], submits it
 * once through [RenameSubmission], and reads the actual outbound frame the endpoint asked
 * its adapter to write — then settles it with the owner's actual reply and applies that
 * result to real dialog state. Nothing is asserted against an always-true stand-in: an
 * uncommitted or invalidated proof, a reply belonging to another request, or an outcome
 * that is not the owner's positive `renamed` each leaves the form open, and the
 * held-dispatch cases show the click receipt is what keeps the queued write alive.
 */
internal class RenameSubmissionTest {

    private val hostId = HostId.parse("host-1")
    private val run = RosterClientHarness.RUN_ID

    private class Opened(
        val harness: RosterClientHarness,
        val drawn: SessionUiState,
        val form: RenameSessionDialog,
        val proof: MutableUiActionProof,
    )

    /** One row exactly as the projection publishes it, carrying the owner's decoded metadata. */
    private fun uiRow(metadata: RemoteSessionMetadata, revision: Long): SessionUiState = SessionUiState(
        hostId = hostId,
        hostLabel = "Owner A",
        hostRunId = run,
        stale = false,
        rosterRevision = revision,
        metadata = metadata,
    )

    private fun host(rows: List<SessionUiState>): HostUiState = HostUiState(
        host = ClientUiFixtures.host("host-1", label = "Owner A"),
        connection = HostConnectionState.CONNECTED,
        roster = RosterSnapshot(RosterFreshness.CURRENT, run, rows.first().rosterRevision, rows),
        capabilities = HostCapabilities(
            negotiated = true,
            close = CapabilityStatus.SUPPORTED,
            create = CapabilityStatus.SUPPORTED,
            rename = CapabilityStatus.SUPPORTED,
        ),
    )

    /** A genuinely armed drawn-form proof: committed frame and readable identity line. */
    private fun committedProof(rowId: String = "row-1"): MutableUiActionProof = MutableUiActionProof(
        UiActionTargetToken(UiProofScreen.SESSION_RENAME, hostId, hostRunId = run, rowId = rowId, generation = 1),
    ).also {
        it.setCriticalIdentityReadable(true)
        assertTrue(it.markCommitted(it.beginDraw()), "the frame this click stands on was committed")
    }

    /** Subscribed, one complete snapshot, and the drawn row and form the menu item produced. */
    private fun opened(draft: String = "New name", revision: Long = 1L): Opened {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot(revision = revision)
        val drawn = uiRow(harness.endpoint.state().projection.rows.first { it.id == "row-1" }, revision)
        val target = assertNotNull(RenameTarget.of(drawn))
        val proof = committedProof()
        return Opened(harness, drawn, RenameSessionDialog(target, draft, proof), proof)
    }

    private fun settledEvent(harness: RosterClientHarness): RosterClientEvent.OperationSettled =
        harness.events.filterIsInstance<RosterClientEvent.OperationSettled>().single()

    // ------------------------------------------------------------- the reported flow

    @Test
    fun aRenameTypedIntoTheOpenFormSubmitsOnceAndClosesOnlyThatFormOnTheOwnersRenamed() {
        val opened = opened()
        // The operator edits the frozen current name to a new one.
        val edited = opened.form.copy(nameDraft = "New name")
        val dialogs = ClientDialogs(renameSession = edited)
        assertEquals(opened.drawn.displayTitle, edited.target.currentName)
        assertEquals("New name", edited.nameDraft)

        // The owner harmlessly republishes the SAME live row while the form is open.
        opened.harness.publishSnapshot(revision = 2L)
        val refreshed = uiRow(opened.harness.endpoint.state().projection.rows.first { it.id == "row-1" }, 2L)

        val submission = assertNotNull(
            RenameSubmission.begin(host(listOf(refreshed)), opened.harness.generation, edited, opened.proof),
            "an ordinary owner republish must not drop the operator's deliberate Rename",
        )
        opened.harness.push(opened.harness.endpoint.renameSession(submission.command))

        // Dispatch is held: the write is queued, not yet handed to the transport.
        assertEquals(RosterDispatchDecision.Allow, opened.harness.decide(opened.harness.sends.lastIndex))
        assertTrue(opened.proof.grantsAction(), "the committed click receipt survives asynchronous dispatch")
        // Every controller refresh — including the one that follows the submit itself —
        // copies the pending form through renewDialogProofs(), keeping its proof while the
        // operation is busy. That ordinary copy is what the settlement must act on.
        val refreshedForm = edited.copy(proof = edited.proof)
        assertNotSame(edited, refreshedForm)
        assertSame(edited.proof, refreshedForm.proof)
        val refreshedDialogs = dialogs.copy(renameSession = refreshedForm)
        assertNotSame(dialogs, refreshedDialogs)
        assertSame(refreshedDialogs, submission.closeIfConfirmed(refreshedDialogs, run, RosterRequestResult.Unknown),
            "nothing has settled, so the submitted form is still open")

        // A healthy channel now takes the one queued write off this side, so the owner's
        // reply below answers a request that genuinely left the client.
        opened.harness.drain()
        assertEquals(1, opened.harness.countOfType("rename_request"), "one deliberate submit is exactly one request")
        val sent = opened.harness.frames().filterIsInstance<RosterFrame.RenameRequest>().single()
        assertEquals(run, sent.hostRunId)
        assertEquals("row-1", sent.rowId)
        assertEquals(edited.target.expectedSessionId, sent.expectedSessionId)
        assertEquals(edited.target.expectedSessionEpoch, sent.expectedSessionEpoch)
        assertEquals("New name", sent.name)
        assertEquals(opened.harness.lastRequestOf("rename_request"), sent.requestId)

        opened.harness.deliver(RosterFrame.RenameResult(sent.requestId, OwnerRenameFacts.RENAMED))
        val event = settledEvent(opened.harness)
        assertEquals(RosterOperationKind.RENAME, event.kind)
        assertEquals(RosterRequestResult.OwnerResult(RosterOwnerOutcome.Rename(OwnerRenameFacts.RENAMED)), event.result)

        val closed = submission.closeIfConfirmed(refreshedDialogs, event.hostRunId, event.result)
        assertNull(closed.renameSession, "the exact submitted form closes on the owner's confirmed rename")

        // The displayed name still comes only from the owner's next authoritative snapshot,
        // and reopening Rename over it shows the new name.
        opened.harness.publishSnapshot(
            revision = 3L,
            rows = listOf(RosterClientHarness.row("row-1", name = "New name"), RosterClientHarness.row("row-2")),
        )
        val authoritative = uiRow(opened.harness.endpoint.state().projection.rows.first { it.id == "row-1" }, 3L)
        assertEquals("New name", authoritative.displayTitle)
        assertEquals("New name", assertNotNull(RenameTarget.of(authoritative)).currentName)
        assertNull(closed.renameSession)
    }

    @Test
    fun theSubmittedRequestNamesTheExactHostRunRowNativeTupleAndEditedName() {
        val opened = opened()
        val target = assertNotNull(RenameTarget.of(opened.drawn))
        val edited = opened.form.copy(nameDraft = "Renamed by the operator")
        val submission = assertNotNull(
            RenameSubmission.begin(host(listOf(opened.drawn)), opened.harness.generation, edited, edited.proof),
        )

        opened.harness.push(opened.harness.endpoint.renameSession(submission.command))
        opened.harness.drain()

        assertEquals(1, opened.harness.countOfType("rename_request"), "one deliberate submit is exactly one request")
        val frame = opened.harness.frames().filterIsInstance<RosterFrame.RenameRequest>().single()
        assertEquals(run, frame.hostRunId)
        assertEquals("row-1", frame.rowId)
        assertEquals(target.expectedSessionId, frame.expectedSessionId)
        assertEquals(target.expectedSessionEpoch, frame.expectedSessionEpoch)
        assertEquals("Renamed by the operator", frame.name)
        assertEquals(opened.harness.lastRequestOf("rename_request"), frame.requestId)

        opened.harness.deliver(RosterFrame.RenameResult(frame.requestId, OwnerRenameFacts.RENAMED))
        assertEquals(
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.Rename(OwnerRenameFacts.RENAMED)),
            opened.harness.settled().single().third,
        )
        // This side never renames the row it renders: only the owner's snapshot does.
        assertEquals("Label row-1", opened.harness.endpoint.state().projection.rows.first { it.id == "row-1" }.label)
    }

    // ------------------------------------------------------------- the load-bearing proof

    @Test
    fun aProofNeverCommittedCannotEvenBeginTheSubmission() {
        val opened = opened()
        // The drawn control's identity line is readable, so the only thing missing is the
        // frame-commit report: this is a never-committed click, not an unreadable proof.
        val uncommitted = MutableUiActionProof(opened.proof.target)
        uncommitted.setCriticalIdentityReadable(true)
        assertTrue(uncommitted.isCurrent)
        assertTrue(uncommitted.criticalIdentityReadable)
        assertFalse(uncommitted.hasCommittedFrame, "no frame-commit report ever reached this proof")
        assertFalse(uncommitted.grantsAction())

        // The form carries that very proof object, so the refusal cannot be a stand-in for
        // the identity check: begin() reaches the committed-receipt capture and rejects it.
        val form = opened.form.copy(proof = uncommitted)
        assertSame(uncommitted, form.proof)
        assertNull(RenameSubmission.begin(host(listOf(opened.drawn)), opened.harness.generation, form, form.proof))
        assertEquals(0, opened.harness.countOfType("rename_request"))
    }

    @Test
    fun aProofInvalidatedWhileTheWriteIsQueuedNeverReachesTheTransport() {
        val opened = opened()
        val dialogs = ClientDialogs(renameSession = opened.form)
        val submission = assertNotNull(
            RenameSubmission.begin(host(listOf(opened.drawn)), opened.harness.generation, opened.form, opened.proof),
        )
        opened.harness.push(opened.harness.endpoint.renameSession(submission.command))

        opened.proof.invalidate(UiProofInvalidationReason.FOCUS_CHANGE)
        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE),
            opened.harness.decide(opened.harness.sends.lastIndex))
        opened.harness.reportLast(RosterSendDisposition.NotDispatched(RosterSendRefusal.PROOF_UNAVAILABLE))

        val event = settledEvent(opened.harness)
        assertEquals(RosterRequestResult.NotSent(RosterNotSentReason.TARGET_UNAVAILABLE), event.result)
        assertSame(dialogs, submission.closeIfConfirmed(dialogs, event.hostRunId, event.result),
            "a request that never reached the transport is never a closed form")
    }

    @Test
    fun aMovedNativeTupleIsRefusedBeforeAnythingIsWritten() {
        val opened = opened()
        val observed = opened.drawn.metadata.nativeSession!!
        // The same row id now names a NEWER native conversation.
        val moved = uiRow(
            opened.drawn.metadata.copy(nativeSession = observed.copy(epoch = observed.epoch + 1L)),
            opened.drawn.rosterRevision,
        )
        assertNull(RenameSubmission.begin(host(listOf(moved)), opened.harness.generation, opened.form, opened.proof))
        assertEquals(0, opened.harness.countOfType("rename_request"))
    }

    // ------------------------------------------------- non-dismissal and replacement form

    @Test
    fun everyOtherOwnerOutcomeLeavesTheSubmittedFormOpen() {
        for (fact in listOf(OwnerRenameFacts.STALE_SESSION, OwnerRenameFacts.REFUSED, OwnerRenameFacts.BUSY,
            OwnerRenameFacts.UNKNOWN)) {
            val opened = opened()
            val dialogs = ClientDialogs(renameSession = opened.form)
            val submission = assertNotNull(
                RenameSubmission.begin(host(listOf(opened.drawn)), opened.harness.generation, opened.form, opened.proof),
            )
            opened.harness.push(opened.harness.endpoint.renameSession(submission.command))
            opened.harness.deliver(
                RosterFrame.RenameResult(opened.harness.lastRequestOf("rename_request"), fact),
            )
            val event = settledEvent(opened.harness)
            assertSame(dialogs, submission.closeIfConfirmed(dialogs, event.hostRunId, event.result), fact.wireName)
            assertNotNull(dialogs.renameSession)
        }
    }

    @Test
    fun aReplyForAnotherRequestSettlesNothingAtAll() {
        val opened = opened()
        val dialogs = ClientDialogs(renameSession = opened.form)
        val submission = assertNotNull(
            RenameSubmission.begin(host(listOf(opened.drawn)), opened.harness.generation, opened.form, opened.proof),
        )
        opened.harness.push(opened.harness.endpoint.renameSession(submission.command))

        opened.harness.deliver(RosterFrame.RenameResult("some-other-request", OwnerRenameFacts.RENAMED))
        assertTrue(opened.harness.settled().isEmpty(), "a foreign reply is not this request's outcome")
        assertSame(dialogs, submission.closeIfConfirmed(dialogs, run, RosterRequestResult.Unknown))
        assertNotNull(dialogs.renameSession)
    }

    @Test
    fun aReplacementFormIsNeverClosedByTheOlderRequestsResult() {
        val opened = opened()
        val submission = assertNotNull(
            RenameSubmission.begin(host(listOf(opened.drawn)), opened.harness.generation, opened.form, opened.proof),
        )
        opened.harness.push(opened.harness.endpoint.renameSession(submission.command))
        opened.harness.deliver(
            RosterFrame.RenameResult(opened.harness.lastRequestOf("rename_request"), OwnerRenameFacts.RENAMED),
        )
        val event = settledEvent(opened.harness)

        val replacementForm = opened.form.copy(proof = committedProof())
        val withReplacement = ClientDialogs(renameSession = replacementForm)
        assertSame(withReplacement, submission.closeIfConfirmed(withReplacement, event.hostRunId, event.result),
            "a form minted after this request is not the one that submitted it")
        // The same replacement survives its own ordinary refresh copies too.
        val refreshedReplacement = ClientDialogs(renameSession = replacementForm.copy(proof = replacementForm.proof))
        assertNotSame(withReplacement, refreshedReplacement)
        assertSame(refreshedReplacement, submission.closeIfConfirmed(refreshedReplacement, event.hostRunId, event.result),
            "a refreshed copy of a replacement form is still not the submitted form")
        assertSame(withReplacement, submission.closeIfConfirmed(withReplacement, "another-run", event.result))
        assertSame(withReplacement,
            submission.closeIfConfirmed(withReplacement, event.hostRunId, RosterRequestResult.Unknown))
        assertNull(submission.closeIfConfirmed(ClientDialogs(), event.hostRunId, event.result).renameSession)
    }
}
