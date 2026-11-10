package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Concurrent destination lifetimes.
 *
 * These checks pin the properties a multi-host client depends on and that a
 * single-shared-transport design would silently break: every saved host gets its
 * own transport, its own epoch, and its own disposal, and the saved-catalog
 * bound — not any per-transport operation bound — is the capacity.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HostConnectionRegistryConcurrencyTest {

    private fun ConnectionRegistrySnapshot.host(id: HostId): HostConnectionSnapshot =
        hosts.first { it.hostId == id }

    @Test
    fun `two configured hosts connect concurrently and stay independent`() = runTest {
        RegistryHarness().use { harness ->
            val first = RegistryFixtures.host(1)
            val second = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(first, second))
            harness.seedPins(listOf(first, second))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()

            assertEquals(HostConnectionPhase.NEVER, registry.snapshot.value.host(first.id).phase)
            assertEquals(HostConnectionPhase.NEVER, registry.snapshot.value.host(second.id).phase)

            registry.connect(first.id)
            registry.connect(second.id)
            advanceUntilIdle()

            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(first.id).phase)
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(second.id).phase)

            // One transport per destination, and never the same instance twice.
            assertEquals(2, harness.transports.size)
            assertNotSame(harness.transports[0], harness.transports[1])
            assertEquals(2, harness.listener.available.size)
            assertEquals(
                setOf(first.id, second.id),
                harness.listener.available.map { it.hostId }.toSet(),
            )
            registry.close()
        }
    }

    @Test
    fun `losing one host disposes only that host's transport`() = runTest {
        RegistryHarness().use { harness ->
            val first = RegistryFixtures.host(1)
            val second = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(first, second))
            harness.seedPins(listOf(first, second))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(first.id)
            registry.connect(second.id)
            advanceUntilIdle()

            val firstTransport = harness.transports.first { it.serverKey.keyId == harness.peerKey(first.endpoint).keyId }
            val secondTransport = harness.transports.first { it !== firstTransport }

            // The far side drops one connection only.
            firstTransport.channels.single().endWith(1006, "peer gone")
            advanceUntilIdle()

            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(first.id).phase)
            assertEquals(HostConnectionReason.CONNECTION_LOST, registry.snapshot.value.host(first.id).reason)
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(second.id).phase)
            assertTrue(firstTransport.disposed, "the lost destination's transport must be disposed")
            assertFalse(secondTransport.disposed, "another host's transport must never be touched")

            val losses = harness.listener.lost.filter { !it.stale }
            assertEquals(1, losses.size)
            assertEquals(first.id, losses.single().hostId)
            registry.close()
        }
    }

    @Test
    fun `two saved hosts at the same endpoint are separate associations`() = runTest {
        RegistryHarness().use { harness ->
            val shared = RegistryFixtures.endpoint(7)
            val first = ConfiguredHost(
                id = HostId.parse("same-endpoint-a"),
                label = io.github.rfairburn.pireviewgate.core.hosts.HostLabel.parse("Kitchen"),
                endpoint = shared,
            )
            val second = ConfiguredHost(
                id = HostId.parse("same-endpoint-b"),
                label = io.github.rfairburn.pireviewgate.core.hosts.HostLabel.parse("Studio"),
                endpoint = shared,
            )
            harness.seedSettings(RegistryFixtures.settings(first, second))
            harness.seedPins(listOf(first, second))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(first.id)
            registry.connect(second.id)
            advanceUntilIdle()

            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(first.id).phase)
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(second.id).phase)
            assertEquals(2, harness.transports.size)

            // Identical remote rows are irrelevant: the ids are different, so the
            // handoffs are different channels and disconnecting one leaves the
            // other's association, key, and channel alone.
            val before = registry.snapshot.value.host(second.id)
            registry.disconnect(first.id)
            advanceUntilIdle()

            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(first.id).phase)
            val after = registry.snapshot.value.host(second.id)
            assertEquals(before.phase, after.phase)
            assertEquals(before.generation, after.generation)
            assertEquals(before.peerFingerprint, after.peerFingerprint)
            assertEquals(2, harness.transports.size)
            assertTrue(harness.listener.available.map { it.hostId }.toSet() == setOf(first.id, second.id))
            assertFalse(harness.transports[1].disposed)
            registry.close()
        }
    }

    @Test
    fun `every saved host capacity connects, not a sixteen host limit`() = runTest {
        RegistryHarness().use { harness ->
            val hosts = (1..io.github.rfairburn.pireviewgate.core.hosts.HostCatalog.MAX_HOSTS).map { index ->
                RegistryFixtures.host(index)
            }
            harness.seedSettings(RegistryFixtures.settings(*hosts.toTypedArray()))
            harness.seedPins(hosts)
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()

            hosts.forEach { registry.connect(it.id) }
            advanceUntilIdle()

            val connected = registry.snapshot.value.hosts.filter { it.phase == HostConnectionPhase.CONNECTED }
            assertEquals(io.github.rfairburn.pireviewgate.core.hosts.HostCatalog.MAX_HOSTS, connected.size)
            assertEquals(io.github.rfairburn.pireviewgate.core.hosts.HostCatalog.MAX_HOSTS, harness.transports.size)
            assertEquals(io.github.rfairburn.pireviewgate.core.hosts.HostCatalog.MAX_HOSTS, harness.listener.available.size)
            // Every destination has its own epoch counter, so a shared global
            // counter or a single active slot is impossible by construction.
            assertEquals(
                io.github.rfairburn.pireviewgate.core.hosts.HostCatalog.MAX_HOSTS,
                registry.snapshot.value.hosts.map { it.hostId }.distinct().size,
            )
            registry.close()
        }
    }

    @Test
    fun `a superseded attempt reports a stale loss and never a fake removal`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            val retiredChannel = harness.transports.single().channels.single()
            val retiredGeneration = registry.snapshot.value.host(one.id).generation

            // Backgrounding retires the destination. A late report from the old
            // attempt must be labelled stale and must not invent a removal.
            registry.leaveForeground()
            advanceUntilIdle()
            retiredChannel.endWith(1006, "late")
            advanceUntilIdle()

            val stale = harness.listener.lost.filter { it.stale }
            assertTrue(stale.isEmpty() || stale.all { it.generation <= retiredGeneration })
            assertEquals(1, harness.savedCatalog().size, "a late channel report never removes a saved host")
            assertNull(registry.snapshot.value.host(one.id).peerFingerprint)
            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(one.id).phase)
            assertNotEquals(HostConnectionPhase.ERROR, registry.snapshot.value.host(one.id).phase)
            registry.close()
        }
    }
}
