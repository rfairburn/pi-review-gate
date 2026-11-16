package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEvent
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientHarness
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOwnerOutcome
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRequestResult
import io.github.rfairburn.pireviewgate.core.client.ui.CapabilityStatus
import io.github.rfairburn.pireviewgate.core.client.ui.ClientDialogs
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiFixtures
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.MutableUiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.NativeRenameSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.NativeRenameTarget
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.RosterSnapshot
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionTargetToken
import io.github.rfairburn.pireviewgate.core.client.ui.UiProofScreen
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliTarget
import io.github.rfairburn.pireviewgate.core.protocol.native.SessionBackend
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerNativeRenameFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The native host-caption submission and its four truthful owner answers. */
internal class NativeRenameSubmissionTest {
    private val hostId = HostId.parse("host-1")
    private val run = RosterClientHarness.RUN_ID
    private val target = NativeCliTarget("claude-default", NativeCliBackend.CLAUDE, "Claude default")

    private class Opened(
        val harness: RosterClientHarness,
        val host: HostUiState,
        val form: NativeRenameSessionDialog,
        val proof: MutableUiActionProof,
    )

    private fun nativeMetadata(
        backend: SessionBackend? = SessionBackend.CLAUDE,
        id: String = "row-1",
        label: String = "My caption",
    ) = RemoteSessionMetadata(
        id = id,
        label = label,
        workspace = "/srv/owner/$id",
        lifecycle = io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle.ALIVE,
        hasLiveProcess = true,
        inputSurface = false,
        backend = backend,
    )

    private fun uiRow(metadata: RemoteSessionMetadata, revision: Long) = SessionUiState(
        hostId = hostId, hostLabel = "Owner A", hostRunId = run, stale = false,
        rosterRevision = revision, metadata = metadata,
    )

    private fun host(row: SessionUiState, nativeName: CapabilityStatus = CapabilityStatus.SUPPORTED): HostUiState =
        HostUiState(
            host = ClientUiFixtures.host("host-1", label = "Owner A"),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, run, row.rosterRevision, listOf(row)),
            capabilities = HostCapabilities(
                negotiated = true,
                native = CapabilityStatus.SUPPORTED,
                nativeName = nativeName,
            ),
        )

    private fun committedProof(): MutableUiActionProof = MutableUiActionProof(
        UiActionTargetToken(UiProofScreen.SESSION_RENAME, hostId, hostRunId = run, rowId = "row-1", generation = 1),
    ).also {
        it.setCriticalIdentityReadable(true)
        assertTrue(it.markCommitted(it.beginDraw()))
    }

    private fun opened(draft: String = "New caption", metadata: RemoteSessionMetadata = nativeMetadata()): Opened {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot(rows = listOf(metadata), nativeCliTargets = listOf(target))
        val drawn = uiRow(harness.endpoint.state().projection.rows.single(), 1L)
        val nativeTarget = assertNotNull(NativeRenameTarget.of(drawn))
        val proof = committedProof()
        return Opened(
            harness,
            host(drawn),
            NativeRenameSessionDialog(nativeTarget, draft, proof),
            proof,
        )
    }

    private fun ownerResult(facts: OwnerNativeRenameFacts): RosterRequestResult =
        RosterRequestResult.OwnerResult(RosterOwnerOutcome.NativeRename(facts))

    @Test
    fun `begin admits the exact native row and builds no Pi tuple`() {
        val opened = opened()
        val submission = assertNotNull(
            NativeRenameSubmission.begin(opened.host, opened.harness.generation, opened.form, opened.proof),
        )
        assertEquals(run, submission.command.hostRunId)
        assertEquals("row-1", submission.command.rowId)
        assertEquals(NativeCliBackend.CLAUDE, submission.command.backend)
        assertEquals("New caption", submission.command.name)
        assertEquals(NativeCliBackend.CLAUDE, submission.command.proof?.backend)
        assertTrue(!submission.command.toString().contains("expectedSession"))
        assertNull(NativeRenameSubmission.begin(
            opened.host.copy(capabilities = opened.host.capabilities.copy(nativeName = CapabilityStatus.UNSUPPORTED)),
            opened.harness.generation, opened.form, opened.proof,
        ))
    }

    @Test
    fun `only the two positive owner truths close exactly that native form`() {
        for (facts in listOf(OwnerNativeRenameFacts.RENAMED_DURABLE, OwnerNativeRenameFacts.RENAMED_IN_MEMORY)) {
            val opened = opened()
            val submission = assertNotNull(
                NativeRenameSubmission.begin(opened.host, opened.harness.generation, opened.form, opened.proof),
            )
            // A controller refresh may copy the pending form while retaining the
            // exact receipt object; that still closes only this submitted form.
            val current = ClientDialogs(nativeRenameSession = opened.form.copy(proof = opened.proof))
            assertNull(submission.closeIfConfirmed(current, run, ownerResult(facts)).nativeRenameSession)
        }
        for (facts in listOf(OwnerNativeRenameFacts.REFUSED, OwnerNativeRenameFacts.UNKNOWN)) {
            val opened = opened()
            val submission = assertNotNull(
                NativeRenameSubmission.begin(opened.host, opened.harness.generation, opened.form, opened.proof),
            )
            val current = ClientDialogs(nativeRenameSession = opened.form)
            assertEquals(opened.form, submission.closeIfConfirmed(current, run, ownerResult(facts)).nativeRenameSession)
        }
    }

    @Test
    fun `a refusal unknown never sent or foreign form leaves the form and caption untouched`() {
        val opened = opened()
        val submission = assertNotNull(
            NativeRenameSubmission.begin(opened.host, opened.harness.generation, opened.form, opened.proof),
        )
        val current = ClientDialogs(nativeRenameSession = opened.form)
        for (result in listOf(
            RosterRequestResult.Unknown,
            RosterRequestResult.NotSent(io.github.rfairburn.pireviewgate.core.client.roster.RosterNotSentReason.BUSY),
        )) {
            assertEquals(opened.form,
                submission.closeIfConfirmed(current, run, result).nativeRenameSession)
        }
        assertEquals(opened.form,
            submission.closeIfConfirmed(current, "other-run", ownerResult(OwnerNativeRenameFacts.RENAMED_DURABLE))
                .nativeRenameSession)
        assertNull(submission.closeIfConfirmed(ClientDialogs(), run,
            ownerResult(OwnerNativeRenameFacts.RENAMED_DURABLE)).nativeRenameSession)
    }

    @Test
    fun `a backend move or a replaced run is refused without retargeting`() {
        val opened = opened()
        val moved = uiRow(nativeMetadata(backend = SessionBackend.CODEX), 2L)
        assertNull(NativeRenameRowFence.row(host(moved), opened.form.target))
        val replacedRun = opened.host.copy(roster = opened.host.roster?.copy(hostRunId = "run-2"))
        assertNull(NativeRenameRowFence.row(replacedRun, opened.form.target))
        assertNull(NativeRenameSubmission.begin(replacedRun, opened.harness.generation, opened.form, opened.proof))
        val noBackend = uiRow(nativeMetadata(backend = null), 2L)
        assertNull(NativeRenameRowFence.row(host(noBackend), opened.form.target))
        val disconnected = opened.host.copy(connection = HostConnectionState.DISCONNECTED)
        assertNull(NativeRenameRowFence.row(disconnected, opened.form.target))
        assertNull(NativeRenameSubmission.begin(disconnected, opened.harness.generation, opened.form, opened.proof))
        val missing = opened.host.copy(roster = opened.host.roster?.copy(rows = emptyList()))
        assertNull(NativeRenameRowFence.row(missing, opened.form.target))
    }

    @Test
    fun `the endpoint result settles the operation and the owner facts are the report`() {
        val opened = opened()
        val submission = assertNotNull(
            NativeRenameSubmission.begin(opened.host, opened.harness.generation, opened.form, opened.proof),
        )
        opened.harness.push(opened.harness.endpoint.renameNativeSession(submission.command))
        val frame = opened.harness.sends.last().frame as io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame.NativeRenameRequest
        opened.harness.drain()
        opened.harness.deliver(io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame.NativeRenameResult(
            frame.requestId, OwnerNativeRenameFacts.RENAMED_DURABLE,
        ))
        val settled = opened.harness.events.filterIsInstance<RosterClientEvent.OperationSettled>().single()
        val facts = ((settled.result as RosterRequestResult.OwnerResult).outcome as RosterOwnerOutcome.NativeRename).facts
        assertEquals(OwnerNativeRenameFacts.RENAMED_DURABLE, facts)
        assertNull(submission.closeIfConfirmed(
            ClientDialogs(nativeRenameSession = opened.form), run, settled.result,
        ).nativeRenameSession)
    }
}
