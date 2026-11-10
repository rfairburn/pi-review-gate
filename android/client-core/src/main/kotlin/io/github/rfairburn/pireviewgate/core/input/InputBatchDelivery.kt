package io.github.rfairburn.pireviewgate.core.input

/**
 * Ordered delivery of one input batch, with a currency check between packets.
 *
 * A batch is prepared against one proof — one committed frame, one set of modes.
 * Delivery is not atomic, though: the sink is the caller's own callback, and a
 * caller that takes the frame away from inside that callback (rebinding, suspending
 * input, or installing a publish with no source) has stopped standing behind the
 * pixels the rest of the batch names. Continuing would attribute those packets to a
 * retired proof, which is exactly what the proof exists to prevent.
 *
 * So [emitInOrder] asks, before every packet after the first, whether the proof is
 * still current, and stops the moment it is not. The check is a cheap read of
 * published state, never a lock, and it is never held across the sink.
 */
object InputBatchDelivery {
	/**
	 * Hand each element of [packets] to [emit], in order.
	 *
	 * [stillCurrent] is consulted between packets, not before the first: a caller
	 * that already decided the proof is current when it prepared the batch has paid
	 * for that check once. Returns how many packets were handed over, so the caller
	 * can tell a completed batch from a stopped one.
	 */
	fun emitInOrder(
		packets: List<ByteArray>,
		stillCurrent: () -> Boolean,
		emit: (ByteArray) -> Unit,
	): Int {
		var delivered = 0
		for (packet in packets) {
			if (delivered > 0 && !stillCurrent()) break
			emit(packet)
			delivered += 1
		}
		return delivered
	}
}
