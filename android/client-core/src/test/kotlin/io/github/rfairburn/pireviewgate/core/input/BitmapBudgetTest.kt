package io.github.rfairburn.pireviewgate.core.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BitmapBudgetTest {
	@Test
	fun `reservations fit until the ceiling is reached`() {
		val budget = BitmapBudget(100L)
		assertTrue(budget.tryReserve(60L))
		assertTrue(budget.tryReserve(40L))
		assertFalse(budget.tryReserve(1L))
		assertEquals(100L, budget.reservedBytes)
		assertEquals(0L, budget.availableBytes)
	}

	@Test
	fun `a single request larger than the whole budget is refused`() {
		val budget = BitmapBudget(100L)
		assertFalse(budget.tryReserve(101L))
		assertEquals(0L, budget.reservedBytes)
	}

	@Test
	fun `nonsense sizes are refused`() {
		val budget = BitmapBudget(100L)
		assertFalse(budget.tryReserve(0L))
		assertFalse(budget.tryReserve(-5L))
	}

	@Test
	fun `released bytes become available again`() {
		val budget = BitmapBudget(100L)
		assertTrue(budget.tryReserve(90L))
		budget.release(50L)
		assertEquals(40L, budget.reservedBytes)
		assertTrue(budget.tryReserve(60L))
		assertFalse(budget.tryReserve(1L))
	}

	@Test
	fun `clearing returns everything`() {
		val budget = BitmapBudget(100L)
		assertTrue(budget.tryReserve(100L))
		budget.releaseAll()
		assertEquals(0L, budget.reservedBytes)
		assertTrue(budget.tryReserve(100L))
	}
}
