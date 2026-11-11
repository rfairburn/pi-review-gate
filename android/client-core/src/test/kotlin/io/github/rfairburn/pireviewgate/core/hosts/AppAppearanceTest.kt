package io.github.rfairburn.pireviewgate.core.hosts

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The saved app appearance: light by default, one closed document value, and no
 * silent default for anything the schema does not name.
 *
 * These are settings and codec checks only. The terminal's colors belong to the
 * host and to the platform surface, and nothing in this schema can express one.
 */
class AppAppearanceTest {

    private val first = ConfiguredHost(
        id = HostId.parse("11111111-1111-4111-8111-111111111111"),
        label = HostLabel.parse("Kitchen desk"),
        endpoint = Endpoint("192.168.1.20", 8443),
        previouslyConnected = true,
        reconnectSuppressed = false,
    )
    private val second = ConfiguredHost(
        id = HostId.parse("22222222-2222-4222-8222-222222222222"),
        label = HostLabel.parse("Studio (LAN)"),
        endpoint = Endpoint("10.0.0.7", 9001),
        previouslyConnected = false,
        reconnectSuppressed = true,
    )

    private fun decodeValid(text: String): NetworkSettings =
        when (val result = NetworkSettingsDocumentCodec.decode(text)) {
            is SettingsDecodeResult.Valid -> result.settings
            is SettingsDecodeResult.Invalid -> fail("expected a valid document, got ${result.reason.name}")
        }

    private fun decodeInvalid(text: String): StorageFailureReason =
        when (val result = NetworkSettingsDocumentCodec.decode(text)) {
            is SettingsDecodeResult.Invalid -> result.reason
            is SettingsDecodeResult.Valid -> fail("expected a refused document")
        }

    @Test
    fun `the appearance choice is closed to light and dark and defaults to light`() {
        assertEquals(2, AppAppearance.entries.size, "no follow-system, automatic, or palette variant")
        assertEquals(AppAppearance.LIGHT, AppAppearance.DEFAULT)
        assertEquals(AppAppearance.LIGHT, NetworkSettings.DEFAULTS.appearance)
        assertEquals(AppAppearance.LIGHT, NetworkSettings().appearance)
        assertEquals("light", AppAppearance.LIGHT.wireName)
        assertEquals("dark", AppAppearance.DARK.wireName)
    }

    @Test
    fun `only the exact lower-case variant names are admitted`() {
        assertEquals(AppAppearance.LIGHT, AppAppearance.fromWireName("light"))
        assertEquals(AppAppearance.DARK, AppAppearance.fromWireName("dark"))
        for (rejected in listOf("Light", "LIGHT", "Dark", "DARK", "system", "auto", "light ", "", " follow")) {
            assertNull(AppAppearance.fromWireName(rejected), "must refuse '$rejected'")
        }
    }

    @Test
    fun `changing the appearance moves that one preference and nothing else`() {
        val saved = NetworkSettings(
            autoReconnect = true,
            viewerRemoteInputEnabled = false,
            hosts = HostCatalog.of(listOf(first, second)),
            savedFirstReplyTimeoutSeconds = 120,
            debugInputMessagingEnabled = true,
        )
        val dark = saved.withAppearance(AppAppearance.DARK)

        assertEquals(AppAppearance.DARK, dark.appearance)
        assertEquals(saved.copy(appearance = AppAppearance.DARK), dark)
        assertEquals(saved.autoReconnect, dark.autoReconnect)
        assertEquals(saved.viewerRemoteInputEnabled, dark.viewerRemoteInputEnabled)
        assertEquals(saved.savedFirstReplyTimeoutSeconds, dark.savedFirstReplyTimeoutSeconds)
        assertEquals(saved.debugInputMessagingEnabled, dark.debugInputMessagingEnabled)
        assertEquals(saved.hosts.hosts, dark.hosts.hosts)
        assertEquals(saved, dark.withAppearance(AppAppearance.LIGHT))
    }

    @Test
    fun `appearance is absent light and only a chosen variant is written`() {
        // An older document that never knew the key reads as light.
        val oldDocument = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]}"
        assertEquals(AppAppearance.LIGHT, decodeValid(oldDocument).appearance)

        // Light stays sparse: a saved document of defaults writes no key at all.
        val light = NetworkSettings(
            autoReconnect = false,
            viewerRemoteInputEnabled = true,
            hosts = HostCatalog.of(listOf(first)),
        )
        val lightText = NetworkSettingsDocumentCodec.encode(light)
        assertFalse(lightText.contains("\"appearance\""), "the light default stays sparse: $lightText")
        assertEquals(AppAppearance.LIGHT, decodeValid(lightText).appearance)

        // Only a chosen variant is written, and it round trips with every other fact.
        val dark = light.withAppearance(AppAppearance.DARK)
        val darkText = NetworkSettingsDocumentCodec.encode(dark)
        assertTrue(darkText.contains("\"appearance\":\"dark\""), darkText)
        assertEquals(dark, decodeValid(darkText))

        // Choosing light again writes the sparse document back, with nothing else moved.
        val backToLight = dark.withAppearance(AppAppearance.LIGHT)
        assertEquals(light, backToLight)
        assertFalse(NetworkSettingsDocumentCodec.encode(backToLight).contains("\"appearance\""))

        // Sparse dark round trip alongside a non-default sibling preference and hosts.
        val mixed = NetworkSettings(
            autoReconnect = true,
            viewerRemoteInputEnabled = false,
            hosts = HostCatalog.of(listOf(first, second)),
            savedFirstReplyTimeoutSeconds = 120,
            debugInputMessagingEnabled = true,
            appearance = AppAppearance.DARK,
        )
        val mixedText = NetworkSettingsDocumentCodec.encode(mixed)
        assertTrue(mixedText.contains("\"appearance\":\"dark\""), mixedText)
        assertEquals(mixed, decodeValid(mixedText))
        assertEquals(120, decodeValid(mixedText).savedFirstReplyTimeoutSeconds)
        assertTrue(decodeValid(mixedText).debugInputMessagingEnabled)
        assertEquals(2, decodeValid(mixedText).hosts.hosts.size)
    }

    @Test
    fun `an appearance that is not an exact variant name refuses instead of becoming a default`() {
        val base = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]"
        for (bad in listOf(
            "\"Dark\"", "\"LIGHT\"", "\"DARK\"", "\"system\"", "\"auto\"", "\"light \"", "\"\"",
            "true", "false", "1", "0", "null", "{}", "[]",
        )) {
            assertEquals(
                StorageFailureReason.MALFORMED,
                decodeInvalid("$base,\"appearance\":$bad}"),
                "must refuse $bad rather than default or coerce it",
            )
        }
        // The closed schema admits only the exact key name.
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"autoReconnect\":false,\"hosts\":[],\"appAppearance\":\"dark\"}"),
        )
        // A host entry cannot carry it either.
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(
                "{\"version\":1,\"autoReconnect\":false,\"hosts\":[{\"id\":\"a\",\"label\":\"L\"," +
                    "\"host\":\"h\",\"port\":443,\"previouslyConnected\":false," +
                    "\"reconnectSuppressed\":false,\"appearance\":\"dark\"}]}",
            ),
        )
    }
}
