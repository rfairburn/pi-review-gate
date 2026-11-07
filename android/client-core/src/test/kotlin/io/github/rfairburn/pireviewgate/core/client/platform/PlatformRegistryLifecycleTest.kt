package io.github.rfairburn.pireviewgate.core.client.platform

import io.github.rfairburn.pireviewgate.core.client.connection.HostConnectionPhase
import io.github.rfairburn.pireviewgate.core.client.connection.RegistryFixtures
import io.github.rfairburn.pireviewgate.core.client.connection.RegistryHarness
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Policy with the real concurrent registry; only the existing transport fixture is synthetic. */
@OptIn(ExperimentalCoroutinesApi::class)
class PlatformRegistryLifecycleTest {
    @Test
    fun `saved Auto starts once at first real foreground without pairing or expanding resume candidates`() = runTest {
        RegistryHarness().use { harness ->
            val active = RegistryFixtures.host(1, previouslyConnected = true)
            val suppressed = RegistryFixtures.host(2, previouslyConnected = true, suppressed = true)
            val unknown = RegistryFixtures.host(3, previouslyConnected = true)
            val neverConnected = RegistryFixtures.host(4)
            val initial = RegistryFixtures.settings(active, suppressed, unknown, neverConnected, autoReconnect = true)
            harness.seedSettings(initial)
            harness.seedPins(listOf(active, suppressed, neverConnected))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.setForeground(false)
            registry.start()
            val policy = ClientForegroundBinding { registry.setForeground(it) }
            val callbacks = object : ClientLifecycleCallbacks {
                override fun invalidateTerminalInput() = Unit
                override fun invalidateWindowProofs() = Unit
                override fun cancelPendingUserIntent() = Unit
            }
            var id = policy.bind(callbacks)
            try {
                policy.onStart(id) // Neither interactive nor unlocked yet.
                advanceUntilIdle()
                assertTrue(harness.transports.isEmpty())
                assertFalse(registry.snapshot.value.foreground)

                policy.deviceVisibility(ClientDeviceVisibility(true, true))
                testScheduler.runCurrent() // Startup is immediate, not the first backoff wait.
                val opened = harness.transports.single()
                assertEquals(active.endpoint.host, opened.endpoint?.host)
                assertEquals(listOf(PeerAppLane.APP), opened.openedLanes)
                assertEquals(harness.peerKey(active.endpoint), opened.lastReadTrust)
                assertEquals(active.id, harness.listener.available.single().hostId)
                assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.hosts.first { it.hostId == active.id }.phase)
                assertEquals(0, opened.pairCalls)
                assertFalse(opened.lastApproverUsed)
                assertTrue(registry.snapshot.value.pendingConsents.isEmpty())
                assertEquals(0, harness.prompt.asked)
                assertEquals(0, harness.identity.generations)
                assertEquals(0, harness.settings.writes)

                // A newly eligible host is not another startup opportunity.
                val later = RegistryFixtures.host(5, previouslyConnected = true)
                harness.seedPins(listOf(later))
                harness.seedSettings(RegistryFixtures.settings(active, suppressed, unknown, neverConnected, later, autoReconnect = true))
                registry.reload()
                registry.enterForeground()
                policy.onResume(id)
                policy.onWindowFocusChanged(id, true)
                policy.onWindowFocusChanged(id, false)
                policy.onWindowFocusChanged(id, true)
                policy.onStop(id, true)
                policy.unbind(id, true)
                id = policy.bind(callbacks)
                policy.onStart(id)
                policy.onResume(id)
                policy.onWindowFocusChanged(id, true)
                advanceUntilIdle()
                assertEquals(1, harness.transports.size)
                assertFalse(opened.disposed)

                policy.onStop(id, false)
                advanceUntilIdle()
                assertTrue(opened.disposed)
                policy.onStart(id)
                advanceUntilIdle()
                assertEquals(listOf(active.endpoint.host, active.endpoint.host), harness.transports.map { it.endpoint?.host })
                assertEquals(2, harness.listener.available.size)
                assertTrue(harness.transports.all { it.pairCalls == 0 && !it.lastApproverUsed })
                assertEquals(0, harness.identity.generations)
            } finally {
                policy.close()
                registry.close()
            }
        }
    }

    @Test
    fun `background delegates epoch invalidation and Auto off restoration to registry with no pairing`() = runTest {
        RegistryHarness().use { harness ->
            val active = RegistryFixtures.host(1, previouslyConnected = true)
            val idle = RegistryFixtures.host(2, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(active, idle, autoReconnect = false))
            harness.seedPins(listOf(active, idle))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.setForeground(false)
            registry.start()
            val policy = ClientForegroundBinding { registry.setForeground(it) }
            val id = policy.bind(object : ClientLifecycleCallbacks {
                override fun invalidateTerminalInput() = Unit
                override fun invalidateWindowProofs() = Unit
                override fun cancelPendingUserIntent() = Unit
            })
            try {
                advanceUntilIdle()
                assertTrue(harness.transports.isEmpty())
                policy.deviceVisibility(ClientDeviceVisibility(true, true))
                policy.onStart(id)
                policy.onResume(id)
                policy.onWindowFocusChanged(id, true)
                registry.connect(active.id)
                advanceUntilIdle()
                assertEquals(1, harness.transports.size)
                val before = registry.snapshot.value.hosts.first { it.hostId == active.id }.generation
                policy.onStop(id, false)
                assertFalse(policy.terminalInputEligible)
                val after = registry.snapshot.value.hosts.first { it.hostId == active.id }.generation
                assertTrue(after > before) // Synchronous epoch retirement, not a queued reducer task.
                assertTrue(harness.transports.single().disposed)
                policy.onStart(id)
                advanceUntilIdle()
                assertEquals(2, harness.transports.size)
                assertEquals(0, harness.transports.last().pairCalls)
                assertFalse(harness.transports.last().lastApproverUsed)
                assertEquals(
                    HostConnectionPhase.CONNECTED,
                    registry.snapshot.value.hosts.first { it.hostId == active.id }.phase,
                )
                assertEquals(
                    HostConnectionPhase.DISCONNECTED,
                    registry.snapshot.value.hosts.first { it.hostId == idle.id }.phase,
                )
                assertFalse(policy.terminalInputEligible) // No input restored with the network.
            } finally {
                policy.close()
                registry.close()
            }
        }
    }
}
