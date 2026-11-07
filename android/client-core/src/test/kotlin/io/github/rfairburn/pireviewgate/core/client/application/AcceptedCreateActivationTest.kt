package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.runtime.TerminalTarget
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiFixtures
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCreateFacts
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.*

/** The committed Create form -> exact owner `started` row -> one activation contract. */
class AcceptedCreateActivationTest {
    private val host = HostId.parse("owner-a")
    private val run = "run-1"
    private val workspace = "  exact workspace  "
    private val request = "request-1"
    private val sequence = AtomicLong(0L)

    private fun newProof(hostId: HostId = host, runId: String? = run, current: Boolean = true,
                      committed: Boolean = true, readable: Boolean = true): MutableUiActionProof {
        val token = UiActionTargetToken(UiProofScreen.SESSION_CREATE, hostId, hostRunId = runId,
            generation = sequence.incrementAndGet())
        return MutableUiActionProof(token).also {
            val epoch = it.beginDraw()
            it.setCriticalIdentityReadable(readable)
            if (committed) it.markCommitted(epoch)
            if (!current) it.invalidate(UiProofInvalidationReason.DISMISSED)
        }
    }

    private fun dialog(proof: UiActionProof = newProof(), selected: HostId? = host,
                        draft: String = workspace): CreateSessionDialog =
        CreateSessionDialog(owners = listOf(OwnerChoice(host, "Owner A", "10.0.0.1:8443",
            HostConnectionState.CONNECTED, createEligible = true)), selectedHostId = selected,
            workspaceDraft = draft, proof = proof)

    private fun capture(origin: ClientRoute = ClientRoute.Sessions, form: CreateSessionDialog = dialog(),
                        click: FrozenAction? = null): AcceptedCreateActivation? {
        val frozen = click ?: FrozenAction.capture(form.proof) ?: return null
        return AcceptedCreateActivation.capture(host, 9, run, workspace, form, frozen, origin)
    }

    private fun admitted(activation: AcceptedCreateActivation, pending: RosterPendingOperation? =
        RosterPendingOperation(RosterOperationKind.CREATE, request, run, sequence = 1, deadlineAtMs = 100)) {
        activation.admitted(pending)
    }

    private fun settled(result: RosterRequestResult = RosterRequestResult.OwnerResult(
        RosterOwnerOutcome.Create(OwnerCreateFacts.Started(run, "row-new"))),
        requestId: String = request, runId: String = run, kind: RosterOperationKind = RosterOperationKind.CREATE) =
        RosterClientEvent.OperationSettled(kind, requestId, runId, result)

    @Test fun deliberateCommittedFormClaimsOnlyTheExactOwnerReturnedRowOnce() {
        val form = dialog()
        val activation = assertNotNull(capture(form = form))
        assertSame(form.proof, activation.formProof)
        assertNull(activation.returnedRow)
        admitted(activation)
        val returned = assertNotNull(activation.started(settled(), form))
        assertEquals(AcceptedCreateActivation.StartedRow(run, "row-new"), returned)
        assertTrue(activation.authorizes(TerminalTarget(host, run, "row-new"), 9))
        assertFalse(activation.authorizes(TerminalTarget(host, run, "another-row"), 9))
        assertFalse(activation.authorizes(TerminalTarget(host, "another-run", "row-new"), 9))
        assertFalse(activation.authorizes(TerminalTarget(HostId.parse("owner-b"), run, "row-new"), 9))
        assertFalse(activation.authorizes(TerminalTarget(host, run, "row-new"), 10))
        assertTrue(activation.claim(TerminalTarget(host, run, "row-new"), 9))
        assertFalse(activation.claim(TerminalTarget(host, run, "row-new"), 9),
            "one accepted create authorizes one activation only")
        assertNull(activation.returnedRow)
    }

    @Test fun acceptedReturnedRowAdmitsOneNavigationFromSessionsOrHostsOrigin() {
        for (origin in listOf<ClientRoute>(ClientRoute.Sessions, ClientRoute.Hosts)) {
            val form = dialog(proof = newProof())
            val activation = assertNotNull(capture(origin = origin, form = form))
            admitted(activation)
            assertNotNull(activation.started(settled(), form))
            val nav = AcceptedNavigation()
            val target = TerminalTarget(host, run, "row-new")
            assertNull(nav.acceptReturnedRow(TerminalTarget(host, run, "foreign-row"), 9, activation))
            assertNull(nav.acceptReturnedRow(target, 10, activation))
            assertNull(nav.wanted())
            val wanted = assertNotNull(nav.acceptReturnedRow(target, 9, activation))
            assertEquals(target, wanted.target)
            assertEquals(9L, wanted.connectionGeneration)
            assertTrue(nav.isCurrent(wanted))
            assertNull(nav.acceptReturnedRow(target, 9, activation),
                "a later refresh or duplicate response cannot mint a second navigation")
            nav.cancel()
            assertFalse(nav.isCurrent(wanted))
        }
    }

    @Test fun ownerStartedAloneOrANewerFormDraftReceiptNeverAuthorizesAnActivation() {
        val uncommitted = dialog(proof = newProof(committed = false))
        assertNull(capture(form = uncommitted))
        val unreadable = dialog(proof = newProof(readable = false))
        assertNull(capture(form = unreadable))
        assertNull(capture(form = dialog(selected = HostId.parse("owner-b"))))
        assertNull(capture(form = dialog(draft = "$workspace changed")))

        // An accepted request with no committed form receipt at the submit boundary.
        val unadmittedForm = dialog()
        val notYetAdmitted = assertNotNull(capture(form = unadmittedForm))
        assertNull(notYetAdmitted.started(settled(), unadmittedForm))
        assertNull(notYetAdmitted.returnedRow)

        // The receipt that was submitted is retained; a replacement re-key is not it.
        val submitted = dialog()
        val activation = assertNotNull(capture(form = submitted))
        admitted(activation)
        val replacement = submitted.copy(workspaceDraft = "$workspace changed", proof = newProof())
        assertNull(activation.started(settled(), replacement))
        assertNull(activation.returnedRow)

        // A real change to the owner or workspace after capture is a newer intent.
        val changedOwner = assertNotNull(capture(form = submitted))
        admitted(changedOwner)
        assertNull(changedOwner.started(settled(), submitted.copy(selectedHostId = null)))
        val changedDraft = assertNotNull(capture(form = submitted))
        admitted(changedDraft)
        assertNull(changedDraft.started(settled(), submitted.copy(workspaceDraft = "$workspace changed")))
    }

    @Test fun retiredClickStillLetsTheExactFormCloseButNeverAuthorizesNavigation() {
        val proof = newProof()
        val form = dialog(proof = proof)
        val activation = assertNotNull(capture(form = form))
        admitted(activation)
        proof.invalidate(UiProofInvalidationReason.LIFECYCLE_CHANGE)
        assertEquals(AcceptedCreateActivation.StartedRow(run, "row-new"), activation.started(settled(), form),
            "the exact submitted form may close after the owner actually started the row")
        assertFalse(activation.mayActivate, "a retired committed proof is never recaptured as consent")
        assertNull(activation.returnedRow)
        assertFalse(activation.claim(TerminalTarget(host, run, "row-new"), 9))
    }

    @Test fun everyNonStartedOrUncorrelatedOutcomeLeavesNoActivation() {
        val results = listOf(
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.Create(OwnerCreateFacts.Unconfirmed)),
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.Create(OwnerCreateFacts.Refused)),
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.Create(OwnerCreateFacts.Unknown)),
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.Create(OwnerCreateFacts.Started("other-run", "row-new"))),
            RosterRequestResult.Unknown,
            RosterRequestResult.NotSent(RosterNotSentReason.NOT_READY),
        )
        for (result in results) {
            val form = dialog()
            val activation = assertNotNull(capture(form = form))
            admitted(activation)
            assertNull(activation.started(settled(result = result), form), result.toString())
            assertNull(activation.returnedRow)
            assertFalse(activation.claim(TerminalTarget(host, run, "row-new"), 9))
        }
        val form = dialog()
        val activation = assertNotNull(capture(form = form))
        admitted(activation)
        assertNull(activation.started(settled(requestId = "foreign-request"), form))
        val otherKindForm = dialog()
        val otherKind = assertNotNull(capture(form = otherKindForm))
        admitted(otherKind)
        assertNull(otherKind.started(settled(kind = RosterOperationKind.RENAME), otherKindForm))
        val otherRunForm = dialog()
        val otherRun = assertNotNull(capture(form = otherRunForm))
        admitted(otherRun)
        assertNull(otherRun.started(settled(runId = "other-run"), otherRunForm))
    }

    @Test fun newerExplicitIntentRetiresNavigationButStillLetsTheExactFormClose() {
        val form = dialog()
        val activation = assertNotNull(capture(form = form))
        admitted(activation)
        activation.supersede()
        assertFalse(activation.mayActivate)
        val returned = assertNotNull(activation.started(settled(), form))
        assertEquals(AcceptedCreateActivation.StartedRow(run, "row-new"), returned)
        assertNull(activation.returnedRow, "a superseded intent is never revived by ownerStarted")
        assertFalse(activation.claim(TerminalTarget(host, run, "row-new"), 9))
    }

    @Test fun returnedRowFeedsTheSameStableImmediateCloseFence() {
        val form = dialog()
        val activation = assertNotNull(capture(form = form))
        admitted(activation)
        assertNotNull(activation.started(settled(), form))
        val fresh = ClientUiFixtures.row("owner-a", rowId = "row-new", revision = 8, label = "fresh title")
            .copy(hostRunId = run)
        val currentHost = HostUiState(
            host = ClientUiFixtures.host("owner-a"),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, run, 8, listOf(fresh)),
            capabilities = HostCapabilities(negotiated = true, close = CapabilityStatus.SUPPORTED),
        )
        val drawn = fresh.copy(rosterRevision = 7, metadata = fresh.metadata.copy(label = "old title"))
        val drawnTarget = SessionActionTarget.of(drawn)
        assertSame(fresh, CloseRowFence.row(currentHost, drawnTarget),
            "the title/revision refresh must not hide the same owner row from Close")
        assertNotNull(AcceptedNavigation().acceptReturnedRow(TerminalTarget(host, run, "row-new"), 9, activation))
        val closeProof = ClientUiFixtures.FakeProof(UiActionTargetToken(UiProofScreen.SESSION_CLOSE, host,
            hostRunId = run, rowId = "row-new", generation = 1))
        val closeDialog = CloseSessionDialog(SessionActionTarget.of(fresh), closeProof)
        assertSame(closeDialog, CloseResultFence.matching(closeDialog, closeProof, host, run))
    }

    @Test fun focusOrPauseAfterTheFormsNormalClosureCancelsDelayedNavigation() {
        val form = dialog()
        val activation = assertNotNull(capture(form = form))
        admitted(activation)
        // The owner started the row, the controller intentionally closed its form, and
        // the continuation is waiting for the returned CURRENT row.
        assertNotNull(activation.started(settled(), form))
        assertTrue(activation.mayActivate)
        activation.focusLost()
        assertFalse(activation.mayActivate, "pause or window-focus loss retires the delayed activation")
        assertNull(activation.returnedRow)
        val target = TerminalTarget(host, run, "row-new")
        assertFalse(activation.claim(target, 9))
        assertNull(AcceptedNavigation().acceptReturnedRow(target, 9, activation),
            "a later resume and matching CURRENT row must not resurrect navigation")
    }

    @Test fun cancellationIsPermanentAndAcceptedMetadataIsExact() {
        val form = dialog()
        val activation = assertNotNull(capture(form = form))
        admitted(activation)
        assertNotNull(activation.started(settled(), form))
        activation.cancel()
        assertFalse(activation.authorizes(TerminalTarget(host, run, "row-new"), 9))
        assertNull(AcceptedNavigation().acceptReturnedRow(TerminalTarget(host, run, "row-new"), 9, activation))

        for (pending in listOf(
            null,
            RosterPendingOperation(RosterOperationKind.CLOSE, request, run, rowId = "row-1", deadlineAtMs = 100),
            RosterPendingOperation(RosterOperationKind.CREATE, request, run, sequence = null, deadlineAtMs = 100),
            RosterPendingOperation(RosterOperationKind.CREATE, "foreign-request", run, sequence = 1, deadlineAtMs = 100),
            RosterPendingOperation(RosterOperationKind.CREATE, request, "foreign-run", sequence = 1, deadlineAtMs = 100),
        )) {
            val candidate = dialog(submittedFormProof())
            val next = assertNotNull(capture(form = candidate))
            admitted(next, pending)
            assertNull(next.started(settled(), candidate), pending.toString())
        }
    }

    private fun submittedFormProof(): MutableUiActionProof = newProof()
}
