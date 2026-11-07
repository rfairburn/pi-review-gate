package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterBounds
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterMetadataRow
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterProtocol
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWireErrorCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Handshake, subscription, atomic snapshot, freshness, and loss behaviour of the
 * roster client endpoint.
 *
 * Every value here is synthetic: no live owner run, row, workspace, or credential
 * appears in this file.
 */
internal class RosterClientEndpointTest {

    // ------------------------------------------------------------- handshake

    @Test
    fun `start offers the required baseline and every capability this implementation knows`() {
        val harness = RosterClientHarness()
        harness.start()

        val hello = harness.sends.single().frame as RosterFrame.Hello
        assertEquals(RosterWire.SERVICE, hello.service)
        assertEquals(RosterWire.MAJOR, hello.major)
        assertTrue(hello.capabilities.contains(RosterWire.REQUIRED_CAPABILITY))
        for (capability in RosterWire.KNOWN_OPTIONAL_CAPABILITIES) {
            assertTrue(hello.capabilities.contains(capability), "expected $capability to be offered")
        }
        // Deduplicated: the harness repeats Close and the frame must stay encodable.
        assertEquals(hello.capabilities.size, hello.capabilities.toSet().size)
        // Nothing but the hello leaves before an acknowledgement.
        assertEquals(1, harness.sends.size)
        assertTrue(harness.sends.single().frame is RosterFrame.Hello)
        assertTrue(harness.armed.keys.any { it.kind == RosterDeadlineKind.HANDSHAKE })
    }

    @Test
    fun `an acknowledgement narrows what this side may assume and never widens it`() {
        val harness = RosterClientHarness()
        harness.start()
        harness.acknowledgeHandshake(listOf(RosterWire.REQUIRED_CAPABILITY, RosterWire.CLOSE_CAPABILITY))

        val state = harness.endpoint.state()
        assertEquals(RosterClientPhase.READY, state.phase)
        assertEquals(listOf(RosterWire.REQUIRED_CAPABILITY, RosterWire.CLOSE_CAPABILITY), state.capabilities)
        assertTrue(state.supportsClose)
        assertFalse(state.supportsCreate)
        assertFalse(state.supportsSaved)
        assertFalse(state.supportsRename)
        assertNull(harness.armed.keys.firstOrNull { it.kind == RosterDeadlineKind.HANDSHAKE })
    }

    @Test
    fun `an acknowledgement claiming an unoffered capability fails the channel`() {
        val harness = RosterClientHarness(offeredCapabilities = listOf(RosterWire.CLOSE_CAPABILITY))
        harness.start()
        harness.deliver(
            RosterFrame.HelloAck(
                RosterWire.SERVICE,
                RosterWire.MAJOR,
                RosterWire.MINOR,
                listOf(RosterWire.REQUIRED_CAPABILITY, RosterWire.SAVED_CAPABILITY),
            ),
        )

        assertEquals(RosterClientPhase.FAILED, harness.endpoint.state().phase)
        assertEquals(
            RosterStalenessReason.HANDSHAKE_REFUSED,
            harness.endpoint.state().projection.reason,
        )
        assertTrue(harness.events.any { it is RosterClientEvent.HandshakeRefused })
    }

    @Test
    fun `a missing acknowledgement is a handshake timeout, not an empty roster`() {
        val harness = RosterClientHarness()
        harness.start()
        harness.fireDeadline(RosterDeadlineKind.HANDSHAKE)

        val state = harness.endpoint.state()
        assertEquals(RosterClientPhase.FAILED, state.phase)
        // The source marks a handshake timeout as not current, and with no rows ever
        // published it is a genuinely empty projection carrying an honest reason.
        assertEquals(RosterProjectionState.STALE, state.projection.state)
        assertEquals(RosterStalenessReason.HANDSHAKE_TIMEOUT, state.projection.reason)
        assertEquals(emptyList(), state.projection.rows)
        // The endpoint never retries on its own.
        assertEquals(1, harness.countOfType("hello"))
    }

    // ----------------------------------------------------------- subscription

    @Test
    fun `subscribe mints one subscription and arms the first-snapshot deadline`() {
        val harness = RosterClientHarness()
        harness.start()
        harness.acknowledgeHandshake(RosterClientHarness.ALL_CAPABILITIES)
        harness.push(harness.endpoint.subscribe())

        val subscription = harness.subscriptionId()
        assertEquals(RosterClientPhase.SUBSCRIBED, harness.endpoint.state().phase)
        assertEquals(subscription, harness.endpoint.state().subscriptionId)
        assertEquals(
            listOf(RosterClientEvent.SubscriptionStarted(subscription)),
            harness.events.filterIsInstance<RosterClientEvent.SubscriptionStarted>(),
        )
        assertTrue(harness.armed.keys.any { it.kind == RosterDeadlineKind.SNAPSHOT_START })
        // Control traffic carries no row, form, or picker epoch.
        assertTrue(harness.sends.all { it.proof is RosterSendProof.Control })
    }

    @Test
    fun `a second subscribe on a live channel is refused rather than queued`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.push(harness.endpoint.subscribe())

        assertEquals(
            listOf(RosterClientEvent.SubscriptionRefused(RosterSubscriptionRefusal.ALREADY_SUBSCRIBED)),
            harness.events.filterIsInstance<RosterClientEvent.SubscriptionRefused>(),
        )
        assertEquals(1, harness.countOfType("subscribe"))
    }

    @Test
    fun `subscribe before the acknowledgement is refused`() {
        val harness = RosterClientHarness()
        harness.start()
        harness.push(harness.endpoint.subscribe())

        assertEquals(
            listOf(RosterClientEvent.SubscriptionRefused(RosterSubscriptionRefusal.NOT_READY)),
            harness.events.filterIsInstance<RosterClientEvent.SubscriptionRefused>(),
        )
        assertEquals(0, harness.countOfType("subscribe"))
    }

    // ------------------------------------------------------- atomic snapshot

    @Test
    fun `rows become current only from a complete begin-page-end sequence`() {
        val harness = RosterClientHarness()
        val subscription = harness.subscribed()

        harness.deliver(
            RosterFrame.SnapshotBegin(subscription, "t-1", RosterClientHarness.RUN_ID, 3L, 2L, 2L),
        )
        // Nothing is published while a transfer is in flight.
        assertEquals(RosterProjectionState.EMPTY, harness.endpoint.state().projection.state)
        assertNotNull(harness.endpoint.state().inFlightTransfer)

        harness.deliver(RosterFrame.SnapshotPage(subscription, "t-1", 0L, listOf(RosterClientHarness.row("row-1"))))
        assertEquals(RosterProjectionState.EMPTY, harness.endpoint.state().projection.state)

        harness.deliver(RosterFrame.SnapshotPage(subscription, "t-1", 1L, listOf(RosterClientHarness.row("row-2"))))
        harness.deliver(RosterFrame.SnapshotEnd(subscription, "t-1", 3L, 2L))

        val projection = harness.endpoint.state().projection
        assertEquals(RosterProjectionState.CURRENT, projection.state)
        assertEquals(listOf("row-1", "row-2"), projection.rows.map { it.id })
        assertEquals(RosterClientHarness.RUN_ID, projection.hostRunId)
        assertEquals(3L, projection.revision)
        assertEquals(subscription, projection.subscriptionId)
        assertNull(projection.reason)
        assertNull(harness.endpoint.state().inFlightTransfer)
        assertTrue(
            harness.events.contains(RosterClientEvent.Diagnostic(RosterClientDiagnosticCode.SNAPSHOT_PUBLISHED, 2L)),
        )
    }

    @Test
    fun `a complete zero-row snapshot is current, which is not the same as knowing nothing`() {
        val harness = RosterClientHarness()
        val subscription = harness.subscribed()
        assertEquals(RosterProjectionState.EMPTY, harness.endpoint.state().projection.state)

        harness.deliver(RosterFrame.SnapshotBegin(subscription, "t-1", RosterClientHarness.RUN_ID, 4L, 0L, 0L))
        harness.deliver(RosterFrame.SnapshotEnd(subscription, "t-1", 4L, 0L))

        val projection = harness.endpoint.state().projection
        assertEquals(RosterProjectionState.CURRENT, projection.state)
        assertEquals(emptyList(), projection.rows)
        assertEquals(4L, projection.revision)
    }

    @Test
    fun `a duplicate row id fails the whole transfer instead of landing partially`() {
        val harness = RosterClientHarness()
        val subscription = harness.subscribed()

        harness.deliver(RosterFrame.SnapshotBegin(subscription, "t-1", RosterClientHarness.RUN_ID, 1L, 2L, 1L))
        harness.deliver(
            RosterFrame.SnapshotPage(
                subscription,
                "t-1",
                0L,
                listOf(RosterClientHarness.row("row-1"), RosterClientHarness.row("row-1")),
            ),
        )

        assertEquals(1, harness.closeChannelCount)
        assertEquals(1, harness.countOfType("error"))
        assertEquals(RosterProjectionState.EMPTY, harness.endpoint.state().projection.state)
        assertNull(harness.endpoint.state().inFlightTransfer)
    }

    @Test
    fun `an out-of-order page fails the transfer`() {
        val harness = RosterClientHarness()
        val subscription = harness.subscribed()

        harness.deliver(RosterFrame.SnapshotBegin(subscription, "t-1", RosterClientHarness.RUN_ID, 1L, 2L, 2L))
        harness.deliver(RosterFrame.SnapshotPage(subscription, "t-1", 1L, listOf(RosterClientHarness.row("row-2"))))

        assertEquals(1, harness.closeChannelCount)
        assertNull(harness.endpoint.state().inFlightTransfer)
    }

    @Test
    fun `an inconsistent end discards the staged rows and keeps the last authoritative ones`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot(revision = 5L)
        val before = harness.endpoint.state().projection
        assertEquals(2, before.rows.size)

        // Announces two rows, delivers one, and ends claiming both arrived.
        harness.deliver(RosterFrame.SnapshotBegin(harness.subscriptionId(), "t-2", RosterClientHarness.RUN_ID, 6L, 2L, 1L))
        harness.deliver(RosterFrame.SnapshotPage(harness.subscriptionId(), "t-2", 0L, listOf(RosterClientHarness.row("row-9"))))
        harness.deliver(RosterFrame.SnapshotEnd(harness.subscriptionId(), "t-2", 6L, 2L))

        val projection = harness.endpoint.state().projection
        assertEquals(RosterProjectionState.STALE, projection.state)
        assertEquals(RosterStalenessReason.TRANSFER_FAILED, projection.reason)
        // The staged row is gone and the prior rows are retained, not emptied.
        assertEquals(listOf("row-1", "row-2"), projection.rows.map { it.id })
        assertEquals(5L, projection.revision)
    }

    @Test
    fun `a stalled transfer is abandoned by its idle deadline and never published`() {
        val harness = RosterClientHarness()
        val subscription = harness.subscribed()

        harness.deliver(RosterFrame.SnapshotBegin(subscription, "t-1", RosterClientHarness.RUN_ID, 1L, 2L, 2L))
        harness.fireDeadline(RosterDeadlineKind.TRANSFER_IDLE)

        assertNull(harness.endpoint.state().inFlightTransfer)
        assertEquals(RosterProjectionState.EMPTY, harness.endpoint.state().projection.state)
        // No retry: nothing new was sent except the retirement notice.
        assertEquals(1, harness.countOfType("unsubscribe"))
    }

    @Test
    fun `page byte accounts accumulate so a snapshot over the aggregate bound publishes nothing`() {
        // Each of these pages fits on its own; only their sum is too large. The bound
        // is derived from the encoder's own byte account, so the arithmetic below is
        // exact rather than a guess at row size.
        val rows = (0 until 3).map { RosterClientHarness.row("row-$it") }
        val rowBytes = RosterMetadataRow.encode(rows[0]).toByteArray(Charsets.UTF_8).size.toLong()
        val bounds = RosterBounds(maxPageBytes = rowBytes, maxSnapshotBytes = rowBytes * 5L / 2L)
        val harness = RosterClientHarness(bounds = bounds)
        val subscription = harness.subscribed()
        // A roster this side already trusts, so an abandoned oversized transfer has
        // something to fall back to.
        harness.publishSnapshot(revision = 1L)
        assertTrue(rowBytes * 2L <= bounds.maxSnapshotBytes, "two pages must fit on their own")
        assertTrue(rowBytes * 3L > bounds.maxSnapshotBytes, "the three pages together must exceed the aggregate bound")

        harness.deliver(RosterFrame.SnapshotBegin(subscription, "t-2", RosterClientHarness.RUN_ID, 2L, 3L, 3L))
        harness.deliver(RosterFrame.SnapshotPage(subscription, "t-2", 0L, listOf(rows[0])))
        assertNotNull(harness.endpoint.state().inFlightTransfer)
        harness.deliver(RosterFrame.SnapshotPage(subscription, "t-2", 1L, listOf(rows[1])))
        // Still alive two pages in, so the earlier pages were not counted as the whole.
        assertNotNull(harness.endpoint.state().inFlightTransfer)

        harness.deliver(RosterFrame.SnapshotPage(subscription, "t-2", 2L, listOf(rows[2])))

        // The aggregate crossed the bound: the transfer is abandoned, never truncated
        // to what happened to fit, and nothing is published.
        assertNull(harness.endpoint.state().inFlightTransfer)
        // The failed transfer is refused as a whole: the last authoritative rows stay
        // visible as explicitly not current, rather than a truncated roster going live.
        assertEquals(RosterProjectionState.STALE, harness.endpoint.state().projection.state)
        assertEquals(RosterStalenessReason.TRANSFER_FAILED, harness.endpoint.state().projection.reason)
        assertEquals(listOf("row-1", "row-2"), harness.endpoint.state().projection.rows.map { it.id })
        assertEquals(1L, harness.endpoint.state().projection.revision)
    }

    @Test
    fun `a stale deadline callback from a superseded arm never expires the replacement`() {
        val harness = RosterClientHarness()
        val subscription = harness.subscribed()
        harness.deliver(RosterFrame.SnapshotBegin(subscription, "t-1", RosterClientHarness.RUN_ID, 1L, 2L, 2L))
        val firstArm = harness.armed.keys.single { it.kind == RosterDeadlineKind.TRANSFER_IDLE }

        // Progress re-arms the same logical deadline.
        harness.deliver(RosterFrame.SnapshotPage(subscription, "t-1", 0L, listOf(RosterClientHarness.row("row-1"))))
        val secondArm = harness.armed.keys.single { it.kind == RosterDeadlineKind.TRANSFER_IDLE }
        assertTrue(firstArm != secondArm, "a re-arm must be distinguishable from the arm it replaced")

        // A callback the coordinator had already queued for the replaced arm arrives late.
        harness.fireToken(firstArm)

        assertNotNull(harness.endpoint.state().inFlightTransfer)
        assertEquals(RosterProjectionState.EMPTY, harness.endpoint.state().projection.state)

        // The live arm still owns this deadline and still expires the stalled transfer.
        harness.fireDeadline(RosterDeadlineKind.TRANSFER_IDLE)
        assertNull(harness.endpoint.state().inFlightTransfer)
    }

    @Test
    fun `a stale callback left over from a completed snapshot never abandons the next transfer`() {
        val harness = RosterClientHarness()
        val subscription = harness.subscribed()

        // One complete snapshot, whose idle deadline is captured mid-transfer.
        harness.deliver(RosterFrame.SnapshotBegin(subscription, "t-1", RosterClientHarness.RUN_ID, 1L, 1L, 1L))
        val stale = harness.armed.keys.single { it.kind == RosterDeadlineKind.TRANSFER_IDLE }
        harness.deliver(RosterFrame.SnapshotPage(subscription, "t-1", 0L, listOf(RosterClientHarness.row("row-1"))))
        harness.deliver(RosterFrame.SnapshotEnd(subscription, "t-1", 1L, 1L))
        assertEquals(emptyList(), harness.armed.keys.filter { it.kind == RosterDeadlineKind.TRANSFER_IDLE })

        // A second snapshot on the same subscription is healthy and mid-flight.
        harness.deliver(RosterFrame.SnapshotBegin(subscription, "t-2", RosterClientHarness.RUN_ID, 2L, 1L, 1L))
        harness.deliver(RosterFrame.SnapshotPage(subscription, "t-2", 0L, listOf(RosterClientHarness.row("row-1"))))

        // A callback the coordinator still had queued for the completed snapshot.
        harness.fireToken(stale)

        assertNotNull(harness.endpoint.state().inFlightTransfer)
        assertEquals(RosterProjectionState.CURRENT, harness.endpoint.state().projection.state)
        assertEquals(1L, harness.endpoint.state().projection.revision)
    }

    // ------------------------------------------------------------ freshness

    @Test
    fun `another owner run mid-subscription is refused and the old rows stay visible as stale`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot(runId = "run-A", revision = 2L)
        assertEquals("run-A", harness.endpoint.state().projection.hostRunId)

        harness.deliver(RosterFrame.SnapshotBegin(harness.subscriptionId(), "t-2", "run-B", 9L, 1L, 1L))

        val projection = harness.endpoint.state().projection
        assertEquals(RosterProjectionState.STALE, projection.state)
        assertEquals(RosterStalenessReason.RUN_CHANGED, projection.reason)
        assertEquals(listOf("row-1", "row-2"), projection.rows.map { it.id })
        assertEquals("run-A", projection.hostRunId)
    }

    @Test
    fun `a revision regression on the same subscription is refused`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot(revision = 7L)

        harness.deliver(
            RosterFrame.SnapshotBegin(harness.subscriptionId(), "t-2", RosterClientHarness.RUN_ID, 6L, 1L, 1L),
        )

        assertEquals(RosterStalenessReason.REVISION_REGRESSION, harness.endpoint.state().projection.reason)
        assertEquals(2, harness.endpoint.state().projection.rows.size)
    }

    @Test
    fun `a fresh subscription recovers freshness at the same revision without an owner mutation`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot(revision = 7L)

        harness.push(harness.endpoint.resync())
        assertEquals(1, harness.countOfType("unsubscribe"))
        // The endpoint never starts the replacement subscription itself, and a
        // subscribe issued during the retirement is refused rather than queued.
        assertEquals(1, harness.countOfType("subscribe"))
        harness.push(harness.endpoint.subscribe())
        assertEquals(
            listOf(RosterClientEvent.SubscriptionRefused(RosterSubscriptionRefusal.RETIRING)),
            harness.events.filterIsInstance<RosterClientEvent.SubscriptionRefused>(),
        )
        assertEquals(1, harness.countOfType("subscribe"))

        harness.deliver(RosterFrame.Unsubscribed(harness.subscriptionId()))
        assertEquals(RosterClientPhase.READY, harness.endpoint.state().phase)

        harness.push(harness.endpoint.subscribe())
        val next = harness.subscriptionId()
        harness.deliver(RosterFrame.SnapshotBegin(next, "t-3", RosterClientHarness.RUN_ID, 7L, 1L, 1L))
        harness.deliver(RosterFrame.SnapshotPage(next, "t-3", 0L, listOf(RosterClientHarness.row("row-1"))))
        harness.deliver(RosterFrame.SnapshotEnd(next, "t-3", 7L, 1L))

        assertEquals(RosterProjectionState.CURRENT, harness.endpoint.state().projection.state)
        assertEquals(1, harness.endpoint.state().projection.rows.size)
    }

    // ------------------------------------------------------------------ loss

    @Test
    fun `a lost channel keeps the last rows as explicitly not current`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot(revision = 3L)

        harness.push(harness.endpoint.onChannelClosed())

        val projection = harness.endpoint.state().projection
        assertEquals(RosterProjectionState.STALE, projection.state)
        assertEquals(RosterStalenessReason.CHANNEL_CLOSED, projection.reason)
        assertEquals(listOf("row-1", "row-2"), projection.rows.map { it.id })
        assertEquals(3L, projection.revision)
        assertEquals(RosterClientPhase.DETACHED, harness.endpoint.state().phase)
    }

    @Test
    fun `a lost channel settles every outstanding operation unknown and replays nothing`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot()
        val sendsBefore = harness.sends.size

        harness.push(
            harness.endpoint.closeSession(
                RosterCloseCommand(
                    RosterClientHarness.RUN_ID,
                    "row-1",
                    confirmed = false,
                    proof = RosterClientHarness.rowProof(harness.generation, RosterClientHarness.RUN_ID, "row-1"),
                ),
            ),
        )
        harness.push(
            harness.endpoint.createSession(
                RosterCreateCommand(
                    RosterClientHarness.RUN_ID,
                    "/srv/owner/work",
                    proof = RosterClientHarness.formProof(harness.generation, RosterClientHarness.RUN_ID, "/srv/owner/work"),
                ),
            ),
        )
        val afterRequests = harness.sends.size
        assertTrue(afterRequests > sendsBefore)

        harness.push(harness.endpoint.onChannelClosed())

        val settled = harness.settled()
        assertEquals(2, settled.size)
        assertTrue(settled.all { it.third == RosterRequestResult.Unknown })
        // Nothing is replayed after loss: no further frame left this endpoint.
        assertEquals(afterRequests, harness.sends.size)
    }

    @Test
    fun `frames arriving after detach are ignored`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot()
        harness.push(harness.endpoint.onChannelClosed())
        val sendsAfterClose = harness.sends.size

        harness.push(harness.endpoint.onFrame(RosterProtocol.encode(RosterFrame.Unsubscribe("ghost"), harness.bounds)))

        assertEquals(sendsAfterClose, harness.sends.size)
    }

    // -------------------------------------------------------------- lifecycle

    @Test
    fun `an unconfirmed stop closes the channel and preserves the loss reason`() {
        // The three ways a stop's own retirement can go unconfirmed: the owner never
        // answers, the write was never dispatched, and the write was invoked and failed.
        val failures = listOf<RosterSendDisposition?>(
            null,
            RosterSendDisposition.NotDispatched(RosterSendRefusal.NOT_READY),
            RosterSendDisposition.FailedAfterInvoke,
        )
        for (failure in failures) {
            val harness = RosterClientHarness()
            harness.subscribed()
            harness.publishSnapshot()
            harness.push(harness.endpoint.stop())
            val unsubscribe = harness.sends.indexOfLast { it.frame is RosterFrame.Unsubscribe }
            assertEquals(RosterDispatchDecision.Allow, harness.decide(unsubscribe))
            if (failure == null) {
                harness.report(unsubscribe, RosterSendDisposition.Completed)
                harness.fireDeadline(RosterDeadlineKind.RETIREMENT_ACK)
            } else {
                harness.report(unsubscribe, failure)
            }

            // A retirement the owner never confirmed ends the channel even mid-stop.
            assertEquals(1, harness.closeChannelCount)
            val state = harness.endpoint.state()
            assertEquals(RosterClientPhase.DETACHED, state.phase)
            assertNull(state.retiringSubscriptionId)
            // And it reports the loss of certainty, never a clean stop or an empty roster.
            assertEquals(RosterProjectionState.STALE, state.projection.state)
            assertEquals(RosterStalenessReason.CHANNEL_CLOSED, state.projection.reason)
            assertEquals(listOf("row-1", "row-2"), state.projection.rows.map { it.id })

            harness.push(harness.endpoint.stop())
            assertEquals(1, harness.closeChannelCount)
            assertEquals(RosterStalenessReason.CHANNEL_CLOSED, harness.endpoint.state().projection.reason)
        }
    }

    @Test
    fun `stop retires the subscription and keeps the last rows as stale stopped`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot()

        harness.push(harness.endpoint.stop())
        assertEquals(1, harness.countOfType("unsubscribe"))
        assertTrue(harness.endpoint.state().stopRequested)

        harness.deliver(RosterFrame.Unsubscribed(harness.subscriptionId()))

        val state = harness.endpoint.state()
        assertEquals(RosterClientPhase.DETACHED, state.phase)
        assertEquals(RosterProjectionState.STALE, state.projection.state)
        assertEquals(RosterStalenessReason.STOPPED, state.projection.reason)
        assertEquals(listOf("row-1", "row-2"), state.projection.rows.map { it.id })
        assertEquals(0, harness.closeChannelCount)
    }

    @Test
    fun `an unconfirmed retirement closes the channel instead of being reused`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot()

        harness.push(harness.endpoint.resync())
        harness.fireDeadline(RosterDeadlineKind.RETIREMENT_ACK)

        val state = harness.endpoint.state()
        assertEquals(RosterClientPhase.DETACHED, state.phase)
        assertEquals(1, harness.closeChannelCount)
        assertEquals(RosterStalenessReason.CHANNEL_CLOSED, state.projection.reason)
        assertEquals(listOf("row-1", "row-2"), state.projection.rows.map { it.id })
    }

    @Test
    fun `a retired subscription is never silently replaced`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot()

        harness.push(harness.endpoint.resync())
        // The owner answers about the retiring subscription: that is its confirmation.
        harness.deliver(RosterFrame.Failure(RosterWireErrorCode.UNAVAILABLE, harness.subscriptionId()))

        assertEquals(RosterClientPhase.READY, harness.endpoint.state().phase)
        assertNull(harness.endpoint.state().retiringSubscriptionId)
        assertEquals(1, harness.countOfType("subscribe"))
        assertEquals(
            listOf(RosterClientEvent.SubscriptionRetired(harness.subscriptionIdAt(0), acknowledged = true)),
            harness.events.filterIsInstance<RosterClientEvent.SubscriptionRetired>(),
        )
    }

    @Test
    fun `a stop is idempotent`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.push(harness.endpoint.stop())
        val sendsAfterFirstStop = harness.sends.size
        harness.push(harness.endpoint.stop())

        assertEquals(sendsAfterFirstStop, harness.sends.size)
    }

    @Test
    fun `a hostile frame that this side could only have sent fails the channel`() {
        val harness = RosterClientHarness()
        harness.subscribed()
        harness.publishSnapshot()

        harness.deliverRaw("""{"type":"subscribe","subscriptionId":"sub-1"}""".toByteArray(Charsets.UTF_8))

        assertEquals(1, harness.closeChannelCount)
        assertTrue(
            harness.events.contains(RosterClientEvent.Diagnostic(RosterClientDiagnosticCode.PROTOCOL_VIOLATION, null)),
        )
    }

    @Test
    fun `undecodable bytes fail the channel rather than being skipped`() {
        val harness = RosterClientHarness()
        harness.subscribed()

        harness.deliverRaw("not json".toByteArray(Charsets.UTF_8))

        assertEquals(1, harness.closeChannelCount)
    }
}

private fun RosterClientHarness.subscriptionIdAt(index: Int): String =
    sends.mapNotNull { (it.frame as? RosterFrame.Subscribe)?.subscriptionId }[index]
