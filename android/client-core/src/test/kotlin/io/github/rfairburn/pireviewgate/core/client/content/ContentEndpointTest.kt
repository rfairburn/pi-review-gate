package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentErrorCode
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentEndCode
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.EndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.HelloFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ResizeFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.SubscribeFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.UnsubscribedFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ErrorFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.UnsubscribeFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.contentSource
import io.github.rfairburn.pireviewgate.core.protocol.content.sampleFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.styledFrame
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertIs

/**
 * Lifecycle and publication coverage for the selected-content endpoint: the fixed
 * handshake order, atomic viewport assembly, honest availability, the finite
 * caller-owned deadlines with no idle expiry of an unchanged viewport, newest-only
 * resize, and the terminal behavior of loss and stop.
 */
class ContentEndpointTest {

	/* ------------------------------------------------------------------ *
	 * Handshake
	 * ------------------------------------------------------------------ */

	@Test
	fun `start emits exactly one hello carrying only the offered capabilities`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		val hello = harness.effects.single()

		assertEquals(1, harness.effects.size)
		val frame = assertIs<HelloFrame>(hello.frame)
		assertEquals(ContentProtocol.SERVICE, frame.service)
		assertEquals(ContentProtocol.MAJOR, frame.major)
		assertEquals(listOf(ContentProtocol.REQUIRED_CAPABILITY), frame.capabilities)
		assertEquals(CONNECTION_GENERATION, (hello.guard as ContentSendGuard.Hello).connectionGeneration)
		assertEquals(ContentEndpointPhase.AWAITING_ACK, harness.observation.phase)
		assertEquals(ContentViewStatus.CONNECTING, harness.observation.status)
		assertNull(harness.observation.view)
		assertEquals(
			listOf(ContentDeadlineKind.HANDSHAKE),
			harness.armed.map { it.kind },
		)
	}

	@Test
	fun `acknowledged handshake subscribes to the exact run and row only`() {
		val endpoint = ContentEndpoint(endpointConfig(viewport = ContentViewportRequest(cols = 92, rows = 31)))
		val harness = ContentEndpointHarness(endpoint)
		val subscribe = harness.deliver(ackFrame()).effects.single()
		harness.settleAllEffects()
		harness.deliver(subscribedFrame(endpoint.subscriptionId))

		val frame = subscribe.frame as SubscribeFrame
		assertEquals(endpoint.subscriptionId, frame.subscriptionId)
		assertEquals(RUN_ID, frame.hostRunId)
		assertEquals(ROW_ID, frame.sessionId)
		assertEquals(92, frame.cols)
		assertEquals(31, frame.rows)
		assertEquals(ContentEndpointPhase.STREAMING, harness.observation.phase)
		assertTrue(harness.events.contains(ContentEndpointEvent.Subscribed))
		// Ready is the acknowledgement, never a first visible frame.
		assertEquals(ContentViewStatus.CONNECTING, harness.observation.status)
		assertNull(harness.observation.view)
		// The first-transfer deadline covers "acknowledged and then silent" too.
		assertEquals(listOf(ContentDeadlineKind.FIRST_TRANSFER), harness.armed.map { it.kind })
	}

	@Test
	fun `an acknowledgement claiming a capability that was never offered is refused`() {
		val harness = ContentEndpointHarness(
			ContentEndpoint(endpointConfig(nativeIo = nativeIoOptions(startup = false))),
		)
		harness.deliver(
			ackFrame(
				listOf(
					ContentProtocol.REQUIRED_CAPABILITY,
					ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
				),
			),
		)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.OWNER_REFUSED, harness.observation.reason)
		assertTrue(harness.events.contains(ContentEndpointEvent.Retired(ContentUnavailableReason.OWNER_REFUSED)))
	}

	@Test
	fun `an acknowledged native IO capability turns the extension on and nothing else`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig(nativeIo = nativeIoOptions())))
		harness.deliver(
			ackFrame(
				listOf(
					ContentProtocol.REQUIRED_CAPABILITY,
					ContentProtocol.NATIVE_IO_CAPABILITY,
					ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
				),
			),
		)

		assertTrue(harness.observation.nativeIoNegotiated)
		assertTrue(harness.observation.startupInputNegotiated)
	}

	@Test
	fun `a host that never acknowledges the optional capability stays display-only`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig(nativeIo = nativeIoOptions())))
		harness.deliver(ackFrame())

		assertFalse(harness.observation.nativeIoNegotiated)
		assertFalse(harness.observation.startupInputNegotiated)
	}

	@Test
	fun `a resize requested during the handshake is written only against an acknowledged subscription`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.deliver(ackFrame())

		// No subscription has been acknowledged yet, so nothing is written behind it.
		assertEquals(0, harness.resize(100, 30).effects.size)
		harness.settleAllEffects()
		harness.deliver(subscribedFrame(harness.endpoint.subscriptionId))

		val written = harness.effects.last()
		val frame = assertIs<ResizeFrame>(written.frame)
		assertEquals(harness.endpoint.subscriptionId, frame.subscriptionId)
		assertEquals(100, frame.cols)
		assertEquals(30, frame.rows)
	}

	@Test
	fun `starting twice emits nothing`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		val before = harness.effects.toList()

		assertEquals(0, harness.endpoint.start(harness.nowNanos).effects.size)
		assertEquals(before, harness.effects.toList())
	}

	@Test
	fun `a subscribed acknowledgement arriving twice is a violation`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()

		harness.deliver(subscribedFrame(harness.endpoint.subscriptionId))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
	}

	@Test
	fun `a hello that never settles retires on the handshake deadline`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.advance(ContentDeadlineSettings.DEFAULT.handshakeMs - 1)
		harness.fire(ContentDeadlineKind.HANDSHAKE)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.SUBSCRIPTION_TIMEOUT, harness.observation.reason)
		assertEquals(emptyList(), harness.armed)
	}

	@Test
	fun `subscription acknowledgement restarts the first transfer deadline`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.deliver(ackFrame())
		harness.settleAllEffects()
		harness.deliver(subscribedFrame(harness.endpoint.subscriptionId), advanceMillis = 14_000L)

		// Ready is the exact acknowledgement, so a full window is waited from there — not
		// whatever remained of the window armed at the hello acknowledgement.
		assertEquals(
			29_000_000_000L,
			harness.armed.single { it.kind == ContentDeadlineKind.FIRST_TRANSFER }.dueAtNanos,
		)
		harness.advance(1_000L)
		val early = harness.endpoint.onDeadline(ContentDeadlineKind.FIRST_TRANSFER, harness.nowNanos)
		assertEquals(ContentEndpointPhase.STREAMING, early.observation.phase)

		harness.fire(ContentDeadlineKind.FIRST_TRANSFER)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.SUBSCRIPTION_TIMEOUT, harness.observation.reason)
	}

	@Test
	fun `a stale armed deadline from an earlier step cannot retire anything`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.deliver(ackFrame())
		// The handshake deadline was disarmed by that step; delivering its expiry
		// anyway must not touch the endpoint.
		harness.fire(ContentDeadlineKind.HANDSHAKE)

		assertEquals(ContentEndpointPhase.SUBSCRIBING, harness.observation.phase)
	}

	@Test
	fun `a subscribed acknowledgement for another run never makes this endpoint ready`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.deliver(ackFrame())
		harness.settleAllEffects()
		harness.deliver(subscribedFrame(hostRunId = "run-other"))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
	}

	/* ------------------------------------------------------------------ *
	 * Atomic publication
	 * ------------------------------------------------------------------ */

	@Test
	fun `one complete transfer publishes exactly the assembled viewport`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()

		val view = harness.observation.view
		assertNotNull(view)
		assertEquals(1L, view.meta.sequence)
		assertEquals(RUN_ID, view.meta.hostRunId)
		assertEquals(ROW_ID, view.meta.rowId)
		assertEquals(TARGET_GEOMETRY, view.meta.geometry)
		assertEquals(sampleFrame(), view.frame)
		assertEquals(ContentViewStatus.CURRENT, harness.observation.status)
		assertNull(harness.observation.reason)
		assertTrue(harness.events.any { it is ContentEndpointEvent.SnapshotPublished })
		// An unchanged current frame arms nothing: there is no idle expiry.
		assertEquals(emptyList(), harness.armed)
	}

	@Test
	fun `a viewport larger than one message is assembled whole across pages`() {
		val frame = styledFrame(rows = 40)
		val payloadBytes = ContentProtocol.encodeTerminalPayload(frame).size
		assertTrue(payloadBytes > 4 * ContentBounds.DEFAULT.maxChunkPayloadBytes / 4)
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish(frame = frame, chunkBytes = 2_048)

		val view = harness.observation.view
		assertNotNull(view)
		assertEquals(payloadBytes, view.meta.byteLength)
		assertEquals((payloadBytes + 2_047) / 2_048, view.meta.chunkCount)
		assertEquals(frame, view.frame)
	}

	@Test
	fun `a reordered chunk retires the endpoint and publishes nothing partial`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		val frames = transferFrames(sampleFrame(), subscriptionId = harness.endpoint.subscriptionId, chunkBytes = 8)
		harness.deliver(frames[0])
		assertTrue(harness.armed.any { it.kind == ContentDeadlineKind.TRANSFER_IDLE })
		harness.deliver(frames[2])

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
		assertNull(harness.observation.view)
		assertTrue(harness.events.contains(ContentEndpointEvent.Retired(ContentUnavailableReason.PROTOCOL_VIOLATION)))
	}

	@Test
	fun `an end that closes an incomplete transfer never publishes`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		val frames = transferFrames(sampleFrame(), subscriptionId = harness.endpoint.subscriptionId, chunkBytes = 8)
		harness.deliver(frames[0])
		harness.deliver(frames[1])
		harness.deliver(frames.last())

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertNull(harness.observation.view)
	}

	@Test
	fun `a second begin while one transfer is staged is refused whole`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		val frames = transferFrames(sampleFrame(), subscriptionId = harness.endpoint.subscriptionId, chunkBytes = 8)
		harness.deliver(frames[0])
		harness.deliver(
			transferFrames(
				sampleFrame(),
				subscriptionId = harness.endpoint.subscriptionId,
				transferId = "transfer-2",
				sequence = 2L,
				chunkBytes = 8,
			)[0],
		)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertNull(harness.observation.view)
	}

	@Test
	fun `publish sequences may jump forward but never repeat or regress`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish(sequence = 7L)
		assertEquals(7L, harness.observation.view?.meta?.sequence)
		harness.publish(sequence = 7L)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
	}

	@Test
	fun `a transfer for another owner run retires the endpoint instead of retargeting it`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.deliverAll(
			transferFrames(
				sampleFrame(),
				subscriptionId = harness.endpoint.subscriptionId,
				hostRunId = "run-other",
			),
		)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(RUN_ID, harness.observation.target.ownerRunId)
		assertEquals(ROW_ID, harness.observation.target.rowId)
		assertNull(harness.observation.view)
	}

	@Test
	fun `a staged transfer that goes silent retires on the in-flight deadline`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		val frames = transferFrames(sampleFrame(), subscriptionId = harness.endpoint.subscriptionId, chunkBytes = 8)
		harness.deliver(frames[0])
		harness.fire(ContentDeadlineKind.TRANSFER_IDLE)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.TRANSFER_FAILED, harness.observation.reason)
		assertNull(harness.observation.view)
	}

	@Test
	fun `a legacy publish states no source and is never given one`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig(nativeIo = nativeIoOptions())))
		harness.handshake(
			listOf(
				ContentProtocol.REQUIRED_CAPABILITY,
				ContentProtocol.NATIVE_IO_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
			),
		)
		harness.publish(inputSource = OptionalNativeIoSource.Absent)

		assertEquals(OptionalNativeIoSource.Absent, harness.observation.view?.meta?.inputSource)
		assertNull(harness.endpoint.readNativeInputTarget())
	}

	@Test
	fun `a stated source is readable as a description and never as authority`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig(nativeIo = nativeIoOptions())))
		harness.handshake(
			listOf(
				ContentProtocol.REQUIRED_CAPABILITY,
				ContentProtocol.NATIVE_IO_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
			),
		)
		harness.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))
		val described = harness.endpoint.readNativeInputTarget()

		assertNotNull(described)
		assertEquals(contentSource(geometry = TARGET_GEOMETRY), described.source)
		assertEquals(harness.endpoint.subscriptionId, described.subscriptionId)
		assertEquals(SELECTION_GENERATION, described.selectionGeneration)
		assertNull(harness.observation.writtenReceipt)
	}

	@Test
	fun `a source on a channel that never negotiated native IO is a violation`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
	}

	/* ------------------------------------------------------------------ *
	 * Resize
	 * ------------------------------------------------------------------ */

	@Test
	fun `resize keeps only the newest request while a write is in flight`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()

		val first = harness.resize(100, 30)
		assertEquals(1, first.effects.size)
		val resize = first.effects.single().frame as ResizeFrame
		assertEquals(100, resize.cols)
		// A second request while the first is still in flight replaces it, and only the
		// newest is written once the slot frees.
		val second = harness.resize(120, 34)
		assertEquals(0, second.effects.size)
		harness.settleAllEffects()

		val queued = harness.effects.last().frame as ResizeFrame
		assertEquals(120, queued.cols)
		assertEquals(34, queued.rows)
		assertEquals(ContentViewportRequest(120, 34), harness.observation.requestedViewport)
		// The published geometry only changes when the owner reports a frame.
		assertEquals(TARGET_GEOMETRY, harness.observation.publishedGeometry)
	}

	@Test
	fun `a resize advances the epoch so an older written receipt no longer admits input`() {
		val harness = ContentEndpointHarness(
			ContentEndpoint(
				endpointConfig(
					nativeIo = nativeIoOptions(),
					inputPolicy = ContentInputPolicy(enabled = true, generation = 1L),
				),
			),
		)
		harness.handshake(
			listOf(
				ContentProtocol.REQUIRED_CAPABILITY,
				ContentProtocol.NATIVE_IO_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
			),
		)
		val receipt = harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val drawn = assertIs<ContentWrittenFrameOutcome.Registered>(receipt).receipt
		harness.resize(100, 30)

		// The receipt stays as the record of what was actually drawn, but it describes an
		// older geometry epoch, so it can no longer admit anything.
		assertEquals(drawn, harness.observation.writtenReceipt)
		assertTrue(harness.observation.resizeEpoch > drawn.resizeEpoch)
		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.STALE_RESIZE),
			harness.endpoint.submitInput(keyboardRequest(), authorized = true, nowNanos = harness.nowNanos),
		)
	}

	@Test
	fun `a resize after stop is inert and never restarts delivery`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()
		harness.stop()
		val effects = harness.effects.toList()

		assertEquals(0, harness.resize(100, 30).effects.size)
		assertEquals(effects, harness.effects.toList())
		harness.fire(ContentDeadlineKind.STOP_ACK)
		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
	}

	/* ------------------------------------------------------------------ *
	 * Loss and stop
	 * ------------------------------------------------------------------ */

	@Test
	fun `channel loss preserves the target and invalidates the view without any retry`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()

		val step = harness.channelLost()

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.CONNECTION_LOST, harness.observation.reason)
		assertEquals(RUN_ID, harness.observation.target.ownerRunId)
		assertNull(harness.observation.view)
		assertEquals(emptyList(), step.effects)
		assertEquals(emptyList(), harness.armed)
		assertTrue(harness.events.contains(ContentEndpointEvent.ViewCleared(ContentUnavailableReason.CONNECTION_LOST)))
		// Nothing is resubscribed, reopened, or replayed afterwards.
		harness.deliverAll(transferFrames(sampleFrame(), subscriptionId = harness.endpoint.subscriptionId))
		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertNull(harness.observation.view)
	}

	@Test
	fun `stop unsubscribes only a subscribe the transport actually received`() {
		val neverSent = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		val subscribe = neverSent.deliver(ackFrame()).effects.single()
		assertTrue(subscribe.frame is SubscribeFrame)
		// The subscribe effect exists but was never handed to the transport.
		assertEquals(0, neverSent.stop().effects.size)
		assertEquals(ContentEndpointPhase.RETIRED, neverSent.observation.phase)

		val sent = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		sent.deliver(ackFrame())
		sent.settleAllEffects()
		sent.deliver(subscribedFrame(sent.endpoint.subscriptionId))
		val stopEffects = sent.stop().effects

		assertEquals(1, stopEffects.size)
		assertTrue(stopEffects.single().frame is UnsubscribeFrame)
		assertEquals(sent.endpoint.subscriptionId, (stopEffects.single().frame as UnsubscribeFrame).subscriptionId)
		assertEquals(listOf(ContentDeadlineKind.STOP_ACK), sent.armed.map { it.kind })
	}

	@Test
	fun `stop clears the view and every pending authority synchronously`() {
		val harness = ContentEndpointHarness(
			ContentEndpoint(
				endpointConfig(
					nativeIo = nativeIoOptions(),
					inputPolicy = ContentInputPolicy(enabled = true, generation = 1L),
				),
			),
		)
		harness.handshake(
			listOf(
				ContentProtocol.REQUIRED_CAPABILITY,
				ContentProtocol.NATIVE_IO_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
			),
		)
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		harness.stop()

		assertEquals(ContentEndpointPhase.STOPPING, harness.observation.phase)
		assertNull(harness.observation.view)
		assertNull(harness.observation.writtenReceipt)
		assertNull(harness.endpoint.readNativeInputTarget())
		assertEquals(0, harness.observation.pendingInputCount)
		harness.fire(ContentDeadlineKind.STOP_ACK)
		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
	}

	@Test
	fun `a stop acknowledgement that never arrives still ends the endpoint`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.stop()
		harness.fire(ContentDeadlineKind.STOP_ACK)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.STOPPED, harness.observation.reason)
		assertEquals(emptyList(), harness.armed)
	}

	@Test
	fun `a late owner acknowledgement of the retired subscription settles the stop without reviving it`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()
		harness.stop()
		harness.deliver(UnsubscribedFrame(harness.endpoint.subscriptionId))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.STOPPED, harness.observation.reason)
		assertNull(harness.observation.view)
		assertEquals(emptyList(), harness.armed)
	}

	@Test
	fun `a frame naming another subscription is never treated as this endpoint's noise`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.stop()
		harness.deliver(EndFrame("someone-else", ContentEndCode.CLOSED))

		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
	}

	@Test
	fun `an owner end frame reports content lost and never reopens the subscription`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()

		harness.deliver(EndFrame(harness.endpoint.subscriptionId, ContentEndCode.REPLACED))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.CONTENT_LOST, harness.observation.reason)
		assertNull(harness.observation.view)
	}

	@Test
	fun `an owner error ends the subscription and never reopens it`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()
		harness.deliver(ErrorFrame(ContentErrorCode.NOT_AUTHORIZED, harness.endpoint.subscriptionId))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.OWNER_REFUSED, harness.observation.reason)
		assertFalse(harness.observation.status == ContentViewStatus.CURRENT)
	}

	/* ------------------------------------------------------------------ *
	 * Dropped writes, and the finite bound on an invoked write
	 * ------------------------------------------------------------------ */

	@Test
	fun `a dropped resize release re-writes the newest requested dimensions`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()

		val stale = harness.resize(100, 30).effects.single()
		harness.resize(120, 34)
		harness.resize(100, 30)
		assertEquals(1, harness.effects.size)
		assertEquals(ContentViewportRequest(100, 30), harness.observation.requestedViewport)

		// The transport re-checks the guard before dispatch, finds it belongs to an older
		// epoch, never invokes the write, and reports the effect as dropped. The endpoint
		// knows the owner was never told 100 columns, so it writes the newest request.
		assertFalse(harness.isCurrent(stale))
		harness.drop(stale)

		val newest = assertIs<ResizeFrame>(harness.effects.last().frame)
		assertTrue(harness.isCurrent(harness.effects.last()))
		assertEquals(100, newest.cols)
		assertEquals(30, newest.rows)
	}

	@Test
	fun `an invoked write that never returns is bounded and fails the endpoint`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()
		assertEquals(emptyList(), harness.armed)

		val resize = harness.resize(100, 30).effects.single()
		harness.invoke(resize)
		assertEquals(listOf(ContentDeadlineKind.SEND), harness.armed.map { it.kind })

		harness.fire(ContentDeadlineKind.SEND)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.SEND_FAILED, harness.observation.reason)
		assertEquals(emptyList(), harness.armed)
	}

	@Test
	fun `a completed write clears its send bound and an unchanged viewport arms nothing`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()
		val resize = harness.resize(100, 30).effects.single()
		harness.invoke(resize)

		harness.complete(resize)

		assertEquals(emptyList(), harness.armed)
		// An unchanged published viewport never expires, however long it is left alone.
		harness.advance(600_000L)
		assertEquals(ContentViewStatus.CURRENT, harness.observation.status)
		assertEquals(ContentEndpointPhase.STREAMING, harness.observation.phase)
		assertEquals(emptyList(), harness.armed)
	}

	@Test
	fun `a held input write settles unknown at its send bound and is never retried`() {
		val harness = ContentEndpointHarness(
			ContentEndpoint(
				endpointConfig(
					nativeIo = nativeIoOptions(),
					inputPolicy = ContentInputPolicy(enabled = true, generation = 1L),
				),
			),
		)
		harness.handshake(NATIVE_IO_ACK)
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted
		harness.invoke(accepted.effects.single())
		assertEquals(1, harness.observation.pendingInputCount)
		val issuedSoFar = harness.effects.size

		harness.fire(ContentDeadlineKind.SEND)

		assertEquals(
			listOf(ContentEndpointEvent.InputSettled(accepted.inputId, 1L, ContentSendOutcome.Unknown)),
			harness.events.filterIsInstance<ContentEndpointEvent.InputSettled>(),
		)
		assertEquals(0, harness.observation.pendingInputCount)
		assertEquals(ContentEndpointPhase.STREAMING, harness.observation.phase)
		// The bound never re-writes the held bytes.
		assertEquals(issuedSoFar, harness.effects.size)
	}

	/* ------------------------------------------------------------------ *
	 * Stop bounded by the owner, not by local completion
	 * ------------------------------------------------------------------ */

	@Test
	fun `local completion of the unsubscribe keeps the stop bounded until the owner acknowledges`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()
		val unsubscribe = harness.stop().effects.single()

		harness.invoke(unsubscribe)
		harness.complete(unsubscribe)

		// The bytes came back from the local write; the owner has still said nothing.
		assertEquals(ContentEndpointPhase.STOPPING, harness.observation.phase)
		assertEquals(listOf(ContentDeadlineKind.STOP_ACK), harness.armed.map { it.kind })

		harness.deliver(UnsubscribedFrame(harness.endpoint.subscriptionId))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.STOPPED, harness.observation.reason)
		assertEquals(emptyList(), harness.armed)
	}

	@Test
	fun `a failed or never-dispatched unsubscribe ends the bounded stop without an owner frame`() {
		val failed = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		failed.handshake()
		failed.publish()
		failed.invoke(failed.stop().effects.single())
		failed.failWrite(failed.effects.last())
		assertEquals(ContentEndpointPhase.RETIRED, failed.observation.phase)
		assertEquals(ContentUnavailableReason.STOPPED, failed.observation.reason)

		val dropped = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		dropped.handshake()
		dropped.publish()
		val notice = dropped.stop().effects.single()
		dropped.drop(notice)
		assertEquals(ContentEndpointPhase.RETIRED, dropped.observation.phase)
		assertEquals(ContentUnavailableReason.STOPPED, dropped.observation.reason)
	}

	@Test
	fun `late copy frames for this subscription during stopping are retirement noise`() {
		val harness = ContentEndpointHarness(ContentEndpoint(nativeIoConfig()))
		harness.handshake(NATIVE_IO_ACK)
		harness.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))
		harness.stop()

		harness.deliverAll(inlineCopyFrames(subscriptionId = harness.endpoint.subscriptionId))

		assertEquals(ContentEndpointPhase.STOPPING, harness.observation.phase)
		assertEquals(ContentUnavailableReason.STOPPED, harness.observation.reason)
		assertEquals(emptyList(), harness.events.filterIsInstance<ContentEndpointEvent.CopyDelivered>())

		harness.fire(ContentDeadlineKind.STOP_ACK)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.STOPPED, harness.observation.reason)
	}

	@Test
	fun `a late copy frame naming another subscription is never retirement noise`() {
		val harness = ContentEndpointHarness(ContentEndpoint(nativeIoConfig()))
		harness.handshake(NATIVE_IO_ACK)
		harness.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))
		harness.stop()

		harness.deliverAll(inlineCopyFrames(subscriptionId = "someone-else"))

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
	}

	@Test
	fun `the terminal protocol refusal stays dispatchable after retirement`() {
		val harness = ContentEndpointHarness(ContentEndpoint(endpointConfig()))
		harness.handshake()
		harness.publish()
		harness.stop()

		val refusal = harness.deliver(EndFrame("someone-else", ContentEndCode.CLOSED)).effects.single()

		// Retirement must not make the one refusal notice undeliverable: a transport that
		// re-checks its guard before dispatch would otherwise be told to drop it.
		val guard = assertIs<ContentSendGuard.ProtocolError>(refusal.guard)
		assertEquals(CONNECTION_GENERATION, guard.connectionGeneration)
		assertTrue(harness.endpoint.isSendGuardCurrent(refusal.guard))
		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)

		harness.invoke(refusal)
		harness.complete(refusal)

		assertEquals(ContentEndpointPhase.RETIRED, harness.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, harness.observation.reason)
		assertFalse(harness.endpoint.isSendGuardCurrent(ContentSendGuard.Hello(CONNECTION_GENERATION)))
	}
}
