package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliTarget
import io.github.rfairburn.pireviewgate.core.protocol.native.SessionBackend
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCreateFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerNativeRenameFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterProtocol
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** Synthetic native create and host-caption operations through the real endpoint. */
class RosterNativeOperationsTest {

    private val target = NativeCliTarget("claude-default", NativeCliBackend.CLAUDE, "Claude default")
    private val codex = NativeCliTarget("codex-review", NativeCliBackend.CODEX, "Codex review")

    private fun nativeRow(id: String = "row-1", backend: SessionBackend = SessionBackend.CLAUDE): RemoteSessionMetadata =
        RosterClientHarness.row(id).copy(backend = backend)

    private fun formProof(
        harness: RosterClientHarness,
        run: String = RosterClientHarness.RUN_ID,
        workspace: String = "/srv/owner/work",
        backend: NativeCliBackend = NativeCliBackend.CLAUDE,
        targetId: String = "claude-default",
        catalogScope: NativeCatalogScope = harness.endpoint.state().projection.nativeCatalogScope
            ?.copy(hostRunId = run)
            ?: NativeCatalogScope(run, harness.generation, 0L),
    ): RosterSendProof.NativeForm = RosterSendProof.NativeForm(
        harness.generation, run, workspace, backend, targetId, catalogScope, RosterClientHarness.TRUE_PROOF,
    )

    private fun nativeCreate(
        harness: RosterClientHarness,
        run: String = RosterClientHarness.RUN_ID,
        workspace: String = "/srv/owner/work",
        backend: NativeCliBackend = NativeCliBackend.CLAUDE,
        targetId: String = "claude-default",
    ): RosterNativeCreateCommand = RosterNativeCreateCommand(
        run, workspace, backend, targetId, formProof(harness, run, workspace, backend, targetId),
    )

    private fun subscribedWithCatalog(
        harness: RosterClientHarness = RosterClientHarness(),
        revision: Long = 1L,
        rows: List<RemoteSessionMetadata> = listOf(nativeRow()),
        targets: List<NativeCliTarget>? = listOf(target, codex),
    ): RosterClientHarness {
        harness.subscribed()
        harness.publishSnapshot(revision = revision, rows = rows, nativeCliTargets = targets)
        return harness
    }

    @Test
    fun `catalog commits atomically with rows and a native create sends the exact wire`() {
        val harness = subscribedWithCatalog()
        assertEquals(listOf(target, codex), harness.endpoint.state().projection.nativeCliTargets)

        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        val frame = assertIs<RosterFrame.NativeCreateRequest>(harness.sends.last().frame)
        assertEquals(RosterClientHarness.RUN_ID, frame.hostRunId)
        assertEquals("/srv/owner/work", frame.workspace)
        assertEquals(NativeCliBackend.CLAUDE, frame.backend)
        assertEquals("claude-default", frame.targetId)
        assertEquals(1L, frame.sequence)
        assertEquals(frame.requestId, harness.endpoint.state().pending.single { it.kind == RosterOperationKind.CREATE }.requestId)
        harness.drain()

        harness.deliver(RosterFrame.NativeCreateResult(frame.requestId, OwnerCreateFacts.Started(
            RosterClientHarness.RUN_ID, "row-9",
        )))
        val settled = harness.events.filterIsInstance<RosterClientEvent.OperationSettled>().single()
        assertEquals(RosterOperationKind.CREATE, settled.kind)
        assertIs<RosterRequestResult.OwnerResult>(settled.result)
    }

    @Test
    fun `native and Pi creates share one in-flight slot and one monotonic scalar`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        val first = assertIs<RosterFrame.NativeCreateRequest>(harness.sends.last().frame)
        val before = harness.sends.size

        harness.push(harness.endpoint.createSession(RosterCreateCommand(
            RosterClientHarness.RUN_ID, "/srv/owner/pi",
            RosterSendProof.Form(harness.generation, RosterClientHarness.RUN_ID, "/srv/owner/pi",
                RosterClientHarness.TRUE_PROOF),
        )))
        assertEquals(before, harness.sends.size)
        val refusal = harness.events.filterIsInstance<RosterClientEvent.OperationRefused>().last()
        assertEquals(RosterNotSentReason.BUSY, refusal.reason)

        harness.deliver(RosterFrame.NativeCreateResult(first.requestId, OwnerCreateFacts.Refused))
        harness.push(harness.endpoint.createSession(RosterCreateCommand(
            RosterClientHarness.RUN_ID, "/srv/owner/pi",
            RosterSendProof.Form(harness.generation, RosterClientHarness.RUN_ID, "/srv/owner/pi",
                RosterClientHarness.TRUE_PROOF),
        )))
        val second = assertIs<RosterFrame.CreateRequest>(harness.sends.last().frame)
        assertEquals(2L, second.sequence, "the Pi create must consume the NEXT shared attempt")
    }

    @Test
    fun `unchanged catalog on a later roster revision stays dispatchable`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        val index = harness.sends.lastIndex
        harness.publishSnapshot(
            revision = 2L,
            rows = listOf(nativeRow()),
            nativeCliTargets = listOf(target, codex),
        )
        assertEquals(RosterDispatchDecision.Allow, harness.decide(index))
        harness.report(index, RosterSendDisposition.Completed)
        val request = assertIs<RosterFrame.NativeCreateRequest>(harness.sends[index].frame)
        harness.deliver(RosterFrame.NativeCreateResult(request.requestId, OwnerCreateFacts.Refused))
        assertEquals(1, harness.events.filterIsInstance<RosterClientEvent.OperationSettled>().size)
    }

    @Test
    fun `a held native create is permanently invalidated by a label change`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        val index = harness.sends.lastIndex
        harness.publishSnapshot(
            revision = 2L,
            rows = listOf(nativeRow()),
            nativeCliTargets = listOf(target.copy(label = "Renamed Claude"), codex),
        )
        assertEquals(
            RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE),
            harness.decide(index),
        )
        harness.report(index, RosterSendDisposition.NotDispatched(RosterSendRefusal.PROOF_UNAVAILABLE))
        val settled = harness.events.filterIsInstance<RosterClientEvent.OperationSettled>().single()
        assertEquals(RosterRequestResult.NotSent(RosterNotSentReason.TARGET_UNAVAILABLE), settled.result)
        assertEquals(1, harness.countOfType("create_native_request"))
    }

    @Test
    fun `a held native create is invalidated when the catalog changes but keeps the pair`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        val index = harness.sends.lastIndex
        harness.publishSnapshot(
            revision = 2L,
            rows = listOf(nativeRow()),
            nativeCliTargets = listOf(target, codex, NativeCliTarget("claude-extra", NativeCliBackend.CLAUDE, "Extra")),
        )
        assertEquals(
            RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE),
            harness.decide(index),
        )
    }

    @Test
    fun `withdrawal and identical re-advertisement cannot revive a held native create`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        val index = harness.sends.lastIndex
        harness.publishSnapshot(revision = 2L, rows = listOf(nativeRow()), nativeCliTargets = null)
        assertEquals(null, harness.endpoint.state().projection.nativeCatalogScope)
        harness.publishSnapshot(
            revision = 3L,
            rows = listOf(nativeRow()),
            nativeCliTargets = listOf(target, codex),
        )
        assertEquals(
            RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE),
            harness.decide(index),
        )
    }

    @Test
    fun `catalog change after dispatch does not cancel owner work`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        val index = harness.sends.lastIndex
        val request = assertIs<RosterFrame.NativeCreateRequest>(harness.sends[index].frame)
        harness.report(index, RosterSendDisposition.Completed)
        harness.publishSnapshot(
            revision = 2L,
            rows = listOf(nativeRow()),
            nativeCliTargets = listOf(target.copy(label = "Renamed after dispatch"), codex),
        )
        harness.deliver(RosterFrame.NativeCreateResult(request.requestId, OwnerCreateFacts.Started(
            RosterClientHarness.RUN_ID, "row-9",
        )))
        val settled = harness.events.filterIsInstance<RosterClientEvent.OperationSettled>().single()
        val facts = ((settled.result as RosterRequestResult.OwnerResult).outcome as RosterOwnerOutcome.Create).facts
        assertIs<OwnerCreateFacts.Started>(facts)
    }

    @Test
    fun `an old catalog scope cannot be admitted after the catalog changes`() {
        val harness = subscribedWithCatalog()
        val oldCommand = nativeCreate(harness)
        harness.publishSnapshot(
            revision = 2L,
            rows = listOf(nativeRow()),
            nativeCliTargets = listOf(target, codex, NativeCliTarget("claude-extra", NativeCliBackend.CLAUDE, "Extra")),
        )
        val before = harness.sends.size
        harness.push(harness.endpoint.createNativeSession(oldCommand))
        assertEquals(before, harness.sends.size)
        assertEquals(
            RosterNotSentReason.TARGET_UNAVAILABLE,
            harness.events.filterIsInstance<RosterClientEvent.OperationRefused>().last().reason,
        )
    }

    @Test
    fun `a stale or foreign catalog never falls back to Pi or a default target`() {
        val harness = subscribedWithCatalog()
        // A different owner run is a fresh snapshot and clears the previous catalog
        // until that run's own catalog arrives.
        harness.publishSnapshot(runId = "run-0002", revision = 2L, rows = listOf(nativeRow()), nativeCliTargets = null)
        val before = harness.sends.size
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness, run = "run-0002")))
        assertEquals(before, harness.sends.size)
        assertEquals(RosterNotSentReason.TARGET_UNAVAILABLE,
            harness.events.filterIsInstance<RosterClientEvent.OperationRefused>().last().reason)

        // An id advertised by the OTHER backend is not this backend's target.
        val fresh = subscribedWithCatalog()
        val freshBefore = fresh.sends.size
        fresh.push(fresh.endpoint.createNativeSession(nativeCreate(
            fresh, backend = NativeCliBackend.CODEX, targetId = "claude-default",
        )))
        assertEquals(freshBefore, fresh.sends.size)
        assertEquals(RosterNotSentReason.TARGET_UNAVAILABLE,
            fresh.events.filterIsInstance<RosterClientEvent.OperationRefused>().last().reason)

        // The wrong run is refused rather than retargeted at the current run.
        fresh.push(fresh.endpoint.createNativeSession(nativeCreate(fresh, run = "other-run")))
        assertEquals(freshBefore, fresh.sends.size)
        assertTrue(fresh.frames().none { it is RosterFrame.NativeCreateRequest })
    }

    @Test
    fun `native create result is correlated by request id and must name the current run`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        val request = assertIs<RosterFrame.NativeCreateRequest>(harness.sends.last().frame)
        harness.drain()

        harness.deliver(RosterFrame.NativeCreateResult("foreign-request",
            OwnerCreateFacts.Started(RosterClientHarness.RUN_ID, "row-1")))
        assertTrue(harness.endpoint.state().pending.any { it.kind == RosterOperationKind.CREATE })

        harness.deliver(RosterFrame.NativeCreateResult(request.requestId,
            OwnerCreateFacts.Started("other-run", "row-1")))
        val settled = harness.events.filterIsInstance<RosterClientEvent.OperationSettled>().single()
        assertEquals(RosterRequestResult.Unknown, settled.result)
    }

    @Test
    fun `channel loss clears the catalog and settles native work unknown without replay`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        harness.push(harness.endpoint.renameNativeSession(RosterNativeRenameCommand(
            RosterClientHarness.RUN_ID, "row-1", NativeCliBackend.CLAUDE, "Caption",
            RosterSendProof.NativeRowAction(harness.generation, RosterClientHarness.RUN_ID, "row-1",
                NativeCliBackend.CLAUDE, RosterClientHarness.TRUE_PROOF),
        )))
        harness.drain()
        harness.push(harness.endpoint.onChannelClosed())

        assertEquals(null, harness.endpoint.state().projection.nativeCliTargets)
        assertEquals(RosterProjectionState.STALE, harness.endpoint.state().projection.state)
        val settlements = harness.events.filterIsInstance<RosterClientEvent.OperationSettled>()
        assertEquals(2, settlements.size)
        assertTrue(settlements.all { it.result == RosterRequestResult.Unknown })
        assertEquals(2, harness.countOfType("create_native_request") + harness.countOfType("rename_native_request"))
    }

    @Test
    fun `a native host caption sends rename_native_request and no Pi tuple`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.renameNativeSession(RosterNativeRenameCommand(
            RosterClientHarness.RUN_ID, "row-1", NativeCliBackend.CLAUDE, "Review row",
            RosterSendProof.NativeRowAction(harness.generation, RosterClientHarness.RUN_ID, "row-1",
                NativeCliBackend.CLAUDE, RosterClientHarness.TRUE_PROOF),
        )))
        val frame = assertIs<RosterFrame.NativeRenameRequest>(harness.sends.last().frame)
        assertEquals("row-1", frame.rowId)
        assertEquals(NativeCliBackend.CLAUDE, frame.backend)
        assertEquals("Review row", frame.name)
        assertEquals(1L, frame.sequence)
        assertTrue(!RosterProtocol.encode(frame).decodeToString().contains("expectedSession"))
        harness.drain()

        harness.deliver(RosterFrame.NativeRenameResult(frame.requestId, OwnerNativeRenameFacts.RENAMED_IN_MEMORY))
        val settled = harness.events.filterIsInstance<RosterClientEvent.OperationSettled>().single()
        assertEquals(RosterOperationKind.NATIVE_RENAME, settled.kind)
        val facts = ((settled.result as RosterRequestResult.OwnerResult).outcome as RosterOwnerOutcome.NativeRename).facts
        assertEquals(OwnerNativeRenameFacts.RENAMED_IN_MEMORY, facts)
    }

    @Test
    fun `native caption eligibility and attempt scalar are separate from the Pi rename`() {
        val harness = subscribedWithCatalog()

        // The Pi rename capability is not the native-name capability. A channel that
        // acknowledged only the native create lane cannot accept a native caption.
        val createOnly = RosterClientHarness(offeredCapabilities = listOf(
            RosterWire.CLOSE_CAPABILITY,
            RosterWire.CREATE_CAPABILITY,
            RosterWire.RENAME_CAPABILITY,
            RosterWire.NATIVE_CAPABILITY,
        ))
        createOnly.start()
        createOnly.acknowledgeHandshake(listOf(
            RosterWire.REQUIRED_CAPABILITY,
            RosterWire.CREATE_CAPABILITY,
            RosterWire.RENAME_CAPABILITY,
            RosterWire.NATIVE_CAPABILITY,
        ))
        createOnly.push(createOnly.endpoint.subscribe())
        createOnly.publishSnapshot(rows = listOf(nativeRow()), nativeCliTargets = listOf(target))
        val before = createOnly.sends.size
        createOnly.push(createOnly.endpoint.renameNativeSession(RosterNativeRenameCommand(
            RosterClientHarness.RUN_ID, "row-1", NativeCliBackend.CLAUDE, "Caption",
            RosterSendProof.NativeRowAction(createOnly.generation, RosterClientHarness.RUN_ID, "row-1",
                NativeCliBackend.CLAUDE, RosterClientHarness.TRUE_PROOF),
        )))
        assertEquals(before, createOnly.sends.size)
        assertEquals(RosterNotSentReason.CAPABILITY_UNSUPPORTED,
            createOnly.events.filterIsInstance<RosterClientEvent.OperationRefused>().last().reason)

        // The same acknowledged lane still accepts the Pi conversation rename and
        // keeps its own scalar, which the native lane never reused above.
        harness.push(harness.endpoint.renameSession(RosterRenameCommand(
            RosterClientHarness.RUN_ID, "row-1", "session-row-1", 2L, "Pi name",
            RosterSendProof.RowAction(harness.generation, RosterClientHarness.RUN_ID, "row-1",
                expectedSessionId = "session-row-1", expectedSessionEpoch = 2L,
                ui = RosterClientHarness.TRUE_PROOF),
        )))
        assertEquals(1L, assertIs<RosterFrame.RenameRequest>(harness.sends.last().frame).sequence)
        assertEquals(0L, harness.endpoint.state().nativeRenameSequence)
    }

    @Test
    fun `native caption result is unknown after the observed backend moves`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.renameNativeSession(RosterNativeRenameCommand(
            RosterClientHarness.RUN_ID, "row-1", NativeCliBackend.CLAUDE, "Caption",
            RosterSendProof.NativeRowAction(harness.generation, RosterClientHarness.RUN_ID, "row-1",
                NativeCliBackend.CLAUDE, RosterClientHarness.TRUE_PROOF),
        )))
        val request = assertIs<RosterFrame.NativeRenameRequest>(harness.sends.last().frame)
        harness.drain()
        // The owner republishes the row under the other native backend before the
        // reply arrives: the old caption must not be reported as applied to this row.
        harness.publishSnapshot(
            revision = 2L,
            rows = listOf(nativeRow(backend = SessionBackend.CODEX)),
            nativeCliTargets = listOf(target, codex),
        )
        harness.deliver(RosterFrame.NativeRenameResult(request.requestId, OwnerNativeRenameFacts.RENAMED_DURABLE))
        val settled = harness.events.filterIsInstance<RosterClientEvent.OperationSettled>().single()
        assertEquals(RosterRequestResult.Unknown, settled.result)
    }

    @Test
    fun `Pi create and rename keep their exact frames with the native lane acknowledged`() {
        val harness = subscribedWithCatalog()
        harness.push(harness.endpoint.createSession(RosterCreateCommand(
            RosterClientHarness.RUN_ID, "/srv/owner/pi",
            RosterSendProof.Form(harness.generation, RosterClientHarness.RUN_ID, "/srv/owner/pi",
                RosterClientHarness.TRUE_PROOF),
        )))
        val create = assertIs<RosterFrame.CreateRequest>(harness.sends.last().frame)
        assertTrue(harness.sends.last().frame !is RosterFrame.NativeCreateRequest)
        harness.drain()
        harness.deliver(RosterFrame.CreateResult(create.requestId, OwnerCreateFacts.Refused))

        harness.push(harness.endpoint.renameSession(RosterRenameCommand(
            RosterClientHarness.RUN_ID, "row-1", "session-row-1", 2L, "Pi name",
            RosterSendProof.RowAction(harness.generation, RosterClientHarness.RUN_ID, "row-1",
                expectedSessionId = "session-row-1", expectedSessionEpoch = 2L,
                ui = RosterClientHarness.TRUE_PROOF),
        )))
        assertIs<RosterFrame.RenameRequest>(harness.sends.last().frame)
    }

    @Test
    fun `a snapshot that loses its catalog clears the previous selectable targets`() {
        val harness = subscribedWithCatalog()
        harness.publishSnapshot(revision = 2L, rows = listOf(nativeRow()), nativeCliTargets = null)
        assertEquals(RosterProjectionState.CURRENT, harness.endpoint.state().projection.state)
        assertEquals(null, harness.endpoint.state().projection.nativeCliTargets)
        val before = harness.sends.size
        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness)))
        assertEquals(before, harness.sends.size)
        assertEquals(RosterNotSentReason.TARGET_UNAVAILABLE,
            harness.events.filterIsInstance<RosterClientEvent.OperationRefused>().last().reason)
    }

    @Test
    fun `a typed row backend on a channel without the native lane fails closed`() {
        val harness = RosterClientHarness(offeredCapabilities = listOf(
            RosterWire.CLOSE_CAPABILITY, RosterWire.CREATE_CAPABILITY, RosterWire.RENAME_CAPABILITY,
        ))
        harness.start()
        harness.acknowledgeHandshake(listOf(
            RosterWire.REQUIRED_CAPABILITY, RosterWire.CREATE_CAPABILITY, RosterWire.RENAME_CAPABILITY,
        ))
        harness.push(harness.endpoint.subscribe())
        harness.publishSnapshot(rows = listOf(nativeRow()))
        val state = harness.endpoint.state()
        assertEquals(RosterProjectionState.EMPTY, state.projection.state)
        assertEquals(RosterStalenessReason.PROTOCOL_VIOLATION, state.projection.reason)
        assertTrue(harness.closeChannelCount >= 1)
    }

    @Test
    fun `a catalog on a channel that never negotiated the lane is a protocol failure`() {
        val harness = RosterClientHarness(offeredCapabilities = listOf(
            RosterWire.CLOSE_CAPABILITY, RosterWire.CREATE_CAPABILITY, RosterWire.RENAME_CAPABILITY,
        ))
        harness.start()
        harness.acknowledgeHandshake(listOf(
            RosterWire.REQUIRED_CAPABILITY, RosterWire.CREATE_CAPABILITY, RosterWire.RENAME_CAPABILITY,
        ))
        harness.push(harness.endpoint.subscribe())
        harness.publishSnapshot(rows = listOf(RosterClientHarness.row("row-1")), nativeCliTargets = listOf(target))
        val state = harness.endpoint.state()
        assertEquals(RosterProjectionState.EMPTY, state.projection.state)
        assertEquals(RosterStalenessReason.PROTOCOL_VIOLATION, state.projection.reason)
        assertEquals(null, state.projection.nativeCliTargets)
        assertTrue(harness.closeChannelCount >= 1)
    }
}
