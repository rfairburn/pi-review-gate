package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointEvent
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointPhase
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputAdmission
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy
import io.github.rfairburn.pireviewgate.core.client.content.ContentNotSentReason
import io.github.rfairburn.pireviewgate.core.client.content.ContentSendOutcome
import io.github.rfairburn.pireviewgate.core.client.content.ContentWrittenFrameOutcome
import io.github.rfairburn.pireviewgate.core.client.content.inlineCopyFrames
import io.github.rfairburn.pireviewgate.core.client.content.keyboardRequest
import io.github.rfairburn.pireviewgate.core.client.content.pasteRequest
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientHarness
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.client.roster.RosterProjectionState
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentFrameType
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentEndCode
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.EndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoCopyEvent
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeSessionRef
import io.github.rfairburn.pireviewgate.core.protocol.content.SubscribeFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.contentSource
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertIs

/**
 * The one currently wanted CONTENT stream: how it opens, what it may write, and what it
 * must refuse.
 *
 * The through-line here is that a content stream's authority is composed only from facts
 * the runtime was actually given — the owner's `subscribed` acknowledgement, a real
 * published viewport, the caller's real commit of that viewport, the caller's live
 * preference, the caller's dynamic proof — and that losing any one of them retires input
 * and copy alone. Display, resize, unsubscribe, and every other host's APP lane are never
 * collateral, and no path in this suite may ask an owner session to stop.
 */
class SelectedContentLaneTest {

    @Test
    fun selectingOneRowOpensExactlyOneContentStreamForExactlyThatRunAndRow() = runBlocking {
        val harness = RuntimeHarness(coroutineContext)
        val (channelA, _) = harness.attach(HOST_A)
        val (channelB, _) = harness.attach(HOST_B)
        harness.subscribed(HOST_A, channelA)
        harness.subscribed(HOST_B, channelB)
        harness.publishSnapshot(channelA, rows = listOf(RosterClientHarness.row(ROW_1), RosterClientHarness.row(ROW_2)))
        harness.publishSnapshot(channelB, rows = listOf(RosterClientHarness.row(ROW_1)))
        assertEquals(ViewportResult.Applied(80, 24), harness.runtime.setViewport(80, 24))
        val appFramesBefore = harness.rosterFrames(channelA).size

        val result = harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE)
        assertTrue(result is SelectionResult.Selected, "a current row must be selectable: $result")
        harness.settle()

        assertEquals(1, harness.openedContentChannels.size, "exactly one CONTENT channel was opened")
        val content = harness.lastContentChannel()
        assertEquals(PeerAppLane.CONTENT, content.lane)
        assertEquals(ContentFrameType.HELLO.wireValue, content.contentFrames().single().wireType)
        harness.contentUp(content, NATIVE_IO_ACK_CAPS)
        val subscribe = content.contentFrames().single { it.wireType == ContentFrameType.SUBSCRIBE.wireValue } as SubscribeFrame
        assertEquals(RUN_ID, subscribe.hostRunId)
        assertEquals(ROW_1, subscribe.sessionId)
        // Selecting a terminal is a CONTENT-lane act: it writes nothing on any APP lane,
        // and the other host's roster lane is untouched.
        assertEquals(appFramesBefore, harness.rosterFrames(channelA).size, "the APP lane carried no content traffic")
        assertEquals(1, channelB.countFrame("subscribe"))
        assertEquals(harness.target(), harness.runtime.state.value.selection?.target)
        harness.closeRuntime()
    }

    @Test
    fun aLateContentOpenForASupersededSelectionIsClosedAndNeverSubscribed() = runBlocking {
        val opening = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val lateChannels = mutableListOf<FakePeerByteChannel>()
        val harness = RuntimeHarness(
            coroutineContext,
            opener = ContentChannelOpener { _, _, _ ->
                opening.complete(Unit)
                release.await()
                FakePeerByteChannel(PeerAppLane.CONTENT, "late-content").also { lateChannels += it }
            },
        )
        val (channel, _) = harness.attach(HOST_A)
        harness.subscribed(HOST_A, channel)
        harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))
        harness.runtime.setViewport(80, 24)
        val selected = harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE) as SelectionResult.Selected

        opening.await()
        // The user navigated away while the channel open was still in flight.
        assertEquals(TerminalLeaveResult.Left(harness.target()), harness.runtime.leaveTerminal())
        release.complete(Unit)
        harness.settle()

        assertEquals(1, lateChannels.size)
        val late = lateChannels.single()
        assertEquals(0, late.writes.size, "a superseded selection never subscribes on a late channel")
        assertEquals(1, late.closeCount, "a late channel is closed, not handed to a dead selection")
        assertNull(harness.runtime.state.value.selection)
        assertEquals(1L, selected.selectionGeneration)
        harness.closeRuntime()
    }

    @Test
    fun aRealFrameThenARealCommitThenGuardedInputThenReceiptPhasesIsTheWholeHappyPath() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        val observation = harness.runtime.currentContentObservation()!!
        assertEquals(ContentEndpointPhase.STREAMING, observation.phase)
        assertNotNull(observation.view, "the published viewport is this runtime's only view")
        assertTrue(observation.nativeIoNegotiated)
        assertNull(observation.writtenReceipt, "nothing was committed until the caller said so")

        val registered = harness.commitPublishedFrame(selectionGeneration = 1L)
        assertTrue(registered is ContentWrittenFrameOutcome.Registered, "$registered")
        assertEquals(1, harness.runtime.currentContentObservation()!!.writtenReceipt?.sequence)

        val writtenBefore = content.writes.size
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(admission is ContentInputAdmission.Accepted, "a committed, current, authorized input admits: $admission")
        harness.settle()

        val inputFrames = content.contentFrames().filter { it.wireType.startsWith("input") }
        assertTrue(inputFrames.isNotEmpty(), "the admitted input reached the transport")
        assertEquals(writtenBefore + inputFrames.size, content.writes.size)
        assertEquals(listOf(ContentSendOutcome.Submitted), harness.inputOutcomes())
        harness.closeRuntime()
    }

    @Test
    fun aProofThatTurnsFalseBetweenAdmissionAndDispatchNeverWritesTheInput() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)
        val proof = ToggleProof(true)
        content.blockWrites()
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), proof)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        // The UI withdrew its proof while the page sat in the queue.
        proof.current = false
        content.releaseWrites()
        harness.settle()

        assertEquals(0, content.contentFrames().count { it.wireType.startsWith("input") })
        // The endpoint owns the fixed reason vocabulary for a release before any write;
        // what this suite owns is that a withdrawn proof never becomes a send, and never
        // becomes an unknown either, because nothing was ever invoked.
        assertEquals(
            listOf(ContentSendOutcome.NotSent(ContentNotSentReason.STOPPED)),
            harness.inputOutcomes(),
            "a page never invoked is never-sent, and never an optimistic success",
        )
        harness.closeRuntime()
    }

    @Test
    fun aCoveredTerminalRefusesInputWhileTheStreamAndItsControlsStayLive() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)

        harness.runtime.setTerminalInputCoverage(false)
        assertFalse(harness.runtime.state.value.terminalInputAdmissionOpen, "intake closes synchronously")
        val refused = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(refused is ContentInputAdmission.Refused, "$refused")
        // A modal does not retire the stream: a new measurement still resizes it, and the
        // published view survives.
        assertEquals(ViewportResult.Applied(90, 30), harness.runtime.setViewport(90, 30))
        harness.settle()
        assertTrue(content.contentFrames().any { it.wireType == ContentFrameType.RESIZE.wireValue })
        assertNotNull(harness.runtime.currentContentObservation()?.view)
        assertEquals(0, content.contentFrames().count { it.wireType.startsWith("input") })

        // And the covered stream can still retire itself cleanly.
        assertEquals(TerminalLeaveResult.Left(harness.target()), harness.runtime.leaveTerminal())
        harness.settle()
        assertTrue(content.contentFrames().any { it.wireType == ContentFrameType.UNSUBSCRIBE.wireValue })
        assertEquals(0, content.closeCount, "the notice is sent; the owner's ack still ends the stream")
        harness.unsubscribed(content)
        harness.settle()
        assertEquals(1, content.closeCount, "the runtime closes the channel it opened, once its stream retired")
        harness.closeRuntime()
    }

    @Test
    fun losingAndRegainingCoverageDemandsAFreshRealCommitInsteadOfRevivingTheOldReceipt() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)
        assertTrue(
            harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
                is ContentInputAdmission.Accepted,
        )
        harness.settle()

        harness.runtime.setTerminalInputCoverage(false)
        harness.runtime.setTerminalInputCoverage(true)
        assertFalse(harness.runtime.state.value.terminalInputAdmissionOpen, "identical pixels are not a new commit")
        val refused = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(refused is ContentInputAdmission.Refused, "the old receipt cannot authorize again: $refused")
        assertEquals(1, content.contentFrames().count { it.wireType == ContentFrameType.INPUT.wireValue })

        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        assertTrue(
            harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
                is ContentInputAdmission.Accepted,
        )
        harness.settle()
        assertEquals(2, content.contentFrames().count { it.wireType == ContentFrameType.INPUT.wireValue })
        harness.closeRuntime()
    }

    @Test
    fun switchingSelectionClosesOnlyTheOutgoingStreamAndKillsItsInputSynchronously() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val first = harness.terminalUp()
        harness.commitPublishedFrame(1L)

        val switched = harness.runtime.selectTerminal(harness.target(rowId = ROW_2), ALWAYS_TRUE)
        assertTrue(switched is SelectionResult.Selected, "$switched")
        // Synchronously, before any coroutine ran: the outgoing stream cannot admit input,
        // and the incoming one has no pixels or receipt to inherit.
        assertFalse(harness.runtime.state.value.terminalInputAdmissionOpen)
        val staleSubmit = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(staleSubmit is ContentInputAdmission.Refused, "$staleSubmit")

        harness.settle()
        assertEquals(2, harness.openedContentChannels.size)
        val second = harness.lastContentChannel()
        assertTrue(first !== second)
        assertTrue(first.contentFrames().any { it.wireType == ContentFrameType.UNSUBSCRIBE.wireValue })
        assertEquals(0, first.closeCount, "the outgoing stream is still retiring its own controls")
        harness.unsubscribed(first)
        harness.settle()
        assertEquals(1, first.closeCount)
        assertEquals(0, second.closeCount)
        assertNull(harness.runtime.currentContentObservation()?.writtenReceipt, "a new stream inherits no receipt")
        assertNull(harness.runtime.currentContentObservation()?.view, "a new stream inherits no pixels")
        assertEquals(harness.target(rowId = ROW_2), harness.runtime.state.value.selection?.target)
        harness.closeRuntime()
    }

    @Test
    fun leavingTheTerminalWithdrawsTheStreamWithoutEverAskingTheOwnerToStop() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        val roster = harness.hostChannel(HOST_A)!!

        assertEquals(TerminalLeaveResult.Left(harness.target()), harness.runtime.leaveTerminal())
        harness.settle()

        assertTrue(content.contentFrames().any { it.wireType == ContentFrameType.UNSUBSCRIBE.wireValue })
        assertFalse(content.contentFrames().any { it.wireType == ContentFrameType.ERROR.wireValue })
        harness.unsubscribed(content)
        harness.settle()
        assertEquals(1, content.closeCount)
        assertNoRosterClose(harness.rosterFrames(roster))
        // The host lane and its roster survive a terminal navigation untouched.
        assertEquals(HostLanePhase.ATTACHED, harness.hostState(HOST_A)?.lane)
        assertEquals(RosterProjectionState.CURRENT, harness.hostState(HOST_A)?.roster?.projection?.state)
        assertNull(harness.runtime.state.value.selection)
        assertEquals(harness.target(), harness.runtime.state.value.rememberedTarget)
        assertFalse(harness.runtime.state.value.restoreArmed, "leaving is not an armed restoration")
        harness.closeRuntime()
    }

    @Test
    fun aDisabledPreferenceRetiresInputAndCopyButNotDisplayResizeOrUnsubscribe() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)
        harness.runtime.updateInputPolicy(ContentInputPolicy(enabled = false, generation = 2L))
        harness.settle()

        val refused = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(refused is ContentInputAdmission.Refused, "$refused")
        assertEquals(0, content.contentFrames().count { it.wireType.startsWith("input") })

        // Control traffic is untouched by the preference: a new measurement still goes out,
        // and the stream still retires itself cleanly afterwards.
        harness.runtime.setViewport(100, 28)
        harness.settle()
        assertTrue(content.contentFrames().any { it.wireType == ContentFrameType.RESIZE.wireValue })
        harness.runtime.leaveTerminal()
        harness.settle()
        assertTrue(content.contentFrames().any { it.wireType == ContentFrameType.UNSUBSCRIBE.wireValue })
        harness.closeRuntime()
    }

    @Test
    fun aCopyIsOfferedOnlyToTheViewerStillLookingAndNeverAsARawCompletion() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        val subscription = harness.subscriptionOf(content)

        inlineCopyFrames(
            copyId = "copy-1",
            subscriptionId = subscription,
            sequence = 1L,
            source = nativeSource(),
        ).forEach { content.push(it) }
        harness.settle()
        // The endpoint's raw completion never reaches the adapter. What it reaches is an
        // offer the adapter must claim at delivery time, so a copy that sits in a bounded
        // queue across a navigation or a background cannot reach a clipboard on its own.
        assertEquals(0, harness.contentEvents().filterIsInstance<ContentEndpointEvent.CopyDelivered>().size)
        val offered = harness.events.filterIsInstance<ClientRuntimeEvent.TerminalCopyOffered>()
        assertEquals(1, offered.size)
        assertEquals("copy-1", offered.single().copy.copyId)
        val payload = offered.single().copy.event
        assertTrue(payload is NativeIoCopyEvent.Copy, "the payload is the canonical event, never raw OSC bytes")
        assertEquals("aGVsbG8=", (payload as NativeIoCopyEvent.Copy).encoded)

        // A chooser over the pane: the copy is reported as suppressed, never buffered for a
        // later foreground and never replayed.
        harness.runtime.setTerminalInputCoverage(false)
        inlineCopyFrames(
            copyId = "copy-2",
            subscriptionId = subscription,
            sequence = 2L,
            source = nativeSource(),
        ).forEach { content.push(it) }
        harness.settle()
        val suppressed = harness.events.filterIsInstance<ClientRuntimeEvent.TerminalCopySuppressed>()
        assertEquals(listOf("copy-2"), suppressed.map { it.copyId })
        assertEquals(CopySuppressionReason.TERMINAL_NOT_COVERED, suppressed.single().reason)
        assertEquals(1, harness.events.filterIsInstance<ClientRuntimeEvent.TerminalCopyOffered>().size)
        harness.closeRuntime()
    }

    @Test
    fun aCopyOfferedUnderCurrentFencesIsGrantedExactlyOnce() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        harness.offerCopy(content, "copy-1", 1L)
        assertEquals(1, harness.copyOffers().size)

        val first = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(first is TerminalCopyClaim.Granted, "$first")
        assertEquals("copy-1", (first as TerminalCopyClaim.Granted).copy.copyId)

        // Spent exactly once. A second delivery of the same copy is not a second claim.
        val second = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(
            second is TerminalCopyClaim.Suppressed && second.reason == CopySuppressionReason.COPY_SUPERSEDED,
            "$second",
        )
        harness.closeRuntime()
    }

    @Test
    fun aCopyClaimThatFailsItsProofRetiresThatCopyInsteadOfAllowingARetry() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        harness.offerCopy(content, "copy-1", 1L)

        val stale = harness.runtime.claimTerminalCopy(1L, "copy-1", ToggleProof(initial = false))
        assertTrue(
            stale is TerminalCopyClaim.Suppressed && stale.reason == CopySuppressionReason.PROOF_UNAVAILABLE,
            "$stale",
        )
        // The attempt itself spent the offer. Nothing about this copy is claimable again,
        // not even one tick later under a proof that genuinely holds.
        val retry = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(
            retry is TerminalCopyClaim.Suppressed && retry.reason == CopySuppressionReason.COPY_SUPERSEDED,
            "$retry",
        )
        // A copy actually received afterwards is a different copy, and it is deliverable.
        harness.offerCopy(content, "copy-2", 2L)
        assertTrue(harness.runtime.claimTerminalCopy(1L, "copy-2", ALWAYS_TRUE) is TerminalCopyClaim.Granted)
        harness.closeRuntime()
    }

    @Test
    fun aPolicyChangePermanentlyRetiresAnOfferedCopyEvenAfterItIsSwitchedBackOn() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        harness.offerCopy(content, "copy-1", 1L)

        harness.runtime.updateInputPolicy(ContentInputPolicy(enabled = false, generation = 2L))
        harness.settle()
        val off = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(
            off is TerminalCopyClaim.Suppressed && off.reason == CopySuppressionReason.POLICY_DISABLED,
            "$off",
        )

        // Back on, and with a fresh real commit under the new generation: the original copy
        // is still gone. A policy cycle never revives it.
        harness.runtime.updateInputPolicy(ContentInputPolicy(enabled = true, generation = 3L))
        harness.settle()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        val back = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(
            back is TerminalCopyClaim.Suppressed && back.reason == CopySuppressionReason.COPY_SUPERSEDED,
            "$back",
        )
        harness.closeRuntime()
    }

    @Test
    fun aCoverageReturnPermanentlyRetiresTheCopyOfferedBeforeTheInterruption() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        harness.offerCopy(content, "copy-1", 1L)

        harness.runtime.setTerminalInputCoverage(false)
        harness.settle()
        val covered = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(
            covered is TerminalCopyClaim.Suppressed &&
                covered.reason == CopySuppressionReason.TERMINAL_NOT_COVERED,
            "$covered",
        )

        // The chooser closed and the caller committed a fresh frame. Byte-identical pixels
        // are not the same viewing, and the copy offered before the interruption is over.
        harness.runtime.setTerminalInputCoverage(true)
        harness.settle()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        val returned = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(
            returned is TerminalCopyClaim.Suppressed &&
                returned.reason == CopySuppressionReason.COPY_SUPERSEDED,
            "$returned",
        )
        harness.closeRuntime()
    }

    @Test
    fun aSourceThatReturnsToItsOriginalStillRetiresTheOfferedCopy() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        harness.offerCopy(content, "copy-1", 1L)

        // A different published source, then the original one again. The view is
        // structurally what it was; the source generation it was captured under is not.
        val sourceB = contentSource(
            hostRunId = RUN_ID,
            sessionId = ROW_1,
            nativeSession = NativeSessionRef("native-session-1", 4),
            geometry = CONTENT_GEOMETRY,
        )
        harness.publishContent(
            content,
            source = sourceB,
            sequence = 2L,
            rowId = ROW_1,
            nativeSession = NativeSessionRef("native-session-1", 4),
        )
        harness.publishContent(content, source = nativeSource(ROW_1), sequence = 3L, rowId = ROW_1)

        val claim = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(
            claim is TerminalCopyClaim.Suppressed && claim.reason == CopySuppressionReason.COPY_SUPERSEDED,
            "$claim",
        )
        harness.closeRuntime()
    }

    @Test
    fun aSettlementHeldForAWriteThatThenCrossesInvocationIsPublishedAsUnknown() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        content.blockWrites()
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        harness.settle()

        // Publication pauses right here: the preference change settles this input while its
        // only page is still inside the transport, so "definitely not sent" cannot be said.
        harness.runtime.updateInputPolicy(ContentInputPolicy(enabled = false, generation = 2L))
        harness.settle()
        assertEquals(0, harness.inputOutcomes().size, "held while the write is still inside the transport")

        // The transport then crosses the invocation boundary anyway, and fails there. The
        // only terminal result this input can honestly receive is unknown.
        content.forceInvokeOnRelease()
        content.releaseWrites()
        harness.awaitUntil("the held settlement was published") { harness.inputOutcomes().isNotEmpty() }

        assertEquals(listOf(ContentSendOutcome.Unknown), harness.inputOutcomes())
        harness.closeRuntime()
    }

    @Test
    fun ordinaryContentChannelLossReconcilesAnAcceptedInputWithoutAnyExplicitFinalize() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        content.blockWrites()
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        harness.settle()

        // Only this stream's own inbound side ends, and the blocked write is never released
        // by hand. Nobody calls `finalize`: ordinary termination has to reconcile itself.
        content.endIncoming()
        harness.awaitUntil("the accepted input settled") { harness.inputOutcomes().isNotEmpty() }
        harness.settle()

        assertEquals(1, harness.inputOutcomes().size, "${harness.inputOutcomes()}")
        assertTrue(
            harness.inputOutcomes().single() !is ContentSendOutcome.Submitted,
            "a stream that ended mid-write never reports success: ${harness.inputOutcomes()}",
        )
        assertEquals(1, content.closeCount, "this runtime closes the channel it opened")
        assertEquals(0, harness.time.armedCount(), "nothing of the ended stream stays armed")
        harness.closeRuntime()
    }

    @Test
    fun theStopAcknowledgementDeadlineSurvivesAWriteStuckInTheTransportAndExpiresOnItsOwn() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        content.blockAfterInvoke()
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        harness.settle()

        // The stream is asked to retire while a page sits inside the transport, past its
        // invocation boundary. Its own acknowledgement timer is what ends it.
        harness.runtime.leaveTerminal()
        harness.settle()

        val types = content.contentFrames().map { it.wireType }
        assertTrue(types.contains("hello") || types.contains("subscribe"), "the stream was live: $types")
        assertTrue(harness.time.armedCount() > 0, "the stop-acknowledgement arm stays armed")

        // No further traffic at all: the armed deadline alone must finish the retirement.
        // The wedged page holds the writer, so the lane cannot jump the queue — and the
        // deadline it armed is still what ends the stream.
        harness.time.advance(120L * 1_000_000_000L)
        harness.settle()

        assertEquals(0, harness.time.armedCount(), "the deadline fired and the retired lane cancelled it")
        assertEquals(1, content.closeCount)
        assertNoRosterClose(harness.rosterFrames(harness.hostChannel(HOST_A)!!))
        harness.closeRuntime()
    }

    @Test
    fun anOfferedCopyDiesWithItsSelectionInsteadOfReachingTheNextOne() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        val subscription = harness.subscriptionOf(content)
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        inlineCopyFrames(
            copyId = "copy-1",
            subscriptionId = subscription,
            sequence = 1L,
            source = nativeSource(),
        ).forEach { content.push(it) }
        harness.settle()
        assertEquals(1, harness.events.filterIsInstance<ClientRuntimeEvent.TerminalCopyOffered>().size)

        // Navigating away with the copy still unclaimed: it is over. It cannot be delivered
        // later, and it is never handed to the stream that replaced this one.
        harness.runtime.leaveTerminal()
        harness.settle()
        val claim = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(
            claim is TerminalCopyClaim.Suppressed && claim.reason == CopySuppressionReason.SELECTION_WITHDRAWN,
            "$claim",
        )
        // The policy switching off retires copy alone: the stream still retires itself.
        harness.runtime.updateInputPolicy(ContentInputPolicy(enabled = false, generation = 4L))
        harness.settle()
        harness.unsubscribed(content)
        harness.settle()
        assertNoRosterClose(harness.rosterFrames(harness.hostChannel(HOST_A)!!))
        harness.closeRuntime()
    }

    @Test
    fun aHostThatDiesSettlesAnInvokedContentWriteAsUnknownAndClosesTheStreamItOpened() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        content.blockAfterInvoke()
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        harness.settle()

        // The host's APP channel dies while this page is inside the transport, past its
        // invocation boundary. The accepted input still has to reach a terminal outcome, and
        // the only honest one is unknown.
        harness.hostChannel(HOST_A)!!.endIncoming()
        harness.awaitUntil("the accepted input settled") { harness.inputOutcomes().isNotEmpty() }

        assertTrue(
            harness.inputOutcomes().none { it is ContentSendOutcome.NotSent },
            "an invoked write is never never-sent: ${harness.inputOutcomes()}",
        )
        assertEquals(listOf(ContentSendOutcome.Unknown), harness.inputOutcomes())
        assertEquals(1, content.closeCount, "this runtime closes the channel it opened")
        assertNull(harness.selection(HOST_A))
        assertEquals(0, harness.time.armedCount(), "no deadline of a ended host stays armed")
        harness.closeRuntime()
    }

    @Test
    fun explicitDetachSettlesAQueuedInputInsteadOfAbandoningIt() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)
        content.blockWrites()
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        harness.settle()

        // The parent ends the host with a page still queued and never invoked. Ending is
        // bounded, and the accepted input still reaches a terminal outcome here.
        assertTrue(harness.runtime.detachHost(HostId.parse(HOST_A)))

        assertEquals(1, harness.inputOutcomes().size, "${harness.inputOutcomes()}")
        // The page was cancelled inside the transport, and the transport recorded no
        // positive never-sent for it. The lane may not claim never-sent from that, and it
        // never claims success: exactly one terminal settlement, and it is the unknown one.
        assertTrue(
            harness.inputOutcomes().single() is ContentSendOutcome.Unknown,
            "${harness.inputOutcomes()}",
        )
        assertEquals(1, content.closeCount, "this runtime closes the channel it opened")
        assertEquals(0, harness.time.armedCount(), "no deadline of a retired stream stays armed")
        assertNull(harness.selection(HOST_A))
        harness.closeRuntime()
    }

    @Test
    fun aPolicyChangeAndAStopAreAppliedInRequestOrderAndTheStopDeadlineStaysArmed() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)

        // Two calls issued back to back. Applying the older call's step after the newer one
        // mirrored away the stop-acknowledgement arm and left this stream in STOPPING with
        // nothing left to retire it.
        harness.runtime.updateInputPolicy(ContentInputPolicy(enabled = true, generation = 2L))
        harness.runtime.leaveTerminal()
        harness.settle()

        val types = content.contentFrames().map { it.wireType }
        val unsubscribeAt = types.indexOf("unsubscribe")
        assertTrue(unsubscribeAt >= 0, "the retired stream sent its own notice: $types")
        assertTrue(harness.time.armedCount() > 0, "the stop-acknowledgement deadline is still armed")

        // The owner's acknowledgement completes the retirement, and the armed arm goes with it.
        harness.unsubscribed(content)
        harness.settle()
        assertEquals(1, content.closeCount)
        assertEquals(0, harness.time.armedCount())
        assertNoRosterClose(harness.rosterFrames(harness.hostChannel(HOST_A)!!))
        harness.closeRuntime()
    }

    @Test
    fun aWithdrawalBetweenValidationAndInstallationStartsNoStreamAtAll() = runBlocking {
        val late = mutableListOf<FakePeerByteChannel>()
        val opened = CompletableDeferred<Unit>()
        val proceed = CompletableDeferred<Unit>()
        val harness = RuntimeHarness(
            coroutineContext,
            opener = ContentChannelOpener { _, _, _ ->
                opened.complete(Unit)
                proceed.await()
                FakePeerByteChannel(PeerAppLane.CONTENT, "late").also { late += it }
            },
        )
        val roster = harness.attach(HOST_A).first
        harness.subscribed(HOST_A, roster)
        harness.publishSnapshot(roster, rows = listOf(RosterClientHarness.row(ROW_1)))
        check(harness.runtime.setViewport(80, 24) is ViewportResult.Applied)
        assertTrue(harness.runtime.selectTerminal(harness.target(), ALWAYS_TRUE) is SelectionResult.Selected)
        harness.awaitUntil("the content channel was opened") { opened.isCompleted }

        // The channel exists and the lane does not. Navigation happens in exactly this window.
        harness.runtime.leaveTerminal()
        proceed.complete(Unit)
        harness.settle()

        val content = late.single()
        assertEquals(0, content.writes.size, "a superseded selection never wrote on the channel it opened")
        assertEquals(1, content.closeCount, "the channel this runtime opened is still closed")
        assertNull(harness.selection(HOST_A))
        assertNull(harness.runtime.currentContentObservation())
        harness.closeRuntime()
    }

    @Test
    fun everyPageOfOneLogicalInputLeavesTheWriterInOneUninterruptedRun() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)
        content.blockWrites()
        val first = harness.runtime.submitInput(pasteRequest(bytes = PASTED_PAGE + 1_024, source = nativeSource()), ALWAYS_TRUE)
        val second = harness.runtime.submitInput(pasteRequest(bytes = PASTED_PAGE + 2_048, source = nativeSource()), ALWAYS_TRUE)
        assertTrue(
            first is ContentInputAdmission.Accepted && second is ContentInputAdmission.Accepted,
            "$first / $second",
        )
        content.releaseWrites()
        harness.settle()

        val ids = content.contentFrames().filter { it.wireType.startsWith("input") }.map { inputIdOf(it) }
        assertTrue(ids.size > 4, "a pasted-over-page input is paged: ${ids.size} frames")
        assertEquals(2, ids.distinct().size, "two logical inputs: ${ids.distinct()}")
        val runs = mutableListOf<String>()
        for (id in ids) if (runs.lastOrNull() != id) runs += id
        assertEquals(ids.distinct().sorted(), runs.sorted(), "each logical input's pages are one contiguous run")
        assertEquals(listOf(ContentSendOutcome.Submitted, ContentSendOutcome.Submitted), harness.inputOutcomes())
        harness.closeRuntime()
    }

    @Test
    fun aChannelLostWhileAWriteIsInFlightIsSettledAsUnknownNeverNeverSent() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)
        content.blockWrites()
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        harness.settle(turns = 4)
        // The peer disappears while this side's write has been entered and has not returned.
        content.endIncoming()
        content.releaseWrites()
        harness.settle()

        assertEquals(
            listOf(ContentSendOutcome.Unknown),
            harness.inputOutcomes(),
            "an invoked write can never be called definitely not sent",
        )
        harness.closeRuntime()
    }

    @Test
    fun aProofThatExpiresAtTheSocketWriteBoundaryNeverBecomesBytes() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)
        content.blockWrites()
        // The same proof object is consulted by the lane before it queues, by the channel
        // at admission, and by the channel again under write ownership. It holds for the
        // first two and fails at the last: exactly the window a queued frame lives through.
        val proof = FlipOnCheckProof(flipOn = 4)
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), proof)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        harness.settle()
        assertEquals(3, proof.checks, "the lane and the channel admission both proved it")
        content.releaseWrites()
        harness.settle()

        assertEquals(0, content.contentFrames().count { it.wireType.startsWith("input") })
        assertEquals(
            listOf(ContentSendOutcome.NotSent(ContentNotSentReason.STOPPED)),
            harness.inputOutcomes(),
            "refused under write ownership means nothing was ever invoked",
        )
        harness.closeRuntime()
    }

    @Test
    fun aWriteRefusedAfterItsInvocationBoundarySettlesUnknownNeverNotSent() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)
        val proof = ToggleProof(true)
        content.blockAfterInvoke()
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), proof)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        harness.settle()
        // The frame crossed the invocation boundary and its socket handoff has not
        // returned. Only now does the source stop being current.
        proof.current = false
        content.releaseWrites()
        harness.settle()

        assertEquals(0, content.contentFrames().count { it.wireType.startsWith("input") })
        assertEquals(
            listOf(ContentSendOutcome.Unknown),
            harness.inputOutcomes(),
            "past the invocation boundary, 'provably never sent' is no longer a claim to make",
        )
        harness.closeRuntime()
    }

    @Test
    fun invokedEvidenceReachesTheModelBeforeAnInvalidatingInboundFrame() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        val subscription = harness.subscriptionOf(content)
        harness.commitPublishedFrame(1L)
        content.blockWrites()
        val admission = harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        assertTrue(admission is ContentInputAdmission.Accepted, "$admission")
        harness.settle()
        // The owner ends the stream, and the write is released, without letting the driver
        // take a turn in between: the inbound frame can therefore be sitting in the lane's
        // queue ahead of the invocation report, which is the ordering that used to let a
        // settled never-sent win over a write that had already been invoked.
        content.push(EndFrame(subscription, ContentEndCode.CLOSED))
        content.releaseWrites()
        harness.settle()

        val settled = harness.inputOutcomes()
        assertEquals(1, settled.size)
        assertTrue(
            settled.single() != ContentSendOutcome.NotSent(ContentNotSentReason.STOPPED),
            "an invoked input must never be published as definitely never sent: $settled",
        )
        harness.closeRuntime()
    }

    @Test
    fun theEndpointsOwnDeadlinesAreArmedWithTheInjectedClockAndCancelledOnRetirement() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        // Subscribed and waiting for its first transfer: the endpoint armed that timer, and
        // the runtime armed exactly it on the test's own clock.
        val content = harness.terminalUp(publish = false)
        assertTrue(harness.time.armedCount() > 0, "the endpoint's armed deadline set is mirrored")
        harness.publishContent(content, source = nativeSource(), sequence = 1L)
        assertNotNull(harness.runtime.currentContentObservation()?.view)
        assertTrue(harness.time.armed.all { it > harness.time.nowNanos }, "no armed arm is already expired")

        harness.runtime.leaveTerminal()
        harness.settle()
        harness.unsubscribed(content)
        harness.settle()
        assertEquals(0, harness.time.armedCount(), "a retired stream keeps no timer")
        harness.closeRuntime()
    }
    @Test
    fun anInputQueuedBehindContentChannelTerminationFinishesInsteadOfHangingForever() = runBlocking {
        // One event slot and a collector this suite controls, so the stream's driver can be
        // left parked inside its own publication with its signal queue still un-drained.
        val harness = RuntimeHarness(
            coroutineContext,
            config = runtimeConfig(
                ids = CountingRuntimeIds(),
                contentCapabilities = listOf(ContentProtocol.NATIVE_IO_CAPABILITY),
                initialInputPolicy = ContentInputPolicy(enabled = true, generation = 1L),
                eventQueueCapacity = 1,
            ),
        )
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)

        harness.pauseEvents()
        harness.publishContent(content, source = nativeSource(), sequence = 2L)
        harness.publishContent(content, source = nativeSource(), sequence = 3L)
        // The stream's own channel ends while its driver is parked. The reader queues that
        // notice, so the driver breaks out before it ever reaches what comes after it.
        content.endIncoming()
        harness.settle()

        val call = async {
            harness.runtime.submitInput(keyboardRequest(source = nativeSource()), ALWAYS_TRUE)
        }
        harness.resumeEvents()
        harness.settle()
        val admission = withTimeoutOrNull(5_000L) { call.await() }

        assertNotNull(admission, "the caller was still parked after its stream had finished")
        assertIs<ContentInputAdmission.Refused>(admission)
        harness.closeRuntime()
    }

    @Test
    fun pagesStillQueuedBehindASettledInputLeaveNoTrackingRecordBehind() = runBlocking {
        val harness = nativeInputHarness(coroutineContext)
        val content = harness.terminalUp()
        harness.commitPublishedFrame(1L)

        // The first page crosses the invocation boundary and never returns. The endpoint
        // bounds an invoked write by its own finite send deadline, so the logical input
        // settles while the rest of its pages are still queued behind the stuck one.
        content.blockAfterInvoke()
        assertIs<ContentInputAdmission.Accepted>(
            harness.runtime.submitInput(
                pasteRequest(bytes = PASTED_PAGE + 4_096, source = nativeSource()),
                ALWAYS_TRUE,
            ),
        )
        harness.settle()
        harness.time.advanceMillis(31_000L)
        harness.settle()
        assertEquals(
            listOf(ContentSendOutcome.Unknown),
            harness.inputOutcomes(),
            "the bounded invoked page settles the operation, once",
        )

        // The stuck page finally returns and the remaining pages are dispatched. Their
        // guards are no longer current, so each is refused — and a refused page must never
        // resurrect a tracking record its operation already settled with, because no
        // further terminal event can arrive to remove it.
        content.releaseWrites()
        harness.settle()

        assertEquals(listOf(ContentSendOutcome.Unknown), harness.inputOutcomes(), "still exactly one settlement")
        assertEquals(0, harness.runtime.trackedInputFlights(), "no queued page recreated a settled record")
        harness.closeRuntime()
    }
}

/** The default content chunk page size, so a suite asks for "more than one page" honestly. */
private const val PASTED_PAGE: Int = 32 * 1024

/** A runtime whose content streams offer native input and start with it switched on. */
internal fun nativeInputHarness(
    context: kotlin.coroutines.CoroutineContext,
    policy: ContentInputPolicy = ContentInputPolicy(enabled = true, generation = 1L),
): RuntimeHarness = RuntimeHarness(
    context,
    config = runtimeConfig(
        ids = CountingRuntimeIds(),
        contentCapabilities = listOf(ContentProtocol.NATIVE_IO_CAPABILITY),
        initialInputPolicy = policy,
    ),
)

/** The input id of one input frame, whatever shape that page took. */
internal fun inputIdOf(frame: ContentFrame): String = when (frame) {
    is io.github.rfairburn.pireviewgate.core.protocol.content.InputFrame -> frame.inputId
    is io.github.rfairburn.pireviewgate.core.protocol.content.InputBeginFrame -> frame.inputId
    is io.github.rfairburn.pireviewgate.core.protocol.content.InputChunkFrame -> frame.inputId
    is io.github.rfairburn.pireviewgate.core.protocol.content.InputEndFrame -> frame.inputId
    else -> error("not an input frame: ${frame.wireType}")
}
