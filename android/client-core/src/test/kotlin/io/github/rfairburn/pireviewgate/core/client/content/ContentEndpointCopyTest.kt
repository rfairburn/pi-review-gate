package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.content.Base64Wire
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoCopyEvent
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoCopyUnavailableReason
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.contentSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertIs

/**
 * Text-copy coverage for the selected-content endpoint: atomic inline and paged
 * assembly, delivery only to the current initiating viewer, the single withhold
 * slot across an exact A → B → A source return, replay refusal, emission order by
 * copy sequence rather than dispatch id, and the terminal effect of loss.
 */
class ContentEndpointCopyTest {

	private fun readyCopy(): ContentEndpointHarness {
		val harness = ContentEndpointHarness(ContentEndpoint(nativeIoConfig()))
		harness.handshake(NATIVE_IO_ACK)
		harness.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))
		return harness
	}

	private fun delivered(harness: ContentEndpointHarness): List<ContentCopyReceipt> =
		harness.events.filterIsInstance<ContentEndpointEvent.CopyDelivered>().map { it.copy }

	@Test
	fun `an inline copy is delivered bound to this endpoint and viewer`() {
		val harness = readyCopy()

		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId, dispatchId = 77L))
		val receipt = delivered(harness).single()

		assertEquals(HostId.parse(HOST_ID), receipt.hostId)
		assertEquals(SELECTION_GENERATION, receipt.selectionGeneration)
		assertEquals(harness.endpoint.subscriptionId, receipt.subscriptionId)
		assertEquals("copy-1", receipt.copyId)
		assertEquals(1L, receipt.sequence)
		assertEquals(77L, receipt.dispatchId)
		assertEquals(contentSource(geometry = TARGET_GEOMETRY), receipt.source)
		val event = assertIs<NativeIoCopyEvent.Copy>(receipt.event)
		assertEquals("aGVsbG8=", event.encoded)
	}

	@Test
	fun `a paged copy is assembled whole and keeps its canonical text`() {
		val harness = readyCopy()
		val encoded = checkNotNull(Base64Wire.encodeCanonical("hello 世界".toByteArray()))

		harness.deliverAll(pagedCopyFrames(subscriptionId = harness.endpoint.subscriptionId, encoded = encoded, chunkBytes = 4))
		val receipt = delivered(harness).single()

		assertEquals(encoded, (receipt.event as NativeIoCopyEvent.Copy).encoded)
	}

	@Test
	fun `an unavailable copy reason is delivered as a fixed reason, never as content`() {
		val harness = readyCopy()
		val source = contentSource(geometry = TARGET_GEOMETRY)

		harness.deliver(
			CopyFrame(
				subscriptionId = harness.endpoint.subscriptionId,
				copyId = "copy-1",
				sequence = 1L,
				source = source,
				dispatchId = 5L,
				event = NativeIoCopyEvent.Unavailable(
					reason = NativeIoCopyUnavailableReason.UNSUPPORTED_RUNTIME,
					sessionId = source.nativeSession.sessionId,
					sessionEpoch = source.nativeSession.epoch,
				),
			),
		)

		val receipt = delivered(harness).single()
		assertTrue(receipt.event is NativeIoCopyEvent.Unavailable)
	}

	@Test
	fun `a copy on a channel that never negotiated the extension is a violation`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()

		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
		assertEquals(emptyList(), delivered(harness))
	}

	@Test
	fun `a copy whose source is not current is withheld and never delivered`() {
		val harness = ContentEndpointHarness(ContentEndpoint(nativeIoConfig()))
		harness.handshake(NATIVE_IO_ACK)
		harness.publish(inputSource = OptionalNativeIoSource.Absent)

		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		assertEquals(emptyList(), delivered(harness))
		assertTrue(harness.events.any { it is ContentEndpointEvent.CopyWithheld })
		assertEquals(ContentEndpointPhase.STREAMING, harness.observation.phase)
	}

	@Test
	fun `a source change while pages arrive withholds the completed copy`() {
		val a = contentSource(geometry = TARGET_GEOMETRY)
		val b = contentSource(sourceToken = "host-source-token-b", geometry = TARGET_GEOMETRY)
		val harness = readyCopy()
		val encoded = checkNotNull(Base64Wire.encodeCanonical("copy me".toByteArray()))
		val frames = pagedCopyFrames(subscriptionId = harness.endpoint.subscriptionId, encoded = encoded, chunkBytes = 4, source = a)

		harness.deliver(frames[0])
		harness.deliver(frames[1])
		harness.publish(inputSource = OptionalNativeIoSource.Stated(b))
		harness.deliverAll(frames.drop(2))

		assertEquals(emptyList(), delivered(harness))
		assertTrue(harness.events.any { it is ContentEndpointEvent.CopyWithheld })
	}

	@Test
	fun `an exact A to B to A source return never revives a withheld copy`() {
		val a = contentSource(geometry = TARGET_GEOMETRY)
		val b = contentSource(sourceToken = "host-source-token-b", geometry = TARGET_GEOMETRY)
		val harness = readyCopy()
		val encoded = checkNotNull(Base64Wire.encodeCanonical("copy me".toByteArray()))
		val frames = pagedCopyFrames(subscriptionId = harness.endpoint.subscriptionId, encoded = encoded, chunkBytes = 4, source = a)

		harness.deliver(frames[0])
		harness.publish(inputSource = OptionalNativeIoSource.Stated(b))
		harness.publish(inputSource = OptionalNativeIoSource.Stated(a))
		harness.deliverAll(frames.drop(1))

		assertEquals(emptyList(), delivered(harness))
	}

	@Test
	fun `a replayed copy emission order is refused`() {
		val harness = readyCopy()
		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId, sequence = 4L))
		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId, copyId = "copy-2", sequence = 4L))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
		assertEquals(1, delivered(harness).size)
	}

	@Test
	fun `copies are ordered by emission sequence, never by dispatch id`() {
		val harness = readyCopy()

		// The copy caused by the later input arrives first; both are still delivered,
		// and the receipts keep the owner's emission order.
		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId, copyId = "copy-b", sequence = 2L, dispatchId = 9L))
		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId, copyId = "copy-a", sequence = 3L, dispatchId = 8L))
		val receipts = delivered(harness)

		assertEquals(listOf("copy-b", "copy-a"), receipts.map { it.copyId })
		assertEquals(listOf(2L, 3L), receipts.map { it.sequence })
	}

	@Test
	fun `a copy naming another run or row is a violation, never a retarget`() {
		val harness = readyCopy()
		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId, source = contentSource(hostRunId = "run-other", geometry = TARGET_GEOMETRY)))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(RUN_ID, harness.observation.target.ownerRunId)
		assertEquals(emptyList(), delivered(harness))
	}

	@Test
	fun `a startup publication never routes a conversation-sourced copy`() {
		val harness = ContentEndpointHarness(ContentEndpoint(nativeIoConfig()))
		harness.handshake(NATIVE_IO_ACK)
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleStartupSource()))

		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		assertEquals(emptyList(), delivered(harness))
		assertTrue(harness.events.any { it is ContentEndpointEvent.CopyWithheld })
	}

	@Test
	fun `a stalled paged copy retires on the copy deadline and publishes nothing`() {
		val harness = readyCopy()
		val frames = pagedCopyFrames(subscriptionId = harness.endpoint.subscriptionId, encoded = "aGVsbG8=", chunkBytes = 4)

		harness.deliver(frames[0])
		assertTrue(harness.armed.any { it.kind == ContentDeadlineKind.COPY_IDLE })
		harness.fire(ContentDeadlineKind.COPY_IDLE)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.TRANSFER_FAILED, harness.observation.reason)
		assertEquals(emptyList(), delivered(harness))
	}

	@Test
	fun `a late copy after loss never resurrects the target`() {
		val harness = readyCopy()
		harness.channelLost()

		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(emptyList(), delivered(harness))
		assertNotNull(harness.observation.target)
	}

	@Test
	fun `a copy frame for another subscription is never this endpoint's copy`() {
		val harness = readyCopy()
		harness.deliver(
			CopyFrame(
				subscriptionId = "someone-else",
				copyId = "copy-1",
				sequence = 1L,
				source = contentSource(geometry = TARGET_GEOMETRY),
				dispatchId = 1L,
				event = NativeIoCopyEvent.Copy(
					encoded = "aGVsbG8=",
					sessionId = "native-session-1",
					sessionEpoch = 3,
				),
			),
		)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(emptyList(), delivered(harness))
	}

	@Test
	fun `remote input off withholds a copy that would otherwise be routable`() {
		val harness = ContentEndpointHarness(
			ContentEndpoint(nativeIoConfig(policy = ContentInputPolicy(enabled = false, generation = 1L))),
		)
		harness.handshake(NATIVE_IO_ACK)
		harness.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))

		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		// A copy is delivered only to the current initiating viewer that wants it.
		assertEquals(
			listOf(ContentEndpointEvent.CopyWithheld("copy-1")),
			harness.events.filterIsInstance<ContentEndpointEvent.CopyWithheld>(),
		)
		assertEquals(emptyList(), delivered(harness))
		assertEquals(ContentEndpointPhase.STREAMING, harness.observation.phase)
	}

	@Test
	fun `a preference change while a copy is in flight withholds that copy`() {
		val harness = readyCopy()
		val encoded = checkNotNull(Base64Wire.encodeCanonical("hello 世界".toByteArray()))
		val frames = pagedCopyFrames(
			encoded = encoded,
			subscriptionId = harness.endpoint.subscriptionId,
			chunkBytes = 4,
		)
		harness.deliver(frames.first())

		// The header was admitted under the previous preference generation, so nothing
		// from this assembly is routed even though the pages stay valid and consumed.
		harness.updatePolicy(ContentInputPolicy(enabled = true, generation = 2L))
		harness.deliverAll(frames.drop(1))

		assertEquals(
			listOf(ContentEndpointEvent.CopyWithheld("copy-1")),
			harness.events.filterIsInstance<ContentEndpointEvent.CopyWithheld>(),
		)
		assertEquals(emptyList(), delivered(harness))
	}
}
