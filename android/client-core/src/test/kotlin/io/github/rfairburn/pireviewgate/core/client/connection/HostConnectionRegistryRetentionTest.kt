package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * What the registry holds onto, and what it hands to a callback.
 *
 * A content lane is opened and closed many times across one long foreground
 * session, so a closed lane cannot stay owned until the whole host retires — it
 * still carries its connection object and any inbound buffers nobody is draining.
 * And a listener list that registration mutates cannot be copied by a delivery
 * thread without the same lock: a torn copy throws mid-handoff, and the failure
 * path then reports a live connection as disconnected and stops watching it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HostConnectionRegistryRetentionTest {

    private fun HostConnectionRegistry.hostOf(id: HostId): HostConnectionSnapshot =
        snapshot.value.hosts.first { it.hostId == id }

    private fun awaitWithin(timeoutMs: Long = 5_000L, predicate: () -> Boolean): Boolean {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (System.nanoTime() < deadline) {
            if (predicate()) return true
            Thread.sleep(2L)
        }
        return predicate()
    }

    /**
     * The content lanes this registry still owns for one host.
     *
     * Retention is invisible from the public surface — retiring a host clears the
     * collection whether or not every lane was already closed — so this invariant
     * can only be asserted on the collection itself. Plain Java reflection,
     * because the registry keeps its runtime private on purpose and kotlin-reflect
     * is not on the test classpath.
     */
    @Suppress("UNCHECKED_CAST")
    private fun ownedContent(registry: HostConnectionRegistry, hostId: HostId): List<PeerByteChannel> {
        val runtimesField = HostConnectionRegistry::class.java.getDeclaredField("runtimes")
        runtimesField.isAccessible = true
        val runtime = (runtimesField.get(registry) as Map<HostId, Any>)[hostId] ?: return emptyList()
        val contentField = runtime.javaClass.getDeclaredField("contentChannels")
        contentField.isAccessible = true
        return (contentField.get(runtime) as List<PeerByteChannel>).toList()
    }

    /**
     * How many listeners the registry currently holds.
     *
     * Registration deduplicates, so a test that means to exercise a wide listener
     * list has to be able to prove it actually got one — otherwise a repeated
     * instance silently leaves a list of two and the scenario is not tested at all.
     */
    @Suppress("UNCHECKED_CAST")
    private fun listenerCount(registry: HostConnectionRegistry): Int {
        val field = HostConnectionRegistry::class.java.getDeclaredField("listeners")
        field.isAccessible = true
        return (field.get(registry) as List<HostConnectionListener>).size
    }

    @Test
    fun `a closed content lane is released while the application connection stays up`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()
            assertEquals(HostConnectionPhase.CONNECTED, registry.hostOf(one.id).phase)

            // A viewer can hold several lanes at once, and the registry owns each
            // one until it closes.
            val lanes = (1..8).map { index ->
                val opened = registry.openContentChannel(one.id)
                assertIs<HostContentChannelResult.Opened>(opened)
                advanceUntilIdle()
                assertEquals(
                    index,
                    ownedContent(registry, one.id).size,
                    "lane $index was not owned while open",
                )
                opened.channel.channel
            }

            // Closing one lane releases exactly that lane.
            lanes.forEachIndexed { index, lane ->
                lane.close()
                advanceUntilIdle()
                assertEquals(
                    lanes.size - index - 1,
                    ownedContent(registry, one.id).size,
                    "lane ${index + 1} was still owned after it closed",
                )
            }
            assertEquals(0, ownedContent(registry, one.id).size)

            // And the select/leave cycle can repeat all night over one session
            // without anything piling up.
            repeat(12) {
                val lane = assertIs<HostContentChannelResult.Opened>(
                    registry.openContentChannel(one.id),
                ).channel.channel
                advanceUntilIdle()
                assertEquals(1, ownedContent(registry, one.id).size)
                lane.close()
                advanceUntilIdle()
                assertEquals(0, ownedContent(registry, one.id).size, "a closed content lane was retained")
            }

            // Closing a viewer's lane is not closing the host: the application
            // channel is still live, still watched, and nothing was reported lost.
            assertEquals(HostConnectionPhase.CONNECTED, registry.hostOf(one.id).phase)
            assertEquals(0, harness.listener.lost.size)
            val app = harness.listener.available.single().channel as FakeChannel
            app.send("still streaming".toByteArray())
            assertEquals(1, app.sends.size)

            // The application lane still reports exactly one loss when it ends.
            app.endWith(1006, "peer gone")
            advanceUntilIdle()
            assertEquals(1, harness.listener.lost.size)
            registry.close()
        }
    }

    @Test
    fun `an old content closure cannot drop a replacement generation's lane`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()
            val first = assertIs<HostContentChannelResult.Opened>(registry.openContentChannel(one.id)).channel.channel
            advanceUntilIdle()
            assertEquals(1, ownedContent(registry, one.id).size)

            // The destination is re-armed, and the new generation opens its own lane.
            assertIs<HostCommandResult.Accepted>(registry.disconnect(one.id))
            advanceUntilIdle()
            registry.connect(one.id)
            advanceUntilIdle()
            val second = assertIs<HostContentChannelResult.Opened>(registry.openContentChannel(one.id)).channel.channel
            advanceUntilIdle()
            assertEquals(1, ownedContent(registry, one.id).size)

            // The old generation's closure lands late.
            first.close()
            advanceUntilIdle()

            // It removes nothing from the replacement generation, and that lane
            // still works.
            val owned = ownedContent(registry, one.id)
            assertEquals(1, owned.size)
            assertSame(second, owned.single(), "an old closure removed a newer lane")
            val replacement = owned.single() as FakeChannel
            replacement.send("after the old closure".toByteArray())
            assertEquals(1, replacement.sends.size)
            assertEquals(HostConnectionPhase.CONNECTED, registry.hostOf(one.id).phase)
            registry.close()
        }
    }

    @Test
    fun `listener registration churning during deliveries never tears a callback`() {
        val harness = RegistryHarness()
        try {
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(Dispatchers.IO)
            registry.addListener(harness.listener)
            registry.start()

            // A wide listener list makes a copy genuinely in progress, so the race is
            // something this test can actually land rather than something it hopes
            // for. Registration deduplicates, so these have to be distinct instances.
            val wide = List(3_000) { SilentListener() }
            wide.forEach { registry.addListener(it) }
            assertTrue(
                listenerCount(registry) >= wide.size,
                "the listener list never got wide, so a torn copy could not be exercised: " +
                    listenerCount(registry),
            )

            val churned = SilentListener()
            val stop = AtomicBoolean(false)
            val churner = Thread {
                while (!stop.get()) {
                    registry.addListener(churned)
                    registry.removeListener(churned)
                }
            }.apply { isDaemon = true }
            churner.start()

            val failures = CopyOnWriteArrayList<String>()
            try {
                repeat(40) { cycle ->
                    try {
                        registry.connect(one.id)
                        assertTrue(
                            awaitWithin { registry.hostOf(one.id).phase == HostConnectionPhase.CONNECTED },
                            "cycle $cycle never connected",
                        )
                        assertIs<HostCommandResult.Accepted>(registry.disconnect(one.id))
                        assertTrue(
                            awaitWithin { registry.hostOf(one.id).phase == HostConnectionPhase.DISCONNECTED },
                            "cycle $cycle never disconnected",
                        )
                    } catch (failure: Throwable) {
                        failures += "cycle $cycle: ${failure::class.java.simpleName}: ${failure.message}"
                    }
                }
            } finally {
                stop.set(true)
                churner.join(5_000L)
            }

            assertEquals(emptyList(), failures.toList(), "a delivery raced a listener registration")
            // The registry stayed coherent throughout: every lane it handed over
            // was later reported gone, and nothing was reported for a generation
            // that never handed anything over.
            val handedOff = harness.listener.available.map { it.hostId to it.generation }.toSet()
            val reported = harness.listener.lost.map { it.hostId to it.generation }.toSet()
            assertTrue(handedOff.isNotEmpty())
            assertEquals(emptySet(), handedOff - reported, "a handed-off channel was never reported lost")
            assertEquals(emptySet(), reported - handedOff, "a loss was reported for a generation never handed off")
            registry.connect(one.id)
            assertTrue(awaitWithin { registry.hostOf(one.id).phase == HostConnectionPhase.CONNECTED })
            registry.close()
        } finally {
            harness.close()
        }
    }

    /** A listener that only occupies a slot in the list being copied. */
    private class SilentListener : HostConnectionListener {
        override fun onAppChannelAvailable(channel: HostAppChannel) = Unit
        override fun onContentChannelAvailable(channel: HostContentChannel) = Unit
        override fun onChannelLost(lost: HostChannelLost) = Unit
    }
}
