package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostAddress
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.identity.PinRead
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class HostConnectionRegistryAddressTest {
    private val address = HostAddress.parse("10.0.0.45")

    @Test
    fun `address admission matches Endpoint without normalization or implicit port`() {
        for (value in listOf("", " x", "x ", "x/path", "x?y", "x#y", "x@y", "x\\y", "x".repeat(256))) {
            assertNull(HostAddress.parseOrNull(value))
            assertFailsWith<IllegalArgumentException> { HostAddress.parse(value) }
        }
        for (value in listOf("10.0.0.45", "host.local", "::1", "x".repeat(255))) {
            assertEquals(Endpoint(value, 8443).host, HostAddress.parse(value).value)
        }
    }

    @Test
    fun `save only preserves every catalog fact and never infers a key from history`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true, suppressed = true)
            val two = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(one, two, autoReconnect = true)
                .withViewerRemoteInputEnabled(false))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                val before = registry.snapshot.value
                val identityObservations = harness.identity.observations
                val endpoint = Endpoint(address.value, one.endpoint.port)
                assertEquals(HostAddressUpdateResult.Saved(endpoint),
                    registry.updateHostAddress(one.id, one.endpoint, address))
                advanceUntilIdle()
                val saved = harness.savedSettings()!!
                assertEquals(listOf(one.withEndpoint(endpoint), two), saved.hosts.hosts)
                assertTrue(saved.autoReconnect)
                assertFalse(saved.viewerRemoteInputEnabled)
                val after = registry.snapshot.value
                assertEquals(before.settingsGeneration + 1, after.settingsGeneration)
                assertTrue(after.hosts.first().previouslyConnected)
                assertTrue(after.hosts.first().reconnectSuppressed)
                assertFalse(after.hosts.first().autoEligible)
                assertNull(after.hosts.first().peerFingerprint)
                assertEquals(before.hosts.last(), after.hosts.last())
                assertEquals(PinRead.NoPin, harness.readPin(one.id, endpoint))
                assertEquals(identityObservations, harness.identity.observations)
                assertEquals(0, harness.identity.generations)
                assertTrue(harness.pins.recorded.isEmpty())
                assertTrue(harness.pins.clears.isEmpty())
                assertTrue(harness.transports.isEmpty())
                assertTrue(after.pendingConsents.isEmpty())
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `committed edit fences app and content guards immediately and old loss cannot affect replacement`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val two = RegistryFixtures.host(2)
            val endpoint = Endpoint(address.value, one.endpoint.port)
            harness.peerKeyFor(endpoint, harness.peerKey(one.endpoint))
            harness.seedSettings(RegistryFixtures.settings(one, two))
            harness.seedPins(listOf(one, two))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            try {
                registry.connect(one.id)
                registry.connect(two.id)
                advanceUntilIdle()
                assertIs<HostContentChannelResult.Opened>(registry.openContentChannel(one.id))
                val oldTransport = harness.transports.first()
                val oldChannels = oldTransport.channels.toList()
                assertEquals(listOf(PeerAppLane.APP, PeerAppLane.CONTENT), oldChannels.map { it.lane })
                val handed = harness.listener.available.first()
                val other = harness.listener.available.last()
                val otherSnapshot = registry.snapshot.value.hosts.last()
                val pin = harness.readPin(one.id, one.endpoint)
                val records = harness.pins.recorded.toList()
                val identityKey = harness.identity.key
                val identityObservations = harness.identity.observations
                val generations = harness.identity.generations

                assertEquals(HostAddressUpdateResult.Saved(endpoint),
                    registry.updateHostAddress(one.id, one.endpoint, address))
                // No scheduler turn: queued frames have already lost authority.
                oldChannels.forEach {
                    assertFailsWith<PeerTransportException> { it.send("queued".toByteArray()) }
                    assertTrue(it.sends.isEmpty())
                }
                assertTrue(oldTransport.disposed)
                assertEquals(2, harness.transports.size)
                assertEquals(identityObservations, harness.identity.observations)
                assertEquals(records, harness.pins.recorded)
                assertTrue(harness.pins.clears.isEmpty())
                assertEquals(pin, harness.readPin(one.id, endpoint))
                assertEquals(otherSnapshot, registry.snapshot.value.hosts.last())
                other.channel.send("other host".toByteArray())
                val loss = harness.listener.lost.single()
                assertEquals(handed.hostId, loss.hostId)
                assertEquals(handed.endpoint, loss.endpoint)
                assertEquals(handed.generation, loss.generation)
                assertEquals(HostConnectionReason.CONNECTION_LOST, loss.reason)
                assertFalse(loss.stale)
                assertTrue(registry.snapshot.value.hosts.first().generation > handed.generation)

                registry.connect(one.id)
                advanceUntilIdle()
                val replacement = harness.listener.available.last()
                assertEquals(endpoint, replacement.endpoint)
                assertTrue(replacement.generation > handed.generation)
                val fresh = harness.transports.last()
                assertEquals(pin, harness.readPin(one.id, endpoint))
                assertFalse(fresh.lastApproverUsed)
                assertEquals(identityKey, harness.identity.key)
                assertEquals(generations, harness.identity.generations)
                // Disposal already completed both old fake channels. The old
                // app waiter resumes from cancellation after Connect installs
                // a new watch, so its loss is an old-generation diagnostic.
                val staleLoss = HostChannelLost(handed.hostId, handed.endpoint, handed.generation,
                    HostConnectionReason.CONNECTION_LOST, stale = true)
                assertEquals(listOf(loss, staleLoss), harness.listener.lost.toList())
                val replacementHosts = registry.snapshot.value.hosts
                assertEquals(replacement.hostId, replacementHosts.first().hostId)
                assertEquals(replacement.endpoint, replacementHosts.first().endpoint)
                assertEquals(replacement.generation, replacementHosts.first().generation)
                assertEquals(HostConnectionPhase.CONNECTED, replacementHosts.first().phase)
                oldChannels.forEach { it.endWith(1006, "late old close") }
                advanceUntilIdle()
                replacement.channel.send("fresh".toByteArray())
                other.channel.send("other host still live".toByteArray())
                assertEquals(replacementHosts, registry.snapshot.value.hosts)
                assertEquals(otherSnapshot, registry.snapshot.value.hosts.last())
                assertEquals(listOf(loss, staleLoss), harness.listener.lost.toList())
                assertEquals(pin, harness.readPin(one.id, endpoint))
                assertEquals(identityKey, harness.identity.key)
                assertEquals(generations, harness.identity.generations)
                assertFalse(fresh.disposed)
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `no-op stale target unknown and failed write never publish a phantom address or retire a channel`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            try {
                registry.connect(one.id)
                advanceUntilIdle()
                val before = registry.snapshot.value
                val writes = harness.settings.writes
                assertEquals(HostAddressUpdateResult.Unchanged,
                    registry.updateHostAddress(one.id, one.endpoint, HostAddress.parse(one.endpoint.host)))
                // A stale form is stale even if its submitted address equals the current one.
                assertEquals(HostAddressUpdateResult.StaleTarget,
                    registry.updateHostAddress(one.id, Endpoint("stale", one.endpoint.port), HostAddress.parse(one.endpoint.host)))
                assertEquals(HostAddressUpdateResult.Refused(HostCommandRefusal.UNKNOWN_HOST),
                    registry.updateHostAddress(RegistryFixtures.host(2).id, one.endpoint, address))
                assertEquals(before, registry.snapshot.value)
                assertEquals(writes, harness.settings.writes)
                harness.settings.refuseWrites = StorageFailureReason.WRITE_FAILED
                assertEquals(HostAddressUpdateResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE),
                    registry.updateHostAddress(one.id, one.endpoint, address))
                assertEquals(before.hosts, registry.snapshot.value.hosts)
                assertEquals(before.settingsGeneration, registry.snapshot.value.settingsGeneration)
                assertEquals(StorageFailureReason.WRITE_FAILED, registry.snapshot.value.storage.settings.reason)
                assertEquals(one.endpoint, harness.savedCatalog().hosts.single().endpoint)
                assertFalse(harness.transports.single().disposed)
                harness.transports.single().channels.single().send("still old".toByteArray())
                assertTrue(harness.listener.lost.isEmpty())
                harness.settings.refuseWrites = null
                registry.setViewerRemoteInputEnabled(false)
                assertEquals(one.endpoint, harness.savedCatalog().hosts.single().endpoint)
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `unstarted closed and unreadable settings refuse without writing`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            assertEquals(HostAddressUpdateResult.Refused(HostCommandRefusal.NOT_RUNNING),
                registry.updateHostAddress(one.id, one.endpoint, address))
            harness.settings.refuseReads = StorageFailureReason.UNREADABLE
            registry.start()
            assertEquals(HostAddressUpdateResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE),
                registry.updateHostAddress(one.id, one.endpoint, address))
            registry.close()
            assertEquals(HostAddressUpdateResult.Refused(HostCommandRefusal.NOT_RUNNING),
                registry.updateHostAddress(one.id, one.endpoint, address))
            assertEquals(0, harness.settings.writes)
        }
    }

    @Test
    fun `a publication finishing after close is truthfully saved without reviving the registry`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val endpoint = Endpoint(address.value, one.endpoint.port)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                harness.settings.onWrite = { registry.close() }
                assertEquals(HostAddressUpdateResult.Saved(endpoint),
                    registry.updateHostAddress(one.id, one.endpoint, address))
                advanceUntilIdle()
                assertEquals(one.withEndpoint(endpoint), harness.savedCatalog().hosts.single())
                assertEquals(endpoint, registry.snapshot.value.hosts.single().endpoint)
                assertEquals(HostCommandResult.Refused(HostCommandRefusal.NOT_RUNNING), registry.connect(one.id))
                assertTrue(harness.transports.isEmpty())
                assertEquals(0, harness.identity.generations)
            } finally {
                harness.settings.onWrite = null
                registry.close()
            }
        }
    }

    @Test
    fun `new locator still requires native network admission and unreadable trust never becomes first use`() = runTest {
        for (networkAllowed in listOf(false, true)) {
            RegistryHarness().use { harness ->
                val one = RegistryFixtures.host(1)
                val endpoint = Endpoint(address.value, one.endpoint.port)
                harness.seedSettings(RegistryFixtures.settings(one))
                harness.seedPins(listOf(one))
                val registry = harness.registry(StandardTestDispatcher(testScheduler),
                    networkAccess = NetworkAccessAdmission { target ->
                        assertEquals(endpoint, target)
                        networkAllowed
                    })
                registry.start()
                try {
                    harness.pins.refuseReads = StorageFailureReason.UNREADABLE
                    assertEquals(HostAddressUpdateResult.Saved(endpoint),
                        registry.updateHostAddress(one.id, one.endpoint, address))
                    advanceUntilIdle()
                    assertTrue(harness.transports.isEmpty())
                    registry.connect(one.id)
                    advanceUntilIdle()
                    assertEquals(if (networkAllowed) HostConnectionReason.TRUST_UNAVAILABLE
                        else HostConnectionReason.LOCAL_NETWORK_UNAVAILABLE, registry.snapshot.value.hosts.single().reason)
                    if (networkAllowed) {
                        assertTrue(harness.transports.single().trustReadFailed)
                        assertFalse(harness.transports.single().lastApproverUsed)
                    } else {
                        assertTrue(harness.transports.isEmpty())
                        assertEquals(0, harness.identity.generations)
                    }
                    assertTrue(harness.pins.recorded.isEmpty())
                    assertTrue(harness.pins.clears.isEmpty())
                    assertEquals(PinRead.Remembered(harness.storedPeerKey(one.endpoint)), harness.readPin(one.id, endpoint))
                    assertTrue(registry.snapshot.value.pendingConsents.isEmpty())
                } finally {
                    registry.close()
                }
            }
        }
    }

    @Test
    fun `save cancels consent and an old proof cannot pin either address`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                registry.connect(one.id)
                testScheduler.runCurrent()
                val consent = registry.snapshot.value.pendingConsents.single()
                val proof = HostKeyConsentProof(consent.consentId, consent.hostId, consent.generation, consent.foregroundEpoch)
                val endpoint = Endpoint(address.value, one.endpoint.port)
                assertEquals(HostAddressUpdateResult.Saved(endpoint),
                    registry.updateHostAddress(one.id, one.endpoint, address))
                assertTrue(registry.snapshot.value.pendingConsents.isEmpty())
                harness.prompt.presenting = consent.consentId
                assertIs<HostKeyConsentResolution.Stale>(registry.decideKeyConsent(HostKeyConsentChoice.APPROVE, proof))
                advanceUntilIdle()
                assertTrue(harness.pins.recorded.isEmpty())
                assertEquals(PinRead.NoPin, harness.readPin(one.id, endpoint))
                assertEquals(1, harness.transports.size)
                assertTrue(harness.transports.single().disposed)
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `address save cancels an already waiting retry without redialing either locator`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            val endpoint = Endpoint(address.value, one.endpoint.port)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                testScheduler.runCurrent()
                val transport = harness.transports.single()
                transport.channels.single().endWith()
                testScheduler.runCurrent()
                assertEquals(HostConnectionPhase.RETRYING, registry.snapshot.value.hosts.single().phase)
                assertEquals(HostAddressUpdateResult.Saved(endpoint),
                    registry.updateHostAddress(one.id, one.endpoint, address))
                advanceUntilIdle()
                assertEquals(1, harness.transports.size)
                assertTrue(transport.disposed)
                assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.hosts.single().phase)
                assertEquals(one.withEndpoint(endpoint), harness.savedCatalog().hosts.single())
                assertEquals(PinRead.Remembered(harness.storedPeerKey(one.endpoint)), harness.readPin(one.id, endpoint))
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `saved edit withdraws queued Auto and resume without clearing saved policy or Disconnect`() = runTest {
        for (suppressed in listOf(false, true)) {
            RegistryHarness().use { harness ->
                val one = RegistryFixtures.host(1, previouslyConnected = true, suppressed = suppressed)
                val endpoint = Endpoint(address.value, one.endpoint.port)
                harness.peerKeyFor(endpoint, harness.peerKey(one.endpoint))
                harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
                harness.seedPins(listOf(one))
                harness.identity.status = PeerIdentityStatus.Ready
                val registry = harness.registry(StandardTestDispatcher(testScheduler))
                registry.start() // startup Auto is queued but has not run
                try {
                    registry.leaveForeground()
                    assertEquals(HostAddressUpdateResult.Saved(endpoint),
                        registry.updateHostAddress(one.id, one.endpoint, address))
                    registry.enterForeground(listOf(one.id))
                    registry.setAutoReconnect(false)
                    registry.setAutoReconnect(true)
                    advanceUntilIdle()
                    assertTrue(harness.transports.isEmpty())
                    assertTrue(registry.snapshot.value.autoReconnectEnabled)
                    assertFalse(registry.snapshot.value.hosts.single().autoEligible)
                    assertEquals(one.withEndpoint(endpoint), harness.savedCatalog().hosts.single())
                    assertEquals(suppressed, registry.snapshot.value.hosts.single().reconnectSuppressed)
                    registry.connect(one.id)
                    advanceUntilIdle()
                    assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.hosts.single().phase)
                    assertFalse(registry.snapshot.value.hosts.single().reconnectSuppressed)
                    assertEquals(0, harness.identity.generations)
                } finally {
                    registry.close()
                }
            }
        }
    }
}
