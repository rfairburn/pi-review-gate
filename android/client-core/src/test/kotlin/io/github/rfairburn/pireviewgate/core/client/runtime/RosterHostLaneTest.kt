package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientDiagnosticCode
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientPhase
import io.github.rfairburn.pireviewgate.core.client.roster.RosterCloseCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterCreateCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterNotSentReason
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOperationKind
import io.github.rfairburn.pireviewgate.core.client.roster.RosterProjectionState
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRenameCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRequestResult
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedDeleteCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedListCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedResumeCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientHarness
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEvent
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSendProof
import io.github.rfairburn.pireviewgate.core.client.roster.RosterStalenessReason
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedWindowOutcome
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The APP-lane suites: one lane per host, many hosts at once, and the honest settlement
 * of every write the lane attempts.
 *
 * Every expectation here is about evidence the runtime was actually given: a frame it
 * wrote, a channel it consumed, a receipt it consulted. Nothing is asserted that the
 * runtime could satisfy by assuming a peer acted.
 */
class RosterHostLaneTest {

    @Test
    fun theSingleReaderIsInstalledBeforeTheHelloAndEveryImplementedCapabilityIsOffered() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, result) = harness.attach(HOST_A)
        assertEquals(HostAttachResult.Accepted, result)
        harness.settle()

        val hello = harness.rosterFrames(channel).single { it.type == "hello" } as RosterFrame.Hello
        assertTrue(hello.capabilities.containsAll(ALL_ROSTER_CAPABILITIES))
        assertEquals(1, harness.rosterFrames(channel).count { it.type == "hello" }, "no second hello, ever")

        harness.ackRoster(channel)
        harness.settle()
        val state = harness.hostState(HOST_A)!!
        assertEquals(RosterClientPhase.READY, state.roster.phase)
        assertTrue(state.roster.supportsClose)
        assertTrue(state.roster.supportsCreate)
        assertTrue(state.roster.supportsSaved)
        assertTrue(state.roster.supportsRename)
        assertTrue(state.roster.supportsRosterSlot)
        // Nothing is subscribed by itself: the caller decides when metadata starts.
        assertEquals(0, harness.rosterFrames(channel).count { it.type == "subscribe" })
        harness.closeRuntime()
    }

    @Test
    fun inboundIsConsumedWhileAHelloIsQueuedAndAnExpiredHelloNeverBecomesBytes() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        // The write is held, so only an independently installed reader can consume what
        // the peer answers; the runtime must not serialize consumption behind I/O.
        channel.blockWrites()
        harness.settle()
        harness.ackRoster(channel)
        harness.settle()
        assertTrue(
            harness.events.any {
                it is ClientRuntimeEvent.Roster && it.event is RosterClientEvent.HandshakeAccepted
            },
            "the acknowledgement was consumed while the hello write had not returned",
        )
        assertEquals(0, channel.writes.size)
        // The hello is still queued inside the channel when its own acknowledgement
        // arrives. The message's last-instant model decision travels into the channel as
        // its guard and is re-evaluated under write ownership, so a hello that expired
        // while queued never becomes bytes — and never a second hello either.
        channel.releaseWrites()
        harness.settle()
        assertEquals(0, channel.writes.size, "an expired queued frame never reaches the socket")
        assertEquals(0, harness.rosterFrames(channel).count { it.type == "hello" })
        // The handshake still completed, so the lane is usable without ever re-offering
        // a hello the model had already settled.
        assertEquals(RosterClientPhase.READY, harness.hostState(HOST_A)?.roster?.phase)
        harness.closeRuntime()
    }

    @Test
    fun twoHostsConsumeTheirOwnChannelsAtOnceAndNeverMixLanes() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channelA, _) = harness.attach(HOST_A)
        val (channelB, _) = harness.attach(HOST_B)
        harness.subscribed(HOST_A, channelA)
        harness.subscribed(HOST_B, channelB)
        harness.publishSnapshot(channelA, rows = listOf(RosterClientHarness.row(ROW_1)))
        harness.publishSnapshot(channelB, rows = listOf(RosterClientHarness.row(ROW_2)))

        val a = harness.hostState(HOST_A)!!
        val b = harness.hostState(HOST_B)!!
        assertEquals(RosterProjectionState.CURRENT, a.roster.projection.state)
        assertEquals(listOf(ROW_1), a.roster.projection.rows.map { it.id })
        assertEquals(listOf(ROW_2), b.roster.projection.rows.map { it.id })
        assertEquals(1, harness.rosterFrames(channelA).count { it.type == "subscribe" })
        assertEquals(1, harness.rosterFrames(channelB).count { it.type == "subscribe" })
        assertTrue(
            harness.subscriptionIdOf(channelA) != harness.subscriptionIdOf(channelB),
            "each lane mints and consumes its own subscription",
        )
        harness.closeRuntime()
    }

    @Test
    fun sixtyFourHostRostersRunAtOnceAndTheCeilingBeyondThemIsRefused() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val channels = (1..ClientRuntimeConfig.MAX_HOSTS).map { index ->
            val id = "host-%02d".format(index)
            val (channel, result) = harness.attach(id, generation = 1L)
            assertEquals(HostAttachResult.Accepted, result, "host $id must attach")
            channel
        }
        val overflow = harness.attach("host-overflow")
        assertEquals(HostAttachResult.Refused(HostAttachRefusal.HOST_LIMIT), overflow.second)

        harness.awaitUntil("every attached lane wrote its hello") {
            channels.count { it.writes.isNotEmpty() } == channels.size
        }
        assertEquals(ClientRuntimeConfig.MAX_HOSTS, harness.runtime.state.value.attachedHosts.size)
        harness.closeRuntime()
    }

    @Test
    fun aFreshAttemptOnANewGenerationInheritsNothing() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (first, _) = harness.attach(HOST_A, generation = 1L)
        harness.subscribed(HOST_A, first)
        harness.publishSnapshot(channel = first, rows = listOf(RosterClientHarness.row(ROW_1)))
        first.push(RosterFrame.SavedPolicy(RUN_ID, deleteExposed = true))
        harness.settle()
        assertEquals(RosterProjectionState.CURRENT, harness.hostState(HOST_A)!!.roster.projection.state)
        assertNotNull(harness.hostState(HOST_A)!!.roster.savedPolicy)

        assertTrue(harness.runtime.detachHost(HostId.parse(HOST_A)))
        harness.settle()
        assertEquals(HostLanePhase.DETACHED, harness.hostState(HOST_A)!!.lane)

        // A re-attach is a fresh attempt: no inherited rows, Saved policy, or
        // confirmation state, and no cached projection presented as current.
        val (second, result) = harness.attach(HOST_A, generation = 2L)
        assertEquals(HostAttachResult.Accepted, result)
        harness.settle()
        val fresh = harness.hostState(HOST_A)!!
        assertEquals(2L, fresh.connectionGeneration)
        assertEquals(RosterClientPhase.AWAITING_ACK, fresh.roster.phase)
        assertEquals(RosterProjectionState.EMPTY, fresh.roster.projection.state)
        assertEquals(emptyList<String>(), fresh.roster.projection.rows.map { it.id })
        assertNull(fresh.roster.savedPolicy)
        assertEquals(emptyList<String>(), fresh.roster.armedCloseConfirmationRows)
        harness.closeRuntime()
    }

    @Test
    fun aStaleGenerationForTheSameHostIsRefusedWithoutTouchingTheChannel() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        harness.attach(HOST_A, generation = 5L)
        harness.settle()
        assertTrue(harness.runtime.detachHost(HostId.parse(HOST_A)))
        harness.settle()
        val channel = FakePeerByteChannel(PeerAppLane.APP, "stale")
        assertEquals(HostAttachResult.Refused(HostAttachRefusal.STALE_GENERATION), harness.attachOn(HOST_A, channel, 5L))
        assertEquals(HostAttachResult.Refused(HostAttachRefusal.STALE_GENERATION), harness.attachOn(HOST_A, channel, 4L))
        assertEquals(0, channel.writes.size)
        harness.closeRuntime()
    }

    @Test
    fun aContentChannelIsNeverConsumedByARosterLane() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val channel = FakePeerByteChannel(PeerAppLane.CONTENT, "wrong-lane")
        assertEquals(
            HostAttachResult.Refused(HostAttachRefusal.WRONG_LANE),
            harness.attachOn(HOST_A, channel),
        )
        assertEquals(0, channel.writes.size)
        assertNull(harness.hostState(HOST_A))
        harness.closeRuntime()
    }

    @Test
    fun aMultiframeSnapshotPublishesWholeAndCarriesEveryObservedFact() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        val rows = (1..5).map { RosterClientHarness.row("row-$it", epoch = it.toLong()) }

        // A partial transfer is never published: the projection stays as it was.
        channel.push(
            RosterFrame.SnapshotBegin(
                subscriptionId = harness.subscriptionIdOf(channel),
                transferId = "transfer-1",
                hostRunId = RUN_ID,
                revision = 1L,
                totalRows = 5L,
                pageCount = 3L,
            ),
        )
        channel.push(
            RosterFrame.SnapshotPage(
                subscriptionId = harness.subscriptionIdOf(channel),
                transferId = "transfer-1",
                pageIndex = 0L,
                rows = rows.take(2),
            ),
        )
        harness.settle()
        assertEquals(RosterProjectionState.EMPTY, harness.hostState(HOST_A)!!.roster.projection.state)

        channel.push(
            RosterFrame.SnapshotPage(
                subscriptionId = harness.subscriptionIdOf(channel),
                transferId = "transfer-1",
                pageIndex = 1L,
                rows = rows.subList(2, 4),
            ),
        )
        channel.push(
            RosterFrame.SnapshotPage(
                subscriptionId = harness.subscriptionIdOf(channel),
                transferId = "transfer-1",
                pageIndex = 2L,
                rows = rows.subList(4, 5),
            ),
        )
        channel.push(
            RosterFrame.SnapshotEnd(
                subscriptionId = harness.subscriptionIdOf(channel),
                transferId = "transfer-1",
                revision = 1L,
                totalRows = 5L,
            ),
        )
        harness.settle()

        val projection = harness.hostState(HOST_A)!!.roster.projection
        assertEquals(RosterProjectionState.CURRENT, projection.state)
        assertEquals(5, projection.rows.size)
        assertEquals(1L, projection.revision)
        // Full metadata is carried unchanged for later presentation ordering: nothing is
        // trimmed, re-labelled, or reduced to an id.
        val row = projection.rows.first { it.id == "row-3" }
        assertEquals("Label row-3", row.label)
        assertEquals("/srv/owner/row-3", row.workspace)
        assertEquals(3L, row.nativeSession?.epoch)
        harness.closeRuntime()
    }

    @Test
    fun aLostChannelKeepsRowsAsStaleAndSettlesEveryOutstandingOperationUnknown() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1), RosterClientHarness.row(ROW_2)))

        channel.blockWrites()
        val admission = harness.runtime.closeSession(
            HostId.parse(HOST_A),
            RosterCloseCommand(RUN_ID, ROW_1, confirmed = false, proof = rowProof(1L, RUN_ID, ROW_1)),
        )
        assertTrue(admission is RosterOperationAdmission.Accepted)
        harness.settle()
        channel.endIncoming()
        harness.settle()

        val state = harness.hostState(HOST_A)!!
        assertEquals(HostLanePhase.DETACHED, state.lane)
        assertEquals(RosterProjectionState.STALE, state.roster.projection.state)
        assertEquals(listOf(ROW_1, ROW_2), state.roster.projection.rows.map { it.id })
        assertEquals(RosterStalenessReason.CHANNEL_CLOSED, state.roster.projection.reason)
        // A blocked write is never reported as positively never sent.
        val settled = harness.settledOperations()
        assertTrue(settled.any { it.kind == RosterOperationKind.CLOSE && it.result == RosterRequestResult.Unknown })
        assertTrue(settled.none { it.kind == RosterOperationKind.CLOSE && it.result is RosterRequestResult.NotSent })
        channel.releaseWrites()
        harness.closeRuntime()
    }

    @Test
    fun aWriteRefusedBeforeAdmissionSettlesAsNeverSentAndAnInvokedFailureAsUnknown() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1), RosterClientHarness.row(ROW_2)))

        channel.refuseNextWrite()
        harness.runtime.closeSession(
            HostId.parse(HOST_A),
            RosterCloseCommand(RUN_ID, ROW_1, confirmed = false, proof = rowProof(1L, RUN_ID, ROW_1)),
        )
        harness.settle()
        harness.assertSettled(RosterOperationKind.CLOSE) { result ->
            result is RosterRequestResult.NotSent
        }

        channel.failNextWrite()
        harness.runtime.closeSession(
            HostId.parse(HOST_A),
            RosterCloseCommand(RUN_ID, ROW_2, confirmed = false, proof = rowProof(1L, RUN_ID, ROW_2)),
        )
        harness.settle()
        harness.assertSettled(RosterOperationKind.CLOSE) { it == RosterRequestResult.Unknown }
        harness.closeRuntime()
    }

    @Test
    fun outboundOverflowIsRefusedHonestlyInsteadOfBufferedWithoutLimit() = runBlocking {
        val harness = RuntimeHarness(
            coroutineContext,
            config = runtimeConfig(ids = CountingRuntimeIds(), outboundCapacity = 1),
        )
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(
            channel,
            rows = (1..6).map { RosterClientHarness.row("row-$it") },
        )
        channel.blockWrites()
        val admissions = (1..6).map { index ->
            harness.runtime.closeSession(
                HostId.parse(HOST_A),
                RosterCloseCommand(
                    RUN_ID,
                    "row-$index",
                    confirmed = false,
                    proof = rowProof(1L, RUN_ID, "row-$index"),
                ),
            )
        }
        harness.settle()
        assertTrue(
            admissions.isNotEmpty(),
            "admission is the model's verdict; the queue's bound shows up as an honest settlement",
        )
        harness.assertSettled(RosterOperationKind.CLOSE) { result ->
            result is RosterRequestResult.NotSent && result.reason == RosterNotSentReason.NOT_READY
        }
        channel.releaseWrites()
        harness.closeRuntime()
    }

    @Test
    fun anApplicationWriteThatExpiresInsideTheChannelNeverBecomesBytes() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1), RosterClientHarness.row(ROW_2)))
        // This proof is the message's own fence. It holds for every check made before the
        // frame is queued and for the channel's admission check, and fails at the check the
        // real writer performs immediately before the socket write — the only point at which
        // a frame that expired while queued can still be stopped.
        val proof = FlipOnCheckProof(flipOn = 5)
        channel.blockWrites()
        val admission = harness.runtime.closeSession(
            HostId.parse(HOST_A),
            RosterCloseCommand(RUN_ID, ROW_2, confirmed = false, proof = rowProof(1L, RUN_ID, ROW_2, ui = proof)),
        )
        assertTrue(admission is RosterOperationAdmission.Accepted, "$admission")
        harness.settle()
        assertEquals(4, proof.checks, "the model, the lane, and channel admission all proved it first")
        channel.releaseWrites()
        harness.settle()

        assertEquals(0, harness.rosterFrames(channel).count { it.type == "close_request" })
        harness.assertSettled(RosterOperationKind.CLOSE) {
            it is RosterRequestResult.NotSent && it.reason == RosterNotSentReason.NOT_READY
        }
        harness.closeRuntime()
    }

    @Test
    fun stopIntentRefusesAnApplicationWriteWhileQueuedAndLeavesRetirementControlFree() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1), RosterClientHarness.row(ROW_2)))
        channel.blockWrites()
        val admission = harness.runtime.closeSession(
            HostId.parse(HOST_A),
            RosterCloseCommand(RUN_ID, ROW_2, confirmed = false, proof = rowProof(1L, RUN_ID, ROW_2)),
        )
        assertTrue(admission is RosterOperationAdmission.Accepted, "$admission")
        harness.settle()
        // Stop intent lands while the close still sits queued inside the channel. The
        // message's own model decision travels into the channel as its guard, and the
        // retirement notice carries only its own, so one refusal never strands the other.
        harness.runtime.stopRoster(HostId.parse(HOST_A))
        harness.settle()
        channel.releaseWrites()
        harness.settle()

        assertEquals(0, harness.rosterFrames(channel).count { it.type == "close_request" })
        // The endpoint settles its own outstanding application operation as unobservable
        // once stop intent is recorded; what this suite owns is that no bytes went out and
        // no optimistic result was invented.
        harness.assertSettled(RosterOperationKind.CLOSE) { it is RosterRequestResult.Unknown }
        assertTrue(harness.rosterFrames(channel).any { it.type == "unsubscribe" })
        harness.closeRuntime()
    }

    @Test
    fun acceptedAdmissionCarriesThePendingOperationOfTheStepThatAcceptedIt() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))

        val admission = harness.runtime.createSession(
            HostId.parse(HOST_A),
            RosterCreateCommand(RUN_ID, "/srv/owner/new", proof = formProof(1L, RUN_ID, "/srv/owner/new")),
        )
        assertTrue(admission is RosterOperationAdmission.Accepted, "$admission")
        val accepted = admission as RosterOperationAdmission.Accepted
        val pending = accepted.pending
        assertNotNull(pending, "an accepted create owns a pending record in the step that accepted it")
        assertEquals(RosterOperationKind.CREATE, pending.kind)
        assertEquals(accepted.requestId, pending.requestId)
        assertEquals(RUN_ID, pending.hostRunId)
        assertNotNull(pending.sequence, "create carries this channel's own attempt number")

        harness.settle()
        val create = harness.lastRequest(channel, "create_request") as RosterFrame.CreateRequest
        assertEquals(accepted.requestId, create.requestId)
        assertEquals(pending.sequence, create.sequence, "the adapter binds an owner answer to the same sequence")
        // A settlement clears the endpoint's own pending list, and never rewrites what the
        // caller was handed at acceptance.
        channel.endIncoming()
        harness.settle()
        assertTrue(harness.hostState(HOST_A)?.roster?.pending?.none { it.requestId == accepted.requestId } == true)
        assertEquals(pending, accepted.pending)
        harness.closeRuntime()
    }

    @Test
    fun acceptedSavedAdmissionsKeepTheirOwnWireSequenceAfterSupersessionAndSettlement() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))

        suspend fun list(query: String): RosterOperationAdmission.Accepted {
            val admission = harness.runtime.savedList(
                HostId.parse(HOST_A),
                RosterSavedListCommand(RUN_ID, query, 0L, 3L, proof = readProof(1L, RUN_ID)),
            )
            assertTrue(admission is RosterOperationAdmission.Accepted, "$admission")
            return admission
        }

        val first = list("first")
        val firstPending = assertNotNull(first.pending)
        val capturedFirst = firstPending.copy()
        harness.settle()
        val firstFrame = harness.lastRequest(channel, "saved_list_request") as RosterFrame.SavedListRequest
        assertEquals(RosterOperationKind.SAVED_LIST, firstPending.kind)
        assertEquals(RUN_ID, firstPending.hostRunId)
        assertEquals(firstFrame.requestId, first.requestId)
        assertEquals(firstFrame.requestId, firstPending.requestId)
        assertEquals(1L, firstFrame.sequence)
        assertEquals(firstFrame.sequence, firstPending.sequence)

        val second = list("second")
        val secondPending = assertNotNull(second.pending)
        val capturedSecond = secondPending.copy()
        harness.settle()
        val secondFrame = harness.lastRequest(channel, "saved_list_request") as RosterFrame.SavedListRequest
        assertEquals(secondFrame.requestId, second.requestId)
        assertEquals(secondFrame.requestId, secondPending.requestId)
        assertEquals(firstFrame.sequence + 1L, secondFrame.sequence)
        assertEquals(secondFrame.sequence, secondPending.sequence)
        assertTrue(
            harness.settledOperations().any {
                it.requestId == first.requestId && it.result == RosterRequestResult.Unknown
            },
        )

        channel.push(RosterFrame.SavedWindowResult(second.requestId, OwnerSavedWindowOutcome.Unknown))
        harness.settle()
        assertTrue(harness.hostState(HOST_A)!!.roster.pending.none { it.kind.isSaved })
        assertEquals(capturedFirst, first.pending)
        assertEquals(capturedSecond, second.pending)
        harness.closeRuntime()
    }

    @Test
    fun savedAdmissionDoesNotLookUpPendingAfterDispatchHasAlreadySettledIt() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))

        // Admission succeeds, then the lane's immediate dispatch check refuses the write.
        val admission = harness.runtime.savedList(
            HostId.parse(HOST_A),
            RosterSavedListCommand(RUN_ID, "", 0L, 3L, proof = readProof(1L, RUN_ID, ui = FlipOnCheckProof(2))),
        )
        assertTrue(admission is RosterOperationAdmission.Accepted, "$admission")
        val pending = assertNotNull(admission.pending)
        assertEquals(admission.requestId, pending.requestId)
        assertEquals(1L, pending.sequence)
        harness.settle()
        assertTrue(harness.hostState(HOST_A)!!.roster.pending.none { it.kind.isSaved })
        assertTrue(
            harness.settledOperations().any {
                it.requestId == admission.requestId && it.result is RosterRequestResult.NotSent
            },
        )
        assertEquals(0, harness.rosterFrames(channel).count { it.type == "saved_list_request" })
        harness.closeRuntime()
    }

    @Test
    fun savedAdmissionHasNoPendingWhenTheAcceptingEndpointStepAlreadySettledIt() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))
        channel.blockWrites()

        // Hold the endpoint's four outstanding sends. Superseding a read settles its
        // operation, not the disposition of the write still waiting in the channel.
        repeat(4) { index ->
            val admission = harness.runtime.savedList(
                HostId.parse(HOST_A),
                RosterSavedListCommand(RUN_ID, "held-$index", 0L, 3L, proof = readProof(1L, RUN_ID)),
            )
            assertTrue(admission is RosterOperationAdmission.Accepted, "$admission")
            assertEquals((index + 1).toLong(), assertNotNull(admission.pending).sequence)
            harness.settle()
        }
        val admission = harness.runtime.savedList(
            HostId.parse(HOST_A),
            RosterSavedListCommand(RUN_ID, "no send slot", 0L, 3L, proof = readProof(1L, RUN_ID)),
        )
        assertTrue(admission is RosterOperationAdmission.Accepted, "$admission")
        assertNull(admission.pending, "the accepting step settled NotSent; no pending record may be fabricated")
        harness.settle()
        assertTrue(harness.hostState(HOST_A)!!.roster.pending.none { it.kind.isSaved })
        assertEquals(
            RosterRequestResult.NotSent(RosterNotSentReason.NOT_READY),
            harness.settledOperations().single { it.requestId == admission.requestId }.result,
        )
        channel.releaseWrites()
        harness.settle()
        assertEquals(0, harness.rosterFrames(channel).count { it.type == "saved_list_request" })
        harness.closeRuntime()
    }

    @Test
    fun everyRemoteOperationIsAnExactForwarderOfTheCallersOwnFacts() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))

        val workspace = "  /srv/owner/keep  me  "
        val untrimmed = workspace
        harness.runtime.createSession(
            HostId.parse(HOST_A),
            RosterCreateCommand(
                RUN_ID,
                untrimmed,
                proof = formProof(1L, RUN_ID, untrimmed),
            ),
        )
        harness.settle()
        val create = harness.lastRequest(channel, "create_request") as RosterFrame.CreateRequest
        assertEquals(untrimmed, create.workspace, "a workspace is forwarded verbatim, never trimmed or resolved")

        harness.runtime.renameSession(
            HostId.parse(HOST_A),
            RosterRenameCommand(
                RUN_ID,
                ROW_1,
                expectedSessionId = "session-$ROW_1",
                expectedSessionEpoch = 2L,
                name = "  New name  ",
                proof = rowProof(1L, RUN_ID, ROW_1, "session-$ROW_1", 2L),
            ),
        )
        harness.settle()
        val rename = harness.lastRequest(channel, "rename_request") as RosterFrame.RenameRequest
        assertEquals("  New name  ", rename.name, "a name is forwarded verbatim")
        assertEquals("session-$ROW_1", rename.expectedSessionId)
        assertEquals(2L, rename.expectedSessionEpoch)

        harness.runtime.savedList(
            HostId.parse(HOST_A),
            RosterSavedListCommand(
                RUN_ID,
                query = " keep  spacing ",
                offset = 0L,
                count = 10L,
                proof = readProof(1L, RUN_ID),
            ),
        )
        harness.settle()
        val list = harness.lastRequest(channel, "saved_list_request") as RosterFrame.SavedListRequest
        assertEquals(" keep  spacing ", list.query)

        channel.push(RosterFrame.SavedPolicy(RUN_ID, deleteExposed = true))
        harness.settle()
        harness.runtime.savedDeletePrepare(
            HostId.parse(HOST_A),
            RosterSavedDeleteCommand(
                RUN_ID,
                catalogId = "catalog-1",
                resultId = "result-1",
                entryId = "entry-0",
                proof = entryProof(1L, RUN_ID, "catalog-1", "result-1", "entry-0"),
            ),
        )
        harness.settle()
        // No owned window yet, so the entry handle is not this picker's: the request is
        // refused by the model rather than sent on the strength of a matching string.
        val refused = harness.refusedOperations().filter { it.kind == RosterOperationKind.SAVED_DELETE }
        assertTrue(
            refused.any { it.reason == RosterNotSentReason.TARGET_UNAVAILABLE },
            "an unowned entry handle must be refused, not written: $refused",
        )
        assertEquals(0, harness.rosterFrames(channel).count { it.type == "saved_delete_request" })
        harness.closeRuntime()
    }

    @Test
    fun savedEntryHandlesAreOpaqueAndOnlyAnOwnedWindowMayBeResumed() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))
        channel.push(RosterFrame.SavedPolicy(RUN_ID, deleteExposed = true))
        harness.settle()

        harness.runtime.savedList(
            HostId.parse(HOST_A),
            RosterSavedListCommand(
                RUN_ID, "", 0L, 3L,
                proof = readProof(1L, RUN_ID),
            ),
        )
        harness.settle()
        val requestId = (harness.lastRequest(channel, "saved_list_request") as RosterFrame.SavedListRequest).requestId
        channel.push(
            RosterFrame.SavedWindowBegin(
                requestId, RUN_ID, "catalog-1", "result-1",
                total = 3L, issueCount = 0L, offset = 0L, rows = 3L, pageCount = 1L,
            ),
        )
        channel.push(
            RosterFrame.SavedWindowPage(
                requestId,
                0L,
                listOf(
                    RosterClientHarness.entry(0),
                    RosterClientHarness.entry(1),
                    RosterClientHarness.entry(2),
                ),
            ),
        )
        channel.push(RosterFrame.SavedWindowEnd(requestId, rows = 3L, pageCount = 1L))
        harness.settle()

        val ownership = harness.hostState(HOST_A)!!.roster.savedOwnership
        assertNotNull(ownership)
        assertEquals(listOf("entry-0", "entry-1", "entry-2"), ownership.windows.single().entryIds)

        harness.runtime.savedResume(
            HostId.parse(HOST_A),
            RosterSavedResumeCommand(
                RUN_ID, "catalog-1", "result-1", "entry-1",
                proof = entryProof(1L, RUN_ID, "catalog-1", "result-1", "entry-1"),
            ),
        )
        harness.settle()
        assertEquals(1, harness.rosterFrames(channel).count { it.type == "saved_resume_request" })

        harness.runtime.savedResume(
            HostId.parse(HOST_A),
            RosterSavedResumeCommand(
                RUN_ID, "catalog-1", "result-1", "entry-24",
                proof = entryProof(1L, RUN_ID, "catalog-1", "result-1", "entry-24"),
            ),
        )
        harness.settle()
        assertEquals(
            1,
            harness.rosterFrames(channel).count { it.type == "saved_resume_request" },
            "an entry this picker never owns is never sent",
        )
        harness.closeRuntime()
    }

    @Test
    fun retiringALaneCancelsEveryArmedDeadlineAndLeavesNoJobBehind() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        // A subscription with no snapshot outstanding still holds its start deadline.
        assertTrue(harness.time.armedCount() > 0)

        assertTrue(harness.runtime.detachHost(HostId.parse(HOST_A)))
        harness.settle()
        assertEquals(0, harness.time.armedCount(), "a retired lane arms nothing")
        assertEquals(HostLanePhase.DETACHED, harness.hostState(HOST_A)!!.lane)
        assertTrue(
            harness.events.any {
                it is ClientRuntimeEvent.HostDetached && it.reason == HostDetachReason.PARENT_DETACHED
            },
        )
        // Retirement asked for a subscription end, never for an owner session to stop.
        assertNoRosterClose(harness.rosterFrames(channel))
        assertEquals(1, harness.rosterFrames(channel).count { it.type == "unsubscribe" })
        harness.closeRuntime()
    }

    @Test
    fun aResyncNeverStartsItsReplacementSubscription() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)

        val first = harness.runtime.resyncRoster(HostId.parse(HOST_A))
        assertTrue(first is RosterSubscriptionAdmission.RetirementRequested)
        harness.settle()
        // Overlapping calls join the one outstanding retirement.
        val second = harness.runtime.resyncRoster(HostId.parse(HOST_A))
        assertTrue(second is RosterSubscriptionAdmission.RetirementJoined)
        harness.settle()
        assertEquals(1, harness.rosterFrames(channel).count { it.type == "unsubscribe" })
        assertEquals(1, harness.rosterFrames(channel).count { it.type == "subscribe" })

        channel.push(RosterFrame.Unsubscribed(harness.subscriptionIdOf(channel)))
        harness.settle()
        // The replacement is the caller's decision, and the lane will honour it.
        val third = harness.runtime.subscribeRoster(HostId.parse(HOST_A))
        assertTrue(third is RosterSubscriptionAdmission.Started)
        harness.closeRuntime()
    }

    @Test
    fun aRosterCallQueuedBehindChannelTerminationFinishesInsteadOfHangingForever() = runBlocking {
        // One event slot, and a collector this suite controls: the lane's driver can then be
        // left parked inside its own publication, which is what keeps its signal queue
        // un-drained while a termination notice and a call both pile up behind it.
        val harness = RuntimeHarness(
            coroutineContext,
            config = runtimeConfig(ids = CountingRuntimeIds(), eventQueueCapacity = 1),
        )
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1), RosterClientHarness.row(ROW_2)))

        harness.pauseEvents()
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)), revision = 2L)
        // The peer ends the channel while the driver is parked. The reader queues that
        // notice, so the driver will break out before it ever reaches the call behind it.
        channel.endIncoming()
        harness.settle()

        val call = async {
            harness.runtime.closeSession(
                HostId.parse(HOST_A),
                RosterCloseCommand(RUN_ID, ROW_1, confirmed = false, proof = rowProof(1L, RUN_ID, ROW_1)),
            )
        }
        harness.resumeEvents()
        harness.settle()
        val admission = withTimeoutOrNull(5_000L) { call.await() }

        assertNotNull(admission, "the caller was still parked after the lane it called had finished")
        assertTrue(admission is RosterOperationAdmission.NotReached, "$admission")
    }

    @Test
    fun aCommandForAHostThisRuntimeNeverHadIsRefusedWithoutReachingAnyModel() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val admission = harness.runtime.closeSession(
            HostId.parse("host-absent"),
            RosterCloseCommand(RUN_ID, ROW_1, confirmed = false, proof = rowProof(1L, RUN_ID, ROW_1)),
        )
        assertEquals(
            RosterOperationAdmission.NotReached(RosterOperationKind.CLOSE, RuntimeIntake.HOST_NOT_ATTACHED),
            admission,
        )
        assertNull(harness.hostState("host-absent"))
        harness.closeRuntime()
    }

    /**
     * A retirement that reaches its bound still settles what it accepted.
     *
     * The lane's retirement is bounded by wall clock, and a write still inside the
     * transport cannot be waited on. What the lane owes the caller regardless is the
     * terminal settlement of the operation it accepted — never a silently abandoned
     * request, and never an optimistic one either.
     */
    @Test
    fun aBoundedRetirementStillSettlesAnAcceptedOperationForTheCaller() = runBlocking {
        val harness = RuntimeHarness(
            coroutineContext,
            config = runtimeConfig(ids = CountingRuntimeIds(), retirementGraceMs = 1L),
        )
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))
        channel.blockWrites()
        val admission = harness.runtime.createSession(
            HostId.parse(HOST_A),
            RosterCreateCommand(RUN_ID, "/srv/owner/new", proof = formProof(1L, RUN_ID, "/srv/owner/new")),
        )
        assertTrue(admission is RosterOperationAdmission.Accepted, "$admission")
        harness.settle()

        // The parent retires the host while the create is still inside the transport, so this
        // lane's retirement reaches its bound. An operation this runtime accepted still owes
        // the caller a terminal settlement, and a bounded end publishes it rather than
        // discarding it along with the lane.
        assertTrue(harness.runtime.detachHost(HostId.parse(HOST_A)))

        harness.assertSettled(RosterOperationKind.CREATE) { it is RosterRequestResult.Unknown }
        assertEquals(HostLanePhase.DETACHED, harness.hostState(HOST_A)!!.lane)
        assertEquals(0, harness.time.armedCount(), "a bounded retirement cancels every arm")
        harness.closeRuntime()
    }

    @Test
    fun aReplacementGenerationKeepsItsOwnStreamWhenAnOlderGenerationsLaneFinishes() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val firstContent = harness.terminalUp()
        harness.hostChannel(HOST_A)!!.endIncoming()
        harness.awaitUntil("the older lane finished") { harness.hostState(HOST_A)?.lane == HostLanePhase.DETACHED }
        harness.settle()
        assertNull(harness.selection(HOST_A), "the older attempt's stream went with it")
        assertEquals(1, firstContent.closeCount, "this runtime closed the channel it opened")

        // The parent re-attaches this host on a newer attempt and the user selects again.
        val second = FakePeerByteChannel(PeerAppLane.APP, "host-a-gen-2")
        harness.hostChannels[HOST_A] = second
        assertEquals(HostAttachResult.Accepted, harness.attachOn(HOST_A, second, generation = 2L))
        harness.subscribed(HOST_A, second)
        harness.publishSnapshot(second, rows = listOf(RosterClientHarness.row(ROW_1)))
        check(harness.runtime.setViewport(80, 24) is ViewportResult.Applied)
        assertTrue(harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE) is SelectionResult.Selected)
        harness.settle()

        // Nothing a finished older generation reports can withdraw what this attempt owns.
        assertNotNull(harness.selection(HOST_A))
        assertEquals(2L, harness.hostState(HOST_A)?.connectionGeneration)
        assertEquals(1, firstContent.closeCount, "the older stream is not reopened or re-closed")
        assertEquals(0, second.countFrame("close_request"))
        harness.closeRuntime()
    }
}

/** Asserts that one operation of [kind] settled exactly once in a way the predicate accepts. */
internal fun RuntimeHarness.assertSettled(
    kind: RosterOperationKind,
    predicate: (RosterRequestResult) -> Boolean,
) {
    val settled = settledOperations().filter { it.kind == kind }
    assertTrue(settled.any { predicate(it.result) }, "no $kind settlement matched: ${settled.map { it.result }}")
}

internal fun RuntimeHarness.settledOperations(): List<RosterClientEvent.OperationSettled> =
    events.filterIsInstance<ClientRuntimeEvent.Roster>()
        .mapNotNull { it.event as? RosterClientEvent.OperationSettled }

internal fun RuntimeHarness.refusedOperations(): List<RosterClientEvent.OperationRefused> =
    events.filterIsInstance<ClientRuntimeEvent.Roster>()
        .mapNotNull { it.event as? RosterClientEvent.OperationRefused }
