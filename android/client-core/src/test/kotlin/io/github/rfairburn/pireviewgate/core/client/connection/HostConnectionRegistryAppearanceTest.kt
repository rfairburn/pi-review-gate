package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.AppAppearance
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The saved app appearance through the real durable settings document.
 *
 * Light ships and stays in force until the operator chooses otherwise; a saved
 * choice survives a process restart; a refused write publishes nothing; and a
 * presentation preference never disturbs a connection.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HostConnectionRegistryAppearanceTest {

    @Test
    fun `appearance is light until saved and a saved dark choice survives restart`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(
                RegistryFixtures.settings(one, autoReconnect = true)
                    .withViewerRemoteInputEnabled(false),
            )
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                assertEquals(
                    AppAppearance.LIGHT,
                    registry.snapshot.value.appearance,
                    "the app ships light: ${registry.snapshot.value}",
                )
                val generationBefore = registry.snapshot.value.settingsGeneration

                assertIs<HostCommandResult.Accepted>(registry.setAppearance(AppAppearance.DARK))

                assertEquals(AppAppearance.DARK, registry.snapshot.value.appearance)
                assertEquals(generationBefore + 1, registry.snapshot.value.settingsGeneration)
                assertEquals(AppAppearance.DARK, harness.savedSettings()!!.appearance)
                assertTrue(harness.savedSettings()!!.autoReconnect)
                assertFalse(harness.savedSettings()!!.viewerRemoteInputEnabled)
                assertEquals(listOf(one), harness.savedCatalog().hosts)
            } finally {
                registry.close()
            }

            val restarted = harness.restartingRegistry(StandardTestDispatcher(testScheduler))
            restarted.start()
            try {
                assertEquals(AppAppearance.DARK, restarted.snapshot.value.appearance)
                assertEquals(AppAppearance.DARK, harness.savedSettings()!!.appearance)
            } finally {
                restarted.close()
            }
        }
    }

    @Test
    fun `choosing light again is saved and survives restart`() = runTest {
        RegistryHarness().use { harness ->
            harness.seedSettings(RegistryFixtures.settings(RegistryFixtures.host(1)))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                assertIs<HostCommandResult.Accepted>(registry.setAppearance(AppAppearance.DARK))
                assertEquals(AppAppearance.DARK, harness.savedSettings()!!.appearance)

                assertIs<HostCommandResult.Accepted>(registry.setAppearance(AppAppearance.LIGHT))
                assertEquals(AppAppearance.LIGHT, registry.snapshot.value.appearance)
                assertEquals(AppAppearance.LIGHT, harness.savedSettings()!!.appearance)
            } finally {
                registry.close()
            }

            val restarted = harness.restartingRegistry(StandardTestDispatcher(testScheduler))
            restarted.start()
            try {
                assertEquals(AppAppearance.LIGHT, restarted.snapshot.value.appearance)
            } finally {
                restarted.close()
            }
        }
    }

    @Test
    fun `an appearance save preserves every other settings fact and a failed write publishes nothing`() = runTest {
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
                assertIs<HostCommandResult.Accepted>(registry.setAppearance(AppAppearance.DARK))

                // Only the new preference moves; hosts, history, suppression, Auto,
                // viewer input, the saved timeout, diagnostic messaging, and catalog
                // order stay exactly as saved.
                assertEquals(savedBefore.copy(appearance = AppAppearance.DARK), harness.savedSettings())
                assertEquals(listOf(one.id, two.id), harness.savedCatalog().hosts.map { it.id })

                val beforeFailure = registry.snapshot.value
                val durableBeforeFailure = harness.savedSettings()
                harness.settings.refuseWrites = StorageFailureReason.WRITE_FAILED

                val refused = registry.setAppearance(AppAppearance.LIGHT)
                assertIs<HostCommandResult.Refused>(refused)
                assertEquals(HostCommandRefusal.SETTINGS_UNAVAILABLE, refused.reason)

                // An appearance whose save failed stays exactly as it was: nothing is
                // published from memory and nothing else is disturbed.
                val afterFailure = registry.snapshot.value
                assertEquals(beforeFailure.appearance, afterFailure.appearance)
                assertEquals(beforeFailure.savedFirstReplyTimeoutSeconds, afterFailure.savedFirstReplyTimeoutSeconds)
                assertEquals(beforeFailure.autoReconnectEnabled, afterFailure.autoReconnectEnabled)
                assertEquals(beforeFailure.viewerRemoteInputEnabled, afterFailure.viewerRemoteInputEnabled)
                assertEquals(beforeFailure.debugInputMessagingEnabled, afterFailure.debugInputMessagingEnabled)
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
    fun `switching appearance creates no attempt and retires no transport`() = runTest {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1)
            harness.seedSettings(RegistryFixtures.settings(one, autoReconnect = true))
            val registry = harness.registry(StandardTestDispatcher(testScheduler))
            registry.start()
            try {
                val hostsBefore = registry.snapshot.value.hosts

                assertIs<HostCommandResult.Accepted>(registry.setAppearance(AppAppearance.DARK))
                assertIs<HostCommandResult.Accepted>(registry.setAppearance(AppAppearance.LIGHT))

                // A display preference dials nothing, drops nothing, and moves no
                // admission epoch: the connection frame is byte for byte the same.
                assertEquals(hostsBefore, registry.snapshot.value.hosts)
                assertEquals(0, harness.transports.size, "an appearance change opens no transport")
                assertTrue(registry.snapshot.value.foreground)
            } finally {
                registry.close()
            }
        }
    }
}
