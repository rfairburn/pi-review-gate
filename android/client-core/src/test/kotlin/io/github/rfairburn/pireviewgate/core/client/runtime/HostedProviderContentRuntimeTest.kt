package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointEvent
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointPhase
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputAdmission
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy
import io.github.rfairburn.pireviewgate.core.client.content.ContentSendOutcome
import io.github.rfairburn.pireviewgate.core.client.content.ContentWrittenFrameOutcome
import io.github.rfairburn.pireviewgate.core.client.content.inlineCliCopyFrames
import io.github.rfairburn.pireviewgate.core.client.content.keyboardRequest
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.InputFrame
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoNativeCliCopyEvent
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The hosted provider CLI row through the runtime's own fences: its input is admitted
 * onto the tuple-less source its owner actually published — no Pi conversation is
 * awaited or fabricated — and its text copy travels the SAME offer/claim path, with the
 * SAME suppression reasons, as a Pi conversation copy. An extension the owner never
 * acknowledged opens nothing writable.
 */
class HostedProviderContentRuntimeTest {

    private fun hostedHarness(
        context: kotlin.coroutines.CoroutineContext,
        policy: ContentInputPolicy = ContentInputPolicy(enabled = true, generation = 1L),
    ): RuntimeHarness = RuntimeHarness(
        context,
        config = runtimeConfig(
            ids = CountingRuntimeIds(),
            contentCapabilities = ContentProtocol.IMPLEMENTABLE_OPTIONAL_CAPABILITIES,
            initialInputPolicy = policy,
        ),
    )

    @Test
    fun aHostedProviderRowWritesItsOwnSourceWithoutAnyPiConversationTuple() = runBlocking {
        val harness = hostedHarness(coroutineContext)
        val source = hostedSource()
        val content = harness.terminalUp(
            contentCapabilities = HOSTED_IO_ACK_CAPS,
            source = source,
            nativeSession = null,
        )
        assertEquals(null, harness.runtime.currentContentObservation()?.view?.meta?.nativeSession)
        assertTrue(
            harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered,
            "a hosted provider publication is committable exactly like a Pi one",
        )

        val admission = harness.runtime.submitInput(keyboardRequest(source = source), ALWAYS_TRUE)
        assertIs<ContentInputAdmission.Accepted>(admission)
        harness.settle()

        val frame = content.contentFrames().filterIsInstance<InputFrame>().single()
        assertEquals(source, frame.source)
        assertEquals(listOf(ContentSendOutcome.Submitted), harness.inputOutcomes())
        harness.closeRuntime()
    }

    @Test
    fun aHostedProviderCopyIsOfferedThenGrantedExactlyOnceThroughTheSameClaim() = runBlocking {
        val harness = hostedHarness(coroutineContext)
        val source = hostedSource()
        val content = harness.terminalUp(
            contentCapabilities = HOSTED_IO_ACK_CAPS,
            source = source,
            nativeSession = null,
        )
        assertTrue(harness.commitPublishedFrame(1L) is ContentWrittenFrameOutcome.Registered)

        inlineCliCopyFrames(
            copyId = "copy-1",
            subscriptionId = harness.subscriptionOf(content),
            sequence = 1L,
            source = source,
        ).forEach { content.push(it) }
        harness.settle()

        val offered = harness.copyOffers()
        assertEquals(1, offered.size)
        assertEquals(source, offered.single().copy.source)
        val event = assertIs<NativeIoNativeCliCopyEvent>(offered.single().copy.event)
        assertEquals(NativeCliBackend.CLAUDE, event.backend)
        // The endpoint's raw completion never reaches the adapter: only a claimable offer does.
        assertEquals(0, harness.contentEvents().count { it is ContentEndpointEvent.CopyDelivered })

        val first = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertIs<TerminalCopyClaim.Granted>(first)
        assertEquals("copy-1", (first as TerminalCopyClaim.Granted).copy.copyId)

        val second = harness.runtime.claimTerminalCopy(1L, "copy-1", ALWAYS_TRUE)
        assertTrue(
            second is TerminalCopyClaim.Suppressed && second.reason == CopySuppressionReason.COPY_SUPERSEDED,
            "$second",
        )
        harness.closeRuntime()
    }

    @Test
    fun aHostedProviderCopyIsSuppressedForAViewerThatStoppedLookingAndNeverQueued() = runBlocking {
        val harness = hostedHarness(coroutineContext)
        val source = hostedSource()
        val content = harness.terminalUp(
            contentCapabilities = HOSTED_IO_ACK_CAPS,
            source = source,
            nativeSession = null,
        )
        harness.runtime.setTerminalInputCoverage(false)

        inlineCliCopyFrames(
            copyId = "copy-1",
            subscriptionId = harness.subscriptionOf(content),
            sequence = 1L,
            source = source,
        ).forEach { content.push(it) }
        harness.settle()

        assertEquals(0, harness.copyOffers().size)
        val suppressed = harness.events.filterIsInstance<ClientRuntimeEvent.TerminalCopySuppressed>()
        assertEquals(listOf("copy-1"), suppressed.map { it.copyId })
        assertEquals(CopySuppressionReason.TERMINAL_NOT_COVERED, suppressed.single().reason)

        // Coming back is not the same viewing: the copy is not replayed into a clipboard.
        harness.runtime.setTerminalInputCoverage(true)
        harness.settle()
        assertEquals(0, harness.copyOffers().size)
        harness.closeRuntime()
    }

    @Test
    fun aHostedProviderSourceTheOwnerNeverAcknowledgedOpensNothingWritable() = runBlocking {
        val harness = hostedHarness(coroutineContext)
        val source = hostedSource()
        val content = harness.terminalUp(
            contentCapabilities = NATIVE_IO_ACK_CAPS,
            source = source,
            nativeSession = null,
        )
        harness.settle()

        val observation = harness.runtime.currentContentObservation()
        assertTrue(
            observation == null || observation.phase == ContentEndpointPhase.RETIRED,
            "an unacknowledged extension is a violation, not a degraded stream: $observation",
        )
        assertTrue(
            harness.runtime.submitInput(keyboardRequest(source = source), ALWAYS_TRUE)
            is ContentInputAdmission.Refused,
        )
        assertEquals(0, content.contentFrames().count { it.wireType.startsWith("input") })
        harness.closeRuntime()
    }
}
