package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCloseFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCreateFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerRenameFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterProtocol
import io.github.rfairburn.pireviewgate.core.protocol.roster.SavedDeleteMethod
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Close, Create, and Rename through the roster client endpoint: the three-way
 * result, the per-row and per-channel busy slots, the monotonic attempt numbers,
 * the native-tuple fence, and the proof and send-disposition guards.
 */
internal class RosterClientOperationsTest {

    private fun harness(): RosterClientHarness {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot()
        return harness
    }

    private fun closeCommand(
        harness: RosterClientHarness,
        rowId: String = "row-1",
        confirmed: Boolean = false,
        proof: RosterSendProof.RowAction? = RosterClientHarness.rowProof(
            harness.generation,
            RosterClientHarness.RUN_ID,
            rowId,
        ),
        confirmation: RosterUiProof? = null,
    ) = RosterCloseCommand(RosterClientHarness.RUN_ID, rowId, confirmed, proof, confirmation)

    // ---------------------------------------------------------------- close

    @Test
    fun `a close carries no sequence and changes no row locally`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))

        val message = harness.sends.last()
        val frame = message.frame as RosterFrame.CloseRequest
        assertEquals(RosterClientHarness.RUN_ID, frame.hostRunId)
        assertEquals("row-1", frame.rowId)
        assertEquals(false, frame.confirmed)
        val wire = String(RosterProtocol.encode(frame, harness.bounds), Charsets.UTF_8)
        // The source CloseRequest has no attempt scalar; nothing may invent one.
        assertTrue(!wire.contains("sequence"))
        assertEquals(
            listOf("type", "requestId", "hostRunId", "rowId", "confirmed"),
            Regex("\"([A-Za-z]+)\":").findAll(wire).map { it.groupValues[1] }.toList(),
        )

        harness.reportLast(RosterSendDisposition.Completed)
        harness.deliver(RosterFrame.CloseResult(frame.requestId, OwnerCloseFacts.REMOVED))

        assertEquals(
            listOf(
                Triple(
                    RosterOperationKind.CLOSE,
                    frame.requestId,
                    RosterRequestResult.OwnerResult(RosterOwnerOutcome.Close(OwnerCloseFacts.REMOVED)),
                ),
            ),
            harness.settled(),
        )
        // No optimistic removal: only a later authoritative snapshot changes the rows.
        assertEquals(listOf("row-1", "row-2"), harness.endpoint.state().projection.rows.map { it.id })
    }

    @Test
    fun `one close is in flight per row and a second is refused without queueing`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness, "row-1")))
        harness.push(harness.endpoint.closeSession(closeCommand(harness, "row-1")))
        harness.push(harness.endpoint.closeSession(closeCommand(harness, "row-2")))

        assertEquals(listOf(RosterOperationKind.CLOSE to RosterNotSentReason.BUSY), harness.refusals())
        assertEquals(2, harness.countOfType("close_request"))
    }

    @Test
    fun `a busy or unknown owner answer arms the next deliberate close and sends nothing`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))
        val requestId = harness.lastRequestOf("close_request")
        harness.deliver(RosterFrame.CloseResult(requestId, OwnerCloseFacts.CONFIRMATION_REQUIRED))

        assertEquals(
            listOf(RosterClientEvent.OwnerConfirmationRequired(RosterClientHarness.RUN_ID, "row-1")),
            harness.events.filterIsInstance<RosterClientEvent.OwnerConfirmationRequired>(),
        )
        assertEquals(listOf("row-1"), harness.endpoint.state().armedCloseConfirmationRows)
        // Arming is not an action: no second close left this endpoint.
        assertEquals(1, harness.countOfType("close_request"))
    }

    @Test
    fun `a confirmed close without a fresh specific receipt is never submitted`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness, confirmed = true)))

        assertEquals(listOf(RosterOperationKind.CLOSE to RosterNotSentReason.INVALID_REQUEST), harness.refusals())
        assertEquals(0, harness.countOfType("close_request"))
    }

    @Test
    fun `a confirmed close with a receipt that no longer holds is never submitted`() {
        val harness = harness()
        harness.push(
            harness.endpoint.closeSession(
                closeCommand(harness, confirmed = true, confirmation = RosterClientHarness.FALSE_PROOF),
            ),
        )

        assertEquals(listOf(RosterOperationKind.CLOSE to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
        assertEquals(0, harness.countOfType("close_request"))
    }

    @Test
    fun `a confirmed close carries its receipt and the owner's own facts back`() {
        val harness = harness()
        harness.push(
            harness.endpoint.closeSession(
                closeCommand(harness, confirmed = true, confirmation = RosterClientHarness.TRUE_PROOF),
            ),
        )
        val message = harness.sends.last()
        val proof = message.proof as RosterSendProof.RowAction
        assertNotNull(proof.confirmation)
        val requestId = (message.frame as RosterFrame.CloseRequest).requestId

        harness.deliver(RosterFrame.CloseResult(requestId, OwnerCloseFacts.UNCONFIRMED))

        assertEquals(
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.Close(OwnerCloseFacts.UNCONFIRMED)),
            harness.settled().single().third,
        )
    }

    @Test
    fun `an elapsed close deadline settles unknown and never resends`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))
        harness.fireDeadline(RosterDeadlineKind.CLOSE_RESULT)

        assertEquals(RosterRequestResult.Unknown, harness.settled().single().third)
        assertEquals(1, harness.countOfType("close_request"))
        // The slot is released, so a fresh deliberate request is possible later.
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))
        assertEquals(2, harness.countOfType("close_request"))
    }

    @Test
    fun `a close result for a request this side never made settles nothing`() {
        val harness = harness()
        harness.deliver(RosterFrame.CloseResult("forged-request", OwnerCloseFacts.REMOVED))

        assertEquals(emptyList(), harness.settled())
        assertEquals(0, harness.closeChannelCount)
    }

    // --------------------------------------------------------------- create

    private fun createCommand(
        harness: RosterClientHarness,
        workspace: String = "/srv/owner/work",
        proof: RosterSendProof.Form? = RosterClientHarness.formProof(
            harness.generation,
            RosterClientHarness.RUN_ID,
            workspace,
        ),
    ) = RosterCreateCommand(RosterClientHarness.RUN_ID, workspace, proof)

    @Test
    fun `create is rowless and takes its attempt number from a channel high-water`() {
        val harness = harness()
        harness.push(harness.endpoint.createSession(createCommand(harness)))

        val first = harness.sends.last().frame as RosterFrame.CreateRequest
        assertEquals(1L, first.sequence)
        assertEquals(RosterClientHarness.RUN_ID, first.hostRunId)
        assertEquals("/srv/owner/work", first.workspace)

        // The first attempt times out; its number is never reused.
        harness.fireDeadline(RosterDeadlineKind.CREATE_RESULT)
        assertEquals(RosterRequestResult.Unknown, harness.settled().single().third)

        harness.push(harness.endpoint.createSession(createCommand(harness)))
        val second = harness.sends.last().frame as RosterFrame.CreateRequest
        assertEquals(2L, second.sequence)
        assertTrue(first.requestId != second.requestId)
    }

    @Test
    fun `a second create is refused rather than queued evicted or retargeted`() {
        val harness = harness()
        harness.push(harness.endpoint.createSession(createCommand(harness)))
        harness.push(harness.endpoint.createSession(createCommand(harness, workspace = "/srv/other/work")))

        assertEquals(listOf(RosterOperationKind.CREATE to RosterNotSentReason.BUSY), harness.refusals())
        assertEquals(1, harness.countOfType("create_request"))
    }

    @Test
    fun `a started fact naming another owner run establishes nothing about this request`() {
        val harness = harness()
        harness.push(harness.endpoint.createSession(createCommand(harness)))
        val requestId = harness.lastRequestOf("create_request")

        harness.deliver(RosterFrame.CreateResult(requestId, OwnerCreateFacts.Started("run-other", "row-new")))

        assertEquals(RosterRequestResult.Unknown, harness.settled().single().third)
    }

    @Test
    fun `a create never creates a local row or changes the projection`() {
        val harness = harness()
        harness.push(harness.endpoint.createSession(createCommand(harness)))
        val requestId = harness.lastRequestOf("create_request")
        harness.deliver(RosterFrame.CreateResult(requestId, OwnerCreateFacts.Started(RosterClientHarness.RUN_ID, "row-new")))

        assertEquals(listOf("row-1", "row-2"), harness.endpoint.state().projection.rows.map { it.id })
        assertEquals(RosterProjectionState.CURRENT, harness.endpoint.state().projection.state)
    }

    // --------------------------------------------------------------- rename

    private fun renameCommand(
        harness: RosterClientHarness,
        epoch: Long = 2L,
        proof: RosterSendProof.RowAction? = RosterSendProof.RowAction(
            harness.generation,
            RosterClientHarness.RUN_ID,
            "row-1",
            expectedSessionId = "session-row-1",
            expectedSessionEpoch = epoch,
            ui = RosterClientHarness.TRUE_PROOF,
        ),
    ) = RosterRenameCommand(RosterClientHarness.RUN_ID, "row-1", "session-row-1", epoch, "A new name", proof)

    @Test
    fun `a rename is fenced to the observed native tuple and never carries a previous name`() {
        val harness = harness()
        harness.push(harness.endpoint.renameSession(renameCommand(harness)))

        val frame = harness.sends.last().frame as RosterFrame.RenameRequest
        assertEquals(1L, frame.sequence)
        assertEquals("session-row-1", frame.expectedSessionId)
        assertEquals(2L, frame.expectedSessionEpoch)
        assertEquals("A new name", frame.name)
        val wire = String(RosterProtocol.encode(frame, harness.bounds), Charsets.UTF_8)
        assertTrue(!wire.contains("previous") && !wire.contains("workspace") && !wire.contains("cwd"))

        harness.deliver(RosterFrame.RenameResult(frame.requestId, OwnerRenameFacts.RENAMED))
        assertEquals(
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.Rename(OwnerRenameFacts.RENAMED)),
            harness.settled().single().third,
        )
        // The name this side renders still comes only from the owner's next snapshot.
        assertEquals("Label row-1", harness.endpoint.state().projection.rows.first().label)
    }

    @Test
    fun `a rename built from a stale native tuple is never submitted`() {
        val harness = harness()
        harness.push(harness.endpoint.renameSession(renameCommand(harness, epoch = 1L)))

        assertEquals(listOf(RosterOperationKind.RENAME to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
        assertEquals(0, harness.countOfType("rename_request"))
    }

    @Test
    fun `a rename result after the tuple moved is unknown and is not retargeted onto the new form`() {
        val harness = harness()
        harness.push(harness.endpoint.renameSession(renameCommand(harness)))
        val requestId = harness.lastRequestOf("rename_request")

        // The owner publishes a newer form of the same row: the epoch moved.
        harness.publishSnapshot(
            revision = 8L,
            rows = listOf(RosterClientHarness.row("row-1", epoch = 3L), RosterClientHarness.row("row-2")),
        )
        harness.deliver(RosterFrame.RenameResult(requestId, OwnerRenameFacts.RENAMED))

        assertEquals(RosterRequestResult.Unknown, harness.settled().single().third)
    }

    @Test
    fun `one rename is in flight per channel`() {
        val harness = harness()
        harness.push(harness.endpoint.renameSession(renameCommand(harness)))
        harness.push(harness.endpoint.renameSession(renameCommand(harness)))

        assertEquals(listOf(RosterOperationKind.RENAME to RosterNotSentReason.BUSY), harness.refusals())
        assertEquals(1, harness.countOfType("rename_request"))
    }

    // --------------------------------------------------------- proof guards

    @Test
    fun `an absent proof is refused as invalid and never manufactured by this endpoint`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness, proof = null)))
        harness.push(harness.endpoint.createSession(createCommand(harness, proof = null)))
        harness.push(harness.endpoint.renameSession(renameCommand(harness, proof = null)))

        assertEquals(
            listOf(
                RosterOperationKind.CLOSE to RosterNotSentReason.INVALID_REQUEST,
                RosterOperationKind.CREATE to RosterNotSentReason.INVALID_REQUEST,
                RosterOperationKind.RENAME to RosterNotSentReason.INVALID_REQUEST,
            ),
            harness.refusals(),
        )
        assertEquals(
            0,
            harness.countOfType("close_request") + harness.countOfType("create_request") +
                harness.countOfType("rename_request"),
        )
    }

    @Test
    fun `a proof that answers no longer current refuses the request`() {
        val harness = harness()
        harness.push(
            harness.endpoint.closeSession(
                closeCommand(
                    harness,
                    proof = RosterClientHarness.rowProof(
                        harness.generation,
                        RosterClientHarness.RUN_ID,
                        "row-1",
                        ui = RosterClientHarness.FALSE_PROOF,
                    ),
                ),
            ),
        )
        harness.push(
            harness.endpoint.createSession(
                createCommand(
                    harness,
                    proof = RosterClientHarness.formProof(
                        harness.generation,
                        RosterClientHarness.RUN_ID,
                        "/srv/owner/work",
                        ui = RosterClientHarness.THROWING_PROOF,
                    ),
                ),
            ),
        )

        assertEquals(
            listOf(
                RosterOperationKind.CLOSE to RosterNotSentReason.TARGET_UNAVAILABLE,
                RosterOperationKind.CREATE to RosterNotSentReason.TARGET_UNAVAILABLE,
            ),
            harness.refusals(),
        )
    }

    @Test
    fun `a proof from another channel generation is refused`() {
        val harness = harness()
        harness.push(
            harness.endpoint.closeSession(
                closeCommand(
                    harness,
                    proof = RosterClientHarness.rowProof(harness.generation + 1, RosterClientHarness.RUN_ID, "row-1"),
                ),
            ),
        )

        assertEquals(listOf(RosterOperationKind.CLOSE to RosterNotSentReason.INVALID_REQUEST), harness.refusals())
    }

    @Test
    fun `unrelated control traffic never inherits a row-scoped proof`() {
        val harness = harness()
        val controlProofs = harness.sends.map { it.proof }
        assertTrue(controlProofs.all { it is RosterSendProof.Control })

        harness.push(harness.endpoint.closeSession(closeCommand(harness)))
        val closeProof = harness.sends.last().proof
        assertTrue(closeProof is RosterSendProof.RowAction)
        assertEquals("row-1", closeProof.rowId)
    }

    // ------------------------------------------------------ send outcomes

    @Test
    fun `a write the adapter never dispatched settles positively not-submitted`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))
        harness.reportLast(RosterSendDisposition.NotDispatched(RosterSendRefusal.PROOF_UNAVAILABLE))

        assertEquals(
            RosterRequestResult.NotSent(RosterNotSentReason.TARGET_UNAVAILABLE),
            harness.settled().single().third,
        )
    }

    @Test
    fun `a write invoked and then failed settles unknown because acceptance cannot be excluded`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))
        harness.reportLast(RosterSendDisposition.FailedAfterInvoke)

        assertEquals(RosterRequestResult.Unknown, harness.settled().single().third)
    }

    @Test
    fun `a completed write settles nothing because resolution is not receipt`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))
        harness.reportLast(RosterSendDisposition.Completed)

        assertEquals(emptyList(), harness.settled())
        assertEquals(1, harness.endpoint.state().pending.size)
    }

    @Test
    fun `a request before capability acknowledgement is refused as capability unsupported`() {
        val harness = RosterClientHarness()
        harness.start()
        harness.acknowledgeHandshake(
            listOf(io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire.REQUIRED_CAPABILITY),
        )
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))

        assertEquals(
            listOf(RosterOperationKind.CLOSE to RosterNotSentReason.CAPABILITY_UNSUPPORTED),
            harness.refusals(),
        )
    }

    @Test
    fun `a request after stop is refused as not ready and never leaves the endpoint`() {
        val harness = harness()
        harness.push(harness.endpoint.stop())
        val sendsAfterStop = harness.sends.size
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))

        assertEquals(listOf(RosterOperationKind.CLOSE to RosterNotSentReason.NOT_READY), harness.refusals())
        assertEquals(sendsAfterStop, harness.sends.size)
    }

    // ------------------------------------------------------- dispatch gate

    @Test
    fun `an emitted write is allowed to be dispatched while its request still stands`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))

        assertEquals(RosterDispatchDecision.Allow, harness.decide(harness.sends.lastIndex))
    }

    @Test
    fun `a queued write whose request was superseded is refused at dispatch and settles nothing further`() {
        val harness = harness()
        harness.push(
            harness.endpoint.savedList(
                RosterSavedListCommand(
                    RosterClientHarness.RUN_ID, "first", 0L, 32L,
                    RosterClientHarness.readProof(harness.generation, RosterClientHarness.RUN_ID),
                ),
            ),
        )
        val older = harness.sends.lastIndex
        harness.push(
            harness.endpoint.savedList(
                RosterSavedListCommand(
                    RosterClientHarness.RUN_ID, "second", 0L, 32L,
                    RosterClientHarness.readProof(harness.generation, RosterClientHarness.RUN_ID),
                ),
            ),
        )

        // The effect is still in the coordinator's queue, and its proof object still
        // looks well-formed, yet the endpoint refuses to let it start.
        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY), harness.decide(older))
        harness.report(older, RosterSendDisposition.NotDispatched(RosterSendRefusal.NOT_READY))
        assertEquals(1, harness.settled().size)
    }

    @Test
    fun `a write whose own patience expired is refused at dispatch before its timer fires`() {
        val harness = harness()
        harness.push(harness.endpoint.createSession(createCommand(harness)))
        val index = harness.sends.lastIndex
        assertEquals(RosterDispatchDecision.Allow, harness.decide(index))

        harness.advance(harness.bounds.createResultTimeoutMs + 1L)

        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY), harness.decide(index))
    }

    @Test
    fun `a rename whose native tuple was replaced is refused at dispatch`() {
        val harness = harness()
        harness.push(harness.endpoint.renameSession(renameCommand(harness, epoch = 2L)))
        val index = harness.sends.lastIndex
        assertEquals(RosterDispatchDecision.Allow, harness.decide(index))

        // The owner moved this row underneath the queued write.
        harness.publishSnapshot(
            revision = 2L,
            rows = listOf(
                RosterClientHarness.row("row-1", epoch = 3L),
                RosterClientHarness.row("row-2"),
            ),
        )

        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE), harness.decide(index))
        harness.report(index, RosterSendDisposition.NotDispatched(RosterSendRefusal.PROOF_UNAVAILABLE))
        assertEquals(RosterRequestResult.NotSent(RosterNotSentReason.TARGET_UNAVAILABLE), harness.settled().last().third)
    }

    @Test
    fun `a write queued before stop is refused at dispatch and never re-offered`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))
        val index = harness.sends.lastIndex

        harness.push(harness.endpoint.stop())

        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY), harness.decide(index))
        assertEquals(
            RosterRequestResult.Unknown,
            harness.settled().single { it.first == RosterOperationKind.CLOSE }.third,
        )
    }

    @Test
    fun `stop's own retirement message still dispatches and its acknowledgement completes the stop`() {
        val harness = harness()
        val subscription = harness.subscriptionId()
        harness.push(harness.endpoint.stop())
        val unsubscribe = harness.sends.indexOfLast { it.frame.type == "unsubscribe" }
        assertTrue(unsubscribe >= 0)

        // An adapter that dispatches through the gate must still be able to retire.
        assertEquals(RosterDispatchDecision.Allow, harness.decide(unsubscribe))
        harness.report(unsubscribe, RosterSendDisposition.Completed)
        assertEquals(subscription, harness.endpoint.state().retiringSubscriptionId)

        harness.deliver(RosterFrame.Unsubscribed(subscription))

        assertNull(harness.endpoint.state().retiringSubscriptionId)
        assertEquals(RosterClientPhase.DETACHED, harness.endpoint.state().phase)
        // Once retirement is finished, there is nothing left to dispatch.
        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY), harness.decide(unsubscribe))
    }

    @Test
    fun `a proof that loses the channel and still returns true is never allowed through`() {
        val harness = harness()
        var calls = 0
        val proof = RosterClientHarness.rowProof(
            harness.generation,
            RosterClientHarness.RUN_ID,
            "row-1",
            ui = RosterUiProof {
                calls += 1
                // Reentrant: a caller fence may re-enter this endpoint before answering.
                if (calls > 1) harness.endpoint.onChannelClosed()
                true
            },
        )
        harness.push(harness.endpoint.closeSession(closeCommand(harness, proof = proof)))
        val index = harness.sends.indexOfLast { it.frame.type == "close_request" }
        assertEquals(1, harness.countOfType("close_request"))

        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY), harness.decide(index))
    }

    @Test
    fun `control guards do not depend on any row form or picker epoch`() {
        val harness = RosterClientHarness()
        harness.start()
        harness.acknowledgeHandshake(RosterClientHarness.ALL_CAPABILITIES)
        harness.push(harness.endpoint.subscribe())

        // No snapshot has ever arrived: there is no row, form, or picker state at all,
        // and this control write still stands on its own facts.
        assertEquals(RosterDispatchDecision.Allow, harness.decide(harness.sends.lastIndex))
    }

    @Test
    fun `a caller proof that stopped holding is refused at dispatch`() {
        val harness = harness()
        var stillCurrent = true
        harness.push(
            harness.endpoint.closeSession(
                closeCommand(
                    harness,
                    proof = RosterClientHarness.rowProof(
                        harness.generation,
                        RosterClientHarness.RUN_ID,
                        "row-1",
                        ui = RosterUiProof { stillCurrent },
                    ),
                ),
            ),
        )
        val index = harness.sends.lastIndex
        assertEquals(RosterDispatchDecision.Allow, harness.decide(index))

        stillCurrent = false

        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE), harness.decide(index))
    }

    @Test
    fun `a write already handed to the transport is never withdrawn or re-decided`() {
        val harness = harness()
        harness.push(harness.endpoint.closeSession(closeCommand(harness)))
        val index = harness.sends.lastIndex
        harness.reportLast(RosterSendDisposition.Completed)

        // Nothing left to decide, and no cancellation is invented for accepted work.
        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY), harness.decide(index))
        assertEquals(emptyList(), harness.settled())
        assertEquals(1, harness.endpoint.state().pending.size)
        assertEquals(0, harness.countOfType("unsubscribe"))
    }
}
