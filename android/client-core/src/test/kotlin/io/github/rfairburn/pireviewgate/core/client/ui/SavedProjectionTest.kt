package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry
import io.github.rfairburn.pireviewgate.core.protocol.roster.SavedDeleteRefusalReason
import io.github.rfairburn.pireviewgate.core.protocol.roster.SavedWindowRefusalReason
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Saved browsing keeps to the owner's own opaque handles and its own stated totals.
 *
 * The tests here pin the two things a browser can get wrong: claiming a list is
 * complete when the owner never said how long it is, and treating a displayed path
 * as something this client may act on.
 */
class SavedProjectionTest {

    private val hostId = HostId.parse("a")

    private fun entry(index: Int, caption: String = "caption-$index") = OwnerSavedEntry(
        entryId = "entry-$index",
        sessionId = "session-$index",
        file = "/owner/notes/thing-$index.md",
        caption = caption,
        cwd = "/owner/project",
    )

    private fun state(
        total: Long?,
        offset: Long,
        entries: List<OwnerSavedEntry>,
        status: SavedRequestStatus = SavedRequestStatus.Ready,
    ) = SavedUiState(
        selectedHostId = hostId,
        status = status,
        hostRunId = ClientUiFixtures.RUN_A,
        catalogId = "cat-1",
        resultId = "res-1",
        requestId = "req-1",
        sequence = 2L,
        total = total,
        issueCount = 0L,
        offset = offset,
        entries = entries,
        transferComplete = true,
    )

    @Test
    fun `an unstated total leaves whether-more-exists unknown`() {
        val first = state(total = null, offset = 0L, entries = listOf(entry(0)))
        assertNull(first.hasMore)
        assertEquals(SavedMoreDecision.UNKNOWN_TOTAL, first.moreDecision())
    }

    @Test
    fun `a stated total drives hasMore from the actual offset`() {
        val partial = state(total = 10L, offset = 0L, entries = (0 until 4).map { entry(it) })
        assertEquals(true, partial.hasMore)
        assertEquals(4L, partial.shownThrough)
        assertEquals(SavedMoreDecision.MAY_REQUEST, partial.moreDecision())

        val later = partial.copy(offset = 6L, entries = (6 until 10).map { entry(it) })
        assertEquals(false, later.hasMore)
        assertEquals(10L, later.shownThrough)
        assertEquals(SavedMoreDecision.NOTHING_MORE, later.moreDecision())
    }

    @Test
    fun `an in-flight request blocks another window instead of queueing one`() {
        val inFlight = state(total = 10L, offset = 0L, entries = listOf(entry(0)), status = SavedRequestStatus.Requesting)
        assertEquals(SavedMoreDecision.REQUEST_IN_FLIGHT, inFlight.moreDecision())
    }

    @Test
    fun `a refusal keeps the owner's fixed reason, including no reason at all`() {
        val reasoned = SavedUiState(status = SavedRequestStatus.Refused(SavedWindowRefusalReason.RANGE))
        val bare = SavedUiState(status = SavedRequestStatus.Refused())
        assertEquals(SavedWindowRefusalReason.RANGE, assertNotNull(reasoned.status as? SavedRequestStatus.Refused).reason)
        assertNull(assertNotNull(bare.status as? SavedRequestStatus.Refused).reason)
    }

    @Test
    fun `an entry can only be addressed when every owner handle is present`() {
        val complete = state(total = 1L, offset = 0L, entries = listOf(entry(0)))
        val target = SavedEntryTarget.of(complete, entry(0))
        assertNotNull(target)
        assertEquals("entry-0", target.entryId)
        assertEquals("caption-0", target.caption)
        assertEquals(ClientUiFixtures.RUN_A, target.hostRunId)
        assertEquals("res-1", target.resultId)

        assertTrue(complete.canAddressOwnerResult)
        assertNull(SavedEntryTarget.of(complete.copy(resultId = null), entry(0)))
        assertNull(SavedEntryTarget.of(complete.copy(selectedHostId = null), entry(0)))
        assertNull(SavedEntryTarget.of(complete.copy(catalogId = null), entry(0)))
        assertNull(SavedEntryTarget.of(complete.copy(hostRunId = null), entry(0)))
    }

    @Test
    fun `a frozen delete target keeps the caption that was on screen`() {
        val drawn = SavedEntryTarget(
            hostId = hostId,
            hostRunId = ClientUiFixtures.RUN_A,
            catalogId = "cat-1",
            resultId = "res-1",
            entryId = "entry-0",
            caption = "what the operator read",
        )
        val dialog = SavedDeleteDialog(target = drawn, proof = ClientUiFixtures.FakeProof(ClientUiFixtures.token(UiProofScreen.SAVED_DELETE)))
        assertEquals("what the operator read", dialog.target.caption)
        assertEquals("entry-0", dialog.target.entryId)
    }

    @Test
    fun `a prepare that removes nothing is distinguishable from a refusal`() {
        val target = SavedEntryTarget(
            hostId = hostId,
            hostRunId = ClientUiFixtures.RUN_A,
            catalogId = "cat-1",
            resultId = "res-1",
            entryId = "entry-0",
            caption = "c",
        )
        val confirmation = SavedDeletePreparation(target, SavedDeletePreparationStatus.ConfirmationRequired)
        val refused = SavedDeletePreparation(target, SavedDeletePreparationStatus.Refused(SavedDeleteRefusalReason.ACTIVE))
        assertEquals(SavedDeletePreparationStatus.ConfirmationRequired, confirmation.status)
        assertEquals(SavedDeleteRefusalReason.ACTIVE, (refused.status as SavedDeletePreparationStatus.Refused).reason)
    }

    @Test
    fun `the empty saved view asks for nothing and addresses nothing`() {
        val empty = SavedUiState.EMPTY
        assertNull(empty.selectedHostId)
        assertEquals(SavedRequestStatus.Idle, empty.status)
        assertEquals(0L, empty.offset)
        assertTrue(empty.entries.isEmpty())
        assertFalse(empty.canAddressOwnerResult)
        assertNull(empty.hasMore)
    }

    // -- a window request carries the exact result it was drawn for --------------

    @Test
    fun `a frozen result target carries every handle the drawn window belonged to`() {
        val drawn = state(total = 10L, offset = 0L, entries = listOf(entry(0)))
        val target = SavedResultTarget.of(drawn)
        assertNotNull(target)
        assertEquals(hostId, target.hostId)
        assertEquals(ClientUiFixtures.RUN_A, target.hostRunId)
        assertEquals("cat-1", target.catalogId)
        assertEquals("res-1", target.resultId)
        assertEquals("req-1", target.requestId)
        assertEquals(2L, target.sequence)
    }

    @Test
    fun `a result replaced by a newer transfer is a different target`() {
        val drawn = state(total = 10L, offset = 0L, entries = listOf(entry(0)))
        val replaced = drawn.copy(resultId = "res-2", requestId = "req-9", sequence = 5L)
        val stale = SavedResultTarget.of(drawn)
        val live = SavedResultTarget.of(replaced)
        assertNotNull(stale)
        assertNotNull(live)
        // Same host, same catalog, same selection: only the frozen handles tell the two
        // apart, which is what lets the owner refuse a window request for a result it
        // already replaced instead of following the newest one.
        assertFalse(stale == live)
        assertEquals(stale.hostId, live.hostId)
        assertEquals(stale.catalogId, live.catalogId)
    }

    @Test
    fun `a result the view cannot fully address yields no target and no request`() {
        val partial = state(total = 10L, offset = 0L, entries = listOf(entry(0))).copy(resultId = null)
        assertNull(SavedResultTarget.of(partial))
        assertFalse(partial.canAddressOwnerResult)
    }

    @Test
    fun `an entry target is frozen from the same result the window was drawn for`() {
        val drawn = state(total = 10L, offset = 0L, entries = listOf(entry(0), entry(1)))
        val target = SavedEntryTarget.of(drawn, entry(1))
        assertNotNull(target)
        assertEquals("entry-1", target.entryId)
        assertEquals("res-1", target.resultId)
        assertEquals("caption-1", target.caption)
        // The caption is display text frozen at draw time; the handles are the authority.
        val renamed = drawn.copy(entries = listOf(entry(0), entry(1, caption = "moved caption")))
        assertEquals("caption-1", target.caption)
        assertEquals("moved caption", renamed.entries[1].caption)
    }

    // -- per-entry proofs are keyed by owner handles -----------------------------

    @Test
    fun `entry proofs are looked up by owner handles and default to none`() {
        val drawn = state(total = 10L, offset = 0L, entries = listOf(entry(0)))
        val target = assertNotNull(SavedEntryTarget.of(drawn, entry(0)))
        val key = SavedEntryKey.of(target)
        assertEquals(ClientUiFixtures.RUN_A, key.hostRunId)
        assertEquals("cat-1", key.catalogId)
        assertEquals("res-1", key.resultId)
        assertEquals("entry-0", key.entryId)

        assertEquals(SavedEntryControlProofs(), drawn.proofsFor(key))

        val proofs = drawn.copy(
            entryProofs = mapOf(
                key to SavedEntryControlProofs(
                    resume = MutableUiActionProof(ClientUiFixtures.token(UiProofScreen.SAVED_DELETE)),
                ),
            ),
        )
        assertNotNull(proofs.proofsFor(key).resume)
        assertNull(proofs.proofsFor(key).deletePrepare)
    }

    @Test
    fun `a proof minted for one result is not handed to the same entry id under another`() {
        val first = state(total = 10L, offset = 0L, entries = listOf(entry(0)))
        val key = SavedEntryKey(ClientUiFixtures.RUN_A, "cat-1", "res-1", "entry-0")
        val proofs = first.copy(
            entryProofs = mapOf(
                key to SavedEntryControlProofs(
                    resume = MutableUiActionProof(ClientUiFixtures.token(UiProofScreen.SAVED_DELETE)),
                ),
            ),
        )
        assertNotNull(proofs.proofsFor(key).resume)
        // A newer transfer reuses the entry id under a new result: no standing carries
        // over, so the control is inert until a proof for the new result is minted.
        val newerKey = SavedEntryKey(ClientUiFixtures.RUN_A, "cat-1", "res-2", "entry-0")
        assertNull(proofs.proofsFor(newerKey).resume)
    }

    // -- eligibility is stated, never inferred -----------------------------------

    @Test
    fun `saved browsing requires a live connection and a positively acknowledged capability`() {
        val acknowledged = ClientUiFixtures.hostState(
            "a",
            capabilities = HostCapabilities(saved = CapabilityStatus.SUPPORTED, create = CapabilityStatus.SUPPORTED),
        )
        assertTrue(acknowledged.canBrowseSaved)
        assertTrue(acknowledged.canCreateSession)

        val unknown = ClientUiFixtures.hostState("a")
        assertFalse(unknown.canBrowseSaved)
        assertFalse(unknown.canCreateSession)

        val unsupported = ClientUiFixtures.hostState(
            "a",
            capabilities = HostCapabilities(saved = CapabilityStatus.UNSUPPORTED, create = CapabilityStatus.UNSUPPORTED),
        )
        assertFalse(unsupported.canBrowseSaved)
        assertFalse(unsupported.canCreateSession)

        val capableButOffline = ClientUiFixtures.hostState(
            "a",
            connection = HostConnectionState.DISCONNECTED,
            capabilities = HostCapabilities(saved = CapabilityStatus.SUPPORTED, create = CapabilityStatus.SUPPORTED),
        )
        assertFalse(capableButOffline.canBrowseSaved)
        assertFalse(capableButOffline.canCreateSession)
    }

    @Test
    fun `saved delete exposure needs the owner to expose it`() {
        assertFalse(ClientUiFixtures.hostState("a").savedDeleteExposed)
        assertFalse(
            ClientUiFixtures.hostState("a", savedPolicy = SavedPolicyStatus.OFF).savedDeleteExposed,
        )
        assertTrue(
            ClientUiFixtures.hostState("a", savedPolicy = SavedPolicyStatus.EXPOSED).savedDeleteExposed,
        )
    }
}
