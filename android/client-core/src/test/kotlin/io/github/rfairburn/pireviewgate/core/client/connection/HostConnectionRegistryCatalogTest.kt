package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.CatalogFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.HostAddress
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostCatalog
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.identity.PinRead
import java.lang.management.ManagementFactory
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

@OptIn(ExperimentalCoroutinesApi::class)
class HostConnectionRegistryCatalogTest {
    private fun HostConnectionRegistry.add(host: ConfiguredHost): HostAddResult =
        addHost(host.id, host.label, host.endpoint)

    @Test
    fun `first host save creates no identity pin or connection and preserves preferences even with Auto on`() = runTest {
        for (auto in listOf(false, true)) {
            RegistryHarness().use { harness ->
                if (auto) harness.seedSettings(NetworkSettings(autoReconnect = true))
                val registry = harness.registry(StandardTestDispatcher(testScheduler))
                registry.addListener(harness.listener)
                registry.start()
                val before = registry.snapshot.value
                val identityObservations = harness.identity.observations
                // Deliberately supply a fixture carrying old facts: the command
                // accepts only its three association values, never those facts.
                val host = RegistryFixtures.host(1, previouslyConnected = true, suppressed = true)
                try {
                    assertEquals(HostAddResult.Saved, registry.add(host))
                    advanceUntilIdle()
                    val saved = harness.savedSettings()!!
                    assertEquals(NetworkSettings(autoReconnect = auto, hosts = HostCatalog.of(listOf(
                        host.copy(previouslyConnected = false, reconnectSuppressed = false),
                    ))), saved)
                    val after = registry.snapshot.value
                    val added = after.hosts.single()
                    assertEquals(host.id, added.hostId)
                    assertEquals(host.label.value, added.label)
                    assertEquals(host.endpoint, added.endpoint)
                    assertEquals(HostConnectionPhase.NEVER, added.phase)
                    assertFalse(added.previouslyConnected)
                    assertFalse(added.reconnectSuppressed)
                    assertFalse(added.autoEligible)
                    assertNull(added.peerFingerprint)
                    assertEquals(before.settingsGeneration + 1, after.settingsGeneration)
                    assertEquals(before.identity, after.identity)
                    assertEquals(identityObservations, harness.identity.observations)
                    assertEquals(0, harness.identity.generations)
                    assertEquals(1, harness.settings.writes)
                    assertEquals(PinRead.NoPin, harness.readPin(host.id, host.endpoint))
                    assertTrue(harness.pins.recorded.isEmpty())
                    assertTrue(harness.pins.clears.isEmpty())
                    assertTrue(harness.transports.isEmpty())
                    assertTrue(harness.listener.available.isEmpty())
                    assertTrue(harness.listener.content.isEmpty())
                    assertTrue(harness.listener.lost.isEmpty())
                    assertTrue(after.pendingConsents.isEmpty())
                    assertEquals(0, harness.prompt.asked)
                } finally {
                    registry.close()
                }
            }
        }
    }

    @Test
    fun `append preserves existing live channel history suppression preferences and pin slots`() = runTest {
        RegistryHarness().use { harness ->
            val first = RegistryFixtures.host(1)
            val second = RegistryFixtures.host(2, previouslyConnected = true, suppressed = true)
            harness.seedSettings(RegistryFixtures.settings(first, second).withViewerRemoteInputEnabled(false))
            harness.seedPins(listOf(first, second))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            try {
                registry.connect(first.id)
                advanceUntilIdle()
                val before = registry.snapshot.value
                val savedBefore = harness.savedSettings()!!
                val pinsBefore = listOf(first, second).map { harness.readPin(it.id, it.endpoint) }
                val recordsBefore = harness.pins.recorded.toList()
                val identityObservations = harness.identity.observations
                val transport = harness.transports.single()
                val channel = transport.channels.single()
                // Sharing an endpoint is allowed; the new id stays a separate association.
                val added = RegistryFixtures.host(3).copy(endpoint = first.endpoint)
                assertEquals(HostAddResult.Saved, registry.add(added))
                advanceUntilIdle()

                assertEquals(before.hosts, registry.snapshot.value.hosts.take(2))
                assertEquals(listOf(first.id, second.id, added.id), registry.snapshot.value.hosts.map { it.hostId })
                assertEquals(savedBefore.hosts.hosts + added, harness.savedCatalog().hosts)
                assertFalse(registry.snapshot.value.autoReconnectEnabled)
                assertFalse(registry.snapshot.value.viewerRemoteInputEnabled)
                assertEquals(pinsBefore, listOf(first, second).map { harness.readPin(it.id, it.endpoint) })
                assertEquals(PinRead.NoPin, harness.readPin(added.id, added.endpoint))
                assertEquals(recordsBefore, harness.pins.recorded)
                assertTrue(harness.pins.clears.isEmpty())
                assertEquals(identityObservations, harness.identity.observations)
                assertEquals(1, harness.transports.size)
                assertFalse(transport.disposed)
                assertFalse(channel.isClosed)
                channel.send(byteArrayOf(1))
                assertEquals(1, channel.sends.size)
                assertEquals(1, harness.listener.available.size)
                assertTrue(harness.listener.lost.isEmpty())
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `held addition and preference publication preserve both changes in either order`() = runTest {
        for (addFirst in listOf(true, false)) {
            RegistryHarness().use { harness ->
                val first = RegistryFixtures.host(1, previouslyConnected = true, suppressed = true)
                val added = RegistryFixtures.host(2)
                harness.seedSettings(RegistryFixtures.settings(first))
                val registry = harness.registry(StandardTestDispatcher(testScheduler))
                registry.start()
                try {
                    val add = { assertEquals(HostAddResult.Saved, registry.add(added)) }
                    val preference = {
                        assertEquals(HostCommandResult.Accepted, registry.setViewerRemoteInputEnabled(false))
                    }
                    racePublications(harness, if (addFirst) add else preference, if (addFirst) preference else add) {
                        assertEquals(listOf(first.id), registry.snapshot.value.hosts.map { it.hostId })
                        assertEquals(listOf(first), harness.savedCatalog().hosts)
                    }
                    assertEquals(listOf(first, added), harness.savedCatalog().hosts)
                    assertFalse(harness.savedSettings()!!.viewerRemoteInputEnabled)
                    assertFalse(registry.snapshot.value.viewerRemoteInputEnabled)
                    assertEquals(listOf(first.id, added.id), registry.snapshot.value.hosts.map { it.hostId })
                    assertTrue(registry.snapshot.value.hosts.first().previouslyConnected)
                    assertTrue(registry.snapshot.value.hosts.first().reconnectSuppressed)
                    assertEquals(2, harness.settings.writes)
                    assertFalse(harness.settings.overlapped)
                } finally {
                    registry.close()
                }
            }
        }
    }

    @Test
    fun `held addition and authenticated connection history preserve both changes in either order`() = runTest {
        for (addFirst in listOf(true, false)) {
            RegistryHarness().use { harness ->
                val first = RegistryFixtures.host(1)
                val added = RegistryFixtures.host(2)
                harness.seedSettings(RegistryFixtures.settings(first))
                harness.seedPins(listOf(first))
                val registry = harness.registry(StandardTestDispatcher(testScheduler))
                registry.addListener(harness.listener)
                registry.start()
                try {
                    val add = { assertEquals(HostAddResult.Saved, registry.add(added)) }
                    val history = {
                        assertEquals(HostCommandResult.Accepted, registry.connect(first.id))
                        // Only this command thread drives the scheduler. The real
                        // authenticated open then blocks in markPreviouslyConnected.
                        testScheduler.runCurrent()
                    }
                    racePublications(harness, if (addFirst) add else history, if (addFirst) history else add) {
                        val current = registry.snapshot.value.hosts.single()
                        assertEquals(first.id, current.hostId)
                        assertEquals(HostConnectionPhase.CONNECTED, current.phase)
                        assertEquals(listOf(first), harness.savedCatalog().hosts)
                    }
                    advanceUntilIdle()
                    assertEquals(listOf(first.copy(previouslyConnected = true), added), harness.savedCatalog().hosts)
                    assertEquals(listOf(first.id, added.id), registry.snapshot.value.hosts.map { it.hostId })
                    assertTrue(registry.snapshot.value.hosts.first().previouslyConnected)
                    assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.hosts.first().phase)
                    val transport = harness.transports.single()
                    assertFalse(transport.disposed)
                    transport.channels.single().send(byteArrayOf(1))
                    assertEquals(1, harness.listener.available.size)
                    assertTrue(harness.listener.lost.isEmpty())
                    assertEquals(2, harness.settings.writes)
                    assertFalse(harness.settings.overlapped)
                } finally {
                    registry.close()
                }
            }
        }
    }

    @Test
    fun `Disconnect arriving during held addition stays suppressed in memory and on disk`() = runTest {
        RegistryHarness().use { harness ->
            val first = RegistryFixtures.host(1, previouslyConnected = true)
            val added = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(first))
            harness.seedPins(listOf(first))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                registry.connect(first.id)
                advanceUntilIdle()
                racePublications(harness,
                    { assertEquals(HostAddResult.Saved, registry.add(added)) },
                    { assertEquals(HostCommandResult.Accepted, registry.disconnect(first.id)) },
                ) {
                    val current = registry.snapshot.value.hosts.single()
                    assertTrue(current.reconnectSuppressed)
                    assertEquals(HostConnectionPhase.DISCONNECTED, current.phase)
                    assertTrue(harness.transports.single().disposed)
                }
                advanceUntilIdle()
                assertEquals(listOf(first.copy(reconnectSuppressed = true), added), harness.savedCatalog().hosts)
                assertTrue(registry.snapshot.value.hosts.first().reconnectSuppressed)
                assertTrue(registry.snapshot.value.hosts.first().previouslyConnected)
                assertFalse(registry.snapshot.value.hosts.last().reconnectSuppressed)
                assertEquals(2, harness.settings.writes)
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `failed addition publishes failure but never a phantom host or durable claim`() = runTest {
        RegistryHarness().use { harness ->
            val first = RegistryFixtures.host(1, previouslyConnected = true, suppressed = true)
            val added = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(first))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                val before = registry.snapshot.value
                val savedBefore = harness.savedSettings()
                harness.settings.refuseWrites = StorageFailureReason.WRITE_FAILED
                assertEquals(HostAddResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE), registry.add(added))
                val after = registry.snapshot.value
                assertEquals(before.hosts, after.hosts)
                assertEquals(before.settingsGeneration, after.settingsGeneration)
                assertEquals(savedBefore, harness.savedSettings())
                assertEquals(RegistryNoticeReason.SETTINGS_WRITE_FAILED, after.notice?.reason)
                assertEquals(StorageFailureReason.WRITE_FAILED, after.storage.settings.reason)
                assertFalse(after.storage.settings.available)
                assertFalse(after.viewerRemoteInputEnabled)
                assertEquals(HostAddResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE), registry.add(added))
                assertEquals(1, harness.settings.writes, "unavailable settings must refuse without another write")
                harness.settings.refuseWrites = null
                // A later internal writer must not accidentally persist the failed addition.
                registry.setViewerRemoteInputEnabled(false)
                assertEquals(listOf(first), harness.savedCatalog().hosts)
                assertEquals(before.hosts, registry.snapshot.value.hosts)
                assertTrue(harness.transports.isEmpty())
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `catalog refuses duplicate and sixty fifth entry without writes or snapshot changes`() = runTest {
        RegistryHarness().use { harness ->
            val hosts = (1 until HostCatalog.MAX_HOSTS).map { RegistryFixtures.host(it) }
            harness.seedSettings(RegistryFixtures.settings(*hosts.toTypedArray()))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                val before = registry.snapshot.value
                assertEquals(HostAddResult.CatalogRefused(CatalogFailureReason.DUPLICATE_HOST_ID),
                    registry.add(hosts.first().copy(endpoint = RegistryFixtures.endpoint(100))))
                assertEquals(before, registry.snapshot.value)
                assertEquals(0, harness.settings.writes)
                val last = RegistryFixtures.host(HostCatalog.MAX_HOSTS)
                assertEquals(HostAddResult.Saved, registry.add(last))
                val full = registry.snapshot.value
                assertEquals(HostAddResult.CatalogRefused(CatalogFailureReason.TOO_MANY_HOSTS),
                    registry.add(RegistryFixtures.host(HostCatalog.MAX_HOSTS + 1)))
                assertEquals(full, registry.snapshot.value)
                assertEquals(1, harness.settings.writes)
                assertEquals(hosts + last, harness.savedCatalog().hosts)
                assertEquals((hosts + last).map { it.id }, full.hosts.map { it.hostId })
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `unstarted closed and unreadable registries refuse without writing`() = runTest {
        RegistryHarness().use { harness ->
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            val host = RegistryFixtures.host(1)
            assertEquals(HostAddResult.Refused(HostCommandRefusal.NOT_RUNNING), registry.add(host))
            harness.settings.refuseReads = StorageFailureReason.UNREADABLE
            registry.start()
            assertEquals(HostAddResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE), registry.add(host))
            registry.close()
            assertEquals(HostAddResult.Refused(HostCommandRefusal.NOT_RUNNING), registry.add(host))
            assertTrue(registry.snapshot.value.hosts.isEmpty())
            assertEquals(0, harness.settings.writes)
            assertNull(harness.savedSettings())
        }
    }

    @Test
    fun `address save and held preference or history writes cannot lose either fact in either order`() = runTest {
        for (history in listOf(false, true)) for (addressFirst in listOf(false, true)) {
            RegistryHarness().use { harness ->
                val one = RegistryFixtures.host(1)
                val two = RegistryFixtures.host(2, previouslyConnected = true, suppressed = true)
                val endpoint = Endpoint("10.0.0.45", one.endpoint.port)
                harness.seedSettings(RegistryFixtures.settings(one, two))
                harness.seedPins(listOf(one))
                val registry = harness.registry(StandardTestDispatcher(testScheduler))
                registry.start()
                try {
                    val address = {
                        assertEquals(HostAddressUpdateResult.Saved(endpoint),
                            registry.updateHostAddress(one.id, one.endpoint, HostAddress.parse(endpoint.host)))
                    }
                    val competitor = {
                        if (history) {
                            assertEquals(HostCommandResult.Accepted, registry.connect(one.id))
                            testScheduler.runCurrent()
                        } else {
                            assertEquals(HostCommandResult.Accepted, registry.setViewerRemoteInputEnabled(false))
                        }
                    }
                    racePublications(harness, if (addressFirst) address else competitor,
                        if (addressFirst) competitor else address) {
                        assertEquals(one.endpoint, registry.snapshot.value.hosts.first().endpoint)
                        assertEquals(listOf(one, two), harness.savedCatalog().hosts)
                    }
                    advanceUntilIdle()
                    assertEquals(listOf(one.withEndpoint(endpoint).copy(previouslyConnected = history), two),
                        harness.savedCatalog().hosts)
                    assertEquals(history, harness.savedSettings()!!.viewerRemoteInputEnabled)
                    assertEquals(endpoint, registry.snapshot.value.hosts.first().endpoint)
                    assertEquals(history, registry.snapshot.value.hosts.first().previouslyConnected)
                    assertEquals(2, harness.settings.writes)
                    assertFalse(harness.settings.overlapped)
                    assertEquals(PinRead.Remembered(harness.storedPeerKey(one.endpoint)), harness.readPin(one.id, endpoint))
                    assertTrue(harness.pins.clears.isEmpty())
                } finally {
                    registry.close()
                }
            }
        }
    }

    @Test
    fun `Disconnect during a held address save preserves suppression and history without changing other hosts`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            val two = RegistryFixtures.host(2)
            val endpoint = Endpoint("10.0.0.45", one.endpoint.port)
            harness.seedSettings(RegistryFixtures.settings(one, two))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                racePublications(harness,
                    { assertEquals(HostAddressUpdateResult.Saved(endpoint),
                        registry.updateHostAddress(one.id, one.endpoint, HostAddress.parse(endpoint.host))) },
                    { assertEquals(HostCommandResult.Accepted, registry.disconnect(one.id)) },
                ) {
                    assertEquals(one.endpoint, registry.snapshot.value.hosts.first().endpoint)
                    assertTrue(registry.snapshot.value.hosts.first().reconnectSuppressed)
                }
                assertEquals(listOf(one.withEndpoint(endpoint).copy(reconnectSuppressed = true), two),
                    harness.savedCatalog().hosts)
                assertTrue(registry.snapshot.value.hosts.first().reconnectSuppressed)
                assertTrue(harness.transports.isEmpty())
                assertEquals(2, harness.settings.writes)
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `competing address forms must still match the exact old endpoint when their transaction begins`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val endpoint = Endpoint("10.0.0.45", one.endpoint.port)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                racePublications(harness,
                    { assertEquals(HostAddressUpdateResult.Saved(endpoint),
                        registry.updateHostAddress(one.id, one.endpoint, HostAddress.parse(endpoint.host))) },
                    { assertEquals(HostAddressUpdateResult.StaleTarget,
                        registry.updateHostAddress(one.id, one.endpoint, HostAddress.parse("10.0.0.46"))) },
                ) {
                    assertEquals(one.endpoint, registry.snapshot.value.hosts.single().endpoint)
                }
                assertEquals(one.withEndpoint(endpoint), harness.savedCatalog().hosts.single())
                assertEquals(1, harness.settings.writes)
            } finally {
                registry.close()
            }
        }
    }

    /** Hold one write, then prove its competitor is waiting on that writer's monitor. */
    private fun racePublications(
        harness: RegistryHarness,
        firstCommand: () -> Unit,
        secondCommand: () -> Unit,
        whileHeld: () -> Unit,
    ) {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val firstWrite = AtomicBoolean(true)
        harness.settings.onWrite = {
            if (firstWrite.compareAndSet(true, false)) {
                entered.countDown()
                assertTrue(release.await(10, TimeUnit.SECONDS), "held publication never resumed")
            }
        }
        val first = CommandThread(firstCommand)
        var second: CommandThread? = null
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS), "first command never reached storage")
            second = CommandThread(secondCommand)
            awaitBlockedBy(second, first)
            assertFalse(harness.settings.overlapped)
            whileHeld()
        } finally {
            release.countDown()
            try {
                first.await()
            } finally {
                try {
                    second?.await()
                } finally {
                    harness.settings.onWrite = null
                }
            }
        }
    }

    private class CommandThread(command: () -> Unit) {
        val completion = CompletableFuture<Unit>()
        val thread = Thread {
            try {
                command()
                completion.complete(Unit)
            } catch (failure: Throwable) {
                completion.completeExceptionally(failure)
            }
        }.apply { isDaemon = true; start() }

        fun await() { completion.get(10, TimeUnit.SECONDS) }
    }

    /**
     * Observe actual monitor contention, not a scheduling delay. The first store
     * hook owns a bounded latch; this proves the second operation reached the
     * transaction while that write was held. No production accessor or sleeps.
     */
    private fun awaitBlockedBy(waiter: CommandThread, owner: CommandThread) {
        val threads = ManagementFactory.getThreadMXBean()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            val info = threads.getThreadInfo(waiter.thread.id)
            if (info?.threadState == Thread.State.BLOCKED && info.lockOwnerId == owner.thread.id) return
            if (waiter.completion.isDone) {
                waiter.await()
                fail("competing publication did not wait for the held settings transaction")
            }
            Thread.yield()
        }
        fail("competing publication never contended with the held settings transaction")
    }
}
