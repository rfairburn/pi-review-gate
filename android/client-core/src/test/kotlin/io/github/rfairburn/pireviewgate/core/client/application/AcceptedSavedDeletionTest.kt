package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.*
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.*

/** Production Saved continuation + actual endpoint, without porting the Android controller to JVM. */
class AcceptedSavedDeletionTest {
    private class Fixture {
        val h = RosterClientHarness()
        val host = HostId.parse("host-1")
        val window = AtomicBoolean(true)
        val display: SavedUiState
        val dialog: MutableUiActionProof
        val click: FrozenAction
        val send: RosterSendProof.PickerEntry
        val continuation: AcceptedSavedDeletion
        val pending: RosterPendingOperation
        init {
            h.subscribed(); h.publishSnapshot(); h.exposeDelete()
            h.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
            val list = h.sends.last().frame as RosterFrame.SavedListRequest
            display = SavedUiState(host, SavedRequestStatus.Ready, RosterClientHarness.RUN_ID,
                RosterClientHarness.CATALOG_ID, RosterClientHarness.RESULT_ID, list.requestId, list.sequence,
                total = 1, issueCount = 0, entries = listOf(RosterClientHarness.entry(0)), transferComplete = true,
                query = "  exact query  ")
            val target = assertNotNull(SavedEntryTarget.of(display, display.entries.single()))
            val prepare = RosterSavedDeleteCommand(target.hostRunId, target.catalogId, target.resultId, target.entryId,
                RosterClientHarness.entryProof(h.generation, target.hostRunId, target.catalogId, target.resultId, target.entryId))
            h.push(h.endpoint.savedDeletePrepare(prepare)); h.drain()
            h.deliver(RosterFrame.SavedDeleteResult(h.lastRequestOf("saved"), OwnerSavedDeleteFacts.ConfirmationRequired))
            dialog = MutableUiActionProof(UiActionTargetToken(UiProofScreen.SAVED_DELETE, host,
                hostRunId = target.hostRunId, catalogId = target.catalogId, resultId = target.resultId,
                entryId = target.entryId, generation = 42)).also {
                val epoch = it.beginDraw(); it.setCriticalIdentityReadable(true); it.markCommitted(epoch)
            }
            click = assertNotNull(FrozenAction.capture(dialog))
            send = RosterSendProof.PickerEntry(h.generation, target.hostRunId, target.catalogId, target.resultId,
                target.entryId, 1, click, click)
            continuation = assertNotNull(AcceptedSavedDeletion.capture(target, assertNotNull(SavedResultTarget.of(display)),
                8, display.query, send, dialog, click, RosterUiProof { window.get() }))
            pending = h.push(h.endpoint.savedDeleteConfirmed(prepare.copy(proof = send), click))
                .state.pending.single { it.kind.isSaved }
            h.drain()
        }
        fun deleted(): RosterClientEvent.OperationSettled = h.deliver(RosterFrame.SavedDeleteResult(pending.requestId,
            OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH))).events.filterIsInstance<RosterClientEvent.OperationSettled>().single()
        fun refresh(event: RosterClientEvent.OperationSettled = deleted(),
                    firstReplyTimeoutMs: Long = DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS) =
            continuation.refresh(event, display, 8, dialog, firstReplyTimeoutMs)
    }

    @Test fun confirmedDeletedRequestsExactlyOneFreshListAndKeepsReceivedDataForZeroOrNonzero() {
        for (total in listOf(0L, 2L)) {
            val f = Fixture()
            f.continuation.admitted(f.pending)
            val event = f.deleted()
            assertNull(f.h.endpoint.state().savedOwnership)
            val refresh = assertNotNull(f.refresh(event))
            assertEquals(SavedRequestStatus.Requesting, refresh.display.status)
            assertSame(f.display.entries, refresh.display.entries)
            assertEquals(1L, refresh.display.total)
            assertEquals(f.display.offset, refresh.display.offset)
            assertEquals(SavedResultTarget.of(f.display), SavedResultTarget.of(refresh.display))
            assertNull(refresh.display.windowProof)
            assertTrue(refresh.display.entryProofs.isEmpty())
            assertEquals(f.display.query, refresh.command.query)
            assertEquals(0L, refresh.command.offset); assertEquals(50L, refresh.command.count)
            assertEquals(DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS, refresh.command.firstReplyTimeoutMs)
            assertEquals(f.h.generation, refresh.command.proof?.channelGeneration)
            assertEquals(f.display.hostRunId, refresh.command.hostRunId)
            assertEquals(f.pending.savedPickerRevision, refresh.command.proof?.queryRevision)
            assertNull(refresh.command.proof?.catalogId)
            f.dialog.invalidate(UiProofInvalidationReason.DISMISSED)
            assertFalse(f.click.isStillCurrent(), "the original delete-send receipt really retired")
            f.continuation.observe(refresh.display, 8, null)
            assertTrue(f.continuation.isStillCurrent(), "only its own completed dialog intentionally closed")
            repeat(5) { assertNull(f.refresh(event)) }
            assertTrue(f.continuation.isStillCurrent())
            f.h.push(f.h.endpoint.savedList(refresh.command)); f.h.drain()
            val list = f.h.sends.last().frame as RosterFrame.SavedListRequest
            assertEquals(f.pending.sequence!! + 1, list.sequence)
            assertEquals(refresh.command.query, list.query)
            val entries = (0 until total.toInt()).map { RosterClientHarness.entry(it + 10) }
            val pages = if (entries.isEmpty()) 0L else 1L
            f.h.deliver(RosterFrame.SavedWindowBegin(list.requestId, f.display.hostRunId!!,
                "fresh-catalog", "fresh-result", total, 0, 0, total, pages))
            if (entries.isNotEmpty()) f.h.deliver(RosterFrame.SavedWindowPage(list.requestId, 0, entries))
            assertSame(f.display.entries, refresh.display.entries, "no partial/local deletion result")
            val completed = f.h.deliver(RosterFrame.SavedWindowEnd(list.requestId, total, pages))
                .events.filterIsInstance<RosterClientEvent.OperationSettled>().single()
            val facts = ((completed.result as RosterRequestResult.OwnerResult).outcome as RosterOwnerOutcome.SavedWindow)
                .facts as RosterSavedWindowFacts.Complete
            assertEquals(total, facts.total)
            assertEquals(entries, facts.entries)
            assertTrue(f.continuation.adoptResult())
            f.continuation.cancel()
            assertEquals(entries.map { it.entryId }, f.h.endpoint.state().savedOwnership?.windows?.single()?.entryIds,
                "consumed complete results return to normal manual-read semantics")
            assertEquals(2, f.h.countOfType("saved_list_request"))
            assertEquals(0, f.h.countOfType("saved_search_request"))
            assertEquals(2, f.h.countOfType("saved_delete_request"))
        }
    }

    @Test fun confirmedDeletedFreshListUsesTheConfiguredFirstReplyWait() {
        val f = Fixture()
        f.continuation.admitted(f.pending)

        val refresh = assertNotNull(f.refresh(f.deleted(), firstReplyTimeoutMs = 1_000L))

        assertEquals(1_000L, refresh.command.firstReplyTimeoutMs)
        // The configured wait is the only local read-policy input here; the
        // existing post-delete LIST page size stays 50.
        assertEquals(50L, refresh.command.count)
    }

    @Test fun settlementBeforeAdmissionUsesExactCapturedPendingRatherThanLaterEndpointState() {
        val f = Fixture()
        val operations = OperationCorrelation<AcceptedSavedDeletion>()
        val key = OperationKey(f.host, f.h.generation, RosterOperationKind.SAVED_DELETE, f.pending.requestId)
        operations.begin(f.host, f.h.generation)
        val event = f.deleted()
        assertNull(operations.settle(key, event))
        assertTrue(f.h.endpoint.state().pending.none { it.kind.isSaved })
        f.continuation.admitted(f.pending)
        val pair = assertNotNull(operations.accept(key, f.continuation))
        assertNotNull(pair.first.refresh(pair.second, f.display, 8, f.dialog))
        assertNull(operations.settle(key, event), "duplicate settlement is not a second continuation")
        operations.end(f.host, f.h.generation)
    }

    @Test fun missingOrMismatchedAcceptedMetadataCannotMintARead() {
        val base = Fixture().pending
        val variants = listOf(null, base.copy(savedDeleteConfirmed = false), base.copy(savedPickerRevision = 9),
            base.copy(sequence = null), base.copy(hostRunId = "foreign-run"), base.copy(catalogId = "foreign-catalog"),
            base.copy(resultId = "foreign-result"), base.copy(entryId = "foreign-entry"), base.copy(kind = RosterOperationKind.SAVED_LIST))
        for (pending in variants) {
            val f = Fixture()
            f.continuation.admitted(pending)
            assertNull(f.refresh())
            assertFalse(f.continuation.isStillCurrent())
        }
    }

    @Test fun refusedUnknownUnconfirmedNotSentAndForeignSettlementsNeverRefresh() {
        val f0 = Fixture()
        val event = f0.deleted()
        val results = listOf(RosterRequestResult.Unknown, RosterRequestResult.NotSent(RosterNotSentReason.NOT_READY),
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedDelete(OwnerSavedDeleteFacts.ConfirmationRequired)),
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedDelete(OwnerSavedDeleteFacts.Unconfirmed)),
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedDelete(OwnerSavedDeleteFacts.Unknown)),
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedDelete(OwnerSavedDeleteFacts.Refused(SavedDeleteRefusalReason.STALE))))
        for (result in results) {
            val f = Fixture(); f.continuation.admitted(f.pending)
            assertNull(f.refresh(event.copy(result = result)))
        }
        for (foreign in listOf(event.copy(requestId = "foreign"), event.copy(hostRunId = "foreign-run"),
            event.copy(kind = RosterOperationKind.SAVED_RESUME))) {
            val f = Fixture(); f.continuation.admitted(f.pending)
            assertNull(f.refresh(foreign))
        }
    }

    @Test fun changedPickerQueryResultOwnerDialogAndWindowCancelPermanentlyEvenWhenRestored() {
        for (change in 0..7) {
            val f = Fixture(); f.continuation.admitted(f.pending)
            when (change) {
                0 -> f.continuation.observe(f.display, 9, f.dialog)
                1 -> f.continuation.observe(f.display.copy(query = "changed"), 8, f.dialog)
                2 -> f.continuation.observe(f.display.copy(resultId = "new-result"), 8, f.dialog)
                3 -> f.continuation.observe(f.display.copy(selectedHostId = HostId.parse("another-host")), 8, f.dialog)
                4 -> f.continuation.observe(f.display, 8, null)
                5 -> f.continuation.observe(f.display, 8, MutableUiActionProof(f.dialog.target))
                6 -> { f.window.set(false); assertFalse(f.continuation.isStillCurrent()); f.window.set(true) }
                7 -> f.continuation.observe(f.display, 8, f.dialog, otherDialog = true)
            }
            f.continuation.observe(f.display, 8, f.dialog)
            assertNull(f.refresh())
            assertFalse(f.continuation.isStillCurrent())
        }
    }

    @Test fun selfClosedContinuationStillRejectsRealPickerWindowOrDialogReplacementBeforeWrite() {
        for (change in 0..5) {
            val f = Fixture(); f.continuation.admitted(f.pending)
            val refresh = assertNotNull(f.refresh())
            f.dialog.invalidate(UiProofInvalidationReason.DISMISSED)
            f.continuation.observe(refresh.display, 8, null)
            when (change) {
                0 -> f.continuation.observe(refresh.display, 9, null)
                1 -> f.continuation.observe(refresh.display.copy(query = "changed"), 8, null)
                2 -> f.continuation.observe(refresh.display.copy(hostRunId = "another-run"), 8, null)
                3 -> f.continuation.observe(refresh.display, 8, MutableUiActionProof(f.dialog.target))
                4 -> { f.window.set(false); assertFalse(f.continuation.isStillCurrent()); f.window.set(true) }
                5 -> f.continuation.observe(refresh.display.copy(catalogId = "replacement"), 8, null)
            }
            f.continuation.observe(refresh.display, 8, null)
            f.h.push(f.h.endpoint.savedList(refresh.command))
            assertFalse(f.continuation.isStillCurrent())
            assertNull(f.h.endpoint.state().savedOwnership)
            assertEquals(1, f.h.countOfType("saved_list_request"), "canceled automatic read never becomes an effect")
            assertEquals(RosterNotSentReason.TARGET_UNAVAILABLE, f.h.refusals().last().second)
        }
    }

    @Test fun nativeDialogEpochRetirementBeforeDeletedCannotReviveThroughRearm() {
        for (reason in UiProofInvalidationReason.entries) {
            val f = Fixture(); f.continuation.admitted(f.pending)
            f.dialog.invalidate(reason)
            val epoch = f.dialog.beginDraw(); f.dialog.setCriticalIdentityReadable(true); f.dialog.markCommitted(epoch)
            assertNull(f.refresh())
            assertFalse(f.continuation.isStillCurrent())
        }
    }

    @Test fun externalDismissalAfterSelfCloseAndCancellationAtFinalFrameCannotAuthorizeLateOwnership() {
        for (cancelAfterEnd in listOf(false, true)) {
            val f = Fixture(); f.continuation.admitted(f.pending)
            val refresh = assertNotNull(f.refresh())
            f.h.push(f.h.endpoint.savedList(refresh.command)); f.h.drain()
            val request = f.h.lastRequestOf("saved")
            f.h.deliver(RosterFrame.SavedWindowBegin(request, f.display.hostRunId!!, "new-catalog", "new-result", 1, 0, 0, 1, 1))
            f.h.deliver(RosterFrame.SavedWindowPage(request, 0, f.display.entries))
            if (!cancelAfterEnd) f.continuation.cancel()
            f.h.deliver(RosterFrame.SavedWindowEnd(request, 1, 1))
            f.continuation.cancel()
            assertNull(f.h.endpoint.state().savedOwnership)
            assertFalse(f.continuation.adoptResult())
            assertEquals(2, f.h.countOfType("saved_list_request"))
            assertEquals(0, f.h.countOfType("saved_search_request"))
            assertEquals(2, f.h.countOfType("saved_delete_request"), "prepare plus one confirmed Delete only")
        }
    }

    @Test fun canceledPostDeleteRefreshStatusIsRetiredWithoutAnOwnerRequestOrLateRevival() {
        for (reason in listOf("query", "modal", "leave", "owner")) {
            val f = Fixture(); f.continuation.admitted(f.pending)
            val refresh = assertNotNull(f.refresh())
            f.h.push(f.h.endpoint.savedList(refresh.command)); f.h.drain()
            val read = f.h.lastRequestOf("saved")
            val feedback = SavedRefreshFeedback()
            feedback.shown(f.continuation)
            assertSame(refresh.display, feedback.observe(refresh.display, trackedRead = false),
                "the one live automatic LIST still shows Requesting: $reason")
            assertEquals(2, f.h.countOfType("saved_list_request"),
                "one automatic LIST after the initial read: $reason")
            // The exact cancellation the controller observes: a query edit changes the
            // picker, another dialog covers it, leaving retires it, and owner/window loss
            // fails its lifetime. None of them may leave the automatic read pending.
            when (reason) {
                "query" -> f.continuation.observe(refresh.display.copy(query = "edited"), 8, null)
                "modal" -> f.continuation.observe(refresh.display, 8, null, otherDialog = true)
                "leave" -> f.continuation.cancel()
                "owner" -> f.window.set(false)
            }
            assertFalse(f.continuation.isStillCurrent(), reason)
            val shown = if (reason == "query") refresh.display.copy(query = "edited") else refresh.display
            val retired = feedback.observe(shown, trackedRead = false)
            assertEquals(SavedRequestStatus.Unknown, retired.status, reason)
            assertNull(retired.readFeedbackBaseStatus, reason)
            // Nothing was deleted locally, filtered, or replaced: only the stale status moved.
            assertSame(refresh.display.entries, retired.entries, reason)
            assertEquals(SavedResultTarget.of(refresh.display), SavedResultTarget.of(retired), reason)
            assertNull(retired.windowProof, reason)
            assertTrue(retired.entryProofs.isEmpty(), reason)
            // Its late owner reply is not actionable and cannot install a result or ownership.
            f.h.deliver(RosterFrame.SavedWindowBegin(read, f.display.hostRunId!!, "late-catalog", "late-result", 1, 0, 0, 1, 1))
            f.h.deliver(RosterFrame.SavedWindowPage(read, 0, f.display.entries))
            f.h.deliver(RosterFrame.SavedWindowEnd(read, 1, 1))
            assertEquals(RosterRequestResult.Unknown,
                f.h.settled().last { it.second == read }.third, "the canceled read has no result: $reason")
            assertTrue(f.h.endpoint.state().pending.none { it.kind.isSaved }, "no pending read: $reason")
            assertNull(f.h.endpoint.state().savedOwnership, reason)
            assertFalse(f.continuation.adoptResult(), reason)
            assertNull(f.refresh(), "the one-shot continuation cannot mint another read: $reason")
            assertSame(retired, feedback.observe(retired, trackedRead = false),
                "a late settlement revives no status: $reason")
            assertEquals(2, f.h.countOfType("saved_list_request"), "no retry or replacement request: $reason")
            assertEquals(0, f.h.countOfType("saved_search_request"), reason)
            assertEquals(0, f.h.countOfType("saved_window_request"), reason)
            assertEquals(0, f.h.countOfType("saved_resume_request"), reason)
            assertEquals(2, f.h.countOfType("saved_delete_request"),
                "prepare plus one confirmed Delete only: $reason")
        }
    }
}
