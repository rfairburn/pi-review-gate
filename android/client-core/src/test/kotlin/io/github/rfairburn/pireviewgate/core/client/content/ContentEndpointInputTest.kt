package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.INPUT_MODES
import io.github.rfairburn.pireviewgate.core.protocol.content.InputBeginFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.InputChunkFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.InputEndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.InputFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import io.github.rfairburn.pireviewgate.core.protocol.content.contentSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Input-admission coverage for the selected-content endpoint: admission onto the
 * frame the caller actually committed, the source / modes / policy / geometry
 * fences, atomic paging under one input id and ordinal, the fixed pending bound,
 * and the truthful `not-sent` / `submitted` / `unknown` outcomes.
 */
class ContentEndpointInputTest {

	private fun readyNative(startup: Boolean = true): ContentEndpointHarness {
		val harness = ContentEndpointHarness(ContentEndpoint(nativeIoConfig(startup = startup)))
		harness.handshake(NATIVE_IO_ACK)
		return harness
	}

	@Test
	fun `unpaired surrogates are refused without producing effects`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val before = harness.effects.size

		for (code in listOf(0xD800, 0xDC00)) {
			val text = code.toChar().toString()
			for (request in listOf(keyboardRequest(text), pasteRequest(1).copy(text = text))) {
				assertEquals(
					ContentInputAdmission.Refused(ContentNotSentReason.INVALID_INPUT),
					harness.admit(request),
				)
			}
		}

		// Nothing was staged, so nothing can be written and nothing can report submitted.
		assertEquals(before, harness.effects.size)
		assertEquals(0, harness.observation.pendingInputCount)
	}

	@Test
	fun `a valid supplementary character is preserved`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val text = String(Character.toChars(0x1F600))

		val accepted = harness.admit(pasteRequest(1).copy(text = text)) as ContentInputAdmission.Accepted
		val frame = assertIs<InputFrame>(accepted.effects.single().frame)

		// The lossless check refuses malformed input, never a real one.
		assertEquals(text, String(frame.data, Charsets.UTF_8))
	}

	/* ------------------------------------------------------------------ *
	 * Admission fences
	 * ------------------------------------------------------------------ */

	@Test
	fun `input is refused when the owner never acknowledged the extension`() {
		val harness = ContentEndpointHarness(ContentEndpoint(nativeIoConfig()))
		harness.handshake(listOf(ContentProtocol.REQUIRED_CAPABILITY))
		harness.publish()

		assertEquals(ContentInputAdmission.Refused(ContentNotSentReason.NOT_NEGOTIATED), harness.admit(keyboardRequest()))
	}

	@Test
	fun `input is refused while the remote input preference is off`() {
		val harness = ContentEndpointHarness(
			ContentEndpoint(nativeIoConfig(policy = ContentInputPolicy(enabled = false, generation = 1L))),
		)
		harness.handshake(NATIVE_IO_ACK)
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))

		assertEquals(ContentInputAdmission.Refused(ContentNotSentReason.POLICY_DISABLED), harness.admit(keyboardRequest()))
	}

	@Test
	fun `a preference change, including off to on, never revives an older written receipt`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY), policyGeneration = 1L)
		harness.endpoint.updateInputPolicy(ContentInputPolicy(enabled = true, generation = 2L))

		assertEquals(ContentInputAdmission.Refused(ContentNotSentReason.NO_WRITTEN_FRAME), harness.admit(keyboardRequest()))
		assertTrue(
			harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY), policyGeneration = 2L)
			is ContentWrittenFrameOutcome.Registered,
		)
		assertTrue(harness.admit(keyboardRequest()) is ContentInputAdmission.Accepted)
	}

	@Test
	fun `input is refused before any frame was actually committed`() {
		val harness = readyNative()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))

		assertEquals(ContentInputAdmission.Refused(ContentNotSentReason.NO_WRITTEN_FRAME), harness.admit(keyboardRequest()))
	}

	@Test
	fun `a source that is not the current published one is refused`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))

		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.STALE_SOURCE),
			harness.admit(keyboardRequest(source = contentSource(sourceToken = "another-host-token", geometry = TARGET_GEOMETRY))),
		)
	}

	@Test
	fun `modes that are not the modes of that same publication are refused`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))

		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.STALE_MODES),
			harness.admit(keyboardRequest().copy(inputModes = INPUT_MODES.copy(bracketedPaste = false))),
		)
	}

	@Test
	fun `only an explicit yes from the caller's dynamic proof admits a write`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))

		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.UNAUTHORIZED),
			harness.endpoint.submitInput(keyboardRequest(), authorized = false, nowNanos = harness.nowNanos),
		)
	}

	@Test
	fun `a publication that states no source never becomes writable`() {
		val harness = readyNative()
		harness.publish(inputSource = OptionalNativeIoSource.NoSource)

		assertEquals(
			ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.NO_SOURCE),
			harness.endpoint.recordWrittenFrame(writtenProof(harness)),
		)
	}

	@Test
	fun `a commit naming another publish, binding, geometry, or policy is rejected`() {
		val harness = readyNative()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(contentSource(geometry = TARGET_GEOMETRY)))
		val proof = writtenProof(harness)

		assertEquals(
			ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.SEQUENCE_MISMATCH),
			harness.endpoint.recordWrittenFrame(proof.copy(sequence = proof.sequence + 1)),
		)
		assertEquals(
			ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.BINDING_MISMATCH),
			harness.endpoint.recordWrittenFrame(proof.copy(selectionGeneration = SELECTION_GENERATION - 1)),
		)
		assertEquals(
			ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.GEOMETRY_MISMATCH),
			harness.endpoint.recordWrittenFrame(proof.copy(geometry = SessionGeometry(12, 3, 5))),
		)
		assertEquals(
			ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.POLICY_STALE),
			harness.endpoint.recordWrittenFrame(proof.copy(policyGeneration = proof.policyGeneration - 1)),
		)
		assertNull(harness.observation.writtenReceipt)
	}

	@Test
	fun `startup data that was never negotiated retires instead of being accepted quietly`() {
		val withoutStartup = ContentEndpointHarness(
			ContentEndpoint(
				endpointConfig(
					nativeIo = ContentNativeIoOptions(listOf(ContentProtocol.NATIVE_IO_CAPABILITY)),
					inputPolicy = ContentInputPolicy(enabled = true, generation = 1L),
				),
			),
		)
		withoutStartup.handshake(listOf(ContentProtocol.REQUIRED_CAPABILITY, ContentProtocol.NATIVE_IO_CAPABILITY))
		withoutStartup.publish(inputSource = OptionalNativeIoSource.Stated(sampleStartupSource()))

		assertEquals(ContentEndpointPhase.RETIRED, withoutStartup.observation.phase)
		assertEquals(ContentUnavailableReason.PROTOCOL_VIOLATION, withoutStartup.observation.reason)
	}

	@Test
	fun `startup input is admitted only on a channel that negotiated startup input`() {
		val harness = readyNative()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sampleStartupSource()))
		harness.commitWrittenFrame(sampleStartupSource())

		assertTrue(harness.admit(keyboardRequest(source = sampleStartupSource())) is ContentInputAdmission.Accepted)
	}

	/* ------------------------------------------------------------------ *
	 * Outcomes
	 * ------------------------------------------------------------------ */

	@Test
	fun `an admitted inline packet becomes submitted only after every local write returned`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(keyboardRequest("q")) as ContentInputAdmission.Accepted

		assertEquals(1, accepted.effects.size)
		assertTrue(accepted.effects.single().frame is InputFrame)
		assertEquals(1L, accepted.ordinal)
		harness.settleAllEffects()

		assertTrue(
			harness.events.contains(
				ContentEndpointEvent.InputSettled(accepted.inputId, 1L, ContentSendOutcome.Submitted),
			),
		)
		assertEquals(0, harness.observation.pendingInputCount)
	}

	@Test
	fun `a write that was invoked and then failed is unknown, never not-sent`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted
		val effect = accepted.effects.single()

		harness.report(effect, ContentSendPhase.INVOKED)
		harness.report(effect, ContentSendPhase.FAILED)

		assertTrue(
			harness.events.contains(
				ContentEndpointEvent.InputSettled(accepted.inputId, 1L, ContentSendOutcome.Unknown),
			),
		)
		assertFalse(harness.events.any { it is ContentEndpointEvent.InputSettled && it.outcome is ContentSendOutcome.NotSent })
	}

	@Test
	fun `a loss with a write still outstanding is unknown and never replays`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted
		harness.report(accepted.effects.single(), ContentSendPhase.INVOKED)

		val step = harness.channelLost()

		assertTrue(
			harness.events.contains(
				ContentEndpointEvent.InputSettled(accepted.inputId, 1L, ContentSendOutcome.Unknown),
			),
		)
		assertEquals(emptyList(), step.effects)
		assertFalse(harness.endpoint.isSendGuardCurrent(accepted.effects.single().guard))
	}

	@Test
	fun `an operation never invoked is released as not-sent on loss`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted

		harness.channelLost()

		assertTrue(
			harness.events.contains(
				ContentEndpointEvent.InputSettled(
					accepted.inputId,
					1L,
					ContentSendOutcome.NotSent(ContentNotSentReason.STOPPED),
				),
			),
		)
	}

	@Test
	fun `a source change mid-operation stops it for good even across an exact A to B to A return`() {
		val a = contentSource(geometry = TARGET_GEOMETRY)
		val b = contentSource(sourceToken = "host-source-token-b", geometry = TARGET_GEOMETRY)
		val harness = readyNative()
		harness.commitWrittenFrame(a)
		val accepted = harness.admit(keyboardRequest(source = a)) as ContentInputAdmission.Accepted
		val before = harness.observation.inputGeneration

		harness.publish(inputSource = OptionalNativeIoSource.Stated(b))
		harness.publish(inputSource = OptionalNativeIoSource.Stated(a))

		assertTrue(harness.observation.inputGeneration > before)
		assertTrue(
			harness.events.contains(
				ContentEndpointEvent.InputSettled(
					accepted.inputId,
					1L,
					ContentSendOutcome.NotSent(ContentNotSentReason.STALE_SOURCE),
				),
			),
		)
		assertFalse(harness.endpoint.isSendGuardCurrent(accepted.effects.single().guard))
	}

	@Test
	fun `a source change with a page already invoked settles unknown without the remaining pages`() {
		val a = contentSource(geometry = TARGET_GEOMETRY)
		val b = contentSource(sourceToken = "host-source-token-b", geometry = TARGET_GEOMETRY)
		val harness = readyNative()
		harness.commitWrittenFrame(a)
		val accepted = harness.admit(pasteRequest(60_000)) as ContentInputAdmission.Accepted
		assertTrue(accepted.effects.size > 2)
		harness.report(accepted.effects.first(), ContentSendPhase.INVOKED, ContentSendPhase.COMPLETED)

		harness.publish(inputSource = OptionalNativeIoSource.Stated(b))

		// A correct transport stops at the stale guard and never reports the remaining
		// pages, so the endpoint must settle the operation now rather than wait forever
		// for writes that must not happen. Bytes that may be on the wire are unknown.
		assertEquals(
			listOf(ContentEndpointEvent.InputSettled(accepted.inputId, 1L, ContentSendOutcome.Unknown)),
			harness.events.filterIsInstance<ContentEndpointEvent.InputSettled>(),
		)
		assertEquals(0, harness.observation.pendingInputCount)
		assertFalse(harness.endpoint.isSendGuardCurrent(accepted.effects.last().guard))
	}

	@Test
	fun `an invalidated operation with no page invoked settles not-sent immediately`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(pasteRequest(60_000)) as ContentInputAdmission.Accepted
		assertTrue(accepted.effects.size > 2)

		harness.publish(inputSource = OptionalNativeIoSource.Stated(
			contentSource(sourceToken = "host-source-token-b", geometry = TARGET_GEOMETRY),
		))

		assertEquals(
			listOf(
				ContentEndpointEvent.InputSettled(
					accepted.inputId,
					1L,
					ContentSendOutcome.NotSent(ContentNotSentReason.STALE_SOURCE),
				),
			),
			harness.events.filterIsInstance<ContentEndpointEvent.InputSettled>(),
		)
		assertEquals(0, harness.observation.pendingInputCount)
	}

	@Test
	fun `a resize invalidates an admitted operation without waiting for its write`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted

		harness.resize(90, 28)

		assertEquals(
			listOf(
				ContentEndpointEvent.InputSettled(
					accepted.inputId,
					1L,
					ContentSendOutcome.NotSent(ContentNotSentReason.STALE_RESIZE),
				),
			),
			harness.events.filterIsInstance<ContentEndpointEvent.InputSettled>(),
		)
		assertEquals(0, harness.observation.pendingInputCount)
		assertFalse(harness.endpoint.isSendGuardCurrent(accepted.effects.single().guard))
	}

	@Test
	fun `a preference change invalidates an admitted operation without waiting for its write`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted

		harness.updatePolicy(ContentInputPolicy(enabled = false, generation = 2L))

		assertEquals(
			listOf(
				ContentEndpointEvent.InputSettled(
					accepted.inputId,
					1L,
					ContentSendOutcome.NotSent(ContentNotSentReason.POLICY_DISABLED),
				),
			),
			harness.events.filterIsInstance<ContentEndpointEvent.InputSettled>(),
		)
		assertEquals(0, harness.observation.pendingInputCount)
	}

	@Test
	fun `a later return to the same source never revives an invalidated operation`() {
		val a = contentSource(geometry = TARGET_GEOMETRY)
		val b = contentSource(sourceToken = "host-source-token-b", geometry = TARGET_GEOMETRY)
		val harness = readyNative()
		harness.commitWrittenFrame(a)
		val accepted = harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted

		harness.publish(inputSource = OptionalNativeIoSource.Stated(b))
		harness.publish(inputSource = OptionalNativeIoSource.Stated(a))

		assertEquals(
			listOf(
				ContentEndpointEvent.InputSettled(
					accepted.inputId,
					1L,
					ContentSendOutcome.NotSent(ContentNotSentReason.STALE_SOURCE),
				),
			),
			harness.events.filterIsInstance<ContentEndpointEvent.InputSettled>(),
		)
	}

	/* ------------------------------------------------------------------ *
	 * Packing and bounds
	 * ------------------------------------------------------------------ */

	@Test
	fun `a paste larger than one message pages under one input id and ordinal`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(pasteRequest(60_000)) as ContentInputAdmission.Accepted

		val frames = accepted.effects.map { it.frame }
		val begin = frames.first() as InputBeginFrame
		val end = frames.last() as InputEndFrame
		val chunks = frames.drop(1).dropLast(1).map { it as InputChunkFrame }
		assertEquals(accepted.inputId, begin.inputId)
		assertTrue(chunks.size >= 2)
		assertEquals(begin.byteLength, chunks.sumOf { it.data.size })
		assertEquals(begin.ordinal, end.ordinal)
		assertEquals(begin.chunkCount, chunks.size)
		assertEquals(0L, chunks.first().index)
		chunks.forEachIndexed { position, chunk -> assertEquals(position.toLong(), chunk.index) }

		harness.settleAllEffects()
		assertTrue(
			harness.events.contains(
				ContentEndpointEvent.InputSettled(accepted.inputId, 1L, ContentSendOutcome.Submitted),
			),
		)
	}

	@Test
	fun `a paste one byte over the fixed bound is refused whole, never truncated`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))

		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.TOO_LARGE),
			harness.admit(pasteRequest(ContentProtocol.NATIVE_TEXT_PASTE_MAX_BYTES + 1)),
		)
	}

	@Test
	fun `a keyboard packet larger than one message is refused rather than paged`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))

		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.TOO_LARGE),
			harness.admit(keyboardRequest("q".repeat(ContentBounds.DEFAULT.maxChunkPayloadBytes + 1))),
		)
	}

	@Test
	fun `an empty packet is invalid input and produces no effect`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val before = harness.effects.size

		assertEquals(ContentInputAdmission.Refused(ContentNotSentReason.INVALID_INPUT), harness.admit(keyboardRequest("")))
		assertEquals(before, harness.effects.size)
	}

	@Test
	fun `a mouse report outside the canonical grammar is invalid input`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))

		assertEquals(ContentInputAdmission.Refused(ContentNotSentReason.INVALID_INPUT), harness.admit(mouseRequest("nope")))
		assertTrue(harness.admit(mouseRequest()) is ContentInputAdmission.Accepted)
	}

	@Test
	fun `the pending bound counts logical operations, not pages`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		repeat(ContentEndpoint.MAX_PENDING_INPUT_OPERATIONS) {
			assertTrue(
				harness.admit(pasteRequest(60_000)) is ContentInputAdmission.Accepted,
				"admission ${it + 1} must be accepted",
			)
		}

		assertEquals(ContentInputAdmission.Refused(ContentNotSentReason.BUSY), harness.admit(keyboardRequest()))
		assertEquals(ContentEndpoint.MAX_PENDING_INPUT_OPERATIONS, harness.observation.pendingInputCount)
		harness.settleAllEffects()
		assertEquals(0, harness.observation.pendingInputCount)
	}

	/* ------------------------------------------------------------------ *
	 * Guards
	 * ------------------------------------------------------------------ */

	@Test
	fun `an ended input lifetime never invalidates an unrelated control guard`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val accepted = harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted
		val unsubscribeGuard = ContentSendGuard.Unsubscribe(CONNECTION_GENERATION, harness.endpoint.subscriptionId)
		val resizeGuard = ContentSendGuard.Resize(
			CONNECTION_GENERATION,
			harness.endpoint.subscriptionId,
			harness.observation.resizeEpoch,
		)

		harness.report(accepted.effects.single(), ContentSendPhase.INVOKED, ContentSendPhase.FAILED)

		assertFalse(harness.endpoint.isSendGuardCurrent(accepted.effects.single().guard))
		assertTrue(harness.endpoint.isSendGuardCurrent(unsubscribeGuard))
		assertTrue(harness.endpoint.isSendGuardCurrent(resizeGuard))
	}

	@Test
	fun `a stale connection generation invalidates every guard`() {
		val harness = readyNative()
		assertFalse(
			harness.endpoint.isSendGuardCurrent(
				ContentSendGuard.Subscribe(CONNECTION_GENERATION + 1, harness.endpoint.subscriptionId),
			),
		)
		assertFalse(harness.endpoint.isSendGuardCurrent(ContentSendGuard.Hello(CONNECTION_GENERATION + 1)))
	}

	@Test
	fun `a retired endpoint reports every guard stale`() {
		val harness = readyNative()
		harness.commitWrittenFrame(contentSource(geometry = TARGET_GEOMETRY))
		val guard = (harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted).effects.single().guard

		harness.channelLost()

		assertFalse(harness.endpoint.isSendGuardCurrent(guard))
		assertFalse(
			harness.endpoint.isSendGuardCurrent(
				ContentSendGuard.Unsubscribe(CONNECTION_GENERATION, harness.endpoint.subscriptionId),
			),
		)
	}
}
