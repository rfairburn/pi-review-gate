package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.identity.PeerKey as StoredPeerKey
import io.github.rfairburn.pireviewgate.core.transport.PeerKey as TransportPeerKey
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The seams between this layer and the ones around it.
 *
 * A send guard that has to reach for storage or a UI is a guard that will be
 * skipped under load, and an identity adapter that can smuggle a private half
 * is not an adapter. These checks are the cheap, synchronous promises the
 * higher coordinator and the key store are entitled to.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HostConnectionRegistryGuardTest {

    private fun ConnectionRegistrySnapshot.host(id: HostId): HostConnectionSnapshot =
        hosts.first { it.hostId == id }

    /** The handoff is typed as a channel; a test needs the fake behind it. */
    private fun PeerByteChannel.asFake(): FakeChannel = this as FakeChannel

    @Test
    fun `the registry never reads a channel it handed to a coordinator`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            val handed = harness.listener.available.single()
            assertEquals(0, handed.channel.asFake().receiveCalls)
            // Waiting longer does not make the registry curious.
            advanceUntilIdle()
            assertEquals(0, handed.channel.asFake().receiveCalls)
            registry.close()
        }
    }

    @Test
    fun `backgrounding makes every handed-off channel refuse its next frame`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val two = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(one, two))
            harness.seedPins(listOf(one, two))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            registry.connect(two.id)
            advanceUntilIdle()

            val channels = harness.listener.available.map { it.channel.asFake() }
            assertEquals(2, channels.size)

            registry.leaveForeground()

            // Synchronously: the guard already refuses before any transport has
            // been touched, so a frame that was queued cannot slip out.
            channels.forEach { channel ->
                assertFailsWith<PeerTransportException> { channel.send("queued".toByteArray()) }
                assertEquals(1, channel.dropped)
            }
            advanceUntilIdle()
            registry.close()
        }
    }

    @Test
    fun `one destination's guard going stale never affects another`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val two = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(one, two))
            harness.seedPins(listOf(one, two))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            registry.connect(two.id)
            advanceUntilIdle()

            val first = harness.listener.available.first { it.hostId == one.id }
            val second = harness.listener.available.first { it.hostId == two.id }

            // Losing one association invalidates only its own epoch.
            registry.disconnect(one.id)
            advanceUntilIdle()
            assertFailsWith<PeerTransportException> { first.channel.asFake().send("late".toByteArray()) }
            second.channel.asFake().send("still mine".toByteArray())

            assertEquals(0, second.channel.asFake().dropped)
            assertEquals(1, second.channel.asFake().sends.size)
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(two.id).phase)
            registry.close()
        }
    }

    @Test
    fun `a listener can unsubscribe and then hears nothing`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val two = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(one, two))
            harness.seedPins(listOf(one, two))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            val listener = RecordingListener()
            registry.addListener(listener)
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()
            assertEquals(1, listener.available.size)

            registry.removeListener(listener)
            registry.connect(two.id)
            advanceUntilIdle()
            assertEquals(1, listener.available.size)
            registry.close()
        }
    }

    @Test
    fun `an explicit connect initializes a never-initialized identity exactly once`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val two = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(one, two))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            assertIs<DeviceIdentityObservation.NeverInitialized>(registry.snapshot.value.identity)

            registry.connect(one.id)
            advanceUntilIdle()
            assertEquals(1, harness.identity.generations)
            val ready = registry.snapshot.value.identity
            assertIs<DeviceIdentityObservation.Ready>(ready)
            assertEquals(harness.identity.key.fingerprint, ready.fingerprint)

            // A second host, then a reconnect: nobody generates a second identity.
            registry.connect(two.id)
            advanceUntilIdle()
            registry.disconnect(one.id)
            registry.connect(one.id)
            advanceUntilIdle()
            assertEquals(1, harness.identity.generations)
            registry.close()
        }
    }

    @Test
    fun `the identity adapter fixes the label and hands over no private key`() {
        val key = RegistryFixtures.storedKey()
        val handle = FakeHandle(key)
        val identity = DevicePeerIdentity(handle)

        assertEquals("Pi Review Gate", DevicePeerIdentity.LABEL)
        assertEquals(DevicePeerIdentity.LABEL, identity.label)
        assertEquals(key.keyId, identity.keyId)
        assertEquals(key.fingerprint, identity.fingerprint)
        assertEquals(1, identity.keyManagers.size)
        // The key store's own manager, so possession is proved where the key
        // lives; nothing here is a serialized private half.
        assertSame(handle.newKeyManager(), identity.keyManagers.single())
    }

    @Test
    fun `the key bridge carries the exact spki and invents nothing`() {
        val observed = RegistryFixtures.transportKey()
        val stored = PeerKeyBridge.toStored(observed)

        // Byte-exact in both directions: the bridge is the SPKI and nothing else.
        assertTrue(PeerKeyBridge.sameKey(stored, observed))
        assertEquals(observed.keyId, PeerKeyBridge.toTransport(stored).keyId)
        assertEquals(observed.fingerprint, PeerKeyBridge.toTransport(stored).fingerprint)
        assertTrue(StoredPeerKey.fromSpki(observed.pinnedDer()).contentEquals(stored))

        // A different key is a different identity whatever its label says, and
        // equality is never inferred from a matching display fingerprint.
        val other = RegistryFixtures.transportKey()
        assertNotEquals(observed.keyId, other.keyId)
        assertTrue(!PeerKeyBridge.sameKey(stored, other))
        assertTrue(!PeerKeyBridge.sameKey(PeerKeyBridge.toStored(other), observed))

        // A stored record can only exist if its own digest matches its key bytes,
        // so a hand-edited pin never becomes a bridgeable identity in the first
        // place and the bridge never has to guess which half to believe.
        val edited = StoredPeerKey.parseOrNull(
            keyId = java.util.Base64.getEncoder().encodeToString(RegistryFixtures.spki()),
            fingerprint = stored.fingerprint,
        )
        assertNull(edited, "a key id paired with another key's digest is not an identity")

        // Neither layer will carry an unbounded blob, so no oversized record can
        // cross the bridge in either direction.
        val oversized = ByteArray(StoredPeerKey.MAX_SPKI_DER_BYTES + 1)
        assertFailsWith<IllegalArgumentException> { StoredPeerKey.fromSpki(oversized) }
        assertFailsWith<PeerTransportException> { TransportPeerKey.fromSpkiDer(oversized) }
    }

    @Test
    fun `a handed-off channel carries the epoch its receiver must carry onward`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            val handed = harness.listener.available.single()
            assertEquals(registry.snapshot.value.host(one.id).generation, handed.generation)
            assertEquals(one.endpoint, handed.endpoint)
            assertEquals(harness.peerKey(one.endpoint).fingerprint, handed.peerFingerprint)

            registry.disconnect(one.id)
            advanceUntilIdle()
            val lost = harness.listener.lost.single()
            assertEquals(handed.generation, lost.generation)
            assertTrue(!lost.stale, "this was the live channel, not a superseded attempt")
            registry.close()
        }
    }
}
