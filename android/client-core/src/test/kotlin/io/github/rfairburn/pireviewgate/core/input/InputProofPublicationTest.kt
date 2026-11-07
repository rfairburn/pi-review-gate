package io.github.rfairburn.pireviewgate.core.input

import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.Future
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Who is standing behind which input proof, across threads.
 *
 * The party that asks is usually not the party that decides: a writer thread wants
 * to know whether the frame it prepared a write for is still the current one, while
 * only the UI thread can publish or retire it. These are the cases that matter —
 * a proof read from another thread, a proof retired while a reader is on its way,
 * and a late confirmation for a superseded draw pass trying to become the proof.
 *
 * Everything is ordered by futures and barriers. Nothing sleeps, nothing polls, and
 * no test depends on which thread wins a race.
 */
class InputProofPublicationTest {
	private val pool = Executors.newFixedThreadPool(2)

	@After
	fun tearDown() {
		pool.shutdownNow()
	}

	/** Run [block] on the pool and wait for its result — a barrier, not a poll. */
	private fun <T> onPool(block: () -> T): T = pool.submit(Callable<T> { block() }).get()

	@Test
	fun aPublishedProofIsCurrentAndReadableFromAnotherThread() {
		val proofs = InputProofPublication<String>()
		val published = proofs.publish("frame-1")
		assertEquals("frame-1", published.proof)
		assertEquals(1L, published.publicationEpoch)
		assertTrue(onPool { proofs.isCurrent("frame-1") })
		assertEquals("frame-1", onPool { proofs.current()?.proof })
	}

	@Test
	fun aProofRetiredOnOneThreadIsNeverCurrentOnAnother() {
		val proofs = InputProofPublication<String>()
		proofs.publish("frame-1")
		// The worker retires, then waits at the barrier. Once the main thread gets
		// past it too, the retirement has happened, so what follows is not a race.
		val barrier = CyclicBarrier(2)
		val retired: Future<String?> = pool.submit(Callable<String?> {
			val previous = proofs.retire()
			barrier.await()
			previous?.proof
		})
		barrier.await()
		assertEquals("frame-1", retired.get())
		assertNull(onPool { proofs.current() })
		assertFalse(proofs.isCurrent("frame-1"))
		assertFalse(onPool { proofs.isCurrent("frame-1") })
	}

	@Test
	fun anOlderProofNeverPassesAfterANewerOneIsPublished() {
		val proofs = InputProofPublication<String>()
		proofs.publish("frame-1")
		val second = proofs.publish("frame-2")
		assertEquals(2L, second.publicationEpoch)
		assertFalse(proofs.isCurrent("frame-1"))
		assertTrue(onPool { proofs.isCurrent("frame-2") })
		assertFalse(onPool { proofs.isCurrent("frame-1") })
	}

	@Test
	fun retiringNothingIsANoOpAndNullIsNeverCurrent() {
		val proofs = InputProofPublication<String>()
		assertNull(proofs.retire())
		assertFalse(proofs.isCurrent(null))
		proofs.publish("frame-1")
		assertNotNull(proofs.retire())
		assertNull(proofs.retire())
		assertFalse(proofs.isCurrent("frame-1"))
	}

	@Test
	fun aStaleConfirmationCannotReplaceTheNewerPublishedProof() {
		// The watcher hands whatever the platform confirmed to this same publishing
		// path. A registration that was superseded reports nothing, so a late
		// confirmation for an older draw pass cannot publish itself, before or after
		// the newer pass published.
		val proofs = InputProofPublication<String>()
		val commits = CommitCallbackCoordinator { drawEpoch -> proofs.publish("frame-$drawEpoch") }
		val older = commits.begin(1)
		val newer = commits.begin(2)
		older.report()
		assertNull(proofs.current())
		newer.report()
		assertEquals("frame-2", proofs.current()?.proof)
		older.report()
		assertEquals("frame-2", proofs.current()?.proof)
		assertFalse(proofs.isCurrent("frame-1"))
	}

	@Test
	fun aWithdrawnPassCannotReviveAProofAfterDetachOrRebind() {
		val proofs = InputProofPublication<String>()
		val commits = CommitCallbackCoordinator { drawEpoch -> proofs.publish("frame-$drawEpoch") }
		val pass = commits.begin(1)
		pass.report()
		assertEquals("frame-1", proofs.current()?.proof)
		// A rebind or detach withdraws the pending pass; a confirmation that was
		// already in flight then arrives to nothing.
		commits.withdraw()
		proofs.retire()
		pass.report()
		assertNull(proofs.current())
		assertFalse(proofs.isCurrent("frame-1"))
	}

	@Test
	fun manyReadersAllSeeTheSameCurrentProofUntilTheWriterRetiresIt() {
		val proofs = InputProofPublication<String>()
		proofs.publish("frame-1")
		val go = CountDownLatch(1)
		val reads = (1..4).map { pool.submit(Callable<Boolean> { go.await(); proofs.isCurrent("frame-1") }) }
		go.countDown()
		// The retirement below happens only after every reader has answered, so the
		// expectation is exact rather than a tolerance around a race.
		assertTrue(reads.all { it.get() })
		proofs.retire()
		assertFalse(proofs.isCurrent("frame-1"))
	}
}
