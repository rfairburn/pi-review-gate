package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.protocol.content.Base64Wire
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.INPUT_MODES
import io.github.rfairburn.pireviewgate.core.protocol.content.InputFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoCopyEvent
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoNativeCliCopyEvent
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoNativeCliSource
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.content.contentSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Hosted provider CLI coverage for the selected-content endpoint: a native row's
 * input is admitted onto its own tuple-less written source with no Pi conversation
 * awaited, the two hosted capabilities gate the source and the copy independently, a
 * copy is routed only to the viewer whose current publication names the same backend
 * and source, and every staleness, policy, geometry, and sequence fence behaves
 * exactly as it does for a Pi conversation source.
 *
 * Every hosted publication here states `nativeSession = null` on purpose: this harness
 * hands typed frames to `onFrame`, so it would otherwise accept a publish that the real
 * decoder refuses outright (a hosted provider source paired with a Pi conversation
 * tuple is `BAD_FRAME`, which `NativeCliIoCodecTest` pins at the wire level). A
 * publication that could not exist on the wire would make these results unrepresentative.
 */
class ContentEndpointNativeCliTest {

	private fun readyCli(
		cliInput: Boolean = true,
		cliCopy: Boolean = true,
		ack: List<String> = NATIVE_CLI_IO_ACK,
		policy: ContentInputPolicy = ContentInputPolicy(enabled = true, generation = 1L),
	): ContentEndpointHarness {
		val harness = ContentEndpointHarness(
			ContentEndpoint(nativeCliIoConfig(cliInput = cliInput, cliCopy = cliCopy, policy = policy)),
		)
		harness.handshake(ack)
		return harness
	}

	private fun delivered(harness: ContentEndpointHarness): List<ContentCopyReceipt> =
		harness.events.filterIsInstance<ContentEndpointEvent.CopyDelivered>().map { it.copy }

	private fun settled(harness: ContentEndpointHarness): List<ContentEndpointEvent.InputSettled> =
		harness.events.filterIsInstance<ContentEndpointEvent.InputSettled>()

	/* ------------------------------------------------------------------ *
	 * Input
	 * ------------------------------------------------------------------ */

	@Test
	fun `a hosted provider row is input-ready from its own tuple-less published source`() {
		val harness = readyCli()
		val source = sampleNativeCliSource()

		val outcome = harness.commitWrittenFrame(source, nativeSession = null)
		assertIs<ContentWrittenFrameOutcome.Registered>(outcome)

		val target = harness.endpoint.readNativeInputTarget()
		assertNotNull(target)
		assertIs<NativeIoNativeCliSource>(target.source)
		assertEquals(NativeCliBackend.CLAUDE, target.source.backend)
		assertEquals(source, target.source)
		// The publication named no Pi conversation at all, and readiness did not wait for one.
		assertNull(harness.observation.view?.meta?.nativeSession)
	}

	@Test
	fun `keyboard mouse and an explicit text paste are admitted onto the hosted provider source`() {
		val harness = readyCli()
		harness.commitWrittenFrame(sampleNativeCliSource(), nativeSession = null)

		for (request in listOf(
			keyboardRequest("a", source = sampleNativeCliSource()),
			mouseRequest(source = sampleNativeCliSource()),
			pasteRequest(2_048, source = sampleNativeCliSource()),
		)) {
			val accepted = assertIs<ContentInputAdmission.Accepted>(harness.admit(request))
			val first = assertIs<InputFrame>(accepted.effects.single().frame)
			assertEquals(sampleNativeCliSource(), first.source)
			assertEquals(INPUT_MODES, first.inputModes)
		}
	}

	@Test
	fun `a hosted provider source on a channel that never negotiated it is a violation`() {
		val harness = readyCli(
			ack = listOf(
				ContentProtocol.REQUIRED_CAPABILITY,
				ContentProtocol.NATIVE_IO_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
			),
		)

		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
		assertEquals(null, harness.endpoint.readNativeInputTarget())
		assertEquals(ContentInputAdmission.Refused(ContentNotSentReason.STOPPED), harness.admit(keyboardRequest()))
	}

	@Test
	fun `a hosted provider input is refused when the published source is a Pi conversation`() {
		val harness = readyCli()
		// A coherent Pi conversation publication: its own tuple and its own source.
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))

		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.STALE_SOURCE),
			harness.admit(keyboardRequest(source = sampleNativeCliSource())),
		)
	}

	@Test
	fun `the wrong backend never addresses the published hosted provider row`() {
		val harness = readyCli()
		harness.commitWrittenFrame(sampleNativeCliSource(NativeCliBackend.CLAUDE), nativeSession = null)

		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.STALE_SOURCE),
			harness.admit(keyboardRequest(source = sampleNativeCliSource(NativeCliBackend.CODEX))),
		)
	}

	@Test
	fun `a changed source token is a new incarnation and a stale proof never writes`() {
		val harness = readyCli()
		harness.commitWrittenFrame(sampleNativeCliSource(), nativeSession = null)
		val accepted = harness.admit(keyboardRequest(source = sampleNativeCliSource()))
		val admission = assertIs<ContentInputAdmission.Accepted>(accepted)

		// The owner restarted the child: a new opaque token, same run and row.
		harness.publish(
			sequence = harness.nextSequence,
			inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource().copy(sourceToken = "host-source-token-2")),
			nativeSession = null,
		)

		assertEquals(
			listOf(ContentSendOutcome.NotSent(ContentNotSentReason.STALE_SOURCE)),
			settled(harness).map { it.outcome },
		)
		assertEquals(0, harness.observation.pendingInputCount)
		admission.effects.forEach { effect -> assertTrue(!harness.isCurrent(effect)) }
		harness.settleAllEffects()
		// The new incarnation has no committed frame of its own yet, so nothing writes.
		val restarted = sampleNativeCliSource().copy(sourceToken = "host-source-token-2")
		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.NO_WRITTEN_FRAME),
			harness.admit(keyboardRequest(source = restarted)),
		)
		assertTrue(
			harness.commitWrittenFrame(restarted, nativeSession = null) is ContentWrittenFrameOutcome.Registered,
			"the new incarnation is writable once its own frame is actually committed",
		)
		assertTrue(harness.admit(keyboardRequest(source = restarted)) is ContentInputAdmission.Accepted)
	}

	@Test
	fun `a resize, a policy change, and coverage loss each retire an admitted hosted input`() {
		val resized = readyCli()
		resized.commitWrittenFrame(sampleNativeCliSource(), nativeSession = null)
		resized.admit(keyboardRequest(source = sampleNativeCliSource()))
		resized.resize(40, 12)
		assertEquals(
			listOf(ContentSendOutcome.NotSent(ContentNotSentReason.STALE_RESIZE)),
			settled(resized).map { it.outcome },
		)

		val policyOff = readyCli()
		policyOff.commitWrittenFrame(sampleNativeCliSource(), nativeSession = null)
		policyOff.admit(keyboardRequest(source = sampleNativeCliSource()))
		policyOff.updatePolicy(ContentInputPolicy(enabled = false, generation = 2L))
		assertEquals(
			listOf(ContentSendOutcome.NotSent(ContentNotSentReason.POLICY_DISABLED)),
			settled(policyOff).map { it.outcome },
		)

		val stopped = readyCli()
		stopped.commitWrittenFrame(sampleNativeCliSource(), nativeSession = null)
		stopped.admit(keyboardRequest(source = sampleNativeCliSource()))
		stopped.stop()
		assertEquals(
			listOf(ContentSendOutcome.NotSent(ContentNotSentReason.STOPPED)),
			settled(stopped).map { it.outcome },
		)
	}

	@Test
	fun `an exact A to B to A hosted source return never revives the earlier receipt`() {
		val harness = readyCli()
		val a = sampleNativeCliSource()
		val b = sampleNativeCliSource().copy(sourceToken = "host-source-token-b")
		harness.commitWrittenFrame(a, nativeSession = null)
		harness.publish(sequence = harness.nextSequence, inputSource = OptionalNativeIoSource.Stated(b), nativeSession = null)
		harness.publish(sequence = harness.nextSequence, inputSource = OptionalNativeIoSource.Stated(a), nativeSession = null)

		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.NO_WRITTEN_FRAME),
			harness.admit(keyboardRequest(source = a)),
		)
	}

	/* ------------------------------------------------------------------ *
	 * Text copy
	 * ------------------------------------------------------------------ */

	@Test
	fun `an inline hosted copy is delivered with its backend and no conversation tuple`() {
		val harness = readyCli()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)

		harness.deliverAll(
			inlineCliCopyFrames(
				subscriptionId = harness.endpoint.subscriptionId,
				source = sampleNativeCliSource(),
				dispatchId = 41L,
			),
		)

		val receipt = delivered(harness).single()
		assertEquals(41L, receipt.dispatchId)
		assertEquals(sampleNativeCliSource(), receipt.source)
		val event = assertIs<NativeIoNativeCliCopyEvent>(receipt.event)
		assertEquals(NativeCliBackend.CLAUDE, event.backend)
		assertEquals("aGVsbG8=", event.encoded)
	}

	@Test
	fun `a paged hosted copy is assembled whole and keeps its canonical text`() {
		val harness = readyCli()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)
		val encoded = checkNotNull(Base64Wire.encodeCanonical("copied 世界\n".toByteArray()))

		harness.deliverAll(
			pagedCopyFrames(
				encoded = encoded,
				subscriptionId = harness.endpoint.subscriptionId,
				source = sampleNativeCliSource(),
				chunkBytes = 4,
			),
		)

		val event = assertIs<NativeIoNativeCliCopyEvent>(delivered(harness).single().event)
		assertEquals(encoded, event.encoded)
	}

	@Test
	fun `the whole producer copy bound is carried across pages, never truncated`() {
		val harness = readyCli()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)
		// Exactly the producer's bound in canonical encoded characters.
		val encoded = "A".repeat(ContentProtocol.NATIVE_COPY_MAX_ENCODED_CHARS)

		harness.deliverAll(
			pagedCopyFrames(
				encoded = encoded,
				subscriptionId = harness.endpoint.subscriptionId,
				source = sampleNativeCliSource(),
				chunkBytes = 8_192,
			),
		)

		val event = assertIs<NativeIoNativeCliCopyEvent>(delivered(harness).single().event)
		assertEquals(encoded, event.encoded)
		val decoded = checkNotNull(Base64Wire.decodeCanonical(event.encoded))
		assertTrue(decoded.size <= 75_000, "the encoded bound is the text bound")
	}

	@Test
	fun `a hosted copy on a channel that never negotiated the copy capability is refused`() {
		val harness = readyCli(
			cliCopy = false,
			ack = listOf(
				ContentProtocol.REQUIRED_CAPABILITY,
				ContentProtocol.NATIVE_IO_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_CLI_CAPABILITY,
			),
		)
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)

		harness.deliverAll(inlineCliCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
		assertEquals(emptyList(), delivered(harness))
	}

	@Test
	fun `a hosted copy is withheld from a Pi publication and a Pi copy from a hosted publication`() {
		val hostedView = readyCli()
		hostedView.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))
		hostedView.deliverAll(inlineCliCopyFrames(subscriptionId = hostedView.endpoint.subscriptionId))
		assertEquals(emptyList(), delivered(hostedView))
		assertTrue(hostedView.events.any { it is ContentEndpointEvent.CopyWithheld })

		val piView = readyCli()
		piView.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)
		piView.deliverAll(inlineCopyFrames(subscriptionId = piView.endpoint.subscriptionId))
		assertEquals(emptyList(), delivered(piView))
		assertTrue(piView.events.any { it is ContentEndpointEvent.CopyWithheld })
	}

	@Test
	fun `a hosted copy whose backend no longer matches the published row is withheld`() {
		val harness = readyCli()
		harness.publish(
			inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource(NativeCliBackend.CLAUDE)),
			nativeSession = null,
		)

		harness.deliverAll(
			inlineCliCopyFrames(
				subscriptionId = harness.endpoint.subscriptionId,
				source = sampleNativeCliSource(NativeCliBackend.CODEX),
			),
		)

		assertEquals(emptyList(), delivered(harness))
		assertTrue(harness.events.any { it is ContentEndpointEvent.CopyWithheld })
	}

	@Test
	fun `a hosted copy whose source changed while pages arrive is withheld`() {
		val harness = readyCli()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)
		val encoded = checkNotNull(Base64Wire.encodeCanonical("copy me".toByteArray()))
		val frames = pagedCopyFrames(
			encoded = encoded,
			subscriptionId = harness.endpoint.subscriptionId,
			source = sampleNativeCliSource(),
			chunkBytes = 4,
		)

		harness.deliver(frames.first())
		harness.publish(
			sequence = harness.nextSequence,
			inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource().copy(sourceToken = "host-source-token-2")),
			nativeSession = null,
		)
		harness.deliverAll(frames.drop(1))

		assertEquals(emptyList(), delivered(harness))
		assertTrue(harness.events.any { it is ContentEndpointEvent.CopyWithheld })
	}

	@Test
	fun `an incomplete or replayed hosted copy publishes nothing`() {
		val truncated = readyCli()
		truncated.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)
		val encoded = checkNotNull(Base64Wire.encodeCanonical("copy me".toByteArray()))
		val frames = pagedCopyFrames(
			encoded = encoded,
			subscriptionId = truncated.endpoint.subscriptionId,
			source = sampleNativeCliSource(),
			chunkBytes = 4,
		)
		// The end names a payload whose pages never all arrived.
		truncated.deliverAll(frames.take(1) + frames.last())
		assertEquals(ContentEndpointPhase.RETIRED, truncated.observation.phase)
		assertEquals(emptyList(), delivered(truncated))

		// The emission order already completed can never publish twice.
		val replay = readyCli()
		replay.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)
		replay.deliverAll(inlineCliCopyFrames(subscriptionId = replay.endpoint.subscriptionId, sequence = 3L))
		replay.deliverAll(
			inlineCliCopyFrames(
				subscriptionId = replay.endpoint.subscriptionId,
				copyId = "copy-2",
				sequence = 3L,
			),
		)
		assertEquals(ContentEndpointPhase.RETIRED, replay.observation.phase)
		assertEquals(1, delivered(replay).size)
	}

	@Test
	fun `a hosted copy naming another run or row is a violation, never a retarget`() {
		val harness = readyCli()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)
		val sibling = sampleNativeCliSource().copy(sessionId = "instance-2")

		harness.deliver(
			CopyFrame(
				subscriptionId = harness.endpoint.subscriptionId,
				copyId = "copy-1",
				sequence = 1L,
				source = sibling,
				dispatchId = 1L,
				event = NativeIoNativeCliCopyEvent(encoded = "aGVsbG8=", backend = sibling.backend),
			),
		)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ROW_ID, harness.observation.target.rowId)
		assertEquals(emptyList(), delivered(harness))
	}

	@Test
	fun `remote input off withholds a hosted copy that would otherwise be routable`() {
		val harness = readyCli(policy = ContentInputPolicy(enabled = false, generation = 1L))
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)

		harness.deliverAll(inlineCliCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		assertEquals(emptyList(), delivered(harness))
		assertEquals(
			listOf(ContentEndpointEvent.CopyWithheld("copy-1")),
			harness.events.filterIsInstance<ContentEndpointEvent.CopyWithheld>(),
		)
	}

	@Test
	fun `a preference change while a hosted copy is in flight withholds that copy`() {
		val harness = readyCli()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)
		val frames = pagedCopyFrames(
			encoded = checkNotNull(Base64Wire.encodeCanonical("copy me".toByteArray())),
			subscriptionId = harness.endpoint.subscriptionId,
			source = sampleNativeCliSource(),
			chunkBytes = 4,
		)
		harness.deliver(frames.first())

		harness.updatePolicy(ContentInputPolicy(enabled = true, generation = 2L))
		harness.deliverAll(frames.drop(1))

		assertEquals(emptyList(), delivered(harness))
		assertEquals(
			listOf(ContentEndpointEvent.CopyWithheld("copy-1")),
			harness.events.filterIsInstance<ContentEndpointEvent.CopyWithheld>(),
		)
	}

	@Test
	fun `a Pi conversation copy is unchanged on a channel that also negotiated the hosted variants`() {
		val harness = readyCli()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))

		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		val receipt = delivered(harness).single()
		val event = assertIs<NativeIoCopyEvent.Copy>(receipt.event)
		assertEquals("aGVsbG8=", event.encoded)
		assertEquals(contentSource(geometry = TARGET_GEOMETRY).nativeSession.sessionId, event.sessionId)
	}

	@Test
	fun `a late hosted copy after channel loss never resurrects the target`() {
		val harness = readyCli()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleNativeCliSource()), nativeSession = null)
		harness.channelLost()

		harness.deliverAll(inlineCliCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(emptyList(), delivered(harness))
		assertNotNull(harness.observation.target)
	}
}
