package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterNotSentReason
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOwnerOutcome
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRequestResult
import io.github.rfairburn.pireviewgate.core.client.ui.CapabilityStatus
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiFixtures
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RenameSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.RenameTarget
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.RosterSnapshot
import io.github.rfairburn.pireviewgate.core.client.ui.SessionActionTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionTargetToken
import io.github.rfairburn.pireviewgate.core.client.ui.UiProofScreen
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCloseFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerRenameFacts
import kotlin.test.*

/**
 * Rename-specific stable owner identity versus the ordinary owner republish that happens
 * while a rename form is open, and the exact form a settled rename is allowed to close.
 */
internal class RenameRowFenceTest {

    private fun row(
        revision: Long = 7L,
        name: String = "Native name",
        sessionId: String = "native-1",
        epoch: Long = 3L,
        stale: Boolean = false,
        native: Boolean = true,
    ): SessionUiState = ClientUiFixtures.row(
        "a",
        rowId = "row-1",
        nativeSession = if (native) ClientUiFixtures.nativeSession(sessionId, epoch, name) else null,
        revision = revision,
        stale = stale,
    )

    private fun host(
        rows: List<SessionUiState>,
        connection: HostConnectionState = HostConnectionState.CONNECTED,
        rename: CapabilityStatus = CapabilityStatus.SUPPORTED,
        freshness: RosterFreshness = RosterFreshness.CURRENT,
        run: String = ClientUiFixtures.RUN_A,
    ): HostUiState = HostUiState(
        host = ClientUiFixtures.host("a", label = "Owner A"),
        connection = connection,
        roster = RosterSnapshot(freshness, run, 7L, rows),
        capabilities = HostCapabilities(
            negotiated = true,
            close = CapabilityStatus.SUPPORTED,
            create = CapabilityStatus.SUPPORTED,
            rename = rename,
        ),
    )

    /**
     * The drawn-context lookup this fence replaces: it compared the whole frozen
     * [SessionActionTarget] — revision and drawn title included — against the live row.
     * Kept here only to state, in an executable form, what the repair had to change.
     */
    private fun exactDrawnContextRow(live: SessionUiState, target: RenameTarget): RenameTarget? =
        live.takeIf { !it.stale && SessionActionTarget.of(it) == target.base }?.let { RenameTarget.of(it) }

    private fun refusal(admission: RenameRowAdmission): RenameRowRefusal =
        assertIs<RenameRowAdmission.Refused>(admission).reason

    // ------------------------------------------------------- the reported defect

    @Test
    fun aRenameTheOperatorSubmittedSurvivesTheOwnerRepublishingItsRosterMeanwhile() {
        val drawn = row(revision = 7L, name = "Old name")
        val target = assertNotNull(RenameTarget.of(drawn))
        // The owner republished the same live row while the form was open: nothing about
        // the native conversation moved, only the roster revision did.
        val refreshed = row(revision = 8L, name = "Old name")

        assertNull(exactDrawnContextRow(refreshed, target),
            "the pre-repair lookup dropped the deliberate Rename without any notice")
        assertNotEquals(target.base, SessionActionTarget.of(refreshed))

        val admitted = assertIs<RenameRowAdmission.Admitted>(RenameRowFence.current(host(listOf(refreshed)), target))
        assertSame(refreshed, admitted.row)
        assertSame(refreshed, RenameRowFence.row(host(listOf(refreshed)), target))
        assertEquals(target.expectedSessionId, refreshed.metadata.nativeSession?.sessionId)
        assertEquals(target.expectedSessionEpoch, refreshed.metadata.nativeSession?.epoch)
    }

    @Test
    fun aRenamedRowStillTakesItsDisplayedTitleOnlyFromTheOwnersNextSnapshot() {
        val drawn = row(revision = 7L, name = "Old name")
        val target = assertNotNull(RenameTarget.of(drawn))
        // The owner's next complete snapshot carries the new name for the SAME tuple.
        val renamed = row(revision = 9L, name = "New name")

        assertEquals("New name", renamed.displayTitle, "the authoritative snapshot owns the title")
        assertEquals("Old name", target.currentName, "the frozen form still names what was drawn")
        assertNull(exactDrawnContextRow(renamed, target))
        assertSame(renamed, RenameRowFence.row(host(listOf(renamed)), target),
            "reopening Rename after the owner's snapshot addresses the same live row")
    }

    // ------------------------------------------------------------- the real fence

    @Test
    fun aMovedNativeConversationIsNeverRetargetedOntoANewerFormOfTheSameRow() {
        val target = assertNotNull(RenameTarget.of(row()))

        assertEquals(RenameRowRefusal.NATIVE_TUPLE_CHANGED,
            refusal(RenameRowFence.current(host(listOf(row(epoch = 4L))), target)))
        assertEquals(RenameRowRefusal.NATIVE_TUPLE_CHANGED,
            refusal(RenameRowFence.current(host(listOf(row(sessionId = "native-2"))), target)))
        assertNull(RenameRowFence.row(host(listOf(row(epoch = 4L))), target))

        val tupleless = row(native = false)
        assertEquals(RenameRowRefusal.NO_NATIVE_CONVERSATION,
            refusal(RenameRowFence.current(host(listOf(tupleless)), target)))
        assertNull(RenameTarget.of(tupleless), "no tuple means no rename is offered at all")
    }

    @Test
    fun wrongOwnerRunOrRowAndStaleOrAbsentRowsStillRefuse() {
        val target = assertNotNull(RenameTarget.of(row()))

        val otherOwner = HostUiState(
            host = ClientUiFixtures.host("b", label = "Owner B"),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, ClientUiFixtures.RUN_B, 7L,
                listOf(ClientUiFixtures.row("b", rowId = "row-1",
                    nativeSession = ClientUiFixtures.nativeSession()))),
            capabilities = HostCapabilities(negotiated = true, rename = CapabilityStatus.SUPPORTED),
        )
        assertEquals(RenameRowRefusal.HOST_ABSENT, refusal(RenameRowFence.current(otherOwner, target)))

        val otherRun = host(listOf(row().copy(hostRunId = ClientUiFixtures.RUN_B)), run = ClientUiFixtures.RUN_B)
        assertEquals(RenameRowRefusal.RUN_CHANGED, refusal(RenameRowFence.current(otherRun, target)))

        val otherRow = host(listOf(row().copy(metadata = row().metadata.copy(id = "row-2"))))
        assertEquals(RenameRowRefusal.ROW_MISSING, refusal(RenameRowFence.current(otherRow, target)))

        assertEquals(RenameRowRefusal.STALE, refusal(RenameRowFence.current(host(listOf(row(stale = true))), target)))
        assertEquals(RenameRowRefusal.ROSTER_NOT_CURRENT,
            refusal(RenameRowFence.current(host(listOf(row()), freshness = RosterFreshness.STALE), target)))

        val neverReported = HostUiState(host = ClientUiFixtures.host("a"), connection = HostConnectionState.CONNECTED,
            roster = null, capabilities = HostCapabilities(negotiated = true, rename = CapabilityStatus.SUPPORTED))
        assertEquals(RenameRowRefusal.ROSTER_NOT_CURRENT, refusal(RenameRowFence.current(neverReported, target)))

        assertEquals(RenameRowRefusal.ROW_MISSING,
            refusal(RenameRowFence.current(host(listOf(row())), target.copy(base = target.base.copy(rowId = "row-9")))))
        assertNull(RenameRowFence.row(null, target))
    }

    @Test
    fun disconnectAndUnknownOrUnsupportedRenameCapabilityRefuseEvenForAStableRow() {
        val target = assertNotNull(RenameTarget.of(row()))
        for (connection in listOf(HostConnectionState.DISCONNECTED, HostConnectionState.CONNECTING,
            HostConnectionState.RETRYING, HostConnectionState.ERROR, HostConnectionState.PAIRING)) {
            assertEquals(RenameRowRefusal.DISCONNECTED,
                refusal(RenameRowFence.current(host(listOf(row()), connection = connection), target)), connection.name)
        }
        for (capability in listOf(CapabilityStatus.UNKNOWN, CapabilityStatus.UNSUPPORTED)) {
            assertEquals(RenameRowRefusal.CAPABILITY_UNSUPPORTED,
                refusal(RenameRowFence.current(host(listOf(row()), rename = capability), target)), capability.name)
        }
    }

    // --------------------------------------------------- correlated form dismissal

    private val hostId = HostId.parse("a")

    private fun proof(rowId: String = "row-1", generation: Long = 1L) = ClientUiFixtures.FakeProof(
        UiActionTargetToken(UiProofScreen.SESSION_RENAME, hostId,
            hostRunId = ClientUiFixtures.RUN_A, rowId = rowId, generation = generation),
    )

    private fun form(target: RenameTarget, proof: UiActionProof = proof()) =
        RenameSessionDialog(target, "New name", proof)

    private val renamed = RosterRequestResult.OwnerResult(RosterOwnerOutcome.Rename(OwnerRenameFacts.RENAMED))

    @Test
    fun onlyTheExactSubmittedFormClosesOnTheOwnersPositiveRenamed() {
        val target = assertNotNull(RenameTarget.of(row()))
        val submitted = proof()
        assertTrue(RenameResultFence.closesOn(form(target, submitted), submitted, hostId, target.base.hostRunId, renamed))
    }

    @Test
    fun everyOtherRenameOutcomeLeavesTheSubmittedFormOpen() {
        val target = assertNotNull(RenameTarget.of(row()))
        val submitted = proof()
        val current = target.base.hostRunId
        for (fact in listOf(OwnerRenameFacts.STALE_SESSION, OwnerRenameFacts.REFUSED, OwnerRenameFacts.BUSY,
            OwnerRenameFacts.UNKNOWN)) {
            assertFalse(RenameResultFence.closesOn(form(target, submitted), submitted, hostId, current,
                RosterRequestResult.OwnerResult(RosterOwnerOutcome.Rename(fact))), fact.wireName)
        }
        assertFalse(RenameResultFence.closesOn(form(target, submitted), submitted, hostId, current,
            RosterRequestResult.Unknown), "an unobservable outcome is never a success")
        assertFalse(RenameResultFence.closesOn(form(target, submitted), submitted, hostId, current,
            RosterRequestResult.NotSent(RosterNotSentReason.NOT_READY)), "a never-sent request is never a success")
        assertFalse(RenameResultFence.closesOn(form(target, submitted), submitted, hostId, current,
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.Close(OwnerCloseFacts.REMOVED))),
            "a foreign operation's result never closes this form")
    }

    @Test
    fun aLateOrForeignRenameResultNeverClosesAReplacementForm() {
        val target = assertNotNull(RenameTarget.of(row()))
        val submitted = proof()
        val replacement = form(target, proof(generation = 2L))
        assertFalse(RenameResultFence.closesOn(replacement, submitted, hostId, target.base.hostRunId, renamed),
            "an older request's result cannot close a form minted after it")
        assertFalse(RenameResultFence.closesOn(form(target, submitted), proof(generation = 2L), hostId,
            target.base.hostRunId, renamed), "a replacement proof object is not this form")

        val mismatchedToken = proof(rowId = "row-2")
        assertFalse(RenameResultFence.closesOn(form(target, mismatchedToken), mismatchedToken, hostId,
            target.base.hostRunId, renamed), "the proof's own row must name the form's row")

        assertFalse(RenameResultFence.closesOn(form(target, submitted), submitted, HostId.parse("b"),
            target.base.hostRunId, renamed))
        assertFalse(RenameResultFence.closesOn(form(target, submitted), submitted, hostId, "another-run", renamed))
        assertFalse(RenameResultFence.closesOn(null, submitted, hostId, target.base.hostRunId, renamed))
        assertFalse(RenameResultFence.closesOn(form(target, submitted), null, hostId, target.base.hostRunId, renamed))
    }
}
