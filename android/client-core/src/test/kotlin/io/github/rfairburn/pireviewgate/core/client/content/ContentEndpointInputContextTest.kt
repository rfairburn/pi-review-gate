package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.protocol.content.INPUT_MODES
import io.github.rfairburn.pireviewgate.core.protocol.content.InputFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeSessionRef
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalCursor
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import io.github.rfairburn.pireviewgate.core.protocol.content.contentSource
import io.github.rfairburn.pireviewgate.core.protocol.content.sampleFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.startupSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The semantic input context contract of the selected-content endpoint.
 *
 * With source (token, native tuple and epoch, viewer and geometry revisions,
 * startup-vs-conversation), modes, and geometry unchanged, ordinary terminal output —
 * a new snapshot object or a new publish sequence — neither revokes the caller's
 * actually-committed written receipt nor ends an admitted operation, and a newer
 * commit of the same context does not either. Every genuine semantic change still
 * retires both immediately, and no future, pre-context, or other-generation proof is
 * ever registered.
 */
class ContentEndpointInputContextTest {

	private val sourceA: NativeIoInputSource = contentSource(geometry = TARGET_GEOMETRY)

	private fun readyNative(): ContentEndpointHarness {
		val harness = ContentEndpointHarness(ContentEndpoint(nativeIoConfig(startup = true)))
		harness.handshake(NATIVE_IO_ACK)
		return harness
	}

	/** One ordinary output publication: same source, modes, and geometry; new text state. */
	private fun ContentEndpointHarness.output(count: Int, source: NativeIoInputSource = sourceA) {
		repeat(count) {
			val sequence = nextSequence
			publish(
				frame = sampleFrame().copy(cursor = TerminalCursor(column = (sequence % 12).toInt(), row = 1, visible = true)),
				inputSource = OptionalNativeIoSource.Stated(source),
			)
		}
	}

	private fun ContentEndpointHarness.settledOutcomes(): List<ContentEndpointEvent.InputSettled> =
		events.filterIsInstance<ContentEndpointEvent.InputSettled>()

	/* ------------------------------------------------------------------ *
	 * Positive progress under an unchanged context
	 * ------------------------------------------------------------------ */

	@Test
	fun `a written commit keeps admitting and submitting input across fifty same-context publications`() {
		val harness = readyNative()
		assertIs<ContentWrittenFrameOutcome.Registered>(harness.commitWrittenFrame(sourceA))
		val generation = harness.observation.inputGeneration
		val written = assertNotNull(harness.observation.writtenReceipt)

		harness.output(50)

		assertEquals(51L, harness.observation.view?.meta?.sequence)
		assertEquals(generation, harness.observation.inputGeneration, "ordinary output is not a semantic change")
		assertEquals(written, harness.observation.writtenReceipt, "the committed context proof stays standing")
		val accepted = assertIs<ContentInputAdmission.Accepted>(harness.admit(keyboardRequest("x")))
		// The admitted packet is the exact text, against the endpoint's own current source.
		val frame = assertIs<InputFrame>(accepted.effects.single().frame)
		assertEquals("x", String(frame.data, Charsets.UTF_8))
		harness.settleAllEffects()
		assertEquals(
			listOf(ContentEndpointEvent.InputSettled(accepted.inputId, accepted.ordinal, ContentSendOutcome.Submitted)),
			harness.settledOutcomes(),
		)
	}

	@Test
	fun `an admitted operation survives ordinary output and a newer same-context commit replacing the receipt`() {
		val harness = readyNative()
		harness.commitWrittenFrame(sourceA)
		val accepted = assertIs<ContentInputAdmission.Accepted>(harness.admit(pasteRequest(60_000)))
		assertTrue(accepted.effects.size > 2)
		harness.report(accepted.effects.first(), ContentSendPhase.INVOKED, ContentSendPhase.COMPLETED)

		harness.output(10)
		// The caller genuinely drew and committed a newer publication of the same context.
		val newer = assertIs<ContentWrittenFrameOutcome.Registered>(
			harness.endpoint.recordWrittenFrame(writtenProof(harness)),
		).receipt
		assertEquals(harness.nextSequence - 1, newer.sequence)
		harness.output(10)

		accepted.effects.drop(1).forEach { assertTrue(harness.endpoint.isSendGuardCurrent(it.guard)) }
		assertTrue(harness.settledOutcomes().isEmpty(), "nothing settled the operation early")
		accepted.effects.drop(1).forEach { harness.report(it, ContentSendPhase.INVOKED, ContentSendPhase.COMPLETED) }
		assertEquals(
			listOf(ContentEndpointEvent.InputSettled(accepted.inputId, accepted.ordinal, ContentSendOutcome.Submitted)),
			harness.settledOutcomes(),
		)
	}

	@Test
	fun `a replacement publication with an unchanged source keeps an admitted input`() {
		val harness = readyNative()
		harness.commitWrittenFrame(sourceA)
		val accepted = harness.admit(keyboardRequest()) as ContentInputAdmission.Accepted
		val guard = accepted.effects.single().guard

		// A byte-identical source and modes under a new publish sequence is ordinary
		// output: the documented contract keeps the admitted lifetime.
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sourceA))

		assertTrue(harness.endpoint.isSendGuardCurrent(guard))
		assertEquals(1, harness.observation.pendingInputCount)
		harness.settleAllEffects()
		assertEquals(
			listOf(ContentEndpointEvent.InputSettled(accepted.inputId, 1L, ContentSendOutcome.Submitted)),
			harness.settledOutcomes(),
		)
	}

	@Test
	fun `an earlier drawn publication of the same context still commits after newer output arrived`() {
		val harness = readyNative()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sourceA))
		// The caller drew sequence 1; newer output arrives before its commit callback.
		val drawnAtOne = writtenProof(harness, sequence = 1L)
		harness.output(3)

		val receipt = assertIs<ContentWrittenFrameOutcome.Registered>(
			harness.endpoint.recordWrittenFrame(drawnAtOne),
		).receipt
		assertEquals(1L, receipt.sequence, "the receipt names what was actually drawn, not the newest publish")
		assertEquals(harness.observation.inputGeneration, receipt.inputGeneration)
		assertIs<ContentInputAdmission.Accepted>(harness.admit(keyboardRequest()))
	}

	/* ------------------------------------------------------------------ *
	 * Negative fences: no fabricated, future, or pre-context proof
	 * ------------------------------------------------------------------ */

	@Test
	fun `a future, pre-context, or other-generation commit is never registered`() {
		val sourceB = contentSource(sourceToken = "host-source-token-b", geometry = TARGET_GEOMETRY)
		val harness = readyNative()
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sourceA))
		val drawnUnderFirstA = writtenProof(harness, sequence = 1L)
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sourceB))
		harness.publish(inputSource = OptionalNativeIoSource.Stated(sourceA))
		val generation = harness.observation.inputGeneration
		val current = harness.nextSequence - 1
		val mismatch = ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.SEQUENCE_MISMATCH)

		// A → B → A: the original A commit belongs to a superseded generation.
		assertEquals(mismatch, harness.endpoint.recordWrittenFrame(drawnUnderFirstA))
		// Relabelling its generation cannot help: it was published before this context began.
		assertEquals(mismatch, harness.endpoint.recordWrittenFrame(drawnUnderFirstA.copy(inputGeneration = generation)))
		// Nothing past the current publish was ever drawn.
		assertEquals(mismatch, harness.endpoint.recordWrittenFrame(writtenProof(harness, sequence = current + 1)))
		// The current publish under an older generation is not this context's commit.
		assertEquals(mismatch, harness.endpoint.recordWrittenFrame(writtenProof(harness, inputGeneration = generation - 1)))
		assertEquals(mismatch, harness.endpoint.recordWrittenFrame(writtenProof(harness, inputGeneration = generation + 1)))
		assertNull(harness.observation.writtenReceipt)
		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.NO_WRITTEN_FRAME),
			harness.admit(keyboardRequest()),
		)

		assertIs<ContentWrittenFrameOutcome.Registered>(harness.endpoint.recordWrittenFrame(writtenProof(harness)))
		assertIs<ContentInputAdmission.Accepted>(harness.admit(keyboardRequest()))
	}

	@Test
	fun `every semantic change retires the written receipt and ends an admitted operation for good`() {
		val tuple = contentSource(geometry = TARGET_GEOMETRY)
		val revised = SessionGeometry(cols = 12, rows = 3, revision = 1)
		data class Change(
			val label: String,
			val source: NativeIoInputSource,
			val modes: TerminalInputModes = INPUT_MODES,
			val geometry: SessionGeometry = TARGET_GEOMETRY,
			val viaB: Boolean = false,
		)
		val changes = listOf(
			Change("source token", contentSource(sourceToken = "host-source-token-b", geometry = TARGET_GEOMETRY)),
			Change("native epoch", contentSource(nativeSession = NativeSessionRef("native-session-1", 4), geometry = TARGET_GEOMETRY)),
			Change("native session", contentSource(nativeSession = NativeSessionRef("native-session-2", 3), geometry = TARGET_GEOMETRY)),
			Change("viewer revision", contentSource(viewerRevision = 3, geometry = TARGET_GEOMETRY)),
			Change("startup instead of tuple", startupSource(geometry = TARGET_GEOMETRY)),
			Change("modes only", tuple, modes = INPUT_MODES.copy(bracketedPaste = false)),
			Change("geometry revision", contentSource(geometry = revised), geometry = revised),
			Change("exact A to B to A", tuple, viaB = true),
		)
		for (change in changes) {
			val harness = readyNative()
			assertIs<ContentWrittenFrameOutcome.Registered>(harness.commitWrittenFrame(tuple), change.label)
			val before = harness.observation.inputGeneration
			val accepted = assertIs<ContentInputAdmission.Accepted>(harness.admit(keyboardRequest()), change.label)
			if (change.viaB) {
				harness.publish(inputSource = OptionalNativeIoSource.Stated(
					contentSource(sourceToken = "host-source-token-b", geometry = TARGET_GEOMETRY),
				))
			}
			val ordinaryGeometry = change.geometry == TARGET_GEOMETRY
			if (ordinaryGeometry) {
				harness.publish(inputSource = OptionalNativeIoSource.Stated(change.source), inputModes = change.modes)
			} else {
				// The harness publish derives geometry from the frame; state the revision directly.
				val sequence = harness.nextSequence
				harness.deliverAll(
					transferFrames(
						frame = sampleFrame(),
						subscriptionId = harness.endpoint.subscriptionId,
						transferId = "transfer-$sequence",
						sequence = sequence,
						geometry = change.geometry,
						inputModes = change.modes,
						inputSource = OptionalNativeIoSource.Stated(change.source),
					),
				)
			}

			assertEquals(ContentEndpointPhase.STREAMING, harness.observation.phase, change.label)
			assertTrue(harness.observation.inputGeneration > before, change.label)
			assertNull(harness.observation.writtenReceipt, change.label)
			assertFalse(harness.endpoint.isSendGuardCurrent(accepted.effects.single().guard), change.label)
			assertEquals(
				listOf(
					ContentEndpointEvent.InputSettled(
						accepted.inputId,
						accepted.ordinal,
						ContentSendOutcome.NotSent(ContentNotSentReason.STALE_SOURCE),
					),
				),
				harness.settledOutcomes(),
				change.label,
			)
			// Admission against the new context waits for a genuine commit of it.
			assertEquals(
				ContentInputAdmission.Refused(ContentNotSentReason.NO_WRITTEN_FRAME),
				harness.admit(keyboardRequest(source = change.source, inputModes = change.modes)),
				change.label,
			)
			// Ordinary output in the new context never revives the retired proof either.
			if (ordinaryGeometry && change.modes == INPUT_MODES) {
				harness.output(3, change.source)
				assertNull(harness.observation.writtenReceipt, change.label)
			}
		}
	}

	@Test
	fun `policy, resize, and selection boundaries stay fail closed under same-context output`() {
		val policy = readyNative()
		policy.commitWrittenFrame(sourceA)
		val policyInput = assertIs<ContentInputAdmission.Accepted>(policy.admit(keyboardRequest()))
		policy.updatePolicy(ContentInputPolicy(enabled = true, generation = 2L))
		policy.output(5)
		assertNull(policy.observation.writtenReceipt)
		assertFalse(policy.endpoint.isSendGuardCurrent(policyInput.effects.single().guard))
		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.NO_WRITTEN_FRAME),
			policy.admit(keyboardRequest()),
		)

		val resize = readyNative()
		resize.commitWrittenFrame(sourceA)
		val resizeInput = assertIs<ContentInputAdmission.Accepted>(resize.admit(keyboardRequest()))
		resize.resize(90, 28)
		resize.output(5)
		assertFalse(resize.endpoint.isSendGuardCurrent(resizeInput.effects.single().guard))
		assertEquals(
			ContentInputAdmission.Refused(ContentNotSentReason.STALE_RESIZE),
			resize.admit(keyboardRequest()),
		)

		val selection = readyNative()
		selection.publish(inputSource = OptionalNativeIoSource.Stated(sourceA))
		assertEquals(
			ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.BINDING_MISMATCH),
			selection.endpoint.recordWrittenFrame(writtenProof(selection, selectionGeneration = SELECTION_GENERATION + 1)),
		)
		selection.output(5)
		assertNull(selection.observation.writtenReceipt)
	}
}
