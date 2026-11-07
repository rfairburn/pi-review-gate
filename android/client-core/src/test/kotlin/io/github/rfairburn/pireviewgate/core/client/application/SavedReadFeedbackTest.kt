package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.*
import kotlin.test.*

/**
 * Status-only Saved pending feedback against the actual endpoint, the actual admission/
 * settlement correlation and actual committed proofs. The Android controller is not
 * ported to JVM: [project] is only its existing status projection for one settled read.
 * Rendered bounds are covered by the separate instrumented SavedRequestingFeedback test.
 */
class SavedReadFeedbackTest {
    private class Fixture {
        val h = RosterClientHarness()
        val host = HostId.parse("host-1")
        val feedback = SavedReadFeedback()
        val settlements = SavedReadSettlementFence()
        val correlation = OperationCorrelation<String>()
        val search = committed(UiActionTargetToken(UiProofScreen.SESSION_CREATE, host,
            hostRunId = RosterClientHarness.RUN_ID, generation = 11))
        val window = committed(UiActionTargetToken(UiProofScreen.SAVED_DELETE, host,
            hostRunId = RosterClientHarness.RUN_ID, catalogId = "catalog-0", resultId = "result-0", generation = 12))
        val resume = committed(UiActionTargetToken(UiProofScreen.SAVED_DELETE, host,
            hostRunId = RosterClientHarness.RUN_ID, catalogId = "catalog-0", resultId = "result-0",
            entryId = "entry-0", generation = 13))
        val entryKey = SavedEntryKey(RosterClientHarness.RUN_ID, "catalog-0", "result-0", "entry-0")
        /** The picker as first opened: nothing below the status line can move or swap. */
        val display = SavedUiState(host, SavedRequestStatus.Idle, RosterClientHarness.RUN_ID,
            query = "needle", listProof = search)
        /** A drawn result with entry controls and a live Load More button. */
        val withResult = SavedUiState(host, SavedRequestStatus.Unknown, RosterClientHarness.RUN_ID, "catalog-0",
            "result-0", "older", 1L, total = 5L, issueCount = 0L, entries = listOf(RosterClientHarness.entry(0)),
            transferComplete = true, query = "needle", listProof = search, windowProof = window,
            entryProofs = mapOf(entryKey to SavedEntryControlProofs(resume, null)))
        val view = SavedReadFeedback.View(host, RosterClientHarness.RUN_ID, "needle", 3L, h.generation, true)
        /** The controller's savedResultGeneration: the channel of the adopted result's sequence. */
        var adoptedGeneration: Long? = null
        init { h.subscribed(); h.publishSnapshot() }

        /** One actual committed LIST admission, correlated exactly as the controller does. */
        fun admit(ui: RosterUiProof, query: String = "needle"): Admitted {
            correlation.begin(host, h.generation)
            val step = h.push(h.endpoint.savedList(RosterSavedListCommand(RosterClientHarness.RUN_ID, query, 0, 50,
                RosterClientHarness.readProof(h.generation, RosterClientHarness.RUN_ID, ui = ui))))
            val accepted = step.events.filterIsInstance<RosterClientEvent.OperationAccepted>().single()
            val sequence = step.state.pending.firstOrNull { it.requestId == accepted.requestId }?.sequence
            return Admitted(OperationKey(host, h.generation, accepted.kind, accepted.requestId), sequence, h.sends.lastIndex)
        }
        fun complete(requestId: String): RosterClientEvent.OperationSettled {
            h.deliver(RosterFrame.SavedWindowBegin(requestId, RosterClientHarness.RUN_ID, RosterClientHarness.CATALOG_ID,
                RosterClientHarness.RESULT_ID, total = 1L, issueCount = 0L, offset = 0L, rows = 1L, pageCount = 1L))
            h.deliver(RosterFrame.SavedWindowPage(requestId, 0L, listOf(RosterClientHarness.entry(1))))
            return settledIn(h.deliver(RosterFrame.SavedWindowEnd(requestId, rows = 1L, pageCount = 1L)))
        }
        fun answer(requestId: String, outcome: OwnerSavedWindowOutcome) =
            settledIn(h.deliver(RosterFrame.SavedWindowResult(requestId, outcome)))
        fun accept(read: Admitted, shown: SavedUiState, intake: SavedReadFeedback.View? = view,
                   current: SavedReadFeedback.View = view): SavedUiState =
            feedback.accepted(read.key, read.sequence, intake, false, current, shown)
        /**
         * Mirrors the controller's finish wrapper and finishSettled order: observe, the picker
         * fence, the adopted-sequence fence, the pending gate, the settlement watermark, the
         * projection (adopting a complete result with its accepting sequence), then the read's
         * own settlement.
         */
        fun finish(key: OperationKey, event: RosterClientEvent.OperationSettled, shown: SavedUiState,
                   current: SavedReadFeedback.View = view, sequence: Long? = null): SavedUiState {
            var next = feedback.observe(current, shown)
            if (current == view && !SavedReadFeedback.olderThanAdopted(sequence, key.channelGeneration, next, adoptedGeneration) &&
                feedback.projects(key) && settlements.projects(key, sequence)) {
                next = project(next, event, sequence)
                if (sequence != null && next.status == SavedRequestStatus.Ready) adoptedGeneration = key.channelGeneration
            }
            return feedback.settled(key, current, next)
        }
    }
    private data class Admitted(val key: OperationKey, val sequence: Long?, val sendIndex: Int)

    @Test fun acceptedPendingSearchShowsRequestingUntilItsOwnActualOutcome() {
        // null = a complete owner transfer; otherwise the owner's fixed non-data answer.
        val outcomes = listOf<Pair<OwnerSavedWindowOutcome?, SavedRequestStatus>>(
            null to SavedRequestStatus.Ready,
            OwnerSavedWindowOutcome.Unavailable to SavedRequestStatus.Unavailable,
            OwnerSavedWindowOutcome.Refused(SavedWindowRefusalReason.BUSY) to SavedRequestStatus.Refused(SavedWindowRefusalReason.BUSY),
            OwnerSavedWindowOutcome.Unknown to SavedRequestStatus.Unknown,
        )
        for ((outcome, expected) in outcomes) {
            val f = Fixture()
            val click = assertNotNull(FrozenAction.capture(f.search))
            val read = f.admit(click)
            assertNotNull(read.sequence)
            assertNull(f.correlation.accept(read.key, "read"), "nothing settled inside admission")
            val pending = f.accept(read, f.display)
            f.correlation.end(f.host, f.h.generation)
            assertEquals(SavedRequestStatus.Requesting, pending.status)
            assertEquals(SavedRequestStatus.Idle, pending.readFeedbackBaseStatus)
            assertEquals(read.key, f.feedback.pending)
            assertStatusOnly(f.display, pending)
            assertEquals(f.display.moreDecision() == SavedMoreDecision.MAY_REQUEST,
                pending.moreDecision() == SavedMoreDecision.MAY_REQUEST, "no Load More button appears or vanishes")
            // Repeated controller refreshes keep pending; nothing but its outcome settles it.
            repeat(3) { assertSame(pending, f.feedback.observe(f.view, pending)) }
            // The queued writer still holds the actual committed Search proof and may submit.
            assertTrue(f.search.isCurrent && click.isStillCurrent())
            assertEquals(RosterDispatchDecision.Allow, f.h.decide(read.sendIndex))
            f.h.drain()
            val event = outcome?.let { f.answer(read.key.requestId, it) } ?: f.complete(read.key.requestId)
            assertEquals("read", assertNotNull(f.correlation.settle(read.key, event)).first)
            val shown = f.finish(read.key, event, pending, sequence = read.sequence)
            assertEquals(expected, shown.status)
            assertNull(shown.readFeedbackBaseStatus, "the drawn presentation follows the actual outcome again")
            assertNull(f.feedback.pending)
            assertSame(f.search, shown.listProof)
        }
    }

    @Test fun populatedPickerShowsRequestingWhileItsControlsKeepTheirDrawnPresentation() {
        val f = Fixture()
        // A drawn result with entry controls, a live Load More button and a multiline prior status.
        assertEquals(SavedMoreDecision.MAY_REQUEST, f.withResult.moreDecision())
        val click = assertNotNull(FrozenAction.capture(f.search))
        val read = f.admit(click)
        assertNull(f.correlation.accept(read.key, "read"))
        val pending = f.accept(read, f.withResult)
        assertEquals(SavedRequestStatus.Requesting, pending.status)
        assertEquals(SavedRequestStatus.Unknown, pending.readFeedbackBaseStatus)
        assertEquals(read.key, f.feedback.pending)
        assertStatusOnly(f.withResult, pending)
        // Load More stays the same live button: presentation follows the drawn base status.
        assertEquals(SavedMoreDecision.MAY_REQUEST, pending.moreDecision())
        assertTrue(f.search.isCurrent && f.window.isCurrent && f.resume.isCurrent && click.isStillCurrent())
        // The queued writer's actual committed Search proof still dispatches.
        assertEquals(RosterDispatchDecision.Allow, f.h.decide(read.sendIndex))
        f.h.drain()
        val event = f.answer(read.key.requestId, OwnerSavedWindowOutcome.Unavailable)
        assertNotNull(f.correlation.settle(read.key, event))
        val shown = f.finish(read.key, event, pending, sequence = read.sequence)
        assertEquals(SavedRequestStatus.Unavailable, shown.status)
        assertNull(shown.readFeedbackBaseStatus)
        assertNull(f.feedback.pending)
        // A display that was already in flight (the post-delete continuation) keeps blocking.
        val inFlight = f.withResult.copy(status = SavedRequestStatus.Requesting)
        assertEquals(SavedMoreDecision.REQUEST_IN_FLIGHT, inFlight.moreDecision())
        assertEquals(SavedMoreDecision.REQUEST_IN_FLIGHT,
            inFlight.copy(readFeedbackBaseStatus = SavedRequestStatus.Requesting).moreDecision())
    }

    @Test fun delayedOlderSettlementCannotReplaceANewerAdoptedResult() {
        val f = Fixture()
        // A is admitted by the endpoint, but its admission continuation is held off Main.
        val a = f.admit(assertNotNull(FrozenAction.capture(f.search)))
        f.h.drain()
        // Newer B (a replacement proof in the same picker epoch) supersedes A at the endpoint.
        val retry = committed(f.search.target.copy(generation = 41))
        val b = f.admit(assertNotNull(FrozenAction.capture(retry)))
        assertTrue(assertNotNull(b.sequence) > assertNotNull(a.sequence))
        val aUnknown = f.h.events.filterIsInstance<RosterClientEvent.OperationSettled>().single { it.requestId == a.key.requestId }
        assertEquals(RosterRequestResult.Unknown, aUnknown.result)
        // A's supersession settlement is buffered: its admission has not returned yet.
        assertNull(f.correlation.settle(a.key, aUnknown))
        assertNull(f.correlation.accept(b.key, "B"))
        val pending = f.accept(b, f.display)
        f.h.drain()
        val bEvent = f.complete(b.key.requestId)
        assertEquals("B", assertNotNull(f.correlation.settle(b.key, bEvent)).first)
        val adopted = f.finish(b.key, bEvent, pending, sequence = b.sequence)
        assertEquals(SavedRequestStatus.Ready, adopted.status)
        assertEquals(b.sequence, adopted.sequence)
        assertNull(f.feedback.pending)
        assertTrue(f.feedback.projects(a.key), "the cleared pending tracker alone no longer fences A")
        // A's held admission finally returns and finds its buffered Unknown.
        val late = assertNotNull(f.correlation.accept(a.key, "A"))
        f.correlation.end(f.host, f.h.generation); f.correlation.end(f.host, f.h.generation)
        assertSame(f.display, f.feedback.accepted(a.key, a.sequence, f.view, true, f.view, f.display))
        assertTrue(SavedReadFeedback.olderThanAdopted(a.sequence, a.key.channelGeneration, adopted, f.adoptedGeneration))
        val after = f.finish(a.key, late.second, adopted, sequence = a.sequence)
        assertSame(adopted, after, "B keeps its status, result identity, entries and proofs")
        // Sequences restart per channel: a fresh first read after reconnect is never fenced.
        assertFalse(SavedReadFeedback.olderThanAdopted(1L, a.key.channelGeneration + 1, adopted, f.adoptedGeneration))
        assertFalse(SavedReadFeedback.olderThanAdopted(null, a.key.channelGeneration, adopted, f.adoptedGeneration))
        assertFalse(SavedReadFeedback.olderThanAdopted(a.sequence, a.key.channelGeneration, adopted, null))
        assertFalse(SavedReadFeedback.olderThanAdopted(b.sequence!! + 1, a.key.channelGeneration, adopted, f.adoptedGeneration))
    }

    @Test fun delayedOlderSettlementCannotReplaceANewerNonDataOutcome() {
        val outcomes = listOf(
            OwnerSavedWindowOutcome.Unavailable to SavedRequestStatus.Unavailable,
            OwnerSavedWindowOutcome.Refused(SavedWindowRefusalReason.BUSY) to
                SavedRequestStatus.Refused(SavedWindowRefusalReason.BUSY),
        )
        for ((outcome, expected) in outcomes) {
            val f = Fixture()
            // A is admitted, but its admission continuation is held off Main.
            val a = f.admit(assertNotNull(FrozenAction.capture(f.search)))
            f.h.drain()
            // Newer B (a replacement proof in the same picker epoch) supersedes A at the endpoint.
            val retry = committed(f.search.target.copy(generation = 41))
            val b = f.admit(assertNotNull(FrozenAction.capture(retry)))
            assertTrue(assertNotNull(b.sequence) > assertNotNull(a.sequence))
            val superseded = f.h.events.filterIsInstance<RosterClientEvent.OperationSettled>()
                .single { it.requestId == a.key.requestId }
            assertEquals(RosterRequestResult.Unknown, superseded.result)
            assertNull(f.correlation.settle(a.key, superseded), "buffered: A's admission has not returned")
            assertNull(f.correlation.accept(b.key, "B"))
            val pending = f.accept(b, f.display)
            f.h.drain()
            val answer = f.answer(b.key.requestId, outcome)
            assertNotNull(f.correlation.settle(b.key, answer))
            val shown = f.finish(b.key, answer, pending, sequence = b.sequence)
            assertEquals(expected, shown.status)
            // A non-data answer adopts nothing: the displayed sequence, handles and proofs stay.
            assertEquals(f.display.sequence, shown.sequence)
            assertStatusOnly(f.display, shown)
            assertNull(f.adoptedGeneration)
            assertNull(f.feedback.pending)
            assertFalse(SavedReadFeedback.olderThanAdopted(a.sequence, a.key.channelGeneration, shown, f.adoptedGeneration),
                "the adopted-result fence alone cannot see B's non-data answer")
            // A's held admission returns and finds its buffered supersession Unknown.
            val late = assertNotNull(f.correlation.accept(a.key, "A"))
            f.correlation.end(f.host, f.h.generation)
            f.correlation.end(f.host, f.h.generation)
            val afterAdmission = f.feedback.accepted(a.key, a.sequence, f.view, true, f.view, shown)
            assertSame(shown, afterAdmission)
            assertSame(shown, f.finish(a.key, late.second, afterAdmission, sequence = a.sequence))
            // Other channels never compare; an unsequenced settlement is not fenced.
            assertTrue(f.settlements.projects(a.key.copy(channelGeneration = f.h.generation + 1, requestId = "next"), 1L))
            assertTrue(f.settlements.projects(a.key.copy(requestId = "unsequenced"), null))
        }
    }

    @Test fun immediateSameStepSettlementIsNeverOverwrittenByPending() {
        val f = Fixture()
        val read = f.admit(assertNotNull(FrozenAction.capture(f.search)))
        f.h.drain()
        // The owner's answer reaches correlation before the admission returns to Main.
        val event = f.answer(read.key.requestId, OwnerSavedWindowOutcome.Unavailable)
        assertNull(f.correlation.settle(read.key, event))
        val early = assertNotNull(f.correlation.accept(read.key, "read"), "same-step settlement found")
        val afterAdmission = f.feedback.accepted(read.key, read.sequence, f.view, true, f.view, f.display)
        assertSame(f.display, afterAdmission, "no pending flash for an already settled read")
        val shown = f.finish(read.key, early.second, afterAdmission)
        assertEquals(SavedRequestStatus.Unavailable, shown.status)
        repeat(3) { assertSame(shown, f.feedback.observe(f.view, shown)) }
        assertNull(f.feedback.pending)
    }

    @Test fun notSubmittedReadIsNeverPresentedAsPending() {
        val f = Fixture()
        // Endpoint refusal: no acceptance exists, so the controller never reaches pending.
        val stale = committed(f.search.target.copy(generation = 21))
        val retired = assertNotNull(FrozenAction.capture(stale))
        stale.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
        val refused = f.h.push(f.h.endpoint.savedList(RosterSavedListCommand(RosterClientHarness.RUN_ID, "needle", 0, 50,
            RosterClientHarness.readProof(f.h.generation, RosterClientHarness.RUN_ID, ui = retired))))
        assertTrue(refused.events.none { it is RosterClientEvent.OperationAccepted })
        assertNull(f.feedback.pending)
        assertEquals(SavedRequestStatus.Idle, f.feedback.observe(f.view, f.display).status)

        // Accepted, then positively never dispatched: pending ends as the actual NotSent.
        val read = f.admit(assertNotNull(FrozenAction.capture(f.search)))
        assertNull(f.correlation.accept(read.key, "read"))
        val pending = f.accept(read, f.display)
        assertEquals(SavedRequestStatus.Requesting, pending.status)
        val event = settledIn(f.h.report(read.sendIndex, RosterSendDisposition.NotDispatched(RosterSendRefusal.PROOF_UNAVAILABLE)))
        assertEquals(RosterRequestResult.NotSent(RosterNotSentReason.TARGET_UNAVAILABLE), event.result)
        assertNotNull(f.correlation.settle(read.key, event))
        assertEquals(SavedRequestStatus.Refused(), f.finish(read.key, event, pending).status)
    }

    @Test fun replacedPickerViewsRetirePendingAndLateOutcomesCannotWriteIntoThem() {
        val prior = SavedRequestStatus.Unknown
        val start = Fixture().display.copy(status = prior)
        val changes: List<Pair<String, (Fixture, SavedUiState) -> Pair<SavedReadFeedback.View, SavedUiState>>> = listOf(
            "query edit" to { f: Fixture, p: SavedUiState -> f.view.copy(query = "needle2", pickerEpoch = 4L) to p.copy(query = "needle2", listProof = null) },
            "owner change" to { f: Fixture, _: SavedUiState -> f.view.copy(hostId = HostId.parse("host-2"), pickerEpoch = 4L) to SavedUiState(HostId.parse("host-2")) },
            "run change" to { f: Fixture, _: SavedUiState -> f.view.copy(hostRunId = "run-0002", pickerEpoch = 4L) to SavedUiState(f.host, hostRunId = "run-0002", query = "needle") },
            "leave" to { f: Fixture, p: SavedUiState -> f.view.copy(savedRoute = false, pickerEpoch = 4L) to p },
            "leave and reopen" to { f: Fixture, _: SavedUiState -> f.view.copy(pickerEpoch = 5L) to SavedUiState(f.host, hostRunId = RosterClientHarness.RUN_ID) },
        )
        for ((name, change) in changes) {
            val f = Fixture()
            val read = f.admit(assertNotNull(FrozenAction.capture(f.search)))
            assertNull(f.correlation.accept(read.key, "read"))
            val pending = f.accept(read, start)
            assertEquals(SavedRequestStatus.Requesting, pending.status, name)
            val (next, replacement) = change(f, pending)
            val retired = f.feedback.observe(next, replacement)
            assertNull(f.feedback.pending, name)
            assertNull(retired.readFeedbackBaseStatus, name)
            if (replacement.status == SavedRequestStatus.Requesting) assertEquals(prior, retired.status, name)
            else assertSame(replacement, retired, "$name: a fresh picker is never touched")
            // Late actual outcome of the abandoned read: the controller's picker fence
            // drops its projection, and this helper writes nothing into the new view.
            f.h.drain()
            val event = f.complete(read.key.requestId)
            assertNotNull(f.correlation.settle(read.key, event))
            assertSame(retired, f.feedback.settled(read.key, next, retired), name)
            // A late admission of a read raised from the old view never resurrects pending.
            val late = f.admit(assertNotNull(FrozenAction.capture(f.search)))
            assertNull(f.correlation.accept(late.key, "late"))
            assertSame(retired, f.accept(late, retired, intake = f.view, current = next), name)
            assertNull(f.feedback.pending, name)
        }
    }

    @Test fun delayedOlderAdmissionsCannotRetireOrStealNewerPickerFeedback() {
        val f = Fixture()
        // An older picker's read (and an older channel's read) were admitted first, but their
        // admission continuations resume on Main only after the replacement picker's Search.
        val olderPicker = f.view.copy(query = "old", pickerEpoch = 2L)
        val oldRead = f.admit(RosterClientHarness.TRUE_PROOF, query = "old")
        f.h.drain()
        val newer = f.view.copy(pickerEpoch = 4L)
        val read = f.admit(assertNotNull(FrozenAction.capture(f.search)))
        assertTrue(assertNotNull(read.sequence) > assertNotNull(oldRead.sequence))
        assertNull(f.correlation.accept(read.key, "read"))
        val pending = f.feedback.accepted(read.key, read.sequence, newer, false, newer, f.display)
        assertEquals(SavedRequestStatus.Requesting, pending.status)
        val delayed = listOf(
            // The older picker's LIST, an unpresented window and the post-delete continuation.
            Triple(oldRead.key, oldRead.sequence, olderPicker),
            Triple(oldRead.key.copy(kind = RosterOperationKind.SAVED_WINDOW, requestId = "window-old"), 1L, olderPicker),
            Triple(oldRead.key.copy(requestId = "refresh-old"), 1L, null),
            // An older channel generation's read for this same picker.
            Triple(oldRead.key.copy(channelGeneration = f.h.generation - 1, requestId = "old-channel"), 1L,
                newer.copy(generation = f.h.generation - 1)),
            // A delayed fresh-intake read the endpoint admitted BEFORE the tracked one.
            Triple(oldRead.key.copy(requestId = "earlier"), oldRead.sequence, newer),
            Triple(oldRead.key.copy(kind = RosterOperationKind.SAVED_WINDOW, requestId = "window-new"), 9L, newer),
        )
        for ((key, sequence, intake) in delayed) {
            assertSame(pending, f.feedback.accepted(key, sequence, intake, false, newer, pending), key.toString())
            assertSame(pending, f.feedback.accepted(key, sequence, intake, true, newer, pending), key.toString())
            assertEquals(read.key, f.feedback.pending, key.toString())
        }
        // The endpoint superseded the older read with Unknown; it cannot write into the newer view.
        val superseded = f.h.settled().single { it.second == oldRead.key.requestId }
        assertEquals(RosterRequestResult.Unknown, superseded.third)
        assertFalse(f.feedback.projects(oldRead.key))
        val oldEvent = RosterClientEvent.OperationSettled(oldRead.key.kind, oldRead.key.requestId,
            RosterClientHarness.RUN_ID, RosterRequestResult.Unknown)
        assertEquals(SavedRequestStatus.Requesting, f.finish(oldRead.key, oldEvent, pending, newer).status)
        assertEquals(read.key, f.feedback.pending)
        // A later replacement of the newer picker still retires its pending feedback.
        val edited = newer.copy(query = "needle2", pickerEpoch = 5L)
        val retired = f.feedback.observe(edited, pending.copy(query = "needle2", listProof = null))
        assertEquals(SavedRequestStatus.Idle, retired.status)
        assertNull(retired.readFeedbackBaseStatus)
        assertNull(f.feedback.pending)
    }

    @Test fun generationLossOfTheSamePickerSettlesUnknownNotIdle() {
        val f = Fixture()
        val read = f.admit(assertNotNull(FrozenAction.capture(f.search)))
        assertNull(f.correlation.accept(read.key, "read"))
        val pending = f.accept(read, f.display)
        val reconnected = f.view.copy(generation = f.h.generation + 1)
        val shown = f.feedback.observe(reconnected, pending)
        assertEquals(SavedRequestStatus.Unknown, shown.status)
        assertNull(shown.readFeedbackBaseStatus)
        assertStatusOnly(f.display, shown)
        // The old channel's late settlement cannot settle anything in the reconnected view.
        f.h.drain()
        val event = f.answer(read.key.requestId, OwnerSavedWindowOutcome.Unavailable)
        assertNotNull(f.correlation.settle(read.key, event))
        assertSame(shown, f.finish(read.key, event, shown, reconnected))
        // Also when the settlement reaches the controller before its next refresh.
        val g = Fixture()
        val second = g.admit(assertNotNull(FrozenAction.capture(g.search)))
        assertNull(g.correlation.accept(second.key, "read"))
        val waiting = g.accept(second, g.display)
        g.h.drain()
        val lost = g.answer(second.key.requestId, OwnerSavedWindowOutcome.Unknown)
        assertEquals(SavedRequestStatus.Unknown, g.finish(second.key, lost, waiting, g.view.copy(generation = 99L)).status)
    }

    @Test fun newerFreshSearchReplacesTrackingAndTheSupersededReadCannotOverwriteIt() {
        val f = Fixture()
        val first = f.admit(assertNotNull(FrozenAction.capture(f.search)))
        assertNull(f.correlation.accept(first.key, "first"))
        val firstPending = f.accept(first, f.display)
        f.h.drain()
        // The endpoint supersedes the older read inside the newer admission step.
        val retry = committed(f.search.target.copy(generation = 31))
        val second = f.admit(assertNotNull(FrozenAction.capture(retry)))
        assertEquals(RosterRequestResult.Unknown, f.h.settled().single { it.second == first.key.requestId }.third)
        assertNull(f.correlation.accept(second.key, "second"))
        val secondPending = f.accept(second, firstPending)
        assertEquals(SavedRequestStatus.Requesting, secondPending.status)
        assertEquals(second.key, f.feedback.pending)
        // The older read's Unknown arrives after the newer acceptance: it writes nothing.
        val oldEvent = RosterClientEvent.OperationSettled(first.key.kind, first.key.requestId,
            RosterClientHarness.RUN_ID, RosterRequestResult.Unknown)
        assertFalse(f.feedback.projects(first.key))
        assertEquals(SavedRequestStatus.Requesting, f.finish(first.key, oldEvent, secondPending).status)
        assertEquals(second.key, f.feedback.pending)
        f.h.drain()
        val shown = f.finish(second.key, f.complete(second.key.requestId), secondPending, sequence = second.sequence)
        assertEquals(SavedRequestStatus.Ready, shown.status)
        assertNull(f.feedback.pending)
    }

    @Test fun supersedingUnpresentedReadEndsTrackingOnlyThroughTheTrackedReadsOwnSettlement() {
        val f = Fixture()
        val read = f.admit(assertNotNull(FrozenAction.capture(f.search)))
        assertNull(f.correlation.accept(read.key, "read"))
        val pending = f.accept(read, f.display)
        f.h.drain()
        // An unpresented read (as the post-delete continuation is) supersedes it at the endpoint.
        val other = f.admit(RosterClientHarness.TRUE_PROOF)
        assertNull(f.correlation.accept(other.key, "other"))
        assertSame(pending, f.feedback.accepted(other.key, other.sequence, null, false, f.view, pending))
        assertEquals(read.key, f.feedback.pending)
        assertEquals(1, f.h.frames().count { it is RosterFrame.SavedListRequest && it.requestId == other.key.requestId })
        // The endpoint's own Unknown settlement for the tracked read is emitted inside that
        // admission step, ahead of any owner answer for the newer read: it ends pending.
        val superseded = f.h.events.filterIsInstance<RosterClientEvent.OperationSettled>()
            .single { it.requestId == read.key.requestId }
        assertNotNull(f.correlation.settle(read.key, superseded))
        val ended = f.finish(read.key, superseded, pending)
        assertEquals(SavedRequestStatus.Unknown, ended.status)
        assertNull(f.feedback.pending)
        // The newer read's actual outcome then projects normally.
        assertTrue(f.feedback.projects(other.key))
        f.h.drain()
        assertEquals(SavedRequestStatus.Ready, f.finish(other.key, f.complete(other.key.requestId), ended, sequence = other.sequence).status)
    }

    private companion object {
        fun committed(token: UiActionTargetToken) = MutableUiActionProof(token).also {
            val epoch = it.beginDraw(); it.setCriticalIdentityReadable(true); it.markCommitted(epoch)
        }
        fun settledIn(step: RosterClientStep): RosterClientEvent.OperationSettled =
            step.events.filterIsInstance<RosterClientEvent.OperationSettled>().single()

        /** The controller's existing status projection for one settled LIST/SEARCH. */
        fun project(display: SavedUiState, event: RosterClientEvent.OperationSettled, sequence: Long?): SavedUiState {
            val owner = (event.result as? RosterRequestResult.OwnerResult)?.outcome as? RosterOwnerOutcome.SavedWindow
            val facts = owner?.facts
            if (facts is RosterSavedWindowFacts.Complete) {
                // Adopted only with the exact accepting sequence, as the controller does.
                return if (sequence == null) display.copy(status = SavedRequestStatus.Unknown)
                else display.copy(status = SavedRequestStatus.Ready, catalogId = facts.catalogId, resultId = facts.resultId,
                    requestId = event.requestId, sequence = sequence, total = facts.total, entries = facts.entries)
            }
            return display.copy(status = when (facts) {
                is RosterSavedWindowFacts.Complete -> SavedRequestStatus.Ready
                is RosterSavedWindowFacts.Refused -> SavedRequestStatus.Refused(facts.reason)
                RosterSavedWindowFacts.Unavailable -> SavedRequestStatus.Unavailable
                RosterSavedWindowFacts.Unknown -> SavedRequestStatus.Unknown
                null -> if (event.result is RosterRequestResult.NotSent) SavedRequestStatus.Refused() else SavedRequestStatus.Unknown
            })
        }

        /** Only status and its presentation base differ: proofs, handles and entries are identical. */
        fun assertStatusOnly(before: SavedUiState, after: SavedUiState) {
            assertSame(before.listProof, after.listProof)
            assertSame(before.windowProof, after.windowProof)
            assertSame(before.entryProofs, after.entryProofs)
            assertSame(before.entries, after.entries)
            assertEquals(before.copy(status = after.status, readFeedbackBaseStatus = after.readFeedbackBaseStatus), after)
        }
    }
}
