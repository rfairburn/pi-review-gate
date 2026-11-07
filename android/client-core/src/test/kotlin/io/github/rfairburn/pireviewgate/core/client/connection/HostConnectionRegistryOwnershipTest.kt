package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Ownership of an attempt, and who is allowed to answer a prompt.
 *
 * A connection that nobody is watching is a connection that never reports its own
 * death, and a confirmation nobody is being shown is not a confirmation. These
 * checks pin both: every mode of dialing owns its loss report, and only the
 * committed foreground frame can turn a proof into a decision.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HostConnectionRegistryOwnershipTest {

    private fun ConnectionRegistrySnapshot.host(id: HostId): HostConnectionSnapshot =
        hosts.first { it.hostId == id }

    @Test
    fun `an automatic connection reports its own loss and recovers on the bounded schedule`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            testScheduler.runCurrent()

            // Startup dialed automatically and is now a live connection.
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(one.id).phase)
            val epoch = registry.snapshot.value.host(one.id).generation
            val transport = harness.transports.single()
            val channel = transport.channels.single()
            assertEquals(1, harness.listener.available.size)
            assertTrue(harness.listener.lost.isEmpty())

            // The peer drops the application channel.
            channel.endWith(1006, "peer gone")
            testScheduler.runCurrent()

            val lost = harness.listener.lost.single()
            assertEquals(one.id, lost.hostId)
            assertEquals(epoch, lost.generation)
            assertTrue(!lost.stale, "this was the live channel, not a superseded attempt")
            assertTrue(transport.disposed, "the destination's own transport was not disposed")
            assertTrue(
                registry.snapshot.value.host(one.id).generation > epoch,
                "the epoch stayed valid after its channel ended",
            )
            assertEquals(HostConnectionPhase.RETRYING, registry.snapshot.value.host(one.id).phase)

            // Recovery is the finite schedule, starting at the first wait.
            advanceTimeBy(1_000L)
            testScheduler.runCurrent()
            assertEquals(2, harness.transports.size)
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(one.id).phase)
            registry.close()
        }
    }

    @Test
    fun `losing one automatic connection never disturbs another host's live session`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            val two = RegistryFixtures.host(2, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, two, autoReconnect = true))
            harness.seedPins(listOf(one, two))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            testScheduler.runCurrent()
            assertEquals(2, harness.transports.size)

            val first = harness.transports.first { it.endpoint?.host == one.endpoint.host }
            val second = harness.transports.first { it.endpoint?.host == two.endpoint.host }
            first.channels.single().endWith(1006, "peer gone")
            testScheduler.runCurrent()

            assertTrue(first.disposed)
            assertTrue(!second.disposed)
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(two.id).phase)
            assertEquals(1, harness.listener.lost.size)
            assertEquals(one.id, harness.listener.lost.single().hostId)
            registry.close()
        }
    }

    @Test
    fun `an explicit connect retires an automatic dial that is inside its open`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready

            // The automatic dial is parked mid-open when the user presses Connect.
            val gate = CompletableDeferred<Unit>()
            harness.onTransport(one.endpoint) { openGate = gate }
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            testScheduler.runCurrent()
            assertEquals(1, harness.transports.size)
            assertEquals(HostConnectionPhase.CONNECTING, registry.snapshot.value.host(one.id).phase)

            // Precedence: the explicit request is accepted, not refused behind the
            // automatic attempt's back.
            assertIs<HostCommandResult.Accepted>(registry.connect(one.id))
            testScheduler.runCurrent()

            // The automatic dial's transport is gone, and it is still the only one
            // that has reached `open`.
            assertTrue(harness.transports.first().disposed)
            assertEquals(2, harness.transports.size)
            assertTrue(!harness.transports[1].disposed)
            assertEquals(0, harness.listener.available.size, "a retired dial handed off a channel")

            // Let the parked open finish: it must find its epoch retired and stay
            // silent rather than publishing a second view of the same host.
            gate.complete(Unit)
            testScheduler.runCurrent()
            assertEquals(1, harness.transports.last().channels.size)
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(one.id).phase)
            assertEquals(1, harness.listener.available.size)
            assertEquals(one.id, harness.listener.available.single().hostId)
            registry.close()
        }
    }

    @Test
    fun `a second explicit connect while one is in flight is still refused`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()

            val gate = CompletableDeferred<Unit>()
            harness.onTransport(one.endpoint) { openGate = gate }
            registry.connect(one.id)
            testScheduler.runCurrent()

            val duplicate = registry.connect(one.id)
            assertIs<HostCommandResult.Refused>(duplicate)
            assertEquals(HostCommandRefusal.ATTEMPT_IN_FLIGHT, duplicate.reason)
            assertEquals(1, harness.transports.size)

            gate.complete(Unit)
            testScheduler.runCurrent()
            registry.close()
        }
    }

    @Test
    fun `disconnect withdraws a pending confirmation and a later connect can ask again`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            testScheduler.runCurrent()
            val pending = registry.snapshot.value.pendingConsents.single()
            val staleProof = HostKeyConsentProof(
                pending.consentId,
                pending.hostId,
                pending.generation,
                pending.foregroundEpoch,
            )

            registry.disconnect(one.id)
            testScheduler.runCurrent()

            // The prompt is gone, not latched forever behind a cancelled attempt.
            assertTrue(registry.snapshot.value.pendingConsents.isEmpty())
            val late = registry.decideKeyConsent(HostKeyConsentChoice.APPROVE, staleProof)
            assertIs<HostKeyConsentResolution.Stale>(late)
            assertEquals(HostKeyConsentStaleReason.UNKNOWN_CONSENT, late.reason)

            // And the next explicit Connect is not blocked by the dead prompt: it
            // latches a fresh confirmation that can actually be answered.
            registry.connect(one.id)
            testScheduler.runCurrent()
            val fresh = registry.snapshot.value.pendingConsents.single()
            assertTrue(fresh.consentId != pending.consentId)
            harness.prompt.presenting = fresh.consentId
            assertIs<HostKeyConsentResolution.Applied>(
                registry.decideKeyConsent(
                    HostKeyConsentChoice.APPROVE,
                    HostKeyConsentProof(fresh.consentId, fresh.hostId, fresh.generation, fresh.foregroundEpoch),
                ),
            )
            advanceUntilIdle()
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(one.id).phase)
            registry.close()
        }
    }

    @Test
    fun `neither answer is admitted once the committed frame stops presenting it`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            testScheduler.runCurrent()
            val consent = registry.snapshot.value.pendingConsents.single()
            val proof = HostKeyConsentProof(consent.consentId, consent.hostId, consent.generation, consent.foregroundEpoch)

            // The frame committed the prompt, then was replaced by another frame
            // that does not present it — all inside one foreground epoch.
            harness.prompt.presenting = consent.consentId
            harness.prompt.presenting = null

            val approval = registry.decideKeyConsent(HostKeyConsentChoice.APPROVE, proof)
            assertIs<HostKeyConsentResolution.Stale>(approval)
            assertEquals(HostKeyConsentStaleReason.UI_NOT_COMMITTED, approval.reason)

            val denial = registry.decideKeyConsent(HostKeyConsentChoice.DENY, proof)
            assertIs<HostKeyConsentResolution.Stale>(denial)
            assertEquals(HostKeyConsentStaleReason.UI_NOT_COMMITTED, denial.reason)

            // Refusing did not consume the live confirmation, and nothing paired.
            assertEquals(1, registry.snapshot.value.pendingConsents.size)
            assertTrue(harness.transports.single().pairCalls >= 1)
            assertEquals(HostConnectionPhase.PAIRING, registry.snapshot.value.host(one.id).phase)

            // A frame presenting a different prompt is also not this one.
            harness.prompt.presenting = consent.consentId + 100L
            val replaced = registry.decideKeyConsent(HostKeyConsentChoice.APPROVE, proof)
            assertIs<HostKeyConsentResolution.Stale>(replaced)
            assertEquals(HostKeyConsentStaleReason.UI_NOT_COMMITTED, replaced.reason)

            // Only the frame that actually presents it can be answered.
            assertTrue(harness.prompt.asked >= 3, "the committed frame was never asked")
            harness.prompt.presenting = consent.consentId
            assertIs<HostKeyConsentResolution.Applied>(
                registry.decideKeyConsent(HostKeyConsentChoice.APPROVE, proof),
            )
            advanceUntilIdle()
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(one.id).phase)
            registry.close()
        }
    }
}
