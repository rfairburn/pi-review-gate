package io.github.rfairburn.pireviewgate.core.client.ui

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The thread-safe standing behind every proof.
 *
 * A controller consults a proof from its own thread after receiving an intent, so
 * these cases use real threads and deterministic latches — never sleeps — to pin
 * what a reader is allowed to see while the UI thread retires a control.
 */
class MutableUiActionProofTest {

    private fun proof(screen: UiProofScreen = UiProofScreen.SESSION_CLOSE) =
        MutableUiActionProof(ClientUiFixtures.token(screen))

    @Test
    fun `a fresh proof is current but satisfies nothing else`() {
        val subject = proof()
        assertTrue(subject.isCurrent)
        assertFalse(subject.hasCommittedFrame)
        assertFalse(subject.criticalIdentityReadable)
        assertFalse(subject.grantsAction())
    }

    @Test
    fun `a commit for the current epoch plus readable identity grants`() {
        val subject = proof()
        val epoch = subject.beginDraw()
        subject.markCommitted(epoch)
        subject.setCriticalIdentityReadable(true)
        assertTrue(subject.grantsAction())
    }

    @Test
    fun `a commit for a superseded epoch is dropped`() {
        val subject = proof()
        val first = subject.beginDraw()
        val second = subject.beginDraw()
        assertTrue(second > first)
        subject.markCommitted(first)
        assertFalse(subject.hasCommittedFrame, "an older draw pass must not satisfy the current one")
        subject.markCommitted(second)
        assertTrue(subject.hasCommittedFrame)
    }

    @Test
    fun `invalidation drops the standing and a late report for the old epoch cannot restore it`() {
        val subject = proof()
        val epoch = subject.beginDraw()
        subject.markCommitted(epoch)
        subject.setCriticalIdentityReadable(true)
        assertTrue(subject.grantsAction())

        subject.invalidate(UiProofInvalidationReason.LAYOUT_CHANGE)
        assertFalse(subject.hasCommittedFrame)
        assertFalse(subject.criticalIdentityReadable)
        assertTrue(subject.isCurrent)

        // The report for the retired pass arrives after the invalidation.
        subject.markCommitted(epoch)
        assertFalse(subject.hasCommittedFrame)
        assertFalse(subject.grantsAction())
    }

    @Test
    fun `a retiring invalidation cannot be re-armed`() {
        val subject = proof()
        val epoch = subject.beginDraw()
        subject.markCommitted(epoch)
        subject.setCriticalIdentityReadable(true)

        subject.invalidate(UiProofInvalidationReason.COVERAGE_CHANGE)
        assertFalse(subject.isCurrent)

        val next = subject.beginDraw()
        subject.markCommitted(next)
        subject.setCriticalIdentityReadable(true)
        assertFalse(subject.isCurrent, "a proof under a modal is not re-armable")
        assertFalse(subject.grantsAction())
    }

    @Test
    fun `readable is never reported true for a retired control`() {
        val subject = proof()
        subject.invalidate(UiProofInvalidationReason.DISMISSED)
        subject.setCriticalIdentityReadable(true)
        assertFalse(subject.criticalIdentityReadable)
    }

    @Test
    fun `a reader on another thread sees the commit the ui thread published`() {
        val subject = proof()
        val epoch = subject.beginDraw()
        val start = CountDownLatch(1)
        val done = CountDownLatch(1)
        val observed = AtomicReference(false)
        val worker = Thread {
            start.await()
            subject.markCommitted(epoch)
            observed.set(subject.hasCommittedFrame)
            done.countDown()
        }
        worker.start()
        start.countDown()
        done.await()
        worker.join()
        assertTrue(observed.get(), "a commit published on the ui thread is visible to the reader thread")
    }

    @Test
    fun `a reader on another thread never sees a retired proof as satisfied`() {
        val subject = proof()
        val epoch = subject.beginDraw()
        subject.markCommitted(epoch)
        subject.setCriticalIdentityReadable(true)
        assertTrue(subject.grantsAction())

        val beforeReader = CountDownLatch(1)
        val afterInvalidate = CountDownLatch(1)
        val satisfied = AtomicReference(true)
        val reader = Thread {
            beforeReader.await()
            satisfied.set(subject.grantsAction() || subject.isCurrent)
            afterInvalidate.countDown()
        }
        reader.start()
        beforeReader.countDown()
        afterInvalidate.await()
        reader.join()
        assertTrue(satisfied.get(), "the reader ran before the invalidation and saw the live proof")

        // Now retire first, then let the reader run: it must see the retired state.
        val readerStart = CountDownLatch(1)
        val readerDone = CountDownLatch(1)
        val after = AtomicReference(true)
        val secondReader = Thread {
            readerStart.await()
            after.set(subject.grantsAction() || subject.isCurrent || subject.hasCommittedFrame)
            readerDone.countDown()
        }
        secondReader.start()
        subject.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
        readerStart.countDown()
        readerDone.await()
        secondReader.join()
        assertFalse(after.get(), "invalidate happens first, so a later reader cannot see the old standing")
    }

    @Test
    fun `epoch increases across invalidation so an in-flight report is distinguishable`() {
        val subject = proof()
        val before = subject.beginDraw()
        subject.invalidate(UiProofInvalidationReason.SEMANTIC_RECOMPOSE)
        val after = subject.beginDraw()
        assertTrue(after > before)
        subject.markCommitted(before)
        assertEquals(after, subject.epoch)
        assertFalse(subject.hasCommittedFrame)
    }

    @Test
    fun `a proof only grants the target it was minted for, from any thread`() {
        val subject = proof(UiProofScreen.SESSION_CLOSE)
        val epoch = subject.beginDraw()
        subject.markCommitted(epoch)
        subject.setCriticalIdentityReadable(true)

        val other = AtomicReference(false)
        val wrong = AtomicReference(false)
        val start = CountDownLatch(1)
        val done = CountDownLatch(1)
        val worker = Thread {
            start.await()
            other.set(subject.grantsFor(ClientUiFixtures.token(UiProofScreen.HOST_REMOVE)))
            wrong.set(subject.grantsFor(ClientUiFixtures.token(UiProofScreen.SESSION_CLOSE, rowId = "other-row")))
            done.countDown()
        }
        worker.start()
        start.countDown()
        done.await()
        worker.join()
        assertFalse(other.get())
        assertFalse(wrong.get())
        assertTrue(subject.grantsFor(subject.target))
    }

    @Test
    fun `a grant cannot combine committed and readable from different epochs`() {
        // The controller consults a proof from its own thread while the UI thread
        // invalidates and re-arms. Each property read is atomic, so a naive compound
        // check can take the committed flag from an epoch that was never readable and
        // the readable flag from a newer epoch that was never committed — and authorise
        // something no single generation ever qualified for.
        val subject = proof()
        subject.markCommitted(subject.beginDraw())
        val committedRead = CountDownLatch(1)
        val continueRead = CountDownLatch(1)
        val result = AtomicReference(true)
        val intercepted = object : UiActionProof by subject {
            override val hasCommittedFrame: Boolean
                get() {
                    val captured = subject.hasCommittedFrame
                    committedRead.countDown()
                    check(continueRead.await(5, TimeUnit.SECONDS))
                    return captured
                }
        }
        val reader = Thread { result.set(intercepted.grantsAction()) }
        reader.start()
        try {
            assertTrue(committedRead.await(5, TimeUnit.SECONDS))
            // The UI thread retires the committed epoch and opens a fresh, readable one.
            subject.invalidate(UiProofInvalidationReason.LAYOUT_CHANGE)
            subject.beginDraw()
            subject.setCriticalIdentityReadable(true)
            assertFalse(subject.hasCommittedFrame)
        } finally {
            continueRead.countDown()
            reader.join(5_000L)
        }
        assertFalse(reader.isAlive)
        assertFalse(result.get(), "no single epoch was both committed and readable")
    }

    @Test
    fun `a grant still succeeds while the epoch stands still`() {
        val subject = proof()
        val epoch = subject.beginDraw()
        subject.markCommitted(epoch)
        subject.setCriticalIdentityReadable(true)
        assertTrue(subject.grantsAction())
        assertTrue(subject.grantsFor(subject.target))
    }

    @Test
    fun `a lifecycle pause withdraws standing and a stale delivery cannot restore it`() {
        // A paused window can keep window focus, so pause is its own invalidation. The
        // state machine floor the shared hub relies on: pause clears the proof, an
        // in-flight commit for the paused frame publishes nothing, and only a fresh
        // commit after resume can satisfy it again.
        val subject = proof()
        val epoch = subject.beginDraw()
        subject.markCommitted(epoch)
        subject.setCriticalIdentityReadable(true)
        assertTrue(subject.grantsAction())

        val registry = ProofCommitRegistry()
        val token = assertNotNull(registry.beginRegistration(listOf(subject), windowHasFocus = true))

        subject.invalidate(UiProofInvalidationReason.LIFECYCLE_CHANGE)
        assertFalse(subject.hasCommittedFrame)
        assertFalse(subject.criticalIdentityReadable)
        assertFalse(subject.grantsAction())

        assertEquals(0, registry.deliver(token) { p -> true })
        assertFalse(subject.hasCommittedFrame)

        val resumed = subject.beginDraw()
        subject.setCriticalIdentityReadable(true)
        assertFalse(subject.grantsAction(), "resume alone proves nothing")
        assertTrue(subject.markCommitted(resumed))
        assertTrue(subject.grantsAction())
    }
}
