package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.identity.PinRead
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerPairStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportErrorCode
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pairing, pinning, and the human confirmation in between.
 *
 * The rules under test are the ones that decide whether a phone client can be
 * trusted with trust: a key is recorded only for the association that is still
 * current, a changed key is refused rather than adopted, nothing prompts unless
 * the user asked for this exact connection, and a decision that arrives late or
 * from the wrong screen connects nothing.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HostConnectionRegistryPairingTest {

    private fun ConnectionRegistrySnapshot.host(id: HostId): HostConnectionSnapshot =
        hosts.first { it.hostId == id }

    @Test
    fun `an explicit connect latches one confirmation and records the proved key`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()

            registry.connect(one.id)
            testScheduler.runCurrent()

            // The prompt is latched in the observation, with everything an
            // operator needs and nothing else.
            assertEquals(HostConnectionPhase.PAIRING, registry.snapshot.value.host(one.id).phase)
            val pending = registry.snapshot.value.pendingConsents
            assertEquals(1, pending.size)
            val consent = pending.single()
            assertEquals(one.id, consent.hostId)
            assertEquals(one.endpoint, consent.endpoint)
            assertEquals(HostId.parse("host-1"), consent.hostId)
            assertEquals(registry.snapshot.value.host(one.id).generation, consent.generation)
            assertTrue(consent.expiresAtMonoMs > 0L)

            val proof = HostKeyConsentProof(
                consentId = consent.consentId,
                hostId = consent.hostId,
                generation = consent.generation,
                foregroundEpoch = consent.foregroundEpoch,
            )
            // The committed frame now presents this prompt; only then is an
            // answer the registry is allowed to act on.
            harness.prompt.presenting = consent.consentId
            val resolution = registry.decideKeyConsent(HostKeyConsentChoice.APPROVE, proof)
            assertIs<HostKeyConsentResolution.Applied>(resolution)
            advanceUntilIdle()

            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(one.id).phase)
            assertTrue(registry.snapshot.value.pendingConsents.isEmpty())

            // The recorded pin is the exact key the handshake proved, bound to
            // the saved endpoint — not a label, not a digest.
            val pin = harness.readPin(one.id, one.endpoint)
            assertIs<PinRead.Remembered>(pin)
            assertEquals(harness.peerKey(one.endpoint).keyId, pin.key.keyId)
            assertTrue(
                PeerKeyBridge.sameKey(pin.key, harness.peerKey(one.endpoint)),
                "trust must round-trip through the exact SPKI",
            )
            registry.close()
        }
    }

    @Test
    fun `a denied confirmation connects nothing and stores no key`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            testScheduler.runCurrent()

            val consent = registry.snapshot.value.pendingConsents.single()
            harness.prompt.presenting = consent.consentId
            val resolution = registry.decideKeyConsent(
                HostKeyConsentChoice.DENY,
                HostKeyConsentProof(consent.consentId, consent.hostId, consent.generation, consent.foregroundEpoch),
            )
            assertIs<HostKeyConsentResolution.Applied>(resolution)
            advanceUntilIdle()
            assertEquals(HostConnectionPhase.ERROR, registry.snapshot.value.host(one.id).phase)
            assertEquals(HostConnectionReason.APPROVAL_DECLINED, registry.snapshot.value.host(one.id).reason)
            assertIs<PinRead.NoPin>(harness.readPin(one.id, one.endpoint))
            registry.close()
        }
    }

    @Test
    fun `a late confirmation after background is refused and cannot connect`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            testScheduler.runCurrent()
            val consent = registry.snapshot.value.pendingConsents.single()

            registry.leaveForeground()
            advanceUntilIdle()

            val stale = registry.decideKeyConsent(
                HostKeyConsentChoice.APPROVE,
                proofOf(consent),
            )
            assertIs<HostKeyConsentResolution.Stale>(stale)
            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(one.id).phase)
            assertIs<PinRead.NoPin>(harness.readPin(one.id, one.endpoint))
            registry.close()
        }
    }

    @Test
    fun `a confirmation carrying a stale foreground epoch is refused`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            testScheduler.runCurrent()
            val consent = registry.snapshot.value.pendingConsents.single()

            val wrongEpoch = registry.decideKeyConsent(
                HostKeyConsentChoice.APPROVE,
                HostKeyConsentProof(consent.consentId, consent.hostId, consent.generation, consent.foregroundEpoch - 1L),
            )
            assertIs<HostKeyConsentResolution.Stale>(wrongEpoch)
            assertEquals(HostKeyConsentStaleReason.PROOF_MISMATCH, wrongEpoch.reason)

            // The live confirmation still works, so the refusal was the proof.
            harness.prompt.presenting = consent.consentId
            val good = registry.decideKeyConsent(
                HostKeyConsentChoice.APPROVE,
                proofOf(consent),
            )
            assertIs<HostKeyConsentResolution.Applied>(good)
            registry.close()
        }
    }

    @Test
    fun `a changed key for a pinned host is refused and never replaces the pin`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val remembered = assertNotNull((harness.readPin(one.id, one.endpoint) as? PinRead.Remembered)?.key)

            // The peer now proves a different identity.
            val impostor = RegistryFixtures.transportKey()
            harness.peerKeyFor(one.endpoint, impostor)

            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            assertEquals(HostConnectionPhase.ERROR, registry.snapshot.value.host(one.id).phase)
            assertEquals(HostConnectionReason.PEER_KEY_CHANGED, registry.snapshot.value.host(one.id).reason)
            assertTrue(
                registry.snapshot.value.host(one.id).reason.terminal,
                "a changed key is terminal: only an explicit Connect may try again",
            )
            val stillThere = harness.readPin(one.id, one.endpoint)
            assertIs<PinRead.Remembered>(stillThere)
            assertTrue(remembered.contentEquals(stillThere.key), "a remembered key is never replaced")
            registry.close()
        }
    }

    @Test
    fun `a trust read refusal is never treated as having no key`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            harness.pins.refuseReads = io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason.UNREADABLE

            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            assertEquals(
                false,
                registry.snapshot.value.storage.trust.available,
                "a refused trust handle is reported, not hidden",
            )
            registry.connect(one.id)
            advanceUntilIdle()

            assertEquals(HostConnectionPhase.ERROR, registry.snapshot.value.host(one.id).phase)
            assertEquals(HostConnectionReason.TRUST_UNAVAILABLE, registry.snapshot.value.host(one.id).reason)
            assertTrue(harness.transports.single().trustReadFailed)
            registry.close()
        }
    }

    @Test
    fun `automatic and resume attempts never pair and never prompt`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            harness.onTransport(one.endpoint) { openFailure = PeerTransportErrorCode.APP_TIMEOUT }

            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            advanceUntilIdle()

            // Auto retried, but a pairing never happened and no prompt appeared.
            assertTrue(harness.transports.isNotEmpty())
            assertEquals(0, harness.transports.sumOf { it.pairCalls })
            assertTrue(harness.transports.all { !it.lastApproverUsed })
            assertTrue(registry.snapshot.value.pendingConsents.isEmpty())
            registry.close()
        }
    }

    @Test
    fun `a pairing the peer denies is terminal and is not retried`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            // An explicit Connect is the only thing that pairs, so drive that.
            harness.onTransport(one.endpoint) { pairOutcome = PeerPairStatus.DENIED }
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            assertEquals(HostConnectionPhase.ERROR, registry.snapshot.value.host(one.id).phase)
            assertEquals(HostConnectionReason.PAIRING_DENIED, registry.snapshot.value.host(one.id).reason)
            assertEquals(1, harness.transports.size)
            registry.close()
        }
    }

    @Test
    fun `startup and observation never generate an identity`() = runTest {
        RegistryHarness().use { harness ->
            val hosts = (1..4).map { RegistryFixtures.host(it, previouslyConnected = true) }
            harness.seedSettings(RegistryFixtures.settings(*hosts.toTypedArray(), autoReconnect = true))
            harness.seedPins(hosts)
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            advanceUntilIdle()

            assertEquals(0, harness.identity.generations)
            assertIs<DeviceIdentityObservation.NeverInitialized>(registry.snapshot.value.identity)
            assertTrue(harness.transports.isEmpty(), "an unkeyed identity is never dialed around")
            registry.close()
        }
    }

    @Test
    fun `a previously initialized but missing identity is refused, not regenerated`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Refused(
                io.github.rfairburn.pireviewgate.core.identity.IdentityFailureReason.MISSING_INITIALIZED,
            )
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            assertEquals(0, harness.identity.generations)
            assertEquals(HostConnectionPhase.ERROR, registry.snapshot.value.host(one.id).phase)
            assertEquals(HostConnectionReason.IDENTITY_UNAVAILABLE, registry.snapshot.value.host(one.id).reason)
            assertIs<DeviceIdentityObservation.Refused>(registry.snapshot.value.identity)
            registry.close()
        }
    }

    @Test
    fun `the content lane opens only on a deliberately selected connected host`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val two = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(one, two))
            harness.seedPins(listOf(one, two))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            // Not connected yet: a selection cannot conjure a channel.
            val refused = registry.openContentChannel(two.id)
            assertIs<HostContentChannelResult.Refused>(refused)

            registry.connect(two.id)
            advanceUntilIdle()
            val opened = registry.openContentChannel(two.id)
            assertIs<HostContentChannelResult.Opened>(opened)
            assertEquals(1, harness.listener.content.size)

            // The content lane rode that host's own transport: still one
            // transport per destination, and one open per lane.
            assertEquals(2, harness.transports.size)
            val selected = harness.transports.first { it.openedLanes.size == 2 }
            assertEquals(
                listOf(
                    io.github.rfairburn.pireviewgate.core.transport.PeerAppLane.APP,
                    io.github.rfairburn.pireviewgate.core.transport.PeerAppLane.CONTENT,
                ),
                selected.openedLanes,
            )
            registry.close()
        }
    }

    @Test
    fun `a cleared pin drops frames already queued for that host`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            val channel = harness.transports.single().channels.single()
            assertEquals(0, channel.sends.size, "the registry itself never writes")

            // Forgetting the association drops the key, so the guard must refuse
            // the next frame instead of writing for a host the user removed.
            registry.remove(one.id)
            advanceUntilIdle()
            assertFailsWith<PeerTransportException> { channel.send("late".toByteArray()) }
            assertEquals(1, channel.dropped)
            registry.close()
        }
    }

}

/** The proof a foreground UI would hand back for the confirmation it rendered. */
private fun proofOf(consent: HostKeyConsent) = HostKeyConsentProof(
    consentId = consent.consentId,
    hostId = consent.hostId,
    generation = consent.generation,
    foregroundEpoch = consent.foregroundEpoch,
)
