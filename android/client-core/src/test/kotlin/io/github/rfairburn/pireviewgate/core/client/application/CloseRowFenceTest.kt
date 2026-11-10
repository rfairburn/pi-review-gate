package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import kotlin.test.*

/** Close-specific stable owner identity versus ordinary metadata/title refresh. */
class CloseRowFenceTest {
    private fun row(revision: Long = 7, label: String = "display-row-1", stale: Boolean = false) =
        ClientUiFixtures.row("a", rowId = "row-1", label = label, revision = revision, stale = stale)

    private fun capabilities(close: CapabilityStatus = CapabilityStatus.SUPPORTED) =
        HostCapabilities(negotiated = true, close = close, create = CapabilityStatus.SUPPORTED,
            rename = CapabilityStatus.SUPPORTED)

    private fun host(rows: List<SessionUiState>, connection: HostConnectionState = HostConnectionState.CONNECTED,
                     close: CapabilityStatus = CapabilityStatus.SUPPORTED,
                     freshness: RosterFreshness = RosterFreshness.CURRENT,
                     run: String = ClientUiFixtures.RUN_A) = HostUiState(
        host = ClientUiFixtures.host("a", label = "Owner A"),
        connection = connection,
        roster = RosterSnapshot(freshness, run, 7, rows),
        capabilities = capabilities(close),
    )

    @Test fun sameStableRowSurvivesHarmlessRevisionAndTitleRefresh() {
        val drawn = row(revision = 7, label = "old title")
        val target = SessionActionTarget.of(drawn)
        val refreshed = row(revision = 8, label = "new title")
        val admitted = CloseRowFence.current(host(listOf(refreshed)), target)
        val row = assertIs<CloseRowAdmission.Admitted>(admitted).row
        assertSame(refreshed, row)
        assertEquals(target.hostId, row.hostId)
        assertEquals(target.hostRunId, row.hostRunId)
        assertEquals(target.rowId, row.rowId)
        assertNotEquals(target, SessionActionTarget.of(refreshed))
        assertSame(refreshed, CloseRowFence.row(host(listOf(refreshed)), target))
        assertTrue(host(listOf(refreshed)).capabilities.supports(RosterWire.CLOSE_CAPABILITY))
    }

    @Test fun wrongOwnerRunOrRowAndStaleOrAbsentRowsStillRefuse() {
        val target = SessionActionTarget.of(row())
        val otherOwner = HostUiState(
            host = ClientUiFixtures.host("b", label = "Owner B"),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, ClientUiFixtures.RUN_B, 7,
                listOf(ClientUiFixtures.row("b", rowId = "row-1"))),
            capabilities = capabilities(),
        )
        assertEquals(CloseRowRefusal.HOST_ABSENT, refusal(CloseRowFence.current(otherOwner, target)))

        val otherRun = host(listOf(row().copy(hostRunId = ClientUiFixtures.RUN_B)),
            run = ClientUiFixtures.RUN_B)
        assertEquals(CloseRowRefusal.RUN_CHANGED, refusal(CloseRowFence.current(otherRun, target)))

        val otherRow = host(listOf(row().copy(metadata = row().metadata.copy(id = "row-2"))))
        assertEquals(CloseRowRefusal.ROW_MISSING, refusal(CloseRowFence.current(otherRow, target)))

        val staleRow = host(listOf(row(stale = true)))
        assertEquals(CloseRowRefusal.STALE, refusal(CloseRowFence.current(staleRow, target)))

        val staleRoster = host(listOf(row()), freshness = RosterFreshness.STALE)
        assertEquals(CloseRowRefusal.ROSTER_NOT_CURRENT, refusal(CloseRowFence.current(staleRoster, target)))

        val neverReported = HostUiState(host = ClientUiFixtures.host("a"), connection = HostConnectionState.CONNECTED,
            roster = null, capabilities = capabilities())
        assertEquals(CloseRowRefusal.ROSTER_NOT_CURRENT, refusal(CloseRowFence.current(neverReported, target)))

        val absentTarget = target.copy(rowId = "row-9")
        assertEquals(CloseRowRefusal.ROW_MISSING, refusal(CloseRowFence.current(host(listOf(row())), absentTarget)))
        assertNull(CloseRowFence.row(host(listOf(row())), absentTarget))
    }

    @Test fun disconnectAndUnknownOrUnsupportedCloseCapabilityRefuseEvenForAStableRow() {
        val target = SessionActionTarget.of(row())
        for (connection in listOf(HostConnectionState.DISCONNECTED, HostConnectionState.CONNECTING,
            HostConnectionState.RETRYING, HostConnectionState.ERROR, HostConnectionState.PAIRING)) {
            assertEquals(CloseRowRefusal.DISCONNECTED,
                refusal(CloseRowFence.current(host(listOf(row()), connection = connection), target)),
                connection.name)
        }
        for (capability in listOf(CapabilityStatus.UNKNOWN, CapabilityStatus.UNSUPPORTED)) {
            assertEquals(CloseRowRefusal.CAPABILITY_UNSUPPORTED,
                refusal(CloseRowFence.current(host(listOf(row()), close = capability), target)),
                capability.name)
        }
        assertNull(CloseRowFence.row(null, target))
    }

    private fun refusal(admission: CloseRowAdmission): CloseRowRefusal =
        assertIs<CloseRowAdmission.Refused>(admission).reason

    @Test fun onlyExactFormProofOwnerRunAndRowMatchAResultDialog() {
        val host = HostId.parse("a")
        val target = SessionActionTarget.of(row())
        val proof = ClientUiFixtures.FakeProof(UiActionTargetToken(UiProofScreen.SESSION_CLOSE, host,
            hostRunId = target.hostRunId, rowId = target.rowId, generation = 1))
        val form = CloseSessionDialog(target, proof, connectionGeneration = 9)
        assertSame(form, CloseResultFence.matching(form, proof, host, target.hostRunId))
        assertTrue(CloseConnectionFence.admits(form, 9))
        assertFalse(CloseConnectionFence.admits(form, 10))
        val staged = form.copy(confirmationRequestId = "request-1")
        assertSame(staged, CloseResultFence.matching(staged, proof, host, target.hostRunId),
            "a real second stage still settles only its exact form")
        assertTrue(CloseConnectionFence.admits(staged, 9))
        assertFalse(CloseConnectionFence.admits(staged, 10),
            "the second stage inherits the form's original connection attempt")
        assertNull(CloseResultFence.matching(form, ClientUiFixtures.FakeProof(proof.target, drawEpoch = 2),
            host, target.hostRunId), "a replacement proof object is not this form")
        assertNull(CloseResultFence.matching(form, proof, HostId.parse("b"), target.hostRunId))
        assertNull(CloseResultFence.matching(form, proof, host, "another-run"))
        assertNull(CloseResultFence.matching(form.copy(target = target.copy(rowId = "row-2")), proof,
            host, target.hostRunId))
        assertNull(CloseResultFence.matching(form.copy(target = target.copy(hostId = HostId.parse("b"))),
            proof, host, target.hostRunId))
        assertNull(CloseResultFence.matching(null, proof, host, target.hostRunId))
        assertNull(CloseResultFence.matching(form, null, host, target.hostRunId))
    }

    @Test fun anOpenFirstStageCloseCannotRideAReconnectToTheSameRunAndRow() {
        val host = HostId.parse("a")
        val target = SessionActionTarget.of(row())
        val proof = ClientUiFixtures.FakeProof(UiActionTargetToken(UiProofScreen.SESSION_CLOSE, host,
            hostRunId = target.hostRunId, rowId = target.rowId, generation = 2))
        val openedOnFirstAttempt = CloseSessionDialog(target, proof, connectionGeneration = 9)
        assertTrue(CloseConnectionFence.admits(openedOnFirstAttempt, 9))
        assertFalse(CloseConnectionFence.admits(openedOnFirstAttempt, 10),
            "same stable run/row on a reconnected attempt is still a different consent lifetime")
        assertTrue(CloseConnectionFence.survives(openedOnFirstAttempt, 9, true, 9, true))
        assertFalse(CloseConnectionFence.survives(openedOnFirstAttempt, 10, true, 10, true),
            "reconnect retires the open form's authority")
        assertFalse(CloseConnectionFence.survives(openedOnFirstAttempt, 9, false, 9, true),
            "disconnect retires the open form's authority")
        assertFalse(CloseConnectionFence.survives(openedOnFirstAttempt, 9, true, 10, true))
        assertFalse(CloseConnectionFence.survives(openedOnFirstAttempt, 9, true, 9, false))
        val staged = openedOnFirstAttempt.copy(confirmationRequestId = "request-2")
        assertFalse(CloseConnectionFence.admits(staged, 10))
        val reopened = CloseSessionDialog(target, proof, connectionGeneration = 10)
        assertTrue(CloseConnectionFence.admits(reopened, 10))
        assertFalse(CloseConnectionFence.admits(null, 10))
        assertFalse(CloseConnectionFence.admits(reopened, null))
    }

    @Test fun fenceUsesOnlyTheStableRowKeyNotTheDrawnDisplayContext() {
        val drawn = row(revision = 7, label = "old title")
        val target = SessionActionTarget.of(drawn)
        val refreshedRow = row(revision = 70, label = "completely different title")
        val refreshed = host(listOf(refreshedRow))
        assertEquals(CloseRowAdmission.Admitted(refreshedRow), CloseRowFence.current(refreshed, target))
        // The same stable triple still identifies the row after any title/revision drift.
        assertEquals(CloseRowAdmission.Admitted(refreshedRow),
            CloseRowFence.current(refreshed, target.copy(rosterRevision = 0, drawnTitle = "stale frame title")))
        // Capability is still the owner's acknowledged one, not the row's display fields.
        assertTrue(refreshed.capabilities.supports(RosterWire.CLOSE_CAPABILITY))
    }
}
