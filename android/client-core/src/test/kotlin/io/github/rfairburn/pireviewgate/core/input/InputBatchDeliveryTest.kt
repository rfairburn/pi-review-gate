package io.github.rfairburn.pireviewgate.core.input

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A batch of packets against one proof, delivered in order and stoppable in the
 * middle.
 *
 * The case that matters is the one a caller can create on purpose: taking the frame
 * away from inside the callback that receives the first packet. Everything after
 * that would be attributed to pixels nobody stands behind, so the batch has to stop
 * — and the caller has to be able to tell that it did.
 */
class InputBatchDeliveryTest {
	private fun packets(vararg values: String): List<ByteArray> =
		values.map { it.toByteArray(StandardCharsets.UTF_8) }

	private fun textOf(packet: ByteArray): String = String(packet, StandardCharsets.UTF_8)

	@Test
	fun everyPacketOfACurrentBatchIsDeliveredInOrder() {
		val delivered = mutableListOf<String>()
		val count = InputBatchDelivery.emitInOrder(
			packets("a", "b", "c"),
			stillCurrent = { true },
			emit = { delivered += textOf(it) },
		)
		assertEquals(3, count)
		assertEquals(listOf("a", "b", "c"), delivered)
	}

	@Test
	fun aBatchStopsTheMomentTheProofStopsBeingCurrent() {
		val delivered = mutableListOf<String>()
		var current = true
		val count = InputBatchDelivery.emitInOrder(
			packets("a", "b", "c", "d"),
			stillCurrent = { current },
			emit = { packet ->
				delivered += textOf(packet)
				// The sink retires the surface from inside the callback, the way a
				// caller installing a source-less publish would.
				if (delivered.size == 1) current = false
			},
		)
		assertEquals("nothing after the retirement is handed over", 1, count)
		assertEquals(listOf("a"), delivered)
	}

	@Test
	fun theFirstPacketIsNotCheckedAgainBecauseTheCallerAlreadyCheckedIt() {
		val delivered = mutableListOf<String>()
		val count = InputBatchDelivery.emitInOrder(
			packets("only"),
			stillCurrent = { error("a single-packet batch never consults the currency check") },
			emit = { delivered += textOf(it) },
		)
		assertEquals(1, count)
		assertEquals(listOf("only"), delivered)
	}

	@Test
	fun anEmptyBatchDeliversNothing() {
		val count = InputBatchDelivery.emitInOrder(emptyList(), stillCurrent = { true }, emit = { error("nothing to emit") })
		assertEquals(0, count)
	}

	@Test
	fun aCurrencyCheckThatTurnsFalseBeforeTheSecondPacketIsConsultedOncePerPacket() {
		var checks = 0
		val count = InputBatchDelivery.emitInOrder(
			packets("a", "b", "c"),
			stillCurrent = {
				checks += 1
				false
			},
			emit = { },
		)
		assertEquals("the second packet is refused and the loop stops", 1, count)
		assertEquals(1, checks)
	}
}
