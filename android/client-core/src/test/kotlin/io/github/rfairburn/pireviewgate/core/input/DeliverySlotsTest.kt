package io.github.rfairburn.pireviewgate.core.input

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeliverySlotsTest {
	@Test
	fun `only one result may exist before its owner takes it`() {
		val slots = DeliverySlots()
		val live = AtomicInteger()
		val peak = AtomicInteger()
		val delivered = AtomicInteger()
		val started = CountDownLatch(4)
		val done = CountDownLatch(4)

		repeat(4) {
			thread {
				started.countDown()
				started.await(5, TimeUnit.SECONDS)
				if (!slots.acquire()) return@thread
				try {
					val now = live.incrementAndGet()
					peak.updateAndGet { maxOf(it, now) }
					Thread.sleep(15)
					live.decrementAndGet()
					delivered.incrementAndGet()
				} finally {
					slots.release()
				}
				done.countDown()
			}
		}

		assertTrue(done.await(10, TimeUnit.SECONDS))
		assertEquals(4, delivered.get())
		assertEquals("at most one allocation may be outstanding", 1, peak.get())
		assertEquals(1, slots.freeSlots)
	}

	@Test
	fun `a slot is held until the result is consumed`() {
		val slots = DeliverySlots()
		assertTrue(slots.acquire())
		assertEquals(0, slots.freeSlots)
		slots.release()
		assertEquals(1, slots.freeSlots)
	}

	@Test
	fun `an interrupted wait holds nothing`() {
		val slots = DeliverySlots()
		assertTrue(slots.acquire())
		val blocked = AtomicInteger(-1)
		val waiter = thread {
			blocked.set(if (slots.acquire()) 1 else 0)
		}
		// The waiter is parked; give it a moment, then cancel it the way close does.
		Thread.sleep(50)
		waiter.interrupt()
		waiter.join(5_000)
		assertFalse(waiter.isAlive)
		assertEquals("an interrupted acquire must not hold a slot", 0, blocked.get())
		assertEquals(0, slots.freeSlots)
		slots.release()
	}

	@Test
	fun `more than one permit admits that many outstanding results`() {
		val slots = DeliverySlots(permits = 3)
		assertTrue(slots.acquire())
		assertTrue(slots.acquire())
		assertEquals(1, slots.freeSlots)
		slots.release()
		slots.release()
		assertEquals(3, slots.freeSlots)
	}
}
