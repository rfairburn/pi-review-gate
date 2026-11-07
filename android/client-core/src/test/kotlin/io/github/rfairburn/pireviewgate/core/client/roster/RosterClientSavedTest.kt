package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedDeleteFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedResumeFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedWindowOutcome
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterProtocol
import io.github.rfairburn.pireviewgate.core.protocol.roster.SavedDeleteMethod
import io.github.rfairburn.pireviewgate.core.protocol.roster.SavedDeleteRefusalReason
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Saved catalog exchange: exact run and revision matching, complete paged and
 * fragmented window assembly with an honest total and offset, one pending slot with
 * latest-wins reads and never-superseded mutations, the described delete policy as a
 * client-side admission and dispatch guard, bounded window retention with
 * handle validity for reads and entry operations alike, dismissal that invalidates
 * in-flight picker intent, and the separate prepare and confirmed delete calls.
 */
internal class RosterClientSavedTest {

    private fun harness(): RosterClientHarness {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot()
        return harness
    }

    /** A harness whose picker actually fetched a window, with delete exposed by the owner. */
    private fun ownedHarness(entries: List<OwnerSavedEntry> = (0 until 3).map { RosterClientHarness.entry(it) }) =
        harness().also {
            it.exposeDelete()
            it.ownSavedWindow(entries = entries)
        }

    private fun listCommand(
        harness: RosterClientHarness,
        query: String = "",
        offset: Long = 0L,
        count: Long = 32L,
        firstReplyTimeoutMs: Long = DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS,
    ) =
        RosterSavedListCommand(
            RosterClientHarness.RUN_ID,
            query,
            offset,
            count,
            RosterClientHarness.readProof(harness.generation, RosterClientHarness.RUN_ID),
            firstReplyTimeoutMs = firstReplyTimeoutMs,
        )

    private fun searchCommand(
        harness: RosterClientHarness,
        catalogId: String = RosterClientHarness.CATALOG_ID,
        query: String = "needle",
        firstReplyTimeoutMs: Long = DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS,
    ) = RosterSavedSearchCommand(
        RosterClientHarness.RUN_ID,
        catalogId,
        query,
        0L,
        32L,
        RosterClientHarness.readProof(harness.generation, RosterClientHarness.RUN_ID, catalogId, null),
        firstReplyTimeoutMs = firstReplyTimeoutMs,
    )

    private fun windowCommand(
        harness: RosterClientHarness,
        offset: Long = 0L,
        count: Long = 32L,
        catalogId: String = RosterClientHarness.CATALOG_ID,
        resultId: String = RosterClientHarness.RESULT_ID,
        queryRevision: Long = 1L,
    ) = RosterSavedWindowCommand(
        RosterClientHarness.RUN_ID,
        catalogId,
        resultId,
        offset,
        count,
        RosterClientHarness.readProof(
            harness.generation,
            RosterClientHarness.RUN_ID,
            catalogId,
            resultId,
            queryRevision = queryRevision,
        ),
    )

    private fun resumeCommand(
        harness: RosterClientHarness,
        entryId: String = "entry-0",
        catalogId: String = RosterClientHarness.CATALOG_ID,
        resultId: String = RosterClientHarness.RESULT_ID,
        pickerRevision: Long = 1L,
    ) = RosterSavedResumeCommand(
        RosterClientHarness.RUN_ID,
        catalogId,
        resultId,
        entryId,
        RosterClientHarness.entryProof(
            harness.generation,
            RosterClientHarness.RUN_ID,
            catalogId,
            resultId,
            entryId,
            pickerRevision = pickerRevision,
        ),
    )

    private fun deleteCommand(
        harness: RosterClientHarness,
        entryId: String = "entry-0",
        catalogId: String = RosterClientHarness.CATALOG_ID,
        resultId: String = RosterClientHarness.RESULT_ID,
    ) = RosterSavedDeleteCommand(
        RosterClientHarness.RUN_ID,
        catalogId,
        resultId,
        entryId,
        RosterClientHarness.entryProof(
            harness.generation,
            RosterClientHarness.RUN_ID,
            catalogId,
            resultId,
            entryId,
        ),
    )

    private fun savedRequest(harness: RosterClientHarness): RosterFrame = harness.sends.last().frame

    /** Drive one complete window of the currently owned result through this endpoint. */
    private fun completeWindow(
        harness: RosterClientHarness,
        offset: Long,
        entries: List<OwnerSavedEntry>,
        catalogId: String = RosterClientHarness.CATALOG_ID,
        resultId: String = RosterClientHarness.RESULT_ID,
    ) {
        harness.push(harness.endpoint.savedWindow(windowCommand(harness, offset, entries.size.toLong(), catalogId, resultId)))
        harness.drain()
        val requestId = harness.lastRequestOf("saved")
        harness.deliver(
            RosterFrame.SavedWindowBegin(
                requestId, RosterClientHarness.RUN_ID, catalogId, resultId,
                total = 40L, issueCount = 0L, offset = offset, rows = entries.size.toLong(), pageCount = 1L,
            ),
        )
        harness.deliver(RosterFrame.SavedWindowPage(requestId, 0L, entries))
        harness.deliver(RosterFrame.SavedWindowEnd(requestId, rows = entries.size.toLong(), pageCount = 1L))
    }

    private fun lastResult(harness: RosterClientHarness): RosterRequestResult = harness.settled().last().third

    private fun windowBegin(
        harness: RosterClientHarness,
        requestId: String,
        offset: Long = 0L,
        rows: Long,
        pageCount: Long,
        catalogId: String = RosterClientHarness.CATALOG_ID,
        resultId: String = RosterClientHarness.RESULT_ID,
        total: Long = rows,
    ) = RosterFrame.SavedWindowBegin(
        requestId,
        RosterClientHarness.RUN_ID,
        catalogId,
        resultId,
        total = total,
        issueCount = 0L,
        offset = offset,
        rows = rows,
        pageCount = pageCount,
    )

    // ------------------------------------------------------------- admission

    @Test
    fun `a saved request before any observed run is refused as target unavailable`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.push(harness.endpoint.savedList(listCommand(harness)))

        assertEquals(listOf(RosterOperationKind.SAVED_LIST to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
        assertEquals(0, harness.countOfType("saved_list_request"))
    }

    @Test
    fun `a saved request naming another run is never substituted for the observed one`() {
        val harness = harness()
        harness.push(
            harness.endpoint.savedList(
                RosterSavedListCommand(
                    "run-other",
                    "",
                    0L,
                    32L,
                    RosterClientHarness.readProof(harness.generation, "run-other"),
                ),
            ),
        )

        assertEquals(listOf(RosterOperationKind.SAVED_LIST to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
    }

    @Test
    fun `a window size outside the lane bound is refused before anything is encoded`() {
        val harness = harness()
        harness.push(harness.endpoint.savedList(listCommand(harness, count = 0L)))
        harness.push(harness.endpoint.savedList(listCommand(harness, count = harness.bounds.maxSnapshotRows + 1L)))

        assertEquals(
            listOf(
                RosterOperationKind.SAVED_LIST to RosterNotSentReason.INVALID_REQUEST,
                RosterOperationKind.SAVED_LIST to RosterNotSentReason.INVALID_REQUEST,
            ),
            harness.refusals(),
        )
    }

    @Test
    fun `a list carries the channel's shared monotonic attempt number and the exact query`() {
        val harness = harness()
        val query = "  exact query  "
        harness.push(harness.endpoint.savedList(listCommand(harness, query = query)))

        val frame = savedRequest(harness) as RosterFrame.SavedListRequest
        assertEquals(1L, frame.sequence)
        // Never trimmed, normalized, or lowercased.
        assertEquals(query, frame.query)
        assertEquals(RosterClientHarness.RUN_ID, frame.hostRunId)
        val pending = harness.endpoint.state().pending.single { it.kind.isSaved }
        assertEquals(frame.requestId, pending.requestId)
        assertEquals(frame.sequence, pending.sequence)
    }

    @Test
    fun `captured Saved attempts retain their wire sequence through supersession windows and settlement`() {
        val harness = ownedHarness()
        val searchStep = harness.push(harness.endpoint.savedSearch(searchCommand(harness)))
        val search = searchStep.state.pending.single { it.kind.isSaved }
        val searchAtAcceptance = search.copy()
        val searchFrame = savedRequest(harness) as RosterFrame.SavedSearchRequest
        assertEquals(RosterOperationKind.SAVED_SEARCH, search.kind)
        assertEquals(searchFrame.requestId, search.requestId)
        assertEquals(2L, searchFrame.sequence)
        assertEquals(searchFrame.sequence, search.sequence)

        // Exercise the old 15-second first-reply boundary explicitly; the 60-second
        // default has its own checks below.
        val listStep = harness.push(
            harness.endpoint.savedList(
                listCommand(harness, query = "newer", firstReplyTimeoutMs = 15_000L),
            ),
        )
        val list = listStep.state.pending.single { it.kind.isSaved }
        val listAtAcceptance = list.copy()
        val listFrame = savedRequest(harness) as RosterFrame.SavedListRequest
        assertEquals(RosterOperationKind.SAVED_LIST, list.kind)
        assertEquals(listFrame.requestId, list.requestId)
        assertEquals(searchFrame.sequence + 1L, listFrame.sequence)
        assertEquals(listFrame.sequence, list.sequence)
        assertEquals(
            Triple(RosterOperationKind.SAVED_SEARCH, search.requestId, RosterRequestResult.Unknown),
            harness.settled().last(),
        )
        harness.drain()

        harness.advance(1_000L)
        harness.deliver(windowBegin(harness, list.requestId, rows = 1L, pageCount = 1L, total = 2L))
        harness.deliver(RosterFrame.SavedWindowPage(list.requestId, 0L, listOf(RosterClientHarness.entry(0))))
        val staged = harness.endpoint.state().pending.single { it.kind.isSaved }
        assertEquals(list.sequence, staged.sequence)
        assertEquals(1L, staged.stagedWindowEntries)
        assertTrue(staged.deadlineAtMs > list.deadlineAtMs)
        harness.deliver(RosterFrame.SavedWindowEnd(list.requestId, rows = 1L, pageCount = 1L))
        assertTrue(harness.endpoint.state().pending.none { it.kind.isSaved })

        val windowStep = harness.push(harness.endpoint.savedWindow(windowCommand(harness, offset = 1L, count = 1L)))
        val window = windowStep.state.pending.single { it.kind.isSaved }
        val windowAtAcceptance = window.copy()
        val windowFrame = savedRequest(harness) as RosterFrame.SavedWindowRequest
        assertEquals(RosterOperationKind.SAVED_WINDOW, window.kind)
        assertEquals(windowFrame.requestId, window.requestId)
        assertEquals(listFrame.sequence + 1L, windowFrame.sequence)
        assertEquals(windowFrame.sequence, window.sequence)
        harness.deliver(windowBegin(harness, window.requestId, offset = 1L, rows = 1L, pageCount = 1L, total = 2L))
        harness.deliver(RosterFrame.SavedWindowPage(window.requestId, 0L, listOf(RosterClientHarness.entry(1))))
        harness.deliver(RosterFrame.SavedWindowEnd(window.requestId, rows = 1L, pageCount = 1L))
        assertTrue(harness.endpoint.state().pending.none { it.kind.isSaved })

        // Window attempt numbers never replace the picker's query revision or opaque handles.
        val ownership = assertNotNull(harness.endpoint.state().savedOwnership)
        assertEquals(1L, ownership.pickerRevision)
        assertEquals(RosterClientHarness.CATALOG_ID, ownership.catalogId)
        assertEquals(RosterClientHarness.RESULT_ID, ownership.resultId)
        assertEquals(listOf(0L, 1L), ownership.windows.map { it.offset })
        assertTrue(ownership.windows.all { it.pickerRevision == 1L })
        assertEquals(searchAtAcceptance, search)
        assertEquals(listAtAcceptance, list)
        assertEquals(windowAtAcceptance, window)
    }

    // ------------------------------------------------------------- assembly

    @Test
    fun `a complete paged window reports the full total the actual offset and every entry`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness, offset = 0L, count = 40L)))
        val requestId = harness.lastRequestOf("saved")

        harness.deliver(
            RosterFrame.SavedWindowBegin(
                requestId,
                RosterClientHarness.RUN_ID,
                RosterClientHarness.CATALOG_ID,
                RosterClientHarness.RESULT_ID,
                total = 40L,
                issueCount = 3L,
                offset = 0L,
                rows = 40L,
                pageCount = 2L,
            ),
        )
        // Nothing is published from a partial window.
        assertEquals(1, harness.settled().size)
        harness.deliver(
            RosterFrame.SavedWindowPage(requestId, 0L, (0 until 32).map { RosterClientHarness.entry(it) }),
        )
        assertEquals(1, harness.settled().size)
        harness.deliver(
            RosterFrame.SavedWindowPage(requestId, 1L, (32 until 40).map { RosterClientHarness.entry(it) }),
        )
        harness.deliver(RosterFrame.SavedWindowEnd(requestId, rows = 40L, pageCount = 2L))

        val outcome = harness.settled().last().third
        val facts = (outcome as RosterRequestResult.OwnerResult).outcome as RosterOwnerOutcome.SavedWindow
        val window = facts.facts as RosterSavedWindowFacts.Complete
        assertEquals(40L, window.total)
        assertEquals(0L, window.offset)
        assertEquals(3L, window.issueCount)
        assertEquals(40, window.entries.size)
        assertEquals((0 until 40).map { "entry-$it" }, window.entries.map { it.entryId })
        // Display data survives exactly: this side never resolves, clips, or rewrites it.
        val first = window.entries.first()
        assertEquals("/srv/owner/saved/0.jsonl", first.file)
        assertEquals("/srv/owner/saved", first.cwd)
        assertEquals("Saved 0", first.caption)
    }

    @Test
    fun `a later window of the same result states its own offset and never relists`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness, offset = 32L, count = 8L)))
        val requestId = harness.lastRequestOf("saved")

        harness.deliver(
            RosterFrame.SavedWindowBegin(
                requestId,
                RosterClientHarness.RUN_ID,
                RosterClientHarness.CATALOG_ID,
                RosterClientHarness.RESULT_ID,
                total = 40L,
                issueCount = 0L,
                offset = 32L,
                rows = 8L,
                pageCount = 1L,
            ),
        )
        harness.deliver(RosterFrame.SavedWindowPage(requestId, 0L, (32 until 40).map { RosterClientHarness.entry(it) }))
        harness.deliver(RosterFrame.SavedWindowEnd(requestId, rows = 8L, pageCount = 1L))

        val window = ((harness.settled().last().third as RosterRequestResult.OwnerResult).outcome
            as RosterOwnerOutcome.SavedWindow).facts as RosterSavedWindowFacts.Complete
        assertEquals(40L, window.total)
        assertEquals(32L, window.offset)
        assertEquals(8, window.entries.size)
        // Exactly one window request left this endpoint: a window is not a relist.
        assertEquals(1, harness.countOfType("saved_window_request"))
    }

    @Test
    fun `one oversized entry is reassembled from consecutive fragments and nothing else`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness, count = 1L)))
        val requestId = harness.lastRequestOf("saved")
        val canonical = RosterSavedWire.canonicalEntryText(RosterClientHarness.entry(0))
        val cut = canonical.length / 2

        harness.deliver(
            RosterFrame.SavedWindowBegin(
                requestId,
                RosterClientHarness.RUN_ID,
                RosterClientHarness.CATALOG_ID,
                RosterClientHarness.RESULT_ID,
                total = 1L,
                issueCount = 0L,
                offset = 0L,
                rows = 1L,
                pageCount = 2L,
            ),
        )
        harness.deliver(RosterFrame.SavedWindowFragment(requestId, 0L, 0L, 2L, canonical.substring(0, cut)))
        assertEquals(1, harness.settled().size)
        harness.deliver(RosterFrame.SavedWindowFragment(requestId, 1L, 1L, 2L, canonical.substring(cut)))
        harness.deliver(RosterFrame.SavedWindowEnd(requestId, rows = 1L, pageCount = 2L))

        val window = ((harness.settled().last().third as RosterRequestResult.OwnerResult).outcome
            as RosterOwnerOutcome.SavedWindow).facts as RosterSavedWindowFacts.Complete
        assertEquals(1, window.entries.size)
        assertEquals(RosterClientHarness.entry(0), window.entries.single())
    }

    @Test
    fun `a fragment out of order fails closed instead of publishing a corrupt entry`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness, count = 1L)))
        harness.drain()
        val requestId = harness.lastRequestOf("saved")
        val canonical = RosterSavedWire.canonicalEntryText(RosterClientHarness.entry(0))

        harness.deliver(
            RosterFrame.SavedWindowBegin(
                requestId, RosterClientHarness.RUN_ID, RosterClientHarness.CATALOG_ID, RosterClientHarness.RESULT_ID,
                total = 1L, issueCount = 0L, offset = 0L, rows = 1L, pageCount = 2L,
            ),
        )
        harness.deliver(RosterFrame.SavedWindowFragment(requestId, 0L, 1L, 2L, canonical.substring(10)))

        assertEquals(RosterRequestResult.Unknown, harness.settled().last().third)
        assertEquals(1, harness.closeChannelCount)
    }

    @Test
    fun `a window that ends short of what it announced is refused rather than truncated`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness)))
        harness.drain()
        val requestId = harness.lastRequestOf("saved")

        harness.deliver(
            RosterFrame.SavedWindowBegin(
                requestId, RosterClientHarness.RUN_ID, RosterClientHarness.CATALOG_ID, RosterClientHarness.RESULT_ID,
                total = 40L, issueCount = 0L, offset = 0L, rows = 2L, pageCount = 1L,
            ),
        )
        harness.deliver(RosterFrame.SavedWindowPage(requestId, 0L, listOf(RosterClientHarness.entry(0))))
        harness.deliver(RosterFrame.SavedWindowEnd(requestId, rows = 1L, pageCount = 1L))

        assertEquals(RosterRequestResult.Unknown, harness.settled().last().third)
        assertEquals(1, harness.closeChannelCount)
    }

    @Test
    fun `a non-empty remainder can never be presented as an empty window`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness)))
        val requestId = harness.lastRequestOf("saved")

        harness.deliver(
            RosterFrame.SavedWindowBegin(
                requestId, RosterClientHarness.RUN_ID, RosterClientHarness.CATALOG_ID, RosterClientHarness.RESULT_ID,
                total = 40L, issueCount = 0L, offset = 0L, rows = 0L, pageCount = 0L,
            ),
        )

        assertEquals(RosterRequestResult.Unknown, harness.settled().last().third)
    }

    @Test
    fun `a window for a different result than the one this side asked for fails closed`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness)))
        harness.drain()
        val requestId = harness.lastRequestOf("saved")

        harness.deliver(
            RosterFrame.SavedWindowBegin(
                requestId, RosterClientHarness.RUN_ID, RosterClientHarness.CATALOG_ID, "result-forged",
                total = 1L, issueCount = 0L, offset = 0L, rows = 1L, pageCount = 1L,
            ),
        )

        assertEquals(RosterRequestResult.Unknown, harness.settled().last().third)
        assertEquals(1, harness.closeChannelCount)
    }

    // ---------------------------------------------------------- pending slots

    @Test
    fun `a newer read supersedes an older read and the older settles unknown`() {
        val harness = harness()
        harness.push(harness.endpoint.savedList(listCommand(harness, query = "first")))
        val older = harness.lastRequestOf("saved")
        harness.push(harness.endpoint.savedList(listCommand(harness, query = "second")))

        assertEquals(
            Triple(RosterOperationKind.SAVED_LIST, older, RosterRequestResult.Unknown),
            harness.settled().single(),
        )
        assertEquals(2, harness.countOfType("saved_list_request"))
    }

    @Test
    fun `a pending resume is never superseded and a colliding read is refused busy`() {
        val harness = ownedHarness()
        val settledBefore = harness.settled().size
        val listsBefore = harness.countOfType("saved_list_request")
        harness.push(harness.endpoint.savedResume(resumeCommand(harness)))
        harness.push(harness.endpoint.savedList(listCommand(harness)))

        assertEquals(listOf(RosterOperationKind.SAVED_LIST to RosterNotSentReason.BUSY), harness.refusals())
        assertEquals(listsBefore, harness.countOfType("saved_list_request"))
        assertEquals(1, harness.countOfType("saved_resume_request"))
        assertEquals(settledBefore, harness.settled().size)
    }

    @Test
    fun `a resume reports the owner's own facts and creates no local row`() {
        val harness = ownedHarness()
        val step = harness.push(harness.endpoint.savedResume(resumeCommand(harness)))
        val pending = step.state.pending.single { it.kind.isSaved }
        val frame = savedRequest(harness) as RosterFrame.SavedResumeRequest
        val requestId = frame.requestId
        assertEquals(requestId, pending.requestId)
        assertEquals(2L, frame.sequence)
        assertEquals(frame.sequence, pending.sequence)

        harness.deliver(
            RosterFrame.SavedResumeResult(
                requestId,
                OwnerSavedResumeFacts.Started(RosterClientHarness.RUN_ID, "row-resumed"),
            ),
        )

        assertEquals(
            RosterRequestResult.OwnerResult(
                RosterOwnerOutcome.SavedResume(OwnerSavedResumeFacts.Started(RosterClientHarness.RUN_ID, "row-resumed")),
            ),
            lastResult(harness),
        )
        // Awaiting an observed row, never a local fallback or a focus change.
        assertEquals(listOf("row-1", "row-2"), harness.endpoint.state().projection.rows.map { it.id })
    }

    @Test
    fun `a resume whose started fact names another run establishes nothing`() {
        val harness = ownedHarness()
        harness.push(harness.endpoint.savedResume(resumeCommand(harness)))
        val requestId = harness.lastRequestOf("saved")

        harness.deliver(RosterFrame.SavedResumeResult(requestId, OwnerSavedResumeFacts.Started("run-other", "row-x")))

        assertEquals(RosterRequestResult.Unknown, lastResult(harness))
    }

    @Test
    fun `a fixed refusal answer reaches the caller unchanged`() {
        val harness = harness()
        harness.push(harness.endpoint.savedList(listCommand(harness)))
        val requestId = harness.lastRequestOf("saved")

        harness.deliver(RosterFrame.SavedWindowResult(requestId, OwnerSavedWindowOutcome.Refused()))

        assertEquals(
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedWindow(RosterSavedWindowFacts.Refused(null))),
            harness.settled().single().third,
        )
    }

    @Test
    fun `a late reply for a superseded request settles nothing`() {
        val harness = harness()
        harness.push(harness.endpoint.savedList(listCommand(harness, query = "first")))
        val older = harness.lastRequestOf("saved")
        harness.push(harness.endpoint.savedList(listCommand(harness, query = "second")))
        val settledAfterSupersede = harness.settled().size

        harness.deliver(RosterFrame.SavedWindowResult(older, OwnerSavedWindowOutcome.Unknown))

        assertEquals(settledAfterSupersede, harness.settled().size)
    }

    @Test
    fun `an unanswered saved request settles unknown at its deadline and is never retried`() {
        val harness = harness()
        harness.push(harness.endpoint.savedList(listCommand(harness)))
        harness.fireDeadline(RosterDeadlineKind.SAVED_RESULT)

        assertEquals(RosterRequestResult.Unknown, harness.settled().single().third)
        assertEquals(1, harness.countOfType("saved_list_request"))
    }

    @Test
    fun `progressing saved frames extend the patience instead of expiring against the first deadline`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness, count = 2L)))
        harness.drain()
        val requestId = harness.lastRequestOf("saved")
        val firstArm = harness.armed.keys.single {
            it.kind == RosterDeadlineKind.SAVED_RESULT && it.id == requestId
        }
        val firstDue = harness.armed.getValue(firstArm)
        assertEquals(firstDue, harness.pendingSavedDeadline())

        // The first frame arrives inside the original patience and refreshes it.
        harness.advance(1_000L)
        harness.deliver(windowBegin(harness, requestId, rows = 2L, pageCount = 2L))
        val afterBegin = harness.pendingSavedDeadline()
        assertTrue(afterBegin > firstDue, "a progressing transfer must outlive the patience it was first given")
        assertEquals(harness.now + harness.bounds.transferIdleTimeoutMs, afterBegin)
        val secondArm = harness.armed.keys.single {
            it.kind == RosterDeadlineKind.SAVED_RESULT && it.id == requestId
        }
        assertEquals(afterBegin, harness.armed.getValue(secondArm))

        // Now travel past the original deadline, still inside the refreshed idle window.
        harness.advance(harness.bounds.createResultTimeoutMs)
        assertTrue(harness.now > firstDue)
        harness.deliver(RosterFrame.SavedWindowPage(requestId, 0L, listOf(RosterClientHarness.entry(0))))
        assertEquals(1, harness.settled().size)
        assertTrue(harness.pendingSavedDeadline() > harness.now)

        harness.deliver(RosterFrame.SavedWindowPage(requestId, 1L, listOf(RosterClientHarness.entry(1))))
        harness.deliver(RosterFrame.SavedWindowEnd(requestId, rows = 2L, pageCount = 2L))

        val window = ((harness.settled().last().third as RosterRequestResult.OwnerResult).outcome
            as RosterOwnerOutcome.SavedWindow).facts as RosterSavedWindowFacts.Complete
        assertEquals(2, window.entries.size)
    }

    @Test
    fun `default saved list and searches wait sixty seconds instead of the create result bound`() {
        val listHarness = harness()
        val listStart = listHarness.now
        listHarness.push(listHarness.endpoint.savedList(listCommand(listHarness)))
        assertEquals(listStart + DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS, listHarness.pendingSavedDeadline())

        listHarness.advance(listHarness.bounds.createResultTimeoutMs + 1L)
        assertTrue(listHarness.settled().isEmpty(), "the old 15-second create bound must not end a Saved read")

        listHarness.advance(
            DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS - (listHarness.bounds.createResultTimeoutMs + 1L) - 1L,
        )
        assertTrue(listHarness.settled().isEmpty(), "the read is still pending just before its own deadline")
        listHarness.advance(1L)
        listHarness.fireDeadline(RosterDeadlineKind.SAVED_RESULT)
        assertEquals(RosterRequestResult.Unknown, listHarness.settled().single().third)
        assertEquals(1, listHarness.countOfType("saved_list_request"))

        val searchHarness = ownedHarness(entries = listOf(RosterClientHarness.entry(0)))
        val settledBeforeSearch = searchHarness.settled().size
        val searchStart = searchHarness.now
        searchHarness.push(searchHarness.endpoint.savedSearch(searchCommand(searchHarness)))
        assertEquals(searchStart + DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS, searchHarness.pendingSavedDeadline())

        searchHarness.advance(searchHarness.bounds.createResultTimeoutMs + 1L)
        assertEquals(settledBeforeSearch, searchHarness.settled().size)
    }

    @Test
    fun `a custom saved read wait is captured at admission and a later read uses its own`() {
        val harness = harness()
        val firstStart = harness.now
        harness.push(harness.endpoint.savedList(listCommand(harness, query = "first", firstReplyTimeoutMs = 120_000L)))
        assertEquals(firstStart + 120_000L, harness.pendingSavedDeadline())

        harness.advance(DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS)
        assertTrue(harness.settled().isEmpty(), "an admitted read keeps the wait it captured")
        assertEquals(firstStart + 120_000L, harness.pendingSavedDeadline())

        val secondStart = harness.now
        harness.push(harness.endpoint.savedList(listCommand(harness, query = "second", firstReplyTimeoutMs = 1_000L)))
        assertEquals(RosterRequestResult.Unknown, harness.settled().single().third)
        assertEquals(secondStart + 1_000L, harness.pendingSavedDeadline())

        harness.advance(1_001L)
        harness.fireDeadline(RosterDeadlineKind.SAVED_RESULT)
        assertEquals(RosterRequestResult.Unknown, harness.settled().last().third)
        assertEquals(2, harness.countOfType("saved_list_request"))
    }

    @Test
    fun `a nonpositive or unsafe local Saved wait is refused before encoding`() {
        val harness = harness()
        for (invalid in listOf(0L, -1L, Long.MAX_VALUE)) {
            harness.push(harness.endpoint.savedList(listCommand(harness, firstReplyTimeoutMs = invalid)))
        }

        assertEquals(
            List(3) { RosterOperationKind.SAVED_LIST to RosterNotSentReason.INVALID_REQUEST },
            harness.refusals(),
        )
        assertEquals(0, harness.countOfType("saved_list_request"))
        assertTrue(harness.endpoint.state().pending.none { it.kind.isSaved })
    }

    @Test
    fun `saved window and create first replies keep the unchanged fifteen second bound`() {
        val harness = ownedHarness(entries = listOf(RosterClientHarness.entry(0)))
        val windowStart = harness.now
        harness.push(harness.endpoint.savedWindow(windowCommand(harness, count = 1L)))
        assertEquals(windowStart + harness.bounds.createResultTimeoutMs, harness.pendingSavedDeadline())

        val createStart = harness.now
        val workspace = "/srv/owner/work"
        harness.push(
            harness.endpoint.createSession(
                RosterCreateCommand(
                    RosterClientHarness.RUN_ID,
                    workspace,
                    RosterClientHarness.formProof(harness.generation, RosterClientHarness.RUN_ID, workspace),
                ),
            ),
        )
        val create = harness.endpoint.state().pending.single { it.kind == RosterOperationKind.CREATE }
        assertEquals(createStart + harness.bounds.createResultTimeoutMs, create.deadlineAtMs)
    }

    @Test
    fun `saved read patience stays local and never changes wire bytes`() {
        fun encodedList(timeoutMs: Long): ByteArray {
            val harness = harness()
            harness.push(harness.endpoint.savedList(listCommand(harness, firstReplyTimeoutMs = timeoutMs)))
            return RosterProtocol.encode(harness.sends.last().frame, harness.bounds)
        }

        fun encodedSearch(timeoutMs: Long): ByteArray {
            val harness = ownedHarness(entries = listOf(RosterClientHarness.entry(0)))
            harness.push(harness.endpoint.savedSearch(searchCommand(harness, firstReplyTimeoutMs = timeoutMs)))
            return RosterProtocol.encode(harness.sends.last().frame, harness.bounds)
        }

        val defaultBytes = encodedList(DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS)
        val customBytes = encodedList(120_000L)

        assertTrue(
            defaultBytes.contentEquals(customBytes),
            "the local patience must not alter the owner request",
        )
        assertTrue(!defaultBytes.decodeToString().contains("timeout", ignoreCase = true))
        assertTrue(encodedSearch(DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS).contentEquals(encodedSearch(120_000L)))
    }

    // --------------------------------------------------------------- policy

    @Test
    fun `the described policy applies only to the run this side observes`() {
        val harness = harness()
        assertNull(harness.endpoint.state().savedPolicy)

        harness.deliver(RosterFrame.SavedPolicy("run-other", deleteExposed = true))
        assertNull(harness.endpoint.state().savedPolicy)

        harness.deliver(RosterFrame.SavedPolicy(RosterClientHarness.RUN_ID, deleteExposed = false))
        assertEquals(RosterSavedPolicy(RosterClientHarness.RUN_ID, false), harness.endpoint.state().savedPolicy)
    }

    @Test
    fun `the policy description returns to unknown when the subscription ends`() {
        val harness = harness()
        harness.deliver(RosterFrame.SavedPolicy(RosterClientHarness.RUN_ID, deleteExposed = true))
        assertNotNull(harness.endpoint.state().savedPolicy)

        harness.push(harness.endpoint.resync())

        assertNull(harness.endpoint.state().savedPolicy)
        assertTrue(harness.events.contains(RosterClientEvent.SavedPolicyChanged(null)))
    }

    @Test
    fun `a delete with an unknown policy is refused before anything is sent`() {
        val harness = harness()
        harness.ownSavedWindow()

        harness.push(harness.endpoint.savedDeletePrepare(deleteCommand(harness)))
        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))

        assertEquals(
            listOf(
                RosterOperationKind.SAVED_DELETE to RosterNotSentReason.POLICY_UNAVAILABLE,
                RosterOperationKind.SAVED_DELETE to RosterNotSentReason.POLICY_UNAVAILABLE,
            ),
            harness.refusals(),
        )
        assertEquals(0, harness.countOfType("saved_delete_request"))
    }

    @Test
    fun `a delete while the owner describes exposure Off is refused`() {
        val harness = harness()
        harness.exposeDelete(exposed = false)
        harness.ownSavedWindow()

        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))

        assertEquals(listOf(RosterOperationKind.SAVED_DELETE to RosterNotSentReason.POLICY_UNAVAILABLE), harness.refusals())
        assertEquals(0, harness.countOfType("saved_delete_request"))
    }

    @Test
    fun `exposure that turns Off before dispatch blocks the queued write and settles not-sent`() {
        val harness = ownedHarness()
        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))
        val index = harness.sends.lastIndex
        assertEquals(1, harness.countOfType("saved_delete_request"))
        assertEquals(RosterDispatchDecision.Allow, harness.decide(index))

        harness.exposeDelete(exposed = false)

        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.POLICY_UNAVAILABLE), harness.decide(index))
        harness.report(index, RosterSendDisposition.NotDispatched(RosterSendRefusal.POLICY_UNAVAILABLE))
        assertEquals(RosterRequestResult.NotSent(RosterNotSentReason.POLICY_UNAVAILABLE), lastResult(harness))
    }

    @Test
    fun `exposure returning after a refused attempt never revives that attempt`() {
        val harness = harness()
        harness.exposeDelete(exposed = false)
        harness.ownSavedWindow()
        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))
        val sendsAfterRefusal = harness.sends.size

        harness.exposeDelete(exposed = true)

        assertEquals(sendsAfterRefusal, harness.sends.size)
        assertEquals(emptyList(), harness.endpoint.state().pending.filter { it.kind.isSaved })
        assertEquals(0, harness.countOfType("saved_delete_request"))
    }

    @Test
    fun `a proof that revokes delete exposure and still returns true is never allowed through`() {
        val harness = ownedHarness()
        var calls = 0
        val proof = RosterClientHarness
            .entryProof(harness.generation, RosterClientHarness.RUN_ID, RosterClientHarness.CATALOG_ID, RosterClientHarness.RESULT_ID, "entry-0")
            .copy(
                ui = RosterUiProof {
                    calls += 1
                    // Reentrant: a caller fence can re-enter this endpoint before answering.
                    if (calls > 1) harness.exposeDelete(exposed = false)
                    true
                },
            )
        harness.push(
            harness.endpoint.savedDeleteConfirmed(
                deleteCommand(harness).copy(proof = proof),
                RosterClientHarness.TRUE_PROOF,
            ),
        )
        val index = harness.sends.indexOfLast { it.frame.type == "saved_delete_request" }
        assertEquals(1, harness.countOfType("saved_delete_request"))

        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.POLICY_UNAVAILABLE), harness.decide(index))
    }

    // ------------------------------------------------------ handle ownership

    @Test
    fun `an entry handle this picker never fetched is never admissible`() {
        val harness = harness()
        harness.exposeDelete()

        harness.push(harness.endpoint.savedResume(resumeCommand(harness, entryId = "entry-forged")))

        assertEquals(listOf(RosterOperationKind.SAVED_RESUME to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
        assertEquals(0, harness.countOfType("saved_resume_request"))
    }

    @Test
    fun `a window naming a catalog this picker never listed is refused`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))

        harness.push(
            harness.endpoint.savedWindow(
                windowCommand(harness, catalogId = "catalog-forged", resultId = "result-forged"),
            ),
        )

        assertEquals(listOf(RosterOperationKind.SAVED_WINDOW to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
        assertEquals(0, harness.countOfType("saved_window_request"))
    }

    @Test
    fun `a window for a result a newer list replaced is refused`() {
        val harness = harness()
        harness.ownSavedWindow(resultId = "result-1", entries = listOf(RosterClientHarness.entry(0)))
        harness.ownSavedWindow(resultId = "result-2", entries = listOf(RosterClientHarness.entry(10)))

        harness.push(harness.endpoint.savedWindow(windowCommand(harness, resultId = "result-1")))

        assertEquals(listOf(RosterOperationKind.SAVED_WINDOW to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
        assertEquals(0, harness.countOfType("saved_window_request"))
    }

    @Test
    fun `a window fetched for another picker revision is refused`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))

        harness.push(harness.endpoint.savedWindow(windowCommand(harness, queryRevision = 2L)))

        assertEquals(listOf(RosterOperationKind.SAVED_WINDOW to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
        assertEquals(0, harness.countOfType("saved_window_request"))
    }

    @Test
    fun `a search narrows only a catalog this picker holds`() {
        val harness = harness()
        harness.push(harness.endpoint.savedSearch(searchCommand(harness, catalogId = "catalog-forged")))

        assertEquals(listOf(RosterOperationKind.SAVED_SEARCH to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
        assertEquals(0, harness.countOfType("saved_search_request"))

        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedSearch(searchCommand(harness)))

        assertEquals(1, harness.countOfType("saved_search_request"))
    }

    @Test
    fun `a fourth window evicts the oldest and its handles stop being admissible`() {
        val harness = harness()
        // The list is the first window, and it establishes the catalog and result.
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        completeWindow(harness, offset = 8L, entries = listOf(RosterClientHarness.entry(8)))
        completeWindow(harness, offset = 16L, entries = listOf(RosterClientHarness.entry(16)))
        assertEquals(RosterSavedOwnership.MAX_RETAINED_SAVED_WINDOWS, harness.endpoint.state().savedOwnership?.windows?.size)

        completeWindow(harness, offset = 24L, entries = listOf(RosterClientHarness.entry(24)))

        val ownership = requireNotNull(harness.endpoint.state().savedOwnership)
        assertEquals(RosterSavedOwnership.MAX_RETAINED_SAVED_WINDOWS, ownership.windows.size)
        assertEquals(listOf(8L, 16L, 24L), ownership.windows.map { it.offset })

        harness.push(harness.endpoint.savedResume(resumeCommand(harness, entryId = "entry-0")))
        assertEquals(listOf(RosterOperationKind.SAVED_RESUME to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())

        harness.push(harness.endpoint.savedResume(resumeCommand(harness, entryId = "entry-24")))
        assertEquals(1, harness.countOfType("saved_resume_request"))
    }

    @Test
    fun `a fresh list replaces the catalog and obsoletes the previous handles`() {
        val harness = harness()
        harness.ownSavedWindow(
            catalogId = "catalog-1",
            resultId = "result-1",
            entries = listOf(RosterClientHarness.entry(0)),
        )
        harness.ownSavedWindow(
            catalogId = "catalog-2",
            resultId = "result-2",
            entries = listOf(RosterClientHarness.entry(10)),
        )

        val ownership = requireNotNull(harness.endpoint.state().savedOwnership)
        assertEquals("catalog-2", ownership.catalogId)
        assertEquals("result-2", ownership.resultId)
        assertEquals(1, ownership.windows.size)

        harness.push(
            harness.endpoint.savedResume(
                resumeCommand(harness, entryId = "entry-0", catalogId = "catalog-1", resultId = "result-1"),
            ),
        )
        assertEquals(listOf(RosterOperationKind.SAVED_RESUME to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())

        harness.push(
            harness.endpoint.savedResume(
                resumeCommand(harness, entryId = "entry-10", catalogId = "catalog-2", resultId = "result-2"),
            ),
        )
        assertEquals(1, harness.countOfType("saved_resume_request"))
    }

    @Test
    fun `handles from a dismissed picker are never admissible again`() {
        val harness = harness()
        harness.ownSavedWindow()
        assertNotNull(harness.endpoint.state().savedOwnership)

        harness.push(harness.endpoint.dismissSavedPicker())
        assertNull(harness.endpoint.state().savedOwnership)

        harness.push(harness.endpoint.savedResume(resumeCommand(harness)))
        assertEquals(listOf(RosterOperationKind.SAVED_RESUME to RosterNotSentReason.TARGET_UNAVAILABLE), harness.refusals())
    }

    @Test
    fun `dismissal before the first reply stops that read from publishing or installing ownership`() {
        val harness = harness()
        harness.push(harness.endpoint.savedList(listCommand(harness)))
        val requestId = harness.lastRequestOf("saved")

        harness.push(harness.endpoint.dismissSavedPicker())

        assertNull(harness.endpoint.state().savedOwnership)
        harness.deliver(windowBegin(harness, requestId, rows = 1L, pageCount = 1L))

        assertEquals(RosterRequestResult.Unknown, harness.settled().single().third)
        assertNull(harness.endpoint.state().savedOwnership)

        // The rest of that transfer can neither publish nor re-install ownership.
        harness.deliver(RosterFrame.SavedWindowPage(requestId, 0L, listOf(RosterClientHarness.entry(0))))
        harness.deliver(RosterFrame.SavedWindowEnd(requestId, rows = 1L, pageCount = 1L))
        assertEquals(1, harness.settled().size)
        assertNull(harness.endpoint.state().savedOwnership)
    }

    @Test
    fun `dismissal during pagination settles that read unknown and keeps ownership cleared`() {
        val harness = harness()
        harness.ownSavedWindow(entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness, offset = 8L, count = 1L)))
        harness.drain()
        val requestId = harness.lastRequestOf("saved")
        harness.deliver(windowBegin(harness, requestId, offset = 8L, rows = 1L, pageCount = 1L, total = 40L))
        assertNotNull(harness.endpoint.state().savedOwnership)

        harness.push(harness.endpoint.dismissSavedPicker())

        assertNull(harness.endpoint.state().savedOwnership)
        harness.deliver(RosterFrame.SavedWindowPage(requestId, 0L, listOf(RosterClientHarness.entry(8))))
        harness.deliver(RosterFrame.SavedWindowEnd(requestId, rows = 1L, pageCount = 1L))

        assertEquals(RosterRequestResult.Unknown, harness.settled().last().third)
        assertNull(harness.endpoint.state().savedOwnership)
    }

    @Test
    fun `a queued confirmed delete is refused at dispatch after dismissal and never revives`() {
        val harness = ownedHarness()
        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))
        val index = harness.sends.lastIndex
        assertEquals(RosterDispatchDecision.Allow, harness.decide(index))

        harness.push(harness.endpoint.dismissSavedPicker())

        assertEquals(RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE), harness.decide(index))
        harness.report(index, RosterSendDisposition.NotDispatched(RosterSendRefusal.PROOF_UNAVAILABLE))
        assertEquals(RosterRequestResult.NotSent(RosterNotSentReason.TARGET_UNAVAILABLE), lastResult(harness))
    }

    @Test
    fun `a delete already handed to the transport keeps its owner outcome after dismissal`() {
        val harness = ownedHarness()
        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))
        harness.reportLast(RosterSendDisposition.Completed)
        val requestId = harness.lastRequestOf("saved")

        harness.push(harness.endpoint.dismissSavedPicker())

        // Accepted owner work is never claimed cancelled: its correlated answer still
        // settles the operation honestly.
        harness.deliver(RosterFrame.SavedDeleteResult(requestId, OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)))

        assertEquals(
            RosterRequestResult.OwnerResult(
                RosterOwnerOutcome.SavedDelete(OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)),
            ),
            lastResult(harness),
        )
    }

    @Test
    fun `a late window reply for a replaced result never installs ownership`() {
        val harness = harness()
        harness.ownSavedWindow(resultId = "result-1", entries = listOf(RosterClientHarness.entry(0)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness, resultId = "result-1", count = 1L)))
        val staleRequestId = harness.lastRequestOf("saved")

        // A newer read takes the picker somewhere else, and that result becomes owned.
        harness.ownSavedWindow(
            catalogId = "catalog-2",
            resultId = "result-2",
            entries = listOf(RosterClientHarness.entry(10)),
        )

        harness.deliver(
            RosterFrame.SavedWindowBegin(
                staleRequestId, RosterClientHarness.RUN_ID, RosterClientHarness.CATALOG_ID, RosterClientHarness.RESULT_ID,
                total = 40L, issueCount = 0L, offset = 0L, rows = 1L, pageCount = 1L,
            ),
        )
        harness.deliver(RosterFrame.SavedWindowPage(staleRequestId, 0L, listOf(RosterClientHarness.entry(0))))
        harness.deliver(RosterFrame.SavedWindowEnd(staleRequestId, rows = 1L, pageCount = 1L))

        val ownership = requireNotNull(harness.endpoint.state().savedOwnership)
        assertEquals("result-2", ownership.resultId)
        assertEquals(listOf("entry-10"), ownership.windows.flatMap { it.entryIds })
    }

    @Test
    fun `ownership ends with the subscription rather than surviving as offline history`() {
        val harness = harness()
        harness.ownSavedWindow()
        assertNotNull(harness.endpoint.state().savedOwnership)

        harness.push(harness.endpoint.resync())

        assertNull(harness.endpoint.state().savedOwnership)
    }

    // ------------------------------------------------------------- deletion

    @Test
    fun `prepare and confirmed delete are separate calls with separate frames`() {
        val harness = ownedHarness()
        val prepareStep = harness.push(harness.endpoint.savedDeletePrepare(deleteCommand(harness)))
        val preparePending = prepareStep.state.pending.single { it.kind.isSaved }
        val prepare = harness.sends.last().frame as RosterFrame.SavedDeleteRequest
        assertEquals(false, prepare.confirmed)
        assertEquals(prepare.requestId, preparePending.requestId)
        assertEquals(2L, prepare.sequence)
        assertEquals(prepare.sequence, preparePending.sequence)

        harness.deliver(RosterFrame.SavedDeleteResult(prepare.requestId, OwnerSavedDeleteFacts.ConfirmationRequired))
        assertEquals(
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedDelete(OwnerSavedDeleteFacts.ConfirmationRequired)),
            lastResult(harness),
        )
        // Nothing was removed here and nothing was re-sent automatically.
        assertEquals(1, harness.countOfType("saved_delete_request"))

        val confirmedStep = harness.push(
            harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF),
        )
        val confirmedPending = confirmedStep.state.pending.single { it.kind.isSaved }
        val confirmed = harness.sends.last().frame as RosterFrame.SavedDeleteRequest
        assertEquals(true, confirmed.confirmed)
        assertEquals(prepare.entryId, confirmed.entryId)
        assertEquals(confirmed.requestId, confirmedPending.requestId)
        assertEquals(prepare.sequence + 1L, confirmed.sequence)
        assertEquals(confirmed.sequence, confirmedPending.sequence)
        assertEquals(prepare.sequence, preparePending.sequence)
    }

    @Test
    fun `a written confirmation is spent once and cannot be re-armed`() {
        val harness = ownedHarness()
        val confirmation = RosterUiProof { true }
        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), confirmation))
        assertEquals(1, harness.countOfType("saved_delete_request"))

        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), confirmation))

        assertEquals(listOf(RosterOperationKind.SAVED_DELETE to RosterNotSentReason.INVALID_REQUEST), harness.refusals())
        assertEquals(1, harness.countOfType("saved_delete_request"))
    }

    @Test
    fun `a confirmed delete whose picker moved is never submitted`() {
        val harness = ownedHarness()
        harness.push(
            harness.endpoint.savedDeleteConfirmed(
                deleteCommand(harness),
                RosterClientHarness.FALSE_PROOF,
            ),
        )

        assertEquals(
            listOf(RosterOperationKind.SAVED_DELETE to RosterNotSentReason.TARGET_UNAVAILABLE),
            harness.refusals(),
        )
        assertEquals(0, harness.countOfType("saved_delete_request"))
    }

    @Test
    fun `exact confirmed Deleted retires all obsolete handles before publishing settlement`() {
        val harness = ownedHarness()
        val step = harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))
        val pending = step.state.pending.single { it.kind.isSaved }
        assertEquals(true, pending.savedDeleteConfirmed)
        assertEquals(1L, pending.savedPickerRevision)
        harness.drain()
        val settled = harness.deliver(RosterFrame.SavedDeleteResult(pending.requestId,
            OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)))
        assertNull(settled.state.savedOwnership)
        assertTrue(settled.events.any { it is RosterClientEvent.OperationSettled && it.requestId == pending.requestId })
        harness.push(harness.endpoint.savedSearch(searchCommand(harness)))
        harness.push(harness.endpoint.savedWindow(windowCommand(harness)))
        harness.push(harness.endpoint.savedResume(resumeCommand(harness)))
        harness.push(harness.endpoint.savedDeletePrepare(deleteCommand(harness)))
        assertEquals(4, harness.refusals().count { it.second == RosterNotSentReason.TARGET_UNAVAILABLE })
        assertEquals(0, harness.countOfType("saved_search_request"))
        assertEquals(0, harness.countOfType("saved_window_request"))
        assertEquals(0, harness.countOfType("saved_resume_request"))
        assertEquals(1, harness.countOfType("saved_delete_request"))
    }

    @Test
    fun `prepare Deleted and non-success confirmed outcomes never retire ownership`() {
        val outcomes = listOf(OwnerSavedDeleteFacts.ConfirmationRequired, OwnerSavedDeleteFacts.Unknown,
            OwnerSavedDeleteFacts.Unconfirmed,
            OwnerSavedDeleteFacts.Refused(SavedDeleteRefusalReason.STALE))
        for (outcome in outcomes) {
            val harness = ownedHarness()
            val owned = harness.endpoint.state().savedOwnership
            harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))
            harness.deliver(RosterFrame.SavedDeleteResult(harness.lastRequestOf("saved"), outcome))
            assertEquals(owned, harness.endpoint.state().savedOwnership)
            assertEquals(RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedDelete(outcome)), lastResult(harness))
        }
        val harness = ownedHarness()
        val owned = harness.endpoint.state().savedOwnership
        val prepare = harness.push(harness.endpoint.savedDeletePrepare(deleteCommand(harness))).state.pending.single { it.kind.isSaved }
        assertEquals(false, prepare.savedDeleteConfirmed)
        harness.deliver(RosterFrame.SavedDeleteResult(prepare.requestId, OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)))
        assertEquals(owned, harness.endpoint.state().savedOwnership)
    }

    @Test
    fun `foreign and duplicate Deleted never clear a replacement picker`() {
        val harness = ownedHarness()
        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))
        val request = harness.lastRequestOf("saved")
        val old = harness.endpoint.state().savedOwnership
        harness.deliver(RosterFrame.SavedDeleteResult("foreign-request", OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)))
        assertEquals(old, harness.endpoint.state().savedOwnership)
        harness.deliver(RosterFrame.SavedDeleteResult(request, OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)))
        harness.ownSavedWindow(catalogId = "replacement", resultId = "replacement-result", queryRevision = 29)
        val replacement = harness.endpoint.state().savedOwnership
        harness.deliver(RosterFrame.SavedDeleteResult(request, OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)))
        assertEquals(replacement, harness.endpoint.state().savedOwnership)
    }

    @Test
    fun `delayed scoped dismissal cannot clear a new result or its pending read`() {
        val harness = ownedHarness()
        val old = RosterSavedPickerScope(harness.generation, harness.endpoint.state().savedOwnership, null)
        // Even structurally equal owner handles came from a NEW completed read.
        harness.ownSavedWindow()
        val replacement = harness.endpoint.state().savedOwnership
        assertEquals(old.ownership, replacement)
        assertTrue(old.ownership !== replacement)
        harness.push(harness.endpoint.savedList(listCommand(harness)))
        harness.push(harness.endpoint.dismissSavedPicker(old))
        assertEquals(replacement, harness.endpoint.state().savedOwnership)
        assertEquals(RosterDispatchDecision.Allow, harness.decide(harness.sends.lastIndex))
    }

    @Test
    fun `a canceled automatic List cannot retain ownership during or just after transfer`() {
        for (cancelAfterEnd in listOf(false, true)) {
            val harness = harness()
            var live = true
            harness.push(harness.endpoint.savedList(listCommand(harness).copy(resultLifetime = RosterUiProof { live })))
            val request = harness.lastRequestOf("saved")
            harness.deliver(RosterFrame.SavedWindowBegin(request, RosterClientHarness.RUN_ID,
                RosterClientHarness.CATALOG_ID, RosterClientHarness.RESULT_ID, 1, 0, 0, 1, 1))
            harness.deliver(RosterFrame.SavedWindowPage(request, 0, listOf(RosterClientHarness.entry(0))))
            if (!cancelAfterEnd) live = false
            harness.deliver(RosterFrame.SavedWindowEnd(request, 1, 1))
            live = false
            assertNull(harness.endpoint.state().savedOwnership)
            harness.push(harness.endpoint.savedResume(resumeCommand(harness)))
            assertEquals(RosterNotSentReason.TARGET_UNAVAILABLE, harness.refusals().last().second)
        }
    }

    @Test
    fun `a delete result names only the owner's own removal method`() {
        val harness = ownedHarness()
        harness.push(harness.endpoint.savedDeleteConfirmed(deleteCommand(harness), RosterClientHarness.TRUE_PROOF))
        val requestId = harness.lastRequestOf("saved")

        harness.deliver(RosterFrame.SavedDeleteResult(requestId, OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)))

        assertEquals(
            RosterRequestResult.OwnerResult(
                RosterOwnerOutcome.SavedDelete(OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)),
            ),
            lastResult(harness),
        )
    }
}
