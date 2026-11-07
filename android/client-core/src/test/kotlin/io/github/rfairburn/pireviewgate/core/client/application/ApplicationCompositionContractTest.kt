package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy
import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.runtime.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.client.runtime.TerminalTarget
import io.github.rfairburn.pireviewgate.core.hosts.*
import io.github.rfairburn.pireviewgate.core.protocol.roster.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlin.test.*

/** Deterministic portable application admission, projection and provenance contracts. */
class ApplicationCompositionContractTest {
    private val host = HostId.parse("opaque-host")
    private fun proof(row: String = "row-1") = MutableUiActionProof(UiActionTargetToken(UiProofScreen.SESSION_CLOSE, host,
        hostRunId = "run-1", rowId = row, generation = 1)).also {
        val epoch = it.beginDraw(); it.setCriticalIdentityReadable(true); it.markCommitted(epoch)
    }

    @Test fun frozenEpochCannotReviveAfterRearm() {
        val original = proof()
        val frozen = assertNotNull(FrozenAction.capture(original))
        original.invalidate(UiProofInvalidationReason.LAYOUT_CHANGE)
        val next = original.beginDraw()
        original.setCriticalIdentityReadable(true)
        original.markCommitted(next)
        assertTrue(original.grantsAction())
        assertFalse(frozen.isStillCurrent())
    }

    @Test fun ownerProofRemainsTheActualFormUntilInvalidated() {
        val form = proof()
        val frozen = assertNotNull(FrozenAction.capture(form))
        repeat(64) { assertTrue(frozen.isStillCurrent()) }
        form.invalidate(UiProofInvalidationReason.COVERAGE_CHANGE)
        assertFalse(frozen.isStillCurrent())
        form.markCommitted(form.beginDraw())
        assertFalse(frozen.isStillCurrent())
    }

    @Test fun uncommittedOrUnreadableClicksCannotMintNavigation() {
        val nav = AcceptedNavigation()
        val uncommitted = MutableUiActionProof(proof().target)
        assertNull(FrozenAction.capture(uncommitted))
        val p = proof()
        p.setCriticalIdentityReadable(false)
        assertNull(FrozenAction.capture(p))
        assertNull(nav.wanted())
    }

    @Test fun acceptedNavigationIsDistinctFromDisposedRowProof() {
        val nav = AcceptedNavigation()
        val p = proof()
        val frozen = assertNotNull(FrozenAction.capture(p))
        val target = TerminalTarget(host, "run-1", "row-1")
        val wanted = assertNotNull(nav.accept(target, 9, frozen))
        p.invalidate(UiProofInvalidationReason.DISMISSED)
        assertFalse(frozen.isStillCurrent(), "owner writes may not inherit navigation authority")
        assertTrue(nav.isCurrent(wanted), "an admitted navigation may now measure its REAL surface")
        assertEquals(9L, wanted.connectionGeneration)
        nav.cancel()
        assertFalse(nav.isCurrent(wanted))
        assertNull(nav.accept(target, 9, frozen), "queued stale clicks cannot mint a new transaction")
    }

    @Test fun newerSelectionAndLifecycleCancellationNeverResurrectOldSelection() {
        val nav = AcceptedNavigation()
        val a = assertNotNull(nav.accept(TerminalTarget(host, "run-1", "row-1"), 1, assertNotNull(FrozenAction.capture(proof()))))
        val b = assertNotNull(nav.accept(TerminalTarget(host, "run-1", "row-2"), 2, assertNotNull(FrozenAction.capture(proof("row-2")))))
        assertFalse(nav.isCurrent(a)); assertTrue(nav.isCurrent(b))
        nav.cancel() // The synchronous background/window retirement hook.
        assertFalse(nav.isCurrent(a)); assertFalse(nav.isCurrent(b))
    }

    @Test fun everyInvalidationRetiresFrozenCallbacksWithoutStarvingAnotherTarget() {
        for (reason in UiProofInvalidationReason.entries) {
            val a = proof(); val b = proof("row-2")
            val frozenA = assertNotNull(FrozenAction.capture(a))
            val frozenB = assertNotNull(FrozenAction.capture(b))
            a.invalidate(reason)
            val next = a.beginDraw(); a.setCriticalIdentityReadable(true); a.markCommitted(next)
            assertFalse(frozenA.isStillCurrent(), reason.name)
            assertTrue(frozenB.isStillCurrent(), "unrelated row retained its own epoch")
        }
    }

    @Test fun navigationAdmissionIsTargetScoped() {
        val nav = AcceptedNavigation()
        val click = assertNotNull(FrozenAction.capture(proof()))
        assertNull(nav.accept(TerminalTarget(host, "different-run", "row-1"), 1, click))
        assertNull(nav.accept(TerminalTarget(HostId.parse("another-host"), "run-1", "row-1"), 1, click))
        assertNull(nav.accept(TerminalTarget(host, "run-1", "another-row"), 1, click))
    }

    private fun registry(generation: Long = 1): ConnectionRegistrySnapshot = ConnectionRegistrySnapshot(
        generation, 0, true, false, true, DeviceIdentityObservation.NeverInitialized,
        StorageObservation(StorageHandleState(true), StorageHandleState(true)),
        listOf(HostConnectionSnapshot(host, Endpoint("192.0.2.1", 8443), "Owner", HostConnectionPhase.CONNECTED,
            HostConnectionReason.NONE, generation, true, false, false, null)), emptyList(), null)

    private fun roster(generation: Long, projection: RosterProjection): HostRuntimeState {
        val empty = RosterClientEndpoint(host.value, generation, clock = { 0 }, idFactory = { "id" }).state()
        return HostRuntimeState(host, generation, HostLanePhase.ATTACHED,
            empty.copy(phase = RosterClientPhase.SUBSCRIBED, projection = projection,
                capabilities = listOf(RosterWire.CLOSE_CAPABILITY)))
    }
    private fun runtime(vararg hosts: HostRuntimeState) = ClientRuntimeState(hosts.toList(), null, null, null, false,
        VisibilitySnapshot(true, false), null, ContentInputPolicy(true, 0), false, false)
    private fun complete(rows: List<RemoteSessionMetadata>) = RosterProjection(RosterProjectionState.CURRENT,
        rows, "run-1", 4, "subscription-opaque", null)

    /**
     * One delivered row, decoded exactly as the protocol lane decodes every snapshot
     * row. Counts and activity arrive as wire text so a decoding default is caught
     * rather than agreed with.
     */
    private fun deliveredRow(
        id: String,
        activity: String = "[\"Ready\"]",
        activeTasks: String = "null",
        activeShells: String = "null",
        backgroundTasks: String = "null",
        backgroundShells: String = "null",
    ): RemoteSessionMetadata = assertNotNull(
        RosterMetadataRow.parse(
            Json.parseToJsonElement(
                """{"id":"$id","rosterSlotId":"slot-$id","label":"Row $id","workspace":"/srv/owner/work-$id",""" +
                    """"lifecycle":"alive","hasLiveProcess":true,"busy":false,"pendingInput":false,""" +
                    """"inputSurface":false,"activity":$activity,"nativeSession":null,""" +
                    """"backgroundTasks":$backgroundTasks,"backgroundShells":$backgroundShells,""" +
                    """"activeTasks":$activeTasks,"activeShells":$activeShells}""",
            ),
        ),
    )

    @Test fun deliveredActivityCountsReachTheCardFactsIndependently() {
        val delivered = listOf(
            deliveredRow(
                "zero", activity = "[]", activeTasks = "0", activeShells = "0",
                backgroundTasks = "9", backgroundShells = "8",
            ),
            deliveredRow(
                "partial", activity = "[\"Working\"]", activeTasks = "null", activeShells = "3",
                backgroundTasks = "5", backgroundShells = "null",
            ),
            deliveredRow(
                "positive", activity = "[\"Ready\"]", activeTasks = "2", activeShells = "1",
                backgroundTasks = "0", backgroundShells = "0",
            ),
        )
        val projected = ClientProjection()
            .hosts(registry(), runtime(roster(1, complete(delivered))))
            .single().rows

        // The numeric card facts are the delivered activity-intent counts, each on its
        // own: zero is a count, a missing member stays unknown, and they are independent.
        assertEquals(
            listOf(
                SessionCardBackground.Counts(0L, 0L),
                SessionCardBackground.Counts(null, 3L),
                SessionCardBackground.Counts(2L, 1L),
            ),
            projected.map { sessionCardBackground(it.metadata) },
        )
        // Ownership counts are a different fact and never become intent counts.
        assertEquals(listOf(9L, 5L, 0L), projected.map { it.metadata.backgroundTasks })
        assertEquals(listOf(8L, null, 0L), projected.map { it.metadata.backgroundShells })
        // The compact card line is the delivered nonblank line; an empty delivery invents none.
        assertEquals(listOf(null, "Working", "Ready"), projected.map { sessionCardActivityLine(it.metadata) })
        // Decoding and projection added nothing to the delivered rows.
        assertEquals(delivered, projected.map { it.metadata })
    }

    @Test fun deliveredCountAndActivityUpdatesKeepTheCardIdentity() {
        val projection = ClientProjection()
        val first = projection.hosts(
            registry(1), runtime(roster(1, complete(listOf(deliveredRow("row-1", activity = "[\"Ready\"]"))))),
        ).single().rows.single()
        val second = projection.hosts(
            registry(2),
            runtime(
                roster(
                    2,
                    complete(
                        listOf(
                            deliveredRow(
                                "row-1", activity = "[\"Working\"]", activeTasks = "1", activeShells = "0",
                            ),
                        ),
                    ),
                ),
            ),
        ).single().rows.single()

        assertEquals(SessionRowKey.of(first), SessionRowKey.of(second))
        assertEquals(first.presentationIdentity, second.presentationIdentity)
        assertEquals(SessionCardBackground.Counts(1L, 0L), sessionCardBackground(second.metadata))
        assertEquals("Working", sessionCardActivityLine(second.metadata))
    }

    @Test fun completeMetadataIsNotReconstructedAndUnknownIsNotZero() {
        val metadata = ClientUiFixtures.row("opaque-host", nativeSession = ClientUiFixtures.nativeSession(),
            busy = null, pendingInput = null, activeTasks = null, activeShells = null,
            backgroundTasks = 42, backgroundShells = 7, exitCode = null, error = null, rosterSlotId = "opaque-slot").metadata
        val state = ClientProjection().hosts(registry(), runtime(roster(1, complete(listOf(metadata))))).single()
        assertSame(metadata, state.rows.single().metadata)
        assertEquals(AgentActivity.UNKNOWN, state.rows.single().agentActivity)
        assertNull(state.rows.single().metadata.activeTasks)
        assertEquals(42L, state.rows.single().metadata.backgroundTasks)
        assertEquals(CapabilityStatus.SUPPORTED, state.capabilities.close)
        assertEquals(CapabilityStatus.UNSUPPORTED, state.capabilities.create)
        assertNull(state.capabilities.minor, "an unpublished minor must not become zero")
        assertEquals(SavedPolicyStatus.UNKNOWN, state.savedPolicy)
    }

    @Test fun replacementEmptyChannelRetainsCompleteRowsAsStale() {
        val projection = ClientProjection()
        val row = ClientUiFixtures.row("opaque-host").metadata
        assertFalse(projection.hosts(registry(), runtime(roster(1, complete(listOf(row))))).single().rows.single().stale)
        val replaced = projection.hosts(registry(2), runtime(roster(2, RosterProjection.EMPTY))).single()
        assertTrue(replaced.rows.single().stale)
        assertSame(row, replaced.rows.single().metadata)
        assertEquals(RosterFreshness.STALE, replaced.roster?.freshness)
        val knownEmpty = projection.hosts(registry(2), runtime(roster(2, complete(emptyList())))).single()
        assertEquals(RosterFreshness.CURRENT, knownEmpty.roster?.freshness)
        assertTrue(knownEmpty.rows.isEmpty())
    }

    @Test fun oldGenerationProjectionCannotBePresentedAsReplacementCurrent() {
        val projection = ClientProjection()
        val row = ClientUiFixtures.row("opaque-host").metadata
        projection.hosts(registry(), runtime(roster(1, complete(listOf(row)))))
        val late = projection.hosts(registry(2), runtime(roster(1, complete(emptyList())))).single()
        assertEquals(1, late.rows.size)
        assertTrue(late.isStale)
    }

    @Test fun neverKnownIsNotAnEmptyCompleteRoster() {
        val hostState = ClientProjection().hosts(registry(), runtime()).single()
        assertNull(hostState.roster)
        assertIs<EmptyHostRow.NeverReported>(emptyHostRows(listOf(hostState)).single())
        assertEquals(CapabilityStatus.UNKNOWN, hostState.capabilities.close)
    }

    private data class Admitted(val pending: RosterPendingOperation?)

    @Test fun savedSettlementBeforeAdmissionRetainsExactSameStepSequence() {
        val correlation = OperationCorrelation<Admitted>()
        val key = OperationKey(host, 8, RosterOperationKind.SAVED_LIST, "opaque-request")
        val settlement = RosterClientEvent.OperationSettled(key.kind, key.requestId, "run-1",
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedWindow(RosterSavedWindowFacts.Complete(
                "run-1", "opaque-catalog", "opaque-result", 0, 0, 0, emptyList()))))
        val pending = RosterPendingOperation(key.kind, key.requestId, "run-1", sequence = 17, deadlineAtMs = 99)
        correlation.begin(host, 8)
        assertNull(correlation.settle(key, settlement))
        val joined = assertNotNull(correlation.accept(key, Admitted(pending)))
        assertSame(pending, joined.first.pending)
        assertEquals(17L, joined.first.pending?.sequence)
        assertSame(settlement, joined.second)
        correlation.end(host, 8)
    }

    @Test fun nullPendingSameStepSettlementIsCorrelatedWithoutInventingPending() {
        val correlation = OperationCorrelation<Admitted>()
        val key = OperationKey(host, 9, RosterOperationKind.SAVED_SEARCH, "same-step")
        val settlement = RosterClientEvent.OperationSettled(key.kind, key.requestId, "run-1", RosterRequestResult.NotSent(RosterNotSentReason.TARGET_UNAVAILABLE))
        correlation.begin(host, 9)
        correlation.settle(key, settlement)
        val joined = assertNotNull(correlation.accept(key, Admitted(null)))
        assertNull(joined.first.pending)
        assertSame(settlement, joined.second)
        correlation.end(host, 9)
    }

    @Test fun requestIdsDoNotCrossHostsGenerationsOrKinds() {
        val correlation = OperationCorrelation<String>()
        val key = OperationKey(host, 2, RosterOperationKind.RENAME, "opaque-request")
        correlation.begin(host, 2)
        correlation.accept(key, "this form")
        val event = RosterClientEvent.OperationSettled(key.kind, key.requestId, "run-1", RosterRequestResult.Unknown)
        assertNull(correlation.settle(key.copy(channelGeneration = 1), event))
        assertNull(correlation.settle(key.copy(hostId = HostId.parse("another-host")), event))
        assertNull(correlation.settle(key.copy(kind = RosterOperationKind.CLOSE), event))
        assertEquals("this form", correlation.settle(key, event)?.first)
        correlation.end(host, 2)
    }

    @Test fun oneWantedStreamAndNoLifecycleOrPolicyReplay() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        try {
            val (channel, _) = harness.attach("opaque-host")
            val (other, _) = harness.attach("independent-host")
            harness.subscribed("opaque-host", channel)
            harness.subscribed("independent-host", other)
            harness.publishSnapshot(channel, listOf(RosterClientHarness.row("row-1"), RosterClientHarness.row("row-2")))
            harness.publishSnapshot(other, emptyList())
            harness.runtime.setViewport(60, 18)
            val nav = AcceptedNavigation()
            val a = assertNotNull(nav.accept(TerminalTarget(host, "run-1", "row-1"), 1, assertNotNull(FrozenAction.capture(proof()))))
            assertIs<SelectionResult.Selected>(harness.runtime.selectTerminal(a.target, RosterUiProof { nav.isCurrent(a) }))
            harness.settle()
            val b = assertNotNull(nav.accept(TerminalTarget(host, "run-1", "row-2"), 1, assertNotNull(FrozenAction.capture(proof("row-2")))))
            assertIs<SelectionResult.Selected>(harness.runtime.selectTerminal(b.target, RosterUiProof { nav.isCurrent(b) }))
            assertEquals(b.target, harness.runtime.state.value.pendingSelection)
            assertFalse(nav.isCurrent(a))
            harness.settle()
            assertEquals(b.target, harness.runtime.state.value.selection?.target)
            val opens = harness.openedContentChannels.size
            nav.cancel()
            harness.runtime.setAppForeground(false)
            assertNull(harness.runtime.state.value.selection)
            harness.runtime.updateInputPolicy(ContentInputPolicy(false, 1))
            harness.runtime.updateInputPolicy(ContentInputPolicy(true, 2))
            harness.runtime.setAppForeground(true)
            harness.settle()
            assertNull(harness.runtime.state.value.selection)
            assertEquals(opens, harness.openedContentChannels.size)
            assertEquals(2, harness.runtime.state.value.attachedHosts.size)
            assertTrue(channel.rosterFrames().none { it is RosterFrame.CloseRequest })
            assertTrue(other.rosterFrames().none { it is RosterFrame.CloseRequest })
        } finally { harness.closeRuntime() }
    }

    @Test fun actualPaneMeasurementIsRequiredAndCancelledNavigationDoesNotOpenLater() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        try {
            harness.runtime.setAppForeground(false)
            harness.runtime.setTerminalInputCoverage(false)
            val (channel, _) = harness.attach("opaque-host")
            harness.subscribed("opaque-host", channel)
            harness.publishSnapshot(channel, listOf(RosterClientHarness.row("row-1")))
            harness.runtime.setAppForeground(true)
            val nav = AcceptedNavigation()
            val wanted = assertNotNull(nav.accept(TerminalTarget(host, "run-1", "row-1"), 1, assertNotNull(FrozenAction.capture(proof()))))
            val lifetime = RosterUiProof { nav.isCurrent(wanted) && harness.runtime.state.value.visibility.appForeground }
            assertNull(harness.runtime.state.value.viewport)
            assertEquals(SelectionResult.Refused(SelectionRefusal.NO_VIEWPORT), harness.runtime.selectTerminal(wanted.target, lifetime))
            assertTrue(harness.openedContentChannels.isEmpty())
            nav.cancel()
            harness.runtime.setViewport(60, 18) // Only the simulated real surface callback, never startup.
            assertEquals(SelectionResult.Refused(SelectionRefusal.PROOF_UNAVAILABLE), harness.runtime.selectTerminal(wanted.target, lifetime))
            harness.settle()
            assertTrue(harness.openedContentChannels.isEmpty())
        } finally { harness.closeRuntime() }
    }
}
