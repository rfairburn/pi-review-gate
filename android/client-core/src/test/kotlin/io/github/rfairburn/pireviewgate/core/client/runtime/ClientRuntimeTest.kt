package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy
import io.github.rfairburn.pireviewgate.core.client.content.ContentViewportRequest
import io.github.rfairburn.pireviewgate.core.client.content.ackFrame
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientHarness
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientPhase
import io.github.rfairburn.pireviewgate.core.client.roster.RosterProjectionState
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentFrameType
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.newFixedThreadPoolContext
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertIs

/**
 * The adapter-facing contract of [ClientRuntime]: what a UI may act on, and what it can
 * never talk the runtime into doing.
 *
 * Every case here is about a decision the runtime makes on the caller's own facts — a
 * current roster, an exact owner run and row, a real viewport measurement, a live proof —
 * and about what survives which interruption. Nothing is asserted about the peer: this
 * runtime never learns that a remote session started, stopped, or saw anything.
 */
class ClientRuntimeTest {

    @Test
    fun selectionAdmissionRefusesEveryTargetTheCallerCannotActuallyProve() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        // No host at all.
        assertEquals(
            SelectionResult.Refused(SelectionRefusal.HOST_NOT_ATTACHED),
            harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE),
        )

        val (channel, _) = harness.attach(HOST_A)
        // Attached, but no roster has ever been published.
        assertEquals(
            SelectionResult.Refused(SelectionRefusal.ROSTER_NOT_CURRENT),
            harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE),
        )

        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))
        // A current roster, but the native layer never measured a pane.
        assertEquals(
            SelectionResult.Refused(SelectionRefusal.NO_VIEWPORT),
            harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE),
        )
        harness.runtime.setViewport(80, 24)

        // A row this roster does not carry, and a run it does not carry.
        assertEquals(
            SelectionResult.Refused(SelectionRefusal.ROW_NOT_IN_CURRENT_ROSTER),
            harness.runtime.selectTerminal(harness.target(rowId = "row-absent"), ALWAYS_TRUE),
        )
        assertEquals(
            SelectionResult.Refused(SelectionRefusal.ROW_NOT_IN_CURRENT_ROSTER),
            harness.runtime.selectTerminal(harness.target(runId = OTHER_RUN_ID), ALWAYS_TRUE),
        )

        // The caller's own proof is the last fence, and it can only refuse.
        assertEquals(
            SelectionResult.Refused(SelectionRefusal.PROOF_UNAVAILABLE),
            harness.runtime.selectTerminal(harness.target(), ToggleProof(false)),
        )
        assertEquals(0, harness.openedContentChannels.size, "a refused selection opened nothing")

        assertTrue(harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE) is SelectionResult.Selected)
        assertEquals(
            SelectionResult.Refused(SelectionRefusal.ALREADY_SELECTED),
            harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE),
        )
        harness.closeRuntime()
    }

    @Test
    fun backgroundingWithdrawsTheStreamAndLeavesEveryHostRosterRunning() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        val roster = harness.hostChannel(HOST_A)!!
        val appFramesBefore = harness.rosterFrames(roster).size
        val before = harness.events.size

        harness.runtime.setAppForeground(false)
        assertNull(harness.runtime.state.value.selection, "backgrounding closes the stream now")
        assertFalse(harness.runtime.state.value.terminalInputAdmissionOpen)
        harness.settle()

        // The stream retires its own notice even though input died first.
        assertTrue(content.contentFrames().any { it.wireType == ContentFrameType.UNSUBSCRIBE.wireValue })
        // The host lane and its authoritative roster survive untouched, and no remote
        // session was asked to stop.
        assertEquals(HostLanePhase.ATTACHED, harness.hostState(HOST_A)?.lane)
        assertEquals(RosterProjectionState.CURRENT, harness.hostState(HOST_A)?.roster?.projection?.state)
        assertEquals(appFramesBefore, harness.rosterFrames(roster).size)
        assertNoRosterClose(harness.rosterFrames(roster))
        assertEquals(
            1,
            harness.events.drop(before).count {
                it is ClientRuntimeEvent.SelectionChanged && it.selection == null
            },
            "the withdrawal is published once",
        )
        // Coming back never reopens a stream by itself.
        harness.runtime.setAppForeground(true)
        harness.settle()
        assertNull(harness.runtime.state.value.selection)
        harness.closeRuntime()
    }

    @Test
    fun aHostThatDisappearsTakesOnlyItsOwnStreamAndLeavesTheOthersAlone() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        val (channelB, _) = harness.attach(HOST_B)
        harness.subscribed(HOST_B, channelB)
        harness.publishSnapshot(channelB, rows = listOf(RosterClientHarness.row(ROW_1)))
        val rosterA = harness.hostChannel(HOST_A)!!

        rosterA.endIncoming()
        harness.settle()

        assertNull(harness.runtime.state.value.selection, "the lost host's stream is withdrawn")
        assertEquals(HostLanePhase.DETACHED, harness.hostState(HOST_A)?.lane)
        assertEquals(HostLanePhase.ATTACHED, harness.hostState(HOST_B)?.lane)
        assertEquals(RosterProjectionState.CURRENT, harness.hostState(HOST_B)?.roster?.projection?.state)
        assertTrue(
            harness.events.any {
                it is ClientRuntimeEvent.HostDetached && it.hostId == HostId.parse(HOST_A) &&
                    it.reason == HostDetachReason.CHANNEL_CLOSED
            },
        )
        // The content channel this runtime opened for the lost host is ended here, within
        // its bound: no job, timer, or half-open stream of a lost host is left behind.
        assertEquals(1, content.closeCount)
        // Rows are retained truthfully as stale, never dropped and never called current.
        val retained = harness.hostState(HOST_A)!!.roster
        assertEquals(RosterClientPhase.DETACHED, retained.phase)
        assertEquals(RosterProjectionState.STALE, retained.projection.state)
        assertTrue(retained.projection.rows.isNotEmpty(), "rows are retained, as stale")
        harness.closeRuntime()
    }

    @Test
    fun aReconnectionRestoresADeliberateTargetOnlyFromAFreshRosterThatStillCarriesIt() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        harness.terminalUp()
        assertEquals(1, harness.openedContentChannels.size)
        // A plain selection is not a restoration request; this one is.
        assertEquals(
            RememberTerminalResult.Remembered(harness.target()),
            harness.runtime.rememberTerminalTarget(harness.target(), ALWAYS_TRUE),
        )
        val roster = harness.hostChannel(HOST_A)!!
        roster.endIncoming()
        harness.settle()
        assertTrue(harness.runtime.state.value.restoreArmed, "a lost connection does not cancel an intent")
        assertNull(harness.runtime.state.value.selection)

        // A fresh roster that does NOT carry the remembered row restores nothing.
        val second = harness.attach(HOST_A, generation = 2L).also {
            assertEquals(HostAttachResult.Accepted, it.second)
        }.first
        harness.subscribed(HOST_A, second)
        harness.publishSnapshot(second, rows = listOf(RosterClientHarness.row("row-someone-else")), revision = 2L)
        harness.settle()
        assertEquals(1, harness.openedContentChannels.size, "no substitute row is ever chosen")

        // The same run and the same row, positively present: the deliberate target
        // returns. A roster whose owner run changed retires its own subscription, and a
        // target under a run the current roster does not carry is refused at selection.
        harness.publishSnapshot(second, rows = listOf(RosterClientHarness.row(ROW_1)), revision = 4L)
        harness.settle()
        assertEquals(2, harness.openedContentChannels.size)
        assertEquals(harness.target(), harness.runtime.state.value.selection?.target)
        assertEquals(2L, harness.hostState(HOST_A)?.connectionGeneration)
        harness.closeRuntime()
    }

    @Test
    fun aRememberedTargetWhoseProofWentAwayIsNeverRestored() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val proof = ToggleProof(true)
        val selected = harness.runtime.let { rt ->
            val roster = harness.attach(HOST_A).first
            harness.subscribed(HOST_A, roster)
            harness.publishSnapshot(roster, rows = listOf(RosterClientHarness.row(ROW_1)))
            rt.setViewport(80, 24)
            rt.selectTerminal(harness.target(), ALWAYS_TRUE)
        }
        assertTrue(selected is SelectionResult.Selected)
        harness.settle()
        assertEquals(TerminalLeaveResult.Left(harness.target()), harness.runtime.leaveTerminal())
        harness.settle()
        assertEquals(
            RememberTerminalResult.Remembered(harness.target()),
            harness.runtime.rememberTerminalTarget(harness.target(), proof),
        )

        // The view that asked for restoration is gone, so nothing reopens.
        proof.current = false
        val roster = harness.hostChannel(HOST_A)!!
        harness.publishSnapshot(roster, rows = listOf(RosterClientHarness.row(ROW_1)), revision = 2L)
        harness.settle()
        assertNull(harness.runtime.state.value.selection)
        assertEquals(1, harness.openedContentChannels.size)
        harness.closeRuntime()
    }

    @Test
    fun detachingAHostWithdrawsItsStreamSynchronouslyAndNeverClosesTheParentsChannel() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        val roster = harness.hostChannel(HOST_A)!!

        assertTrue(harness.runtime.detachHost(HostId.parse(HOST_A)))
        assertNull(harness.runtime.state.value.selection, "detach closes input admission on the calling thread")
        harness.settle()

        assertEquals(0, roster.closeCount, "the registry owns the APP channel, not this runtime")
        assertEquals(1, content.closeCount, "this runtime closes the content channel it opened")
        assertEquals(HostLanePhase.DETACHED, harness.hostState(HOST_A)?.lane)
        assertNoRosterClose(harness.rosterFrames(roster))
        // A retired lane keeps no deadline armed.
        assertEquals(0, harness.time.armedCount(), "a detached host keeps no timer")
        // And a stale generation for that host is refused outright.
        assertEquals(
            HostAttachResult.Refused(HostAttachRefusal.STALE_GENERATION),
            harness.attachOn(HOST_A, FakePeerByteChannel(PeerAppLane.APP, "same-generation"), generation = 1L),
        )
        assertEquals(1, harness.openedContentChannels.size, "detach opens nothing further")
        harness.closeRuntime()
    }

    @Test
    fun sixtyFourHostsRunAtOnceAndTheCeilingRefusesHonestly() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        repeat(ClientRuntimeConfig.MAX_HOSTS) { index ->
            val hostId = "host-$index"
            val (channel, result) = harness.attach(hostId)
            assertEquals(HostAttachResult.Accepted, result, "host $index")
            harness.ackRoster(channel)
        }
        harness.settle()
        assertEquals(ClientRuntimeConfig.MAX_HOSTS, harness.runtime.state.value.hosts.size)
        assertEquals(
            ClientRuntimeConfig.MAX_HOSTS,
            harness.runtime.state.value.attachedHosts.size,
            "every host lane is live at once",
        )
        assertEquals(
            HostAttachResult.Refused(HostAttachRefusal.HOST_LIMIT),
            harness.attach("host-overflow").second,
        )
        // One selection still works while the ceiling is saturated.
        val first = harness.hostChannel("host-0")!!
        harness.runtime.subscribeRoster(HostId.parse("host-0"))
        harness.settle()
        harness.publishSnapshot(first, rows = listOf(RosterClientHarness.row(ROW_1)))
        harness.runtime.setViewport(80, 24)
        assertTrue(
            harness.runtime.selectTerminal(TerminalTarget(HostId.parse("host-0"), RUN_ID, ROW_1), ALWAYS_TRUE)
                is SelectionResult.Selected,
        )
        harness.settle()
        assertEquals(1, harness.openedContentChannels.size)
        harness.closeRuntime()
    }

    @Test
    fun thePublishedStateIsTheTruthAtTheMomentItIsRead() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val initial = harness.runtime.state.value
        assertFalse(initial.closed)
        assertNull(initial.selection)
        assertNull(initial.viewport, "no default pane size exists anywhere")
        assertEquals(ContentInputPolicy(enabled = true, generation = 1L), initial.inputPolicy)

        val content = harness.terminalUp()
        val selected = harness.runtime.state.value
        assertNotNull(selected.selection)
        assertEquals(harness.target(), selected.selection.target)
        assertEquals(1L, selected.selection.selectionGeneration)
        assertNull(selected.pendingSelection, "the stream is live, not merely wanted")
        assertFalse(
            selected.terminalInputAdmissionOpen,
            "nothing has been committed yet, so no input authority exists",
        )
        harness.commitPublishedFrame(selected.selection.selectionGeneration)
        assertTrue(harness.runtime.state.value.terminalInputAdmissionOpen, "a real commit opens input")
        assertEquals(80, selected.viewport?.cols)
        assertEquals(24, selected.viewport?.rows)
        assertTrue(selected.visibility.allowsTerminalInput)

        harness.runtime.updateInputPolicy(ContentInputPolicy(enabled = false, generation = 2L))
        harness.settle()
        assertFalse(harness.runtime.state.value.terminalInputAdmissionOpen, "a disabled preference closes input")
        assertNotNull(harness.runtime.state.value.selection, "display is not part of the preference")
        harness.closeRuntime()
    }

    @Test
    fun closingTheRuntimeRetiresEveryLaneAndEndsItsEventStream() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        val (channelB, _) = harness.attach(HOST_B)
        harness.settle()

        harness.runtime.close()
        harness.settle()
        assertTrue(harness.runtime.state.value.closed)
        assertNull(harness.runtime.state.value.selection)
        assertTrue(harness.runtime.state.value.hosts.all { it.lane == HostLanePhase.DETACHED })
        assertTrue(harness.runtime.events.isClosedForReceive, "the event stream ends with the runtime")
        assertEquals(0, harness.time.armedCount(), "no timer outlives the runtime")
        assertEquals(1, content.closeCount, "a runtime-opened content channel is closed by this runtime")
        assertEquals(0, channelB.closeCount, "the parent's APP channel is never closed here")
        // Closing twice changes nothing and never throws.
        harness.runtime.close()
    }

    @Test
    fun anOpenerThatFailsIsReportedAsAFailureAndNeverRetried() = runBlocking {
        val attempts = mutableListOf<Long>()
        val harness = RuntimeHarness(
            coroutineContext,
            opener = ContentChannelOpener { _, generation, _ ->
                attempts += generation
                throw IllegalStateException("the registry could not open a content lane")
            },
        )
        val roster = harness.attach(HOST_A).first
        harness.subscribed(HOST_A, roster)
        harness.publishSnapshot(roster, rows = listOf(RosterClientHarness.row(ROW_1)))
        harness.runtime.setViewport(80, 24)
        assertTrue(harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE) is SelectionResult.Selected)
        harness.settle()

        assertNull(harness.runtime.state.value.selection)
        assertEquals(1, attempts.size, "a failed open is reported, never retried")
        assertTrue(
            harness.events.any {
                it is ClientRuntimeEvent.ContentOpenFailed && it.reason == ContentOpenFailure.CHANNEL_OPEN_FAILED
            },
        )
        harness.closeRuntime()
    }

    @Test
    fun aSelectionWaitingForAMeasurementIsShownAsPendingAndNeverInvented() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val roster = harness.attach(HOST_A).first
        harness.subscribed(HOST_A, roster)
        harness.publishSnapshot(roster, rows = listOf(RosterClientHarness.row(ROW_1)))

        // No measurement yet, so nothing can be selected and nothing is guessed.
        assertEquals(
            SelectionResult.Refused(SelectionRefusal.NO_VIEWPORT),
            harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE),
        )
        assertEquals(0, harness.openedContentChannels.size)
        // The measurement arrives; the same deliberate act now succeeds.
        harness.runtime.setViewport(110, 38)
        assertTrue(harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE) is SelectionResult.Selected)
        harness.awaitUntil("the content lane opened") { harness.openedContentChannels.size == 1 }
        assertEquals(
            ContentViewportRequest(110, 38),
            harness.runtime.currentContentObservation()?.requestedViewport,
            "the stream was opened at the measured size, never a guessed one",
        )
        harness.closeRuntime()
    }

    @Test
    fun aStreamWithdrawnWhileItsInstallationIsParkedStillRetiresWhileTheOwnerKeepsAnswering() = runBlocking {
        val harness = RuntimeHarness(
            coroutineContext,
            config = runtimeConfig(ids = CountingRuntimeIds(), eventQueueCapacity = 1),
        )
        val roster = harness.attach(HOST_A).first
        harness.subscribed(HOST_A, roster)
        harness.publishSnapshot(roster, rows = listOf(RosterClientHarness.row(ROW_1), RosterClientHarness.row(ROW_2)))
        check(harness.runtime.setViewport(80, 24) is ViewportResult.Applied)

        // Stop collecting, then select: the selection's own notice fills the one event slot,
        // so the content installation parks at the publication that follows its lane.
        harness.pauseEvents()
        assertTrue(
            harness.runtime.selectTerminal(harness.target(rowId = ROW_1), ALWAYS_TRUE) is SelectionResult.Selected,
        )
        harness.settle()
        val content = harness.lastContentChannel()

        // Navigation happens while that installation is still parked. The withdrawal has
        // taken this lane, so its retirement must reach a driver that already exists.
        assertIs<TerminalLeaveResult.Left>(harness.runtime.leaveTerminal())
        // The owner stays alive and answers throughout: nothing here is excused by a peer
        // that stopped cooperating.
        content.push(ackFrame())
        harness.settle()
        harness.resumeEvents()
        harness.settle()
        // The withdrawal itself has to retire this stream. No clock advance is used to finish
        // it off, so the only thing that can end it is the retirement the navigation asked
        // for: if that was discarded before startup, this stream stays open forever.
        assertEquals(
            1,
            content.closeCount,
            "a withdrawn stream retires and closes even when its installation was parked",
        )
        assertNull(harness.selection(), "the withdrawn selection is not current")
        assertNull(harness.runtime.currentContentObservation(), "no observation survives its selection")
        harness.closeRuntime()
    }

    @Test
    fun twoReplacementsRacingForTheSameSelectionNeverLeaveTheLoserLive() = runBlocking {
        val harness = RuntimeHarness(
            coroutineContext,
            config = runtimeConfig(ids = CountingRuntimeIds(), retirementGraceMs = 1L),
        )
        harness.terminalUp()
        // A pool this side controls, deliberately the smallest useful size: a racer that
        // blocked a worker while waiting for its peers would strand the rest and hang here.
        val racePool = newFixedThreadPoolContext(TWO_WORKERS, "selection-race")
        try {
            repeat(40) { round ->
                // Only a selection whose stream is genuinely open and started can be the one
                // a loser is orphaned from, so each collision starts from a live stream.
                harness.awaitUntil("round $round: a live stream") {
                    harness.runtime.currentContentObservation() != null
                }

                // Each racer announces arrival and then suspends. Every one of them is
                // genuinely waiting before any is released, and none of them occupies a
                // worker while waiting, so a two-worker pool still releases all four.
                val go = CompletableDeferred<Unit>()
                val ready = List(RACERS) { CompletableDeferred<Unit>() }
                val racers = List(RACERS) { index ->
                    launch(racePool) {
                        ready[index].complete(Unit)
                        go.await()
                        harness.runtime.selectTerminal(
                            harness.target(rowId = if (index % 2 == 0) ROW_1 else ROW_2),
                            ALWAYS_TRUE,
                        )
                    }
                }
                ready.forEach { it.await() }
                go.complete(Unit)
                racers.joinAll()
                // Displaced streams retire on their own bounded notice; the owner never
                // answers here, so their finite acknowledgement bound ends them.
                harness.time.advanceMillis(2_500L)

                // Every stream this runtime opened but the current one belongs to a
                // selection that was displaced, so each must have been withdrawn, retired,
                // and closed.
                harness.awaitUntil("round $round: only the current stream survives") {
                    harness.openedContentChannels.count { it.closeCount == 0 } <= 1
                }
            }
        } finally {
            racePool.close()
        }
        harness.awaitUntil("the final selection's stream is live") {
            harness.runtime.currentContentObservation() != null
        }
        assertNotNull(harness.selection(), "a replacement is still current")
        assertEquals(1, harness.openedContentChannels.count { it.closeCount == 0 })
        assertEquals(0, harness.runtime.trackedInputFlights())
        harness.closeRuntime()
    }

    @Test
    fun twoConcurrentAttachmentsForOneHostAdmitExactlyOneConsumer() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val racePool = newFixedThreadPoolContext(TWO_WORKERS, "attach-race")
        try {
            repeat(60) { round ->
                // A host this runtime has never seen, so both callers are genuinely racing
                // through the same admission decision rather than one following the other.
                val hostId = "host-$round"
                val channels = listOf(
                    FakePeerByteChannel(PeerAppLane.APP, "$hostId-first"),
                    FakePeerByteChannel(PeerAppLane.APP, "$hostId-second"),
                )
                val results = collideOn(racePool, racers = 2) { index ->
                    harness.attachOn(hostId, channels[index], generation = (index + 1).toLong())
                }

                assertEquals(1, results.count { it == HostAttachResult.Accepted }, "round $round: $results")
                val refusedIndex = results.indexOfFirst { it != HostAttachResult.Accepted }
                assertEquals(
                    0,
                    channels[refusedIndex].writes.size,
                    "round $round: a refused attachment still consumed and wrote its channel",
                )
                assertNotNull(harness.hostState(hostId), "round $round: the admitted host is tracked")
            }
        } finally {
            racePool.close()
        }
        harness.closeRuntime()
    }

    @Test
    fun twoConcurrentAttachmentsForDifferentHostsCannotExceedTheHostCeiling() = runBlocking {
        val racePool = newFixedThreadPoolContext(TWO_WORKERS, "ceiling-race")
        try {
            repeat(30) { round ->
                val harness = RuntimeHarness(
                    coroutineContext,
                    config = runtimeConfig(ids = CountingRuntimeIds(), maxHosts = 1),
                )
                val channels = listOf(
                    FakePeerByteChannel(PeerAppLane.APP, HOST_A),
                    FakePeerByteChannel(PeerAppLane.APP, HOST_B),
                )
                val results = collideOn(racePool, racers = 2) { index ->
                    harness.attachOn(
                        if (index == 0) HOST_A else HOST_B,
                        channels[index],
                        generation = 1L,
                    )
                }

                assertEquals(1, results.count { it == HostAttachResult.Accepted }, "round $round: $results")
                val refusedIndex = results.indexOfFirst { it != HostAttachResult.Accepted }
                assertEquals(
                    0,
                    channels[refusedIndex].writes.size,
                    "round $round: the channel refused for capacity was consumed anyway",
                )
                harness.closeRuntime()
                // Disposal leaves nothing untracked behind either: a lane displaced from the
                // host map would still have been writing.
                assertEquals(0, channels[refusedIndex].writes.size, "round $round: an untracked lane survived")
            }
        } finally {
            racePool.close()
        }
    }

    @Test
    fun anAttachmentRacingDisposalIsEitherRefusedOrTornDownWithTheRuntime() = runBlocking {
        val racePool = newFixedThreadPoolContext(TWO_WORKERS, "attach-vs-disposal")
        try {
            repeat(60) { round ->
                val harness = RuntimeHarness(coroutineContext)
                val channel = FakePeerByteChannel(PeerAppLane.APP, HOST_A)
                // One caller attaches, the other disposes, released at the same instant.
                val results = collideOn(racePool, racers = 2) { index ->
                    if (index == 0) {
                        harness.attachOn(HOST_A, channel, generation = 1L) as Any
                    } else {
                        harness.runtime.close()
                    }
                }
                val attach = results[0]

                // Either order is legitimate. What may never happen is an attachment that
                // reports Accepted for a consumer no teardown owns.
                if (attach == HostAttachResult.Accepted) {
                    val state = assertNotNull(
                        harness.hostState(HOST_A),
                        "round $round: an accepted host is tracked",
                    )
                    assertEquals(
                        HostLanePhase.DETACHED,
                        state.lane,
                        "round $round: an accepted APP lane outlived close()",
                    )
                    val writtenAtClose = channel.writes.size
                    harness.settle()
                    assertEquals(
                        writtenAtClose,
                        channel.writes.size,
                        "round $round: a lane that outlived disposal kept consuming its channel",
                    )
                } else {
                    assertEquals(
                        HostAttachResult.Refused(HostAttachRefusal.CLOSED),
                        attach,
                        "round $round: $attach",
                    )
                }
            }
        } finally {
            racePool.close()
        }
    }
}

/** Racing selections per collision. */
private const val RACERS = 4

/** Two workers, so a blocking gate in this test could not hide a stranded racer. */
private const val TWO_WORKERS = 2

/**
 * Release [racers] actions on [pool] at the same instant.
 *
 * Arrival and waiting are both suspensions, so no racer occupies a pool worker while the
 * rest arrive, and every one of them is genuinely waiting before any is released.
 */
private suspend fun <T> CoroutineScope.collideOn(
    pool: CoroutineDispatcher,
    racers: Int,
    action: suspend (Int) -> T,
): List<T> {
    val go = CompletableDeferred<Unit>()
    val ready = List(racers) { CompletableDeferred<Unit>() }
    val racing = List(racers) { index ->
        async(pool) {
            ready[index].complete(Unit)
            go.await()
            action(index)
        }
    }
    ready.forEach { it.await() }
    go.complete(Unit)
    return racing.awaitAll()
}
