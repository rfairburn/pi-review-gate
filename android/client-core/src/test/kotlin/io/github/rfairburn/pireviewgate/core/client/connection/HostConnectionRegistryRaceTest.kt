package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.identity.IdentityFailureReason
import io.github.rfairburn.pireviewgate.core.identity.PinRead
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The failures that only exist when two things happen at once.
 *
 * Every other check in this package can run on one dispatcher, because the
 * question it asks is about order within a single thread. These cannot. A pairing
 * commit is IO with a lock-free gap around it, and saved configuration is one
 * whole document that two callers may both be holding a newer copy of. A test that
 * schedules them politely never sees either defect.
 *
 * So these checks use real threads and real bounded latches, and they assert on
 * what durable storage ends up holding — not on what a caller was told.
 */
class HostConnectionRegistryRaceTest {

    private fun HostConnectionRegistry.hostOf(id: HostId): HostConnectionSnapshot =
        snapshot.value.hosts.first { it.hostId == id }

    /**
     * Wait, within a fixed budget, for a fact a background thread is producing.
     *
     * Bounded on purpose: a race that never resolves must fail the test, not hang
     * the build.
     */
    private fun awaitWithin(timeoutMs: Long = 5_000L, predicate: () -> Boolean): Boolean {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (System.nanoTime() < deadline) {
            if (predicate()) return true
            Thread.sleep(2L)
        }
        return predicate()
    }

    @Test
    fun `a pairing commit racing a removal cannot recreate the pin it forgot`() {
        val harness = RegistryHarness()
        try {
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.identity.status = PeerIdentityStatus.Ready
            // The registry runs on a real dispatcher: its attempt coroutine will be
            // parked inside the durable record, and the test thread must stay free
            // to retire the association underneath it.
            val registry = harness.registry(Dispatchers.IO)
            registry.start()

            val insideRecord = CountDownLatch(1)
            val allowRecordToFinish = CountDownLatch(1)
            harness.pins.onRecord = {
                insideRecord.countDown()
                assertTrue(
                    allowRecordToFinish.await(5L, TimeUnit.SECONDS),
                    "the blocked pairing commit never resumed",
                )
            }

            registry.connect(one.id)
            answerThePrompt(harness, registry)
            assertTrue(
                insideRecord.await(5L, TimeUnit.SECONDS),
                "the explicit attempt never reached its pairing commit",
            )

            // The operator removes the host while that write is in flight. Removal
            // has to wait for the commit to finish, and then forget the key.
            val removeDone = java.util.concurrent.CompletableFuture.runAsync {
                assertIs<HostCommandResult.Accepted>(registry.remove(one.id))
            }
            allowRecordToFinish.countDown()

            // Both operations are awaited before durable storage is inspected, so
            // the assertion cannot be satisfied by a write that has not happened.
            removeDone.get(10L, TimeUnit.SECONDS)
            assertTrue(
                awaitWithin { harness.pins.recorded.isNotEmpty() },
                "the explicit attempt never committed its pairing",
            )
            assertTrue(
                awaitWithin { registry.snapshot.value.hosts.none { it.hostId == one.id } },
                "a retired attempt recreated its host entry",
            )
            // And it cannot leave durable trust behind for an association the
            // operator forgot.
            assertEquals(
                PinRead.NoPin,
                harness.readPin(one.id, one.endpoint),
                "removal did not win the pairing commit it raced",
            )
            assertTrue(harness.transports.all { it.disposed })
            registry.close()
        } finally {
            harness.close()
        }
    }

    @Test
    fun `a pairing commit racing a background keeps the key it proved and closes the link`() {
        val harness = RegistryHarness()
        try {
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(Dispatchers.IO)
            registry.start()

            val insideRecord = CountDownLatch(1)
            val allowRecordToFinish = CountDownLatch(1)
            harness.pins.onRecord = {
                insideRecord.countDown()
                assertTrue(allowRecordToFinish.await(5L, TimeUnit.SECONDS))
            }

            registry.connect(one.id)
            answerThePrompt(harness, registry)
            assertTrue(insideRecord.await(5L, TimeUnit.SECONDS))

            // The app leaves the foreground mid-commit. Retirement now waits at the
            // registry lock instead of slipping past a pre-write check.
            val backgroundDone = java.util.concurrent.CompletableFuture.runAsync { registry.leaveForeground() }
            allowRecordToFinish.countDown()
            backgroundDone.get(10L, TimeUnit.SECONDS)
            assertTrue(
                awaitWithin { harness.pins.recorded.isNotEmpty() },
                "the explicit attempt never committed its pairing",
            )

            // Backgrounding closes connections. It does not forget trust the user
            // never revoked, so the key this handshake proved stays remembered.
            assertIs<PinRead.Remembered>(
                harness.readPin(one.id, one.endpoint),
            )
            assertEquals(0, harness.pins.clears.size, "a pairing commit cleared a pin as compensation")
            assertTrue(
                awaitWithin { !registry.snapshot.value.hosts.any { it.hostId == one.id && it.phase == HostConnectionPhase.CONNECTED } },
                "a backgrounded attempt kept its connection live",
            )
            assertFalse(
                registry.snapshot.value.hosts.first { it.hostId == one.id }.autoEligible &&
                    registry.snapshot.value.autoReconnectEnabled,
            )
            registry.close()
        } finally {
            harness.close()
        }
    }

    @Test
    fun `a commit that only re-proved a long-remembered key never clears it`() {
        val harness = RegistryHarness()
        try {
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            // The association has been paired for a long time. This handshake does
            // not change it, so record() answers Unchanged — the branch that a
            // compensating cleanup would mistake for something it should roll back.
            harness.seedPins(listOf(one))
            val rememberedBefore = assertIs<PinRead.Remembered>(harness.readPin(one.id, one.endpoint))
            val registry = harness.registry(Dispatchers.IO)
            registry.start()

            val insideRecord = CountDownLatch(1)
            val allowRecordToFinish = CountDownLatch(1)
            harness.pins.onRecord = {
                insideRecord.countDown()
                assertTrue(allowRecordToFinish.await(5L, TimeUnit.SECONDS))
            }

            registry.connect(one.id)
            assertTrue(
                insideRecord.await(5L, TimeUnit.SECONDS),
                "the explicit attempt never reached its pairing commit",
            )

            val backgroundDone = java.util.concurrent.CompletableFuture.runAsync { registry.leaveForeground() }
            allowRecordToFinish.countDown()
            backgroundDone.get(10L, TimeUnit.SECONDS)
            assertTrue(awaitWithin { harness.pins.recorded.isNotEmpty() })

            assertEquals(0, harness.pins.clears.size, "an Unchanged pairing commit cleared a durable pin")
            val after = assertIs<PinRead.Remembered>(harness.readPin(one.id, one.endpoint))
            assertEquals(rememberedBefore.key.keyId, after.key.keyId, "the remembered key was replaced")
            registry.close()
        } finally {
            harness.close()
        }
    }

    @Test
    fun `an identity that became unreadable during pairing cannot have its key remembered`() {
        val harness = RegistryHarness()
        try {
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(Dispatchers.IO)
            registry.start()

            registry.connect(one.id)
            assertTrue(
                awaitWithin { registry.snapshot.value.pendingConsents.isNotEmpty() },
                "the explicit attempt never latched a confirmation",
            )

            // The handshake is already under way and the registry cached a healthy
            // identity before it. The local key is withdrawn before the commit.
            harness.identity.status = PeerIdentityStatus.Refused(IdentityFailureReason.KEY_STORE_UNAVAILABLE)
            val consent = registry.snapshot.value.pendingConsents.single()
            harness.prompt.presenting = consent.consentId
            assertIs<HostKeyConsentResolution.Applied>(
                registry.decideKeyConsent(
                    HostKeyConsentChoice.APPROVE,
                    HostKeyConsentProof(consent.consentId, consent.hostId, consent.generation, consent.foregroundEpoch),
                ),
            )

            assertTrue(
                awaitWithin(10_000L) {
                    registry.snapshot.value.hosts.firstOrNull { it.hostId == one.id }?.reason ==
                        HostConnectionReason.IDENTITY_UNAVAILABLE
                },
                "a commit against an unreadable identity was not refused: " +
                    registry.snapshot.value.hosts.first { it.hostId == one.id },
            )
            // Nothing was written under an identity this device can no longer prove.
            assertEquals(0, harness.pins.recorded.size)
            assertEquals(PinRead.NoPin, harness.readPin(one.id, one.endpoint))
            assertTrue(
                registry.snapshot.value.hosts.first { it.hostId == one.id }.peerFingerprint == null,
            )
            registry.close()
        } finally {
            harness.close()
        }
    }

    @Test
    fun `a removal cannot be reconnected underneath itself`() {
        val harness = RegistryHarness()
        try {
            val one = RegistryFixtures.host(1, previouslyConnected = true)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = false))
            harness.seedPins(listOf(one))
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(Dispatchers.IO)
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            assertTrue(awaitWithin { registry.hostOf(one.id).phase == HostConnectionPhase.CONNECTED })
            assertTrue(awaitWithin { harness.listener.available.isNotEmpty() })
            val transportsBefore = harness.transports.size

            // Removal delivers its loss report outside the registry lock, which is
            // precisely the window a replacement dial used to slip into. Hold it open.
            val insideLossCallback = CountDownLatch(1)
            val allowLossCallbackToFinish = CountDownLatch(1)
            val blocking = object : HostConnectionListener {
                override fun onAppChannelAvailable(channel: HostAppChannel) = Unit
                override fun onContentChannelAvailable(channel: HostContentChannel) = Unit

                override fun onChannelLost(lost: HostChannelLost) {
                    insideLossCallback.countDown()
                    assertTrue(
                        allowLossCallbackToFinish.await(5L, TimeUnit.SECONDS),
                        "the paused removal never resumed",
                    )
                }
            }
            registry.addListener(blocking)

            val removeDone = java.util.concurrent.CompletableFuture.supplyAsync { registry.remove(one.id) }
            assertTrue(
                insideLossCallback.await(5L, TimeUnit.SECONDS),
                "removal never reached its loss callback",
            )

            // Explicit Connect: refused, not orphaned.
            val connect = registry.connect(one.id)
            assertIs<HostCommandResult.Refused>(connect)
            assertEquals(HostCommandRefusal.ATTEMPT_IN_FLIGHT, connect.reason)

            // Automatic reconnect: the fence suppresses it as well.
            assertIs<HostCommandResult.Accepted>(registry.setAutoReconnect(true))

            // Resume: platform continuation candidates naming a host that is being
            // removed dial nothing.
            registry.enterForeground(continuationCandidates = listOf(one.id))

            assertEquals(
                transportsBefore,
                harness.transports.size,
                "a replacement was admitted while a removal was in progress",
            )

            allowLossCallbackToFinish.countDown()
            assertIs<HostCommandResult.Accepted>(removeDone.get(10L, TimeUnit.SECONDS))

            assertTrue(
                awaitWithin { registry.snapshot.value.hosts.none { it.hostId == one.id } },
                "the removal did not finish",
            )
            // Nothing owned survives: no orphaned transport is left connected.
            assertTrue(
                awaitWithin { harness.transports.all { it.disposed } },
                "a transport outlived the removal that replaced its host: " +
                    harness.transports.map { it.endpoint?.host to it.disposed },
            )
            assertEquals(PinRead.NoPin, harness.readPin(one.id, one.endpoint))
            assertTrue(
                registry.snapshot.value.hosts.none { it.hostId == one.id },
                "published eligibility outlived the association it described",
            )
            registry.removeListener(blocking)
            registry.close()
        } finally {
            harness.close()
        }
    }

    /**
     * Let a first-use confirmation through from another thread.
     *
     * An unkeyed host pairs, and pairing latches a prompt. These races are about
     * what happens after the prompt, so the test commits the frame, answers, and
     * then waits for the attempt to be parked inside its durable record.
     */
    private fun answerThePrompt(harness: RegistryHarness, registry: HostConnectionRegistry) {
        assertTrue(
            awaitWithin { registry.snapshot.value.pendingConsents.isNotEmpty() },
            "the explicit attempt never latched a confirmation",
        )
        val consent = registry.snapshot.value.pendingConsents.single()
        harness.prompt.presenting = consent.consentId
        val resolution = registry.decideKeyConsent(
            HostKeyConsentChoice.APPROVE,
            HostKeyConsentProof(consent.consentId, consent.hostId, consent.generation, consent.foregroundEpoch),
        )
        assertIs<HostKeyConsentResolution.Applied>(resolution)
    }

    @Test
    fun `two settings publications cannot roll each other back on disk`() {
        val harness = RegistryHarness()
        try {
            val first = RegistryFixtures.host(1)
            val second = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(first, second))
            harness.seedPins(listOf(first, second))
            val registry = harness.registry(Dispatchers.IO)
            registry.start()

            val insideFirstWrite = CountDownLatch(1)
            val allowFirstWriteToFinish = CountDownLatch(1)
            val firstWrite = java.util.concurrent.atomic.AtomicBoolean(true)
            harness.settings.onWrite = {
                if (firstWrite.compareAndSet(true, false)) {
                    insideFirstWrite.countDown()
                    assertTrue(
                        allowFirstWriteToFinish.await(5L, TimeUnit.SECONDS),
                        "the held settings publication never resumed",
                    )
                }
            }

            // A stops one host. Its write is now parked inside the store.
            val aDone = java.util.concurrent.CompletableFuture.runAsync {
                assertIs<HostCommandResult.Accepted>(registry.disconnect(first.id))
            }
            assertTrue(
                insideFirstWrite.await(5L, TimeUnit.SECONDS),
                "the first disconnect never reached the store",
            )

            // B stops another host while A is still publishing. B's document is
            // the newer one and must be the one that survives.
            val bEnteredStore = CountDownLatch(1)
            val bDone = java.util.concurrent.CompletableFuture.runAsync {
                bEnteredStore.countDown()
                assertIs<HostCommandResult.Accepted>(registry.disconnect(second.id))
            }
            assertTrue(bEnteredStore.await(5L, TimeUnit.SECONDS))
            // Bounded pause so B genuinely attempts its write while A is still
            // inside the store. Without ordered publication, that is where the two
            // would collide and the older document could land last.
            Thread.sleep(250L)
            allowFirstWriteToFinish.countDown()

            aDone.get(10L, TimeUnit.SECONDS)
            bDone.get(10L, TimeUnit.SECONDS)

            assertFalse(harness.settings.overlapped, "two settings publications ran at once")

            // The fact that matters: reopening the storage shows both stops, not
            // just whichever document happened to win.
            val reopened = harness.restartingRegistry(Dispatchers.IO)
            reopened.start()
            val hosts = reopened.snapshot.value.hosts.associate { it.hostId to it.reconnectSuppressed }
            assertEquals(
                mapOf(first.id to true, second.id to true),
                hosts,
                "a concurrent publication rolled a manual Disconnect back on disk",
            )
            reopened.close()
            registry.close()
        } finally {
            harness.close()
        }
    }

    @Test
    fun `connection history written concurrently survives reopening storage`() {
        val harness = RegistryHarness()
        try {
            val hosts = (1..4).map { RegistryFixtures.host(it) }
            harness.seedSettings(RegistryFixtures.settings(*hosts.toTypedArray()))
            harness.seedPins(hosts)
            harness.identity.status = PeerIdentityStatus.Ready
            val registry = harness.registry(Dispatchers.IO)
            registry.start()

            // Every host connects at once, and each success marks its own history.
            hosts.forEach { registry.connect(it.id) }
            assertTrue(
                awaitWithin(10_000L) {
                    registry.snapshot.value.hosts.count { it.phase == HostConnectionPhase.CONNECTED } == hosts.size
                },
                "not every host connected: " + registry.snapshot.value.hosts.map { it.phase },
            )
            // CONNECTED in memory is not the durable fact. One host's settings
            // publication republishes the snapshot for all of them, so wait for
            // every history mark to have actually reached the store.
            assertTrue(
                awaitWithin(10_000L) { harness.settings.writes == hosts.size },
                "not every connection history mark reached the store: " + harness.settings.writes,
            )

            val reopened = harness.restartingRegistry(Dispatchers.IO)
            reopened.start()
            val remembered = reopened.snapshot.value.hosts.associate { it.hostId to it.previouslyConnected }
            assertEquals(
                hosts.associate { it.id to true },
                remembered,
                "concurrent connection history lost a host on disk",
            )
            reopened.close()
            registry.close()
        } finally {
            harness.close()
        }
    }

    @Test
    fun `a settings read that fails after a healthy connection forces remote input off`() {
        val harness = RegistryHarness()
        try {
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(Dispatchers.IO)
            registry.start()
            assertTrue(registry.snapshot.value.viewerRemoteInputEnabled)
            registry.connect(one.id)
            assertTrue(awaitWithin { registry.hostOf(one.id).phase == HostConnectionPhase.CONNECTED })

            harness.settings.refuseReads = StorageFailureReason.UNREADABLE
            val result = registry.reload()

            assertIs<HostCommandResult.Refused>(result)
            assertEquals(HostCommandRefusal.SETTINGS_UNAVAILABLE, result.reason)
            assertFalse(
                registry.snapshot.value.viewerRemoteInputEnabled,
                "an unreadable preference document was treated as enabled",
            )
            assertEquals(
                RegistryNoticeReason.SETTINGS_UNREADABLE,
                registry.snapshot.value.notice?.reason,
            )
            registry.close()
        } finally {
            harness.close()
        }
    }

    @Test
    fun `a trust read that fails after a healthy connection refuses its next frame`() {
        val harness = RegistryHarness()
        try {
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(Dispatchers.IO)
            registry.addListener(harness.listener)
            registry.start()
            registry.connect(one.id)
            assertTrue(awaitWithin { registry.hostOf(one.id).phase == HostConnectionPhase.CONNECTED })
            // The snapshot can report CONNECTED a moment before the channel is
            // handed over, so wait for the handoff itself.
            assertTrue(awaitWithin { harness.listener.available.isNotEmpty() })
            val channel = harness.listener.available.single().channel as FakeChannel
            val epoch = registry.hostOf(one.id).generation
            runBlocking { channel.send("first".toByteArray()) }
            assertEquals(1, channel.sends.size)

            harness.pins.refuseReads = StorageFailureReason.UNREADABLE
            val result = registry.reload()

            assertIs<HostCommandResult.Refused>(result)
            assertEquals(HostCommandRefusal.TRUST_UNAVAILABLE, result.reason)
            assertEquals(
                RegistryNoticeReason.TRUST_UNREADABLE,
                registry.snapshot.value.notice?.reason,
            )

            // The live channel's next frame is refused: the registry cannot
            // confirm the key it is writing against, so it does not write.
            assertEquals(0, channel.dropped)
            runBlocking {
                val refused = runCatching { channel.send("second".toByteArray()) }.isFailure
                assertTrue(refused, "a frame was admitted against unverifiable trust")
            }
            assertEquals(1, channel.dropped)
            assertEquals(1, channel.sends.size)

            // Retirement marks the watcher already-reported so the later socket
            // closure stays silent, which means reload itself owes the coordinator
            // its loss report — exactly once, naming the generation it handed over.
            val lost = harness.listener.lost.toList()
            assertEquals(1, lost.size, "trust retirement did not report the channel it closed")
            assertEquals(one.id, lost.single().hostId)
            assertEquals(epoch, lost.single().generation)
            assertEquals(HostConnectionReason.TRUST_UNAVAILABLE, lost.single().reason)
            assertTrue(!lost.single().stale)

            // Let the disposed channel's own closure land. It must not add a second,
            // contradicting report for the same generation.
            assertTrue(awaitWithin { harness.transports.single().disposed })
            channel.endWith(1006, "late peer close after disposal")
            Thread.sleep(250L)
            assertEquals(1, harness.listener.lost.size, "one handed-off generation reported twice")
            registry.close()
        } finally {
            harness.close()
        }
    }

    @Test
    fun `a reload holding an old document cannot undo a concurrent Disconnect`() {
        val harness = RegistryHarness()
        try {
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one))
            harness.seedPins(listOf(one))
            val registry = harness.registry(Dispatchers.IO)
            registry.start()
            registry.connect(one.id)
            assertTrue(awaitWithin { registry.hostOf(one.id).phase == HostConnectionPhase.CONNECTED })

            // Pause reload right where it has the pre-Disconnect document in hand.
            val insideRead = CountDownLatch(1)
            val allowReadToFinish = CountDownLatch(1)
            harness.settings.onRead = {
                insideRead.countDown()
                assertTrue(
                    allowReadToFinish.await(5L, TimeUnit.SECONDS),
                    "the paused reload never resumed",
                )
            }
            val reloadDone = java.util.concurrent.CompletableFuture.supplyAsync { registry.reload() }
            assertTrue(insideRead.await(5L, TimeUnit.SECONDS), "reload never reached its read")

            // The operator stops the host while that reload is still in flight.
            val disconnectDone = java.util.concurrent.CompletableFuture.runAsync {
                assertIs<HostCommandResult.Accepted>(registry.disconnect(one.id))
            }
            // Bounded pause so the Disconnect genuinely attempts its publication
            // while reload is still holding the transaction.
            Thread.sleep(250L)
            allowReadToFinish.countDown()

            // Both calls are awaited before anything is asserted.
            assertIs<HostCommandResult.Accepted>(reloadDone.get(10L, TimeUnit.SECONDS))
            disconnectDone.get(10L, TimeUnit.SECONDS)

            assertTrue(
                awaitWithin { registry.snapshot.value.hosts.first { it.hostId == one.id }.reconnectSuppressed },
                "a reload adopted a document older than the Disconnect",
            )
            val reopened = harness.restartingRegistry(Dispatchers.IO)
            reopened.start()
            assertTrue(
                reopened.snapshot.value.hosts.first { it.hostId == one.id }.reconnectSuppressed,
                "the Disconnect did not survive on disk",
            )
            reopened.close()
            registry.close()
        } finally {
            harness.close()
        }
    }
}

private fun HostConnectionRegistry.hostOfOrNull(id: HostId): HostConnectionSnapshot? =
    snapshot.value.hosts.firstOrNull { it.hostId == id }
