package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.identity.PinRead
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportErrorCode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Foreground and background, and the retry budget behind a dropped link.
 *
 * A phone is backgrounded constantly. What must survive that is the user's
 * intent and the owner's session; what must not survive it is a live socket and
 * a timer nobody can see. These tests pin that line, plus the finite automatic
 * schedule that stops instead of hammering a host for hours.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HostConnectionRegistryLifecycleTest {

    private fun ConnectionRegistrySnapshot.host(id: HostId): HostConnectionSnapshot =
        hosts.first { it.hostId == id }

    @Test
    fun `backgrounding closes every owned connection and reports each channel lost`() = runTest {
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
            assertEquals(2, harness.listener.available.size)
            val ownedBefore = harness.transports.map { it.disposed }
            assertEquals(listOf(false, false), ownedBefore)

            registry.leaveForeground()

            // The epochs move synchronously: by the time this call returns, no
            // admission can succeed, even though the transports are still being
            // torn down on the dispatcher.
            assertTrue(registry.snapshot.value.host(one.id).generation > 0)
            assertTrue(registry.snapshot.value.host(two.id).generation > 0)
            advanceUntilIdle()

            assertEquals(listOf(true, true), harness.transports.map { it.disposed })
            assertEquals(2, harness.listener.lost.size)
            assertEquals(
                setOf(one.id, two.id),
                harness.listener.lost.map { it.hostId }.toSet(),
            )
            assertTrue(
                registry.snapshot.value.hosts.all {
                    it.phase == HostConnectionPhase.DISCONNECTED && !it.autoEligible
                },
            )
            registry.close()
        }
    }

    @Test
    fun `backgrounding sends nothing to the owner and claims no owner work`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            val channel = harness.transports.single().channels.single()
            registry.leaveForeground()
            advanceUntilIdle()

            // The registry never writes a frame, so it certainly never wrote a
            // Close, a Create, or a SavedCancel on the way out.
            assertEquals(0, channel.sends.size)
            assertTrue(channel.isClosed)
            registry.close()
        }
    }

    @Test
    fun `returning to the foreground re-dials only the hosts that were active`() = runTest {
        RegistryHarness().use { harness ->
            val active = RegistryFixtures.host(1, previouslyConnected = true)
            val idle = RegistryFixtures.host(2, previouslyConnected = false)
            harness.seedSettings(RegistryFixtures.settings(active, idle))
            harness.seedPins(listOf(active, idle))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(active.id)
            advanceUntilIdle()
            assertEquals(1, harness.transports.size)

            registry.leaveForeground()
            advanceUntilIdle()
            harness.transports.clear()

            registry.enterForeground()
            advanceUntilIdle()

            assertEquals(listOf(active.endpoint.host), harness.transports.map { it.endpoint?.host })
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(active.id).phase)
            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(idle.id).phase)
            registry.close()
        }
    }

    @Test
    fun `a resume uses the remembered key and never pairs or prompts`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = false))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            registry.leaveForeground()
            advanceUntilIdle()
            harness.transports.clear()

            // Auto reconnect is off, yet returning to the app is itself the
            // user's request to be connected again: exactly one attempt.
            registry.enterForeground()
            advanceUntilIdle()
            assertEquals(1, harness.transports.size)
            assertEquals(0, harness.transports.single().pairCalls)
            assertTrue(!harness.transports.single().lastApproverUsed)
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(one.id).phase)

            // A resume never overwrites the trust that was already remembered.
            val pin = harness.readPin(one.id, one.endpoint)
            assertIs<PinRead.Remembered>(pin)
            assertEquals(harness.peerKey(one.endpoint).keyId, pin.key.keyId)
            registry.close()
        }
    }

    @Test
    fun `a failed resume does not become a loop while automatic reconnect is off`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = false))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(one.id).phase)

            registry.leaveForeground()
            advanceUntilIdle()
            harness.transports.clear()
            // The link is down now: every dial from here on fails.
            harness.onTransport(one.endpoint) { openFailure = PeerTransportErrorCode.APP_TIMEOUT }

            // Returning to the app dials once.
            registry.enterForeground()
            advanceUntilIdle()
            assertEquals(1, harness.transports.size)

            // Nothing is scheduled behind it, so no amount of waiting dials again.
            advanceTimeBy(600_000L)
            assertEquals(1, harness.transports.size)
            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(one.id).phase)
            registry.close()
        }
    }

    @Test
    fun `a cold start with automatic reconnect off dials nobody`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = false))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            advanceUntilIdle()
            assertTrue(harness.transports.isEmpty())
            registry.close()
        }
    }

    @Test
    fun `background startup with Auto off never gains a startup dial on later foregrounds or reloads`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = false))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.setForeground(false)
            registry.start()
            advanceUntilIdle()
            assertTrue(harness.transports.isEmpty())
            registry.enterForeground()
            advanceUntilIdle()
            assertTrue(harness.transports.isEmpty())

            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            registry.reload()
            registry.enterForeground()
            registry.leaveForeground()
            registry.enterForeground()
            advanceUntilIdle()
            assertTrue(harness.transports.isEmpty())
            assertEquals(0, harness.identity.generations)
            assertEquals(0, harness.prompt.asked)
            assertEquals(0, harness.settings.writes)
            registry.close()
        }
    }

    @Test
    fun `deferred saved Auto respects unavailable storage and uninitialized or refused identity`() = runTest {
        val refusals: List<RegistryHarness.() -> Unit> = listOf(
            { identity.status = PeerIdentityStatus.NeverInitialized },
            {
                identity.status = PeerIdentityStatus.Refused(
                    io.github.rfairburn.pireviewgate.core.identity.IdentityFailureReason.MISSING_INITIALIZED,
                )
            },
            { settings.refuseReads = StorageFailureReason.UNAVAILABLE },
            { pins.refuseReads = StorageFailureReason.UNAVAILABLE },
        )
        for (refuse in refusals) {
            RegistryHarness().use { harness ->
                val one = RegistryFixtures.host(1, previouslyConnected = true)
                harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
                harness.seedPins(listOf(one))
                harness.identity.status = PeerIdentityStatus.Ready
                harness.refuse()
                val registry = harness.registry(StandardTestDispatcher(testScheduler))
                registry.setForeground(false)
                registry.start()
                advanceUntilIdle()
                assertTrue(harness.transports.isEmpty())
                registry.enterForeground()
                advanceUntilIdle()
                assertTrue(harness.transports.isEmpty())
                assertEquals(0, harness.identity.generations)
                assertEquals(0, harness.prompt.asked)
                assertTrue(registry.snapshot.value.pendingConsents.isEmpty())
                assertEquals(0, harness.settings.writes)
                registry.close()
            }
        }
    }

    @Test
    fun `deferred startup Auto does not restart an exhausted budget on repeated foregrounds`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            harness.onTransport(one.endpoint) { openFailure = PeerTransportErrorCode.APP_TIMEOUT }
            val registry = harness.registry(StandardTestDispatcher(testScheduler), HostConnectionPolicy.DEFAULT)
            registry.setForeground(false)
            registry.start()
            advanceUntilIdle()
            assertTrue(harness.transports.isEmpty())
            registry.enterForeground()
            testScheduler.runCurrent()
            assertEquals(1, harness.transports.size)
            for ((index, wait) in HostConnectionPolicy.DEFAULT_AUTO_RECONNECT_DELAYS_MS.withIndex()) {
                advanceTimeBy(wait)
                testScheduler.runCurrent()
                assertEquals(index + 2, harness.transports.size)
            }
            assertEquals(HostConnectionReason.AUTO_STOPPED, registry.snapshot.value.host(one.id).reason)
            assertFalse(registry.snapshot.value.host(one.id).autoEligible)

            registry.enterForeground()
            registry.reload()
            registry.enterForeground()
            registry.leaveForeground()
            registry.enterForeground()
            advanceTimeBy(600_000L)
            advanceUntilIdle()
            assertEquals(7, harness.transports.size)
            assertTrue(harness.transports.all { it.pairCalls == 0 && !it.lastApproverUsed })
            assertEquals(0, harness.identity.generations)
            registry.close()
        }
    }

    @Test
    fun `deferred startup Auto does not redial a terminal authorization refusal`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            harness.onTransport(one.endpoint) { openFailure = PeerTransportErrorCode.APP_REFUSED }
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.setForeground(false)
            registry.start()
            advanceUntilIdle()
            assertTrue(harness.transports.isEmpty())
            registry.enterForeground()
            advanceUntilIdle()
            assertEquals(1, harness.transports.size)
            assertEquals(HostConnectionReason.NOT_AUTHORIZED, registry.snapshot.value.host(one.id).reason)
            assertEquals(HostConnectionPhase.ERROR, registry.snapshot.value.host(one.id).phase)
            registry.reload()
            registry.enterForeground()
            registry.enterForeground()
            advanceTimeBy(600_000L)
            advanceUntilIdle()
            assertEquals(1, harness.transports.size)
            assertEquals(0, harness.transports.single().pairCalls)
            assertFalse(harness.transports.single().lastApproverUsed)
            registry.close()
        }
    }

    @Test
    fun `the automatic schedule is finite and then stops`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            harness.onTransport(one.endpoint) { openFailure = PeerTransportErrorCode.APP_TIMEOUT }
            val registry = harness.registry(StandardTestDispatcher(testScheduler), HostConnectionPolicy.DEFAULT)
            registry.start()
            testScheduler.runCurrent()

            // Startup attempt, then exactly the six bounded waits: 1, 2, 4, 8,
            // 15, 30 seconds. Not a seventh, not the last value forever.
            assertEquals(1, harness.transports.size)
            var launched = 1
            var elapsed = 0L
            for (delay in HostConnectionPolicy.DEFAULT_AUTO_RECONNECT_DELAYS_MS) {
                advanceTimeBy(delay)
                testScheduler.runCurrent()
                elapsed += delay
                launched += 1
                assertEquals(launched, harness.transports.size, "after ${elapsed}s of waiting")
            }

            // Nothing is left to run: the schedule stopped rather than repeating
            // the last wait forever.
            advanceTimeBy(600_000L)
            assertEquals(7, harness.transports.size, "the schedule stops instead of hammering")
            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(one.id).phase)
            assertTrue(!registry.snapshot.value.host(one.id).autoEligible)
            registry.close()
        }
    }

    @Test
    fun `an explicit connect interrupts the pending automatic attempt`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            harness.onTransport(one.endpoint) { openFailure = PeerTransportErrorCode.APP_TIMEOUT }
            val registry = harness.registry(StandardTestDispatcher(testScheduler), HostConnectionPolicy.DEFAULT)
            registry.start()
            testScheduler.runCurrent()
            assertEquals(1, harness.transports.size)

            // Waiting inside the 1s backoff...
            advanceTimeBy(500L)
            registry.connect(one.id)
            testScheduler.runCurrent()

            // ...was replaced, not added to: the two attempts never interleave on
            // one destination, and the wait that was pending never fires.
            assertEquals(2, harness.transports.size)
            assertTrue(
                harness.transports[0] !== harness.transports[1],
                "one destination never gets two live attempts at once",
            )
            // Up to but not including the cancelled backoff: nothing new dials.
            advanceTimeBy(400L)
            assertEquals(2, harness.transports.size)
            registry.close()
        }
    }

    @Test
    fun `a manual disconnect suppresses automatic reconnect durably`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            registry.disconnect(one.id)
            advanceUntilIdle()

            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(one.id).phase)
            assertTrue(registry.snapshot.value.host(one.id).reconnectSuppressed)
            assertTrue(harness.savedSettings()!!.hosts.find(one.id)!!.reconnectSuppressed)

            harness.transports.clear()
            registry.enterForeground()
            advanceTimeBy(60_000L)
            advanceUntilIdle()
            assertTrue(harness.transports.isEmpty(), "a host the user stopped stays stopped")

            // Only an explicit Connect lifts it.
            registry.connect(one.id)
            advanceUntilIdle()
            assertEquals(1, harness.transports.size)
            assertTrue(!registry.snapshot.value.host(one.id).reconnectSuppressed)
            assertTrue(!harness.savedSettings()!!.hosts.find(one.id)!!.reconnectSuppressed)
            registry.close()
        }
    }

    @Test
    fun `a suppression that cannot be saved still suppresses this session`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            harness.settings.refuseWrites = StorageFailureReason.WRITE_FAILED
            registry.disconnect(one.id)
            advanceUntilIdle()

            // The user's stop is honoured now, and the failed copy is reported
            // rather than hidden behind a claim that the preference landed.
            assertTrue(registry.snapshot.value.host(one.id).reconnectSuppressed)
            assertNotNull(registry.snapshot.value.notice)
            assertEquals(RegistryNoticeReason.SUPPRESSION_NOT_PERSISTED, registry.snapshot.value.notice!!.reason)
            assertEquals(one.id, registry.snapshot.value.notice!!.hostId)
            assertEquals(false, harness.savedSettings()!!.hosts.find(one.id)!!.reconnectSuppressed)
            assertFalse(registry.snapshot.value.storage.settings.available)

            // An explicit Connect clears the in-memory override with it.
            harness.settings.refuseWrites = null
            registry.connect(one.id)
            advanceUntilIdle()
            assertTrue(!registry.snapshot.value.host(one.id).reconnectSuppressed)
            assertNull(registry.snapshot.value.notice)
            registry.close()
        }
    }

    @Test
    fun `removing a host forgets the local key and association but revokes nothing`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()
            val channel = harness.transports.single().channels.single()

            val result = registry.remove(one.id)
            assertIs<HostCommandResult.Accepted>(result)
            advanceUntilIdle()

            assertTrue(harness.transports.single().disposed)
            assertEquals(0, channel.sends.size, "forgetting is local: nothing is sent to the owner")
            assertIs<PinRead.NoPin>(harness.readPin(one.id, one.endpoint))
            assertNull(harness.savedCatalog().find(one.id))
            assertTrue(registry.snapshot.value.hosts.none { it.hostId == one.id })
            assertNull(registry.snapshot.value.notice)
            assertEquals(1, harness.listener.lost.size)
            registry.close()
        }
    }

    @Test
    fun `a pin that could not be cleared is reported instead of claimed`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            harness.pins.refuseClears = StorageFailureReason.UNAVAILABLE

            registry.remove(one.id)
            advanceUntilIdle()

            assertNotNull(registry.snapshot.value.notice)
            assertEquals(RegistryNoticeReason.PIN_NOT_CLEARED, registry.snapshot.value.notice!!.reason)
            assertIs<PinRead.Remembered>(harness.readPin(one.id, one.endpoint))
            registry.close()
        }
    }

    @Test
    fun `a terminal authorization failure is never retried automatically`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            harness.onTransport(one.endpoint) { openFailure = PeerTransportErrorCode.APP_REFUSED }
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            advanceUntilIdle()

            assertEquals(1, harness.transports.size)
            assertEquals(HostConnectionPhase.ERROR, registry.snapshot.value.host(one.id).phase)
            assertEquals(HostConnectionReason.NOT_AUTHORIZED, registry.snapshot.value.host(one.id).reason)

            advanceTimeBy(600_000L)
            advanceUntilIdle()
            assertEquals(1, harness.transports.size, "a refused grant is not hammered")
            registry.close()
        }
    }

    @Test
    fun `a missing local network grant is named as itself and never blocks other dials`() = runTest {
        RegistryHarness().use { harness ->
            val lan = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(lan))
            harness.seedPins(listOf(lan))
            harness.identity.status = PeerIdentityStatus.Ready
            var asked = 0
            val registry = harness.registry(
                StandardTestDispatcher(testScheduler),
                networkAccess = NetworkAccessAdmission { asked += 1; false },
            )
            registry.start()
            registry.connect(lan.id)
            advanceUntilIdle()

            assertEquals(1, asked)
            assertTrue(harness.transports.isEmpty(), "no socket is opened behind a refused grant")
            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(lan.id).phase)
            assertEquals(
                HostConnectionReason.LOCAL_NETWORK_UNAVAILABLE,
                registry.snapshot.value.host(lan.id).reason,
            )
            assertTrue(
                !registry.snapshot.value.host(lan.id).reason.terminal,
                "a permission gap is not a permanent verdict on the host",
            )
            registry.close()
        }
    }

    @Test
    fun `settings toggles copy the preference and move the generation`() = runTest {
        RegistryHarness().use { harness ->
            harness.seedSettings(RegistryFixtures.settings(RegistryFixtures.host(1)))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            val first = registry.snapshot.value
            assertFalse(first.autoReconnectEnabled, "auto starts off")
            assertTrue(first.viewerRemoteInputEnabled, "remote input ships on: $first")

            assertIs<HostCommandResult.Accepted>(registry.setAutoReconnect(true))
            assertIs<HostCommandResult.Accepted>(registry.setViewerRemoteInputEnabled(false))

            val second = registry.snapshot.value
            assertTrue(second.autoReconnectEnabled, "switch: $second")
            assertFalse(second.viewerRemoteInputEnabled, "switch: $second")
            assertTrue(second.settingsGeneration > first.settingsGeneration, "generation: $second")
            assertTrue(harness.savedSettings()!!.autoReconnect, "durable: ${harness.savedSettings()}")
            assertFalse(harness.savedSettings()!!.viewerRemoteInputEnabled, "durable")
            registry.close()
        }
    }

    @Test
    fun `saved first reply timeout defaults to sixty and a custom value survives restart`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(
                RegistryFixtures.settings(one, autoReconnect = true)
                    .withViewerRemoteInputEnabled(false),
            )
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                assertEquals(60, registry.snapshot.value.savedFirstReplyTimeoutSeconds)
                val generationBefore = registry.snapshot.value.settingsGeneration

                assertIs<HostCommandResult.Accepted>(registry.setSavedFirstReplyTimeoutSeconds(120))

                assertEquals(120, registry.snapshot.value.savedFirstReplyTimeoutSeconds)
                assertEquals(generationBefore + 1, registry.snapshot.value.settingsGeneration)
                assertEquals(120, harness.savedSettings()!!.savedFirstReplyTimeoutSeconds)
                assertTrue(harness.savedSettings()!!.autoReconnect)
                assertFalse(harness.savedSettings()!!.viewerRemoteInputEnabled)
                assertEquals(listOf(one), harness.savedCatalog().hosts)
            } finally {
                registry.close()
            }

            val restarted = harness.restartingRegistry(StandardTestDispatcher(testScheduler))
            restarted.start()
            try {
                assertEquals(120, restarted.snapshot.value.savedFirstReplyTimeoutSeconds)
                assertEquals(120, harness.savedSettings()!!.savedFirstReplyTimeoutSeconds)
            } finally {
                restarted.close()
            }
        }
    }

    @Test
    fun `saved timeout save preserves every other settings fact and a failed write publishes nothing`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true, suppressed = true)
            val two = RegistryFixtures.host(2)
            harness.seedSettings(
                RegistryFixtures.settings(one, two, autoReconnect = true)
                    .withViewerRemoteInputEnabled(false)
                    .withSavedFirstReplyTimeoutSeconds(90),
            )
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                val savedBefore = harness.savedSettings()!!
                assertIs<HostCommandResult.Accepted>(registry.setSavedFirstReplyTimeoutSeconds(1))

                // Only the new preference moves; hosts, history, suppression, Auto,
                // viewer input, and catalog order stay exactly as saved.
                assertEquals(savedBefore.copy(savedFirstReplyTimeoutSeconds = 1), harness.savedSettings())
                assertEquals(listOf(one.id, two.id), harness.savedCatalog().hosts.map { it.id })

                val beforeFailure = registry.snapshot.value
                val durableBeforeFailure = harness.savedSettings()
                harness.settings.refuseWrites = StorageFailureReason.WRITE_FAILED

                val refused = registry.setSavedFirstReplyTimeoutSeconds(120)
                assertIs<HostCommandResult.Refused>(refused)
                assertEquals(HostCommandRefusal.SETTINGS_UNAVAILABLE, refused.reason)

                val afterFailure = registry.snapshot.value
                assertEquals(beforeFailure.savedFirstReplyTimeoutSeconds, afterFailure.savedFirstReplyTimeoutSeconds)
                assertEquals(beforeFailure.settingsGeneration, afterFailure.settingsGeneration)
                assertEquals(durableBeforeFailure, harness.savedSettings())
                assertEquals(RegistryNoticeReason.SETTINGS_WRITE_FAILED, afterFailure.notice?.reason)
                assertFalse(afterFailure.storage.settings.available)
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `an invalid saved timeout is refused before any settings write`() = runTest {
        RegistryHarness().use { harness ->
            harness.seedSettings(RegistryFixtures.settings(RegistryFixtures.host(1)))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                val before = registry.snapshot.value
                val writesBefore = harness.settings.writes

                for (invalid in listOf(0, -1, NetworkSettings.MAX_SAVED_FIRST_REPLY_TIMEOUT_SECONDS + 1)) {
                    val result = registry.setSavedFirstReplyTimeoutSeconds(invalid)
                    assertIs<HostCommandResult.Refused>(result)
                    assertEquals(HostCommandRefusal.INVALID_VALUE, result.reason)
                }

                assertEquals(60, registry.snapshot.value.savedFirstReplyTimeoutSeconds)
                assertEquals(before.settingsGeneration, registry.snapshot.value.settingsGeneration)
                assertEquals(writesBefore, harness.settings.writes)
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `a saved timeout save never repairs or rewrites unreadable settings`() = runTest {
        RegistryHarness().use { harness ->
            harness.seedSettings(RegistryFixtures.settings(RegistryFixtures.host(1)))
            harness.settings.refuseReads = StorageFailureReason.MALFORMED
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                val writesBefore = harness.settings.writes
                val result = registry.setSavedFirstReplyTimeoutSeconds(120)

                assertIs<HostCommandResult.Refused>(result)
                assertEquals(HostCommandRefusal.SETTINGS_UNAVAILABLE, result.reason)
                assertEquals(60, registry.snapshot.value.savedFirstReplyTimeoutSeconds)
                assertEquals(writesBefore, harness.settings.writes)
                assertFalse(registry.snapshot.value.storage.settings.available)
            } finally {
                registry.close()
            }
        }
    }

    @Test
    fun `a refused settings write keeps the in-memory change and says so`() = runTest {
        RegistryHarness().use { harness ->
            harness.seedSettings(RegistryFixtures.settings(RegistryFixtures.host(1)))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            harness.settings.refuseWrites = StorageFailureReason.WRITE_FAILED

            val result = registry.setAutoReconnect(true)
            assertIs<HostCommandResult.Refused>(result)
            assertEquals(HostCommandRefusal.SETTINGS_UNAVAILABLE, result.reason)

            // The switch the user just moved stays moved for this session, and
            // the snapshot says the durable copy failed.
            assertTrue(registry.snapshot.value.autoReconnectEnabled)
            assertFalse(registry.snapshot.value.storage.settings.available)
            assertEquals(RegistryNoticeReason.SETTINGS_WRITE_FAILED, registry.snapshot.value.notice?.reason)
            assertFalse(harness.savedSettings()!!.autoReconnect)
            registry.close()
        }
    }

    @Test
    fun `reload adopts a catalog saved elsewhere without disturbing live hosts`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            val two = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()

            // A different screen added a host while this registry was running.
            harness.seedSettings(RegistryFixtures.settings(one, two))
            harness.seedPins(listOf(two))
            assertIs<HostCommandResult.Accepted>(registry.reload())
            advanceUntilIdle()

            assertEquals(setOf(one.id, two.id), registry.snapshot.value.hosts.map { it.hostId }.toSet())
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(one.id).phase)
            assertEquals(1, harness.transports.size, "the live host was not re-dialed")
            registry.close()
        }
    }

    @Test
    fun `a host re-pointed elsewhere drops the old connection and reports it once`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            advanceUntilIdle()
            val epoch = registry.snapshot.value.host(one.id).generation
            val channel = harness.listener.available.single().channel as FakeChannel

            val moved = ConfiguredHost(
                id = one.id,
                label = one.label,
                endpoint = RegistryFixtures.endpoint(50),
                previouslyConnected = one.previouslyConnected,
                reconnectSuppressed = one.reconnectSuppressed,
            )
            harness.seedSettings(RegistryFixtures.settings(moved))
            registry.reload()
            advanceUntilIdle()

            assertTrue(harness.transports.single().disposed)
            assertEquals(moved.endpoint, registry.snapshot.value.host(one.id).endpoint)
            assertEquals(HostConnectionPhase.DISCONNECTED, registry.snapshot.value.host(one.id).phase)

            // A reload that succeeded still owes the coordinator the channel it
            // took away, naming the generation it handed over.
            assertEquals(1, harness.listener.lost.size)
            assertEquals(one.id, harness.listener.lost.single().hostId)
            assertEquals(epoch, harness.listener.lost.single().generation)
            assertEquals(HostConnectionReason.CONNECTION_LOST, harness.listener.lost.single().reason)
            assertTrue(!harness.listener.lost.single().stale)

            // The stable host keeps its exact key, not the old locator. This
            // fixture's new address proves a different key, which must refuse.
            assertEquals(PinRead.Remembered(harness.storedPeerKey(one.endpoint)),
                harness.readPin(one.id, moved.endpoint))
            registry.connect(one.id)
            advanceUntilIdle()
            assertEquals(HostConnectionPhase.ERROR, registry.snapshot.value.host(one.id).phase)
            assertEquals(HostConnectionReason.PEER_KEY_CHANGED, registry.snapshot.value.host(one.id).reason)

            // A late closure of the disposed channel adds no second report.
            channel.endWith(1006, "late peer close")
            advanceUntilIdle()
            assertEquals(1, harness.listener.lost.size, "one handed-off generation reported twice")
            registry.close()
        }
    }

    @Test
    fun `a host removed from the catalog elsewhere reports its channel once`() = runTest {
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
            assertEquals(2, harness.listener.available.size)
            val epochs = registry.snapshot.value.hosts.associate { it.hostId to it.generation }

            // Another screen deleted one of the two hosts.
            harness.seedSettings(RegistryFixtures.settings(two))
            assertIs<HostCommandResult.Accepted>(registry.reload())
            advanceUntilIdle()

            // The vanished association reports the channel it had handed off.
            assertEquals(1, harness.listener.lost.size)
            assertEquals(one.id, harness.listener.lost.single().hostId)
            assertEquals(epochs.getValue(one.id), harness.listener.lost.single().generation)
            assertEquals(HostConnectionReason.CONNECTION_LOST, harness.listener.lost.single().reason)

            // The host nobody touched keeps its live session and says nothing.
            assertTrue(registry.snapshot.value.hosts.none { it.hostId == one.id })
            assertEquals(HostConnectionPhase.CONNECTED, registry.snapshot.value.host(two.id).phase)
            val live = harness.transports.first { it.endpoint?.host == two.endpoint.host }
            assertTrue(!live.disposed, "an unchanged host was disturbed by a reload")

            // Late closure of the disposed channel adds no second report.
            harness.transports.first { it.endpoint?.host == one.endpoint.host }.channels.single()
                .endWith(1006, "late peer close")
            advanceUntilIdle()
            assertEquals(1, harness.listener.lost.size, "one handed-off generation reported twice")
            registry.close()
        }
    }
}
