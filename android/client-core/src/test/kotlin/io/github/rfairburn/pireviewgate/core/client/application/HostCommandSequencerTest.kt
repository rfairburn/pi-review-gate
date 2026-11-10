package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.connection.HostCommandResult
import io.github.rfairburn.pireviewgate.core.client.connection.HostConnectionPhase
import io.github.rfairburn.pireviewgate.core.client.connection.RegistryFixtures
import io.github.rfairburn.pireviewgate.core.client.connection.RegistryHarness
import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class HostCommandSequencerTest {
    private val host = HostId.parse("command-host")

    @Test fun disconnectFollowsConnectAlreadyBetweenValidationAndRegistryDispatch() = runTest {
        RegistryHarness().use { harness ->
            val configured = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(configured))
            harness.seedPins(listOf(configured))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            try {
                registry.start()
                val queue = HostCommandSequencer()
                val publication = AtomicBoolean(true)
                val validated = CompletableDeferred<Unit>()
                val release = CompletableDeferred<Unit>()
                val calls = mutableListOf<String>()
                // Reserve on the gesture thread, before scheduling either IO task.
                val connect = queue.enqueue(configured.id)
                val connecting = async {
                    connect.dispatch(RosterUiProof { publication.get() }) {
                        validated.complete(Unit)
                        release.await() // IO preemption AFTER validation, BEFORE registry.connect.
                        calls += "connect"
                        registry.connect(configured.id)
                    }
                }
                runCurrent()
                assertTrue(validated.isCompleted)
                publication.set(false) // Synchronous newer Disconnect gesture cancels Connect.
                val disconnect = queue.enqueue(configured.id)
                val disconnecting = async {
                    disconnect.dispatch(RosterUiProof {
                        registry.snapshot.value.hosts.any { it.hostId == configured.id && it.endpoint == configured.endpoint }
                    }) {
                        calls += "disconnect"
                        registry.disconnect(configured.id)
                    }
                }
                runCurrent()
                assertFalse(disconnecting.isCompleted, "Disconnect cannot finish before an entered Connect")
                release.complete(Unit)
                runCurrent()
                assertEquals(HostCommandSequencer.Dispatch.Executed(HostCommandResult.Accepted), connecting.await())
                assertEquals(HostCommandSequencer.Dispatch.Executed(HostCommandResult.Accepted), disconnecting.await())
                assertEquals(listOf("connect", "disconnect"), calls)
                val final = registry.snapshot.value.hosts.single()
                assertEquals(HostConnectionPhase.DISCONNECTED, final.phase)
                assertTrue(final.reconnectSuppressed)
                assertTrue(harness.savedSettings()!!.findHost(configured.id)!!.reconnectSuppressed)
            } finally { registry.close() }
        }
    }

    @Test fun waitingConnectRechecksPublicationAfterAcquiringBoundary() = runTest {
        val queue = HostCommandSequencer()
        val publication = AtomicBoolean(true)
        val release = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        val first = queue.enqueue(host)
        val connect = queue.enqueue(host)
        val blocker = async { first.dispatch(RosterUiProof { publication.get() }) { entered.complete(Unit); release.await() } }
        var connects = 0
        val waiting = async { connect.dispatch(RosterUiProof { publication.get() }) { connects++ } }
        runCurrent()
        assertTrue(entered.isCompleted)
        publication.set(false)
        release.complete(Unit)
        runCurrent()
        blocker.await()
        assertEquals(HostCommandSequencer.Dispatch.Retired, waiting.await())
        assertEquals(0, connects)
    }

    @Test fun delayedDisconnectCannotOvertakeANewerConnect() = runTest {
        RegistryHarness().use { harness ->
            val configured = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(configured))
            harness.seedPins(listOf(configured))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            try {
                registry.start()
                val queue = HostCommandSequencer()
                val disconnect = queue.enqueue(configured.id)
                val connect = queue.enqueue(configured.id)
                val present = RosterUiProof { registry.snapshot.value.hosts.any { it.hostId == configured.id } }
                val calls = mutableListOf<String>()
                // Deliberately schedule IO in the opposite order to gesture intake.
                val newer = async { connect.dispatch(present) { calls += "connect"; registry.connect(configured.id) } }
                runCurrent()
                assertFalse(newer.isCompleted)
                val older = async { disconnect.dispatch(present) { calls += "disconnect"; registry.disconnect(configured.id) } }
                runCurrent()
                older.await(); newer.await()
                assertEquals(listOf("disconnect", "connect"), calls)
                assertFalse(registry.snapshot.value.hosts.single().reconnectSuppressed)
                assertFalse(harness.savedSettings()!!.findHost(configured.id)!!.reconnectSuppressed)
            } finally { registry.close() }
        }
    }

    @Test fun removalUsesTheSameBoundaryAndKeepsItsOwnDynamicProof() = runTest {
        val queue = HostCommandSequencer()
        val committedForm = AtomicBoolean(true)
        val release = CompletableDeferred<Unit>()
        val connect = queue.enqueue(host)
        val remove = queue.enqueue(host)
        val calls = mutableListOf<String>()
        val predecessor = async { connect.dispatch(RosterUiProof { committedForm.get() }) { release.await(); calls += "connect" } }
        val removal = async { remove.dispatch(RosterUiProof { committedForm.get() }) { calls += "remove" } }
        runCurrent()
        assertFalse(removal.isCompleted)
        committedForm.set(false) // Dismiss/background retires the REAL confirmation.
        release.complete(Unit)
        runCurrent()
        predecessor.await()
        assertEquals(HostCommandSequencer.Dispatch.Retired, removal.await())
        assertEquals(listOf("connect"), calls)
    }

    @Test fun anotherHostDoesNotWaitForThisHostsCommand() = runTest {
        val queue = HostCommandSequencer()
        val release = CompletableDeferred<Unit>()
        val allowed = AtomicBoolean(true)
        val first = queue.enqueue(host)
        val other = queue.enqueue(HostId.parse("independent-host"))
        val blocked = async { first.dispatch(RosterUiProof { allowed.get() }) { release.await() } }
        val independent = async { other.dispatch(RosterUiProof { allowed.get() }) { "other completed" } }
        runCurrent()
        assertTrue(independent.isCompleted)
        assertEquals(HostCommandSequencer.Dispatch.Executed("other completed"), independent.await())
        release.complete(Unit)
        blocked.await()
    }

    @Test fun cancelledWaiterDoesNotOpenAGapForItsSuccessor() = runTest {
        val queue = HostCommandSequencer()
        val release = CompletableDeferred<Unit>()
        val allowed = AtomicBoolean(true)
        val a = queue.enqueue(host); val b = queue.enqueue(host); val c = queue.enqueue(host)
        val first = async { a.dispatch(RosterUiProof { allowed.get() }) { release.await() } }
        val cancelled = async { b.dispatch(RosterUiProof { allowed.get() }) { error("cancelled command dispatched") } }
        val last = async { c.dispatch(RosterUiProof { allowed.get() }) { "last" } }
        runCurrent()
        cancelled.cancel()
        runCurrent()
        assertFalse(last.isCompleted)
        release.complete(Unit)
        runCurrent()
        first.await(); cancelled.join()
        assertEquals(HostCommandSequencer.Dispatch.Executed("last"), last.await())
    }
}
