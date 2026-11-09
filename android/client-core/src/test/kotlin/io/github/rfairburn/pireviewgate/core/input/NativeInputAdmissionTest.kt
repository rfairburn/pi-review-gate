package io.github.rfairburn.pireviewgate.core.input

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections

class NativeInputAdmissionTest {
	@Test
	fun `inputs are admitted in submit order even on a parallel pool`() = runBlocking {
		val scope = CoroutineScope(SupervisorJob())
		try {
			val order = Collections.synchronizedList(mutableListOf<Int>())
			val admission = OrderedInputAdmission<Int, Int>(scope, Dispatchers.Default) { item ->
				// Uneven work per item: per-item coroutines would finish out of order.
				if (item % 3 == 0) delay(2) else yield()
				order += item
				item * 10
			}
			val results = (0 until 200).map { admission.submit(it) }
			assertEquals((0 until 200).map { it * 10 }, withTimeout(10_000) { results.awaitAll() })
			assertEquals((0 until 200).toList(), order)
		} finally {
			scope.cancel()
		}
	}

	@Test
	fun `admission waits only for the earlier admission and never for a later settlement`() = runBlocking {
		val scope = CoroutineScope(SupervisorJob())
		try {
			val gate = CompletableDeferred<Unit>()
			val settled = CompletableDeferred<Unit>()
			val admission = OrderedInputAdmission<String, String>(scope, Dispatchers.Default) { item ->
				if (item == "first") gate.await()
				item
			}
			val first = admission.submit("first")
			val second = admission.submit("second")
			delay(20)
			assertFalse("the second input waits behind the first admission", second.isCompleted)
			gate.complete(Unit)
			assertEquals("first", withTimeout(5_000) { first.await() })
			// The second admission completes although nothing about the first has settled.
			assertEquals("second", withTimeout(5_000) { second.await() })
			assertFalse(settled.isCompleted)
		} finally {
			scope.cancel()
		}
	}

	@Test
	fun `one failed admission fails only its own input`() = runBlocking {
		val scope = CoroutineScope(SupervisorJob())
		try {
			val admission = OrderedInputAdmission<Int, Int>(scope, Dispatchers.Default) { item ->
				if (item == 1) error("refused")
				if (item == 2) throw CancellationException("local")
				item
			}
			val results = (0..3).map { admission.submit(it) }
			assertEquals(0, withTimeout(5_000) { results[0].await() })
			assertTrue(runCatching { results[1].await() }.exceptionOrNull() is IllegalStateException)
			assertTrue(runCatching { results[2].await() }.exceptionOrNull() is CancellationException)
			assertEquals(3, withTimeout(5_000) { results[3].await() })
		} finally {
			scope.cancel()
		}
	}

	@Test
	fun `cancelling the owner ends queued admissions without running them`() = runBlocking {
		val scope = CoroutineScope(SupervisorJob())
		val ran = Collections.synchronizedList(mutableListOf<Int>())
		val gate = CompletableDeferred<Unit>()
		val admission = OrderedInputAdmission<Int, Int>(scope, Dispatchers.Default) { item ->
			ran += item
			gate.await()
			item
		}
		val results = (0..2).map { admission.submit(it) }
		withTimeout(5_000) { while (ran.isEmpty()) delay(1) }
		scope.cancel()
		results.forEach { result ->
			assertTrue(runCatching { withTimeout(5_000) { result.await() } }.exceptionOrNull() is CancellationException)
		}
		assertEquals(listOf(0), ran.toList())
		assertTrue(admission.submit(9).isCancelled)
	}

	@Test
	fun `an owner that is already cancelled admits nothing and every result terminates`() {
		val scope = CoroutineScope(SupervisorJob())
		scope.cancel()
		val ran = mutableListOf<Int>()
		val admission = OrderedInputAdmission<Int, Int>(scope, Dispatchers.Unconfined) { item -> ran += item; item }
		val results = (0..2).map { admission.submit(it) }
		results.forEach { assertTrue(it.isCancelled) }
		assertTrue(ran.isEmpty())
	}

	@Test
	fun `an owner cancelled before the consumer first runs still ends every queued input`() {
		val dispatcher = StandardTestDispatcher()
		val scheduler = dispatcher.scheduler
		val scope = CoroutineScope(SupervisorJob())
		val ran = mutableListOf<Int>()
		val admission = OrderedInputAdmission<Int, Int>(scope, dispatcher) { item -> ran += item; item }
		// Queued, but the dispatcher has not run the consumer yet.
		val results = (0..2).map { admission.submit(it) }
		results.forEach { assertFalse(it.isCompleted) }
		scope.cancel()
		scheduler.advanceUntilIdle()
		results.forEach { assertTrue("queued input terminates", it.isCancelled) }
		assertTrue("nothing was admitted", ran.isEmpty())
		assertTrue("later inputs are refused at once", admission.submit(9).isCancelled)
	}

	private data class Key(val scope: String, val id: Int)

	private fun book() = InputSettlementBook<String, Key, String, String>(limit = 64) { it.scope }

	@Test
	fun `at most sixty-four inputs are outstanding, admitting and accepted together`() {
		val book = book()
		repeat(40) { assertTrue(book.reserve("a")) }
		repeat(30) { index ->
			assertNull(book.admitted(Key("a", index), "notice-$index"))
			book.release("a")
		}
		repeat(24) { assertTrue(book.reserve("b")) }
		assertEquals(64, book.outstanding)
		assertFalse("busy", book.reserve("a"))
		assertFalse("busy", book.reserve("c"))
		assertEquals("notice-3", book.settle(Key("a", 3), "Submitted"))
		assertEquals(63, book.outstanding)
		assertTrue(book.reserve("c"))
		assertFalse(book.reserve("c"))
	}

	@Test
	fun `a settlement before its admission is handed to that admission`() {
		val book = book()
		assertTrue(book.reserve("a"))
		assertNull("held as early", book.settle(Key("a", 1), "NotSent"))
		assertEquals("NotSent", book.admitted(Key("a", 1), "notice"))
		book.release("a")
		assertEquals(0, book.outstanding)
		assertNull("nothing is left to settle", book.settle(Key("a", 1), "Submitted"))
	}

	@Test
	fun `early settlements are dropped once nothing in their scope is admitting`() {
		val book = book()
		assertTrue(book.reserve("a"))
		assertNull(book.settle(Key("a", 7), "Unknown"))
		book.release("a")
		assertTrue(book.reserve("a"))
		assertNull("the stale early outcome is gone", book.admitted(Key("a", 7), "notice"))
		assertEquals("notice", book.settle(Key("a", 7), "Submitted"))
	}

	@Test
	fun `a settlement for nothing outstanding is ignored`() {
		val book = book()
		assertNull(book.settle(Key("z", 1), "Submitted"))
		assertEquals(0, book.outstanding)
		assertTrue(book.reserve("z"))
		assertNull(book.settle(Key("y", 1), "Submitted"))
		assertNull(book.admitted(Key("y", 1), "notice"))
	}
}
