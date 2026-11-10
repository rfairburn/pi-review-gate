package io.github.rfairburn.pireviewgate.core.input

import java.util.concurrent.Semaphore

/**
 * How many finished results may exist before their owner has taken them.
 *
 * A background producer that hands work to a UI thread can finish far faster than
 * that thread drains its queue. If each finished result owns a large allocation,
 * the queue itself becomes the memory problem the producer's own size limits were
 * supposed to prevent: nothing is retained by the owner yet, so no owner-side
 * budget sees it.
 *
 * A permit is taken before the allocation and released when the result is consumed
 * or discarded, so the outstanding total stays bounded no matter how much work was
 * queued. [acquire] blocks rather than dropping work, which is what turns the bound
 * into backpressure.
 */
class DeliverySlots(permits: Int = DEFAULT_PERMITS) {
	private val semaphore = Semaphore(permits)

	/**
	 * Wait for a free slot. False only when the wait was interrupted, in which case
	 * no slot is held and the caller must abandon its work.
	 */
	fun acquire(): Boolean = try {
		semaphore.acquire()
		true
	} catch (_: InterruptedException) {
		Thread.currentThread().interrupt()
		false
	}

	/** Give the slot back once the result was delivered or thrown away. */
	fun release() {
		semaphore.release()
	}

	/** Slots free right now. */
	val freeSlots: Int
		get() = semaphore.availablePermits()

	private companion object {
		const val DEFAULT_PERMITS = 1
	}
}
