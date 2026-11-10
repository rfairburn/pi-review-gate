package io.github.rfairburn.pireviewgate.core.input

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyDeliveryLedgerTest {
	private val ledger = KeyDeliveryLedger()

	@Test
	fun `the same press arriving twice is carried once`() {
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 0))
		assertTrue(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 0))
		assertTrue(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 0))
	}

	@Test
	fun `key up is a distinct delivery from key down`() {
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 0))
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 1, repeatCount = 0))
		assertTrue(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 1, repeatCount = 0))
	}

	@Test
	fun `an auto repeat is a distinct delivery`() {
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 0))
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 1))
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 2))
		assertTrue(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 2))
	}

	@Test
	fun `a later press of the same key is carried again`() {
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 0))
		assertFalse(ledger.alreadyDelivered(downTime = 250L, keyCode = 30, action = 0, repeatCount = 0))
	}

	@Test
	fun `a different key interrupts the tracked press`() {
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 0))
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 31, action = 0, repeatCount = 0))
		assertFalse(ledger.alreadyDelivered(downTime = 100L, keyCode = 30, action = 0, repeatCount = 0))
	}
}
