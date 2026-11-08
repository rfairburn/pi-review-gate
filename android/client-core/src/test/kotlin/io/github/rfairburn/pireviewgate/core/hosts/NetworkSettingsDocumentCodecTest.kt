package io.github.rfairburn.pireviewgate.core.hosts

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/** The closed settings schema: exact round trip, and no silent defaults. */
class NetworkSettingsDocumentCodecTest {

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

    private fun decode(text: String): SettingsDecodeResult = NetworkSettingsDocumentCodec.decode(text)

    private fun decodeValid(text: String): NetworkSettings =
        when (val result = decode(text)) {
            is SettingsDecodeResult.Valid -> result.settings
            is SettingsDecodeResult.Invalid -> fail("expected a valid document, got ${result.reason.name}")
        }

    private fun decodeInvalid(text: String): StorageFailureReason =
        when (val result = decode(text)) {
            is SettingsDecodeResult.Invalid -> result.reason
            is SettingsDecodeResult.Valid -> fail("expected a refused document")
        }

    @Test
    fun `a saved catalog round trips exactly`() {
        val settings = NetworkSettings(
            autoReconnect = true,
            viewerRemoteInputEnabled = false,
            hosts = HostCatalog.of(listOf(first, second)),
        )
        val text = NetworkSettingsDocumentCodec.encode(settings)
        assertEquals(settings, decodeValid(text))
    }

    @Test
    fun `an on viewer flag is not written and an absent flag means on`() {
        val on = NetworkSettings(
            autoReconnect = false,
            viewerRemoteInputEnabled = true,
            hosts = HostCatalog.of(listOf(first)),
        )
        val text = NetworkSettingsDocumentCodec.encode(on)
        assertFalse(text.contains("viewerRemoteInputEnabled"), "an on default stays sparse: $text")
        assertTrue(decodeValid(text).viewerRemoteInputEnabled)

        val off = NetworkSettings(
            autoReconnect = false,
            viewerRemoteInputEnabled = false,
            hosts = HostCatalog.of(listOf(first)),
        )
        assertTrue(NetworkSettingsDocumentCodec.encode(off).contains("\"viewerRemoteInputEnabled\":false"))
        assertFalse(decodeValid(NetworkSettingsDocumentCodec.encode(off)).viewerRemoteInputEnabled)
    }

    @Test
    fun `debug input messaging is absent off and only an explicit true is written`() {
        assertFalse(NetworkSettings.DEFAULTS.debugInputMessagingEnabled, "the product default is off")

        // An older document that never knew the key reads as off.
        val oldDocument = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]}"
        assertFalse(decodeValid(oldDocument).debugInputMessagingEnabled)

        // Off stays sparse: a saved document of defaults writes no key at all.
        val off = NetworkSettings(
            autoReconnect = false,
            viewerRemoteInputEnabled = true,
            hosts = HostCatalog.of(listOf(first)),
        )
        val offText = NetworkSettingsDocumentCodec.encode(off)
        assertFalse(offText.contains("debugInputMessagingEnabled"), "an off default stays sparse: $offText")
        assertFalse(decodeValid(offText).debugInputMessagingEnabled)

        // Only an explicit true is written, and it round trips with every other fact.
        val on = off.copy(debugInputMessagingEnabled = true)
        val onText = NetworkSettingsDocumentCodec.encode(on)
        assertTrue(onText.contains("\"debugInputMessagingEnabled\":true"), onText)
        assertEquals(on, decodeValid(onText))

        // Sparse true round trip alongside a non-default sibling preference and hosts.
        val mixed = NetworkSettings(
            autoReconnect = true,
            viewerRemoteInputEnabled = false,
            hosts = HostCatalog.of(listOf(first, second)),
            savedFirstReplyTimeoutSeconds = 120,
            debugInputMessagingEnabled = true,
        )
        val mixedText = NetworkSettingsDocumentCodec.encode(mixed)
        assertTrue(mixedText.contains("\"debugInputMessagingEnabled\":true"), mixedText)
        assertEquals(mixed, decodeValid(mixedText))
        assertFalse(decodeValid(mixedText).viewerRemoteInputEnabled)
        assertEquals(120, decodeValid(mixedText).savedFirstReplyTimeoutSeconds)
        assertEquals(2, decodeValid(mixedText).hosts.hosts.size)
    }

    @Test
    fun `a non-boolean or misnamed debug flag refuses instead of becoming a default`() {
        val base = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]"
        for (bad in listOf("\"yes\"", "\"false\"", "1", "0", "null", "{}", "[]")) {
            assertEquals(
                StorageFailureReason.MALFORMED,
                decodeInvalid("$base,\"debugInputMessagingEnabled\":$bad}"),
                "must refuse $bad rather than default or coerce it",
            )
        }
        // The closed schema admits only the exact key name.
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"autoReconnect\":false,\"hosts\":[],\"debugInputMessaging\":true}"),
        )
        // A host entry cannot carry it either.
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(
                "{\"version\":1,\"autoReconnect\":false,\"hosts\":[{\"id\":\"a\",\"label\":\"L\"," +
                    "\"host\":\"h\",\"port\":443,\"previouslyConnected\":false," +
                    "\"reconnectSuppressed\":false,\"debugInputMessagingEnabled\":true}]}",
            ),
        )
    }

    @Test
    fun `an unknown or non-boolean flag refuses instead of becoming a default`() {
        val base = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]}"
        assertTrue(decodeValid(base).viewerRemoteInputEnabled)

        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"autoReconnect\":false,\"viewerRemoteInputEnabled\":\"yes\",\"hosts\":[]}"),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"autoReconnect\":false,\"viewerRemoteInputEnabled\":\"true\",\"hosts\":[]}"),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"autoReconnect\":false,\"viewerRemoteInputEnabled\":1,\"hosts\":[]}"),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"autoReconnect\":false,\"viewerRemoteInputEnabled\":null,\"hosts\":[]}"),
        )
        // A required flag is never defaulted.
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"viewerRemoteInputEnabled\":true,\"hosts\":[]}"),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"autoReconnect\":\"false\",\"hosts\":[]}"),
        )
    }

    @Test
    fun `an absent saved first reply timeout means sixty and default encoding stays sparse`() {
        val oldDocument = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]}"
        val decoded = decodeValid(oldDocument)
        assertEquals(60, decoded.savedFirstReplyTimeoutSeconds)
        assertEquals(
            "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]}\n",
            NetworkSettingsDocumentCodec.encode(decoded),
        )

        val withHost = NetworkSettings(
            autoReconnect = true,
            viewerRemoteInputEnabled = false,
            hosts = HostCatalog.of(listOf(first)),
        )
        val text = NetworkSettingsDocumentCodec.encode(withHost)
        assertFalse(text.contains("savedFirstReplyTimeoutSeconds"), "the default timeout stays sparse: $text")
        assertEquals(withHost, decodeValid(text))
    }

    @Test
    fun `a custom saved first reply timeout round trips and invalid values are refused`() {
        val custom = NetworkSettings(
            autoReconnect = false,
            viewerRemoteInputEnabled = true,
            hosts = HostCatalog.of(listOf(first)),
            savedFirstReplyTimeoutSeconds = 120,
        )
        val text = NetworkSettingsDocumentCodec.encode(custom)
        assertTrue(text.contains("\"savedFirstReplyTimeoutSeconds\":120"), text)
        assertEquals(custom, decodeValid(text))

        val base = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]"
        for (bad in listOf("0", "-1", "1.5", "1e2", "\"60\"", "null", "1000000000")) {
            assertEquals(
                StorageFailureReason.MALFORMED,
                decodeInvalid("$base,\"savedFirstReplyTimeoutSeconds\":$bad}"),
                "must refuse $bad rather than default or clamp",
            )
        }
    }

    @Test
    fun `saved first reply timeout input admits only positive whole seconds in the document range`() {
        assertEquals(1, NetworkSettings.parseSavedFirstReplyTimeoutSeconds("1"))
        assertEquals(60, NetworkSettings.parseSavedFirstReplyTimeoutSeconds(" 60 "))
        assertEquals(
            NetworkSettings.MAX_SAVED_FIRST_REPLY_TIMEOUT_SECONDS,
            NetworkSettings.parseSavedFirstReplyTimeoutSeconds(
                NetworkSettings.MAX_SAVED_FIRST_REPLY_TIMEOUT_SECONDS.toString(),
            ),
        )
        for (bad in listOf("", " ", "0", "-1", "+1", "1.0", "1e3", "1000000000", "9999999999")) {
            assertNull(NetworkSettings.parseSavedFirstReplyTimeoutSeconds(bad), "must refuse '$bad'")
        }
        assertEquals(60_000L, NetworkSettings.savedFirstReplyTimeoutMillis(60))
        assertEquals(
            NetworkSettings.MAX_SAVED_FIRST_REPLY_TIMEOUT_SECONDS.toLong() * 1_000L,
            NetworkSettings.savedFirstReplyTimeoutMillis(NetworkSettings.MAX_SAVED_FIRST_REPLY_TIMEOUT_SECONDS),
        )
        assertNull(NetworkSettings.savedFirstReplyTimeoutMillis(0))
        assertEquals(60_000L, NetworkSettings.DEFAULTS.savedFirstReplyTimeoutMs)
    }

    @Test
    fun `an unknown version is refused as its own reason`() {
        assertEquals(
            StorageFailureReason.UNSUPPORTED_VERSION,
            decodeInvalid("{\"version\":2,\"autoReconnect\":false,\"hosts\":[]}"),
        )
        assertEquals(
            StorageFailureReason.UNSUPPORTED_VERSION,
            decodeInvalid("{\"version\":0,\"autoReconnect\":false,\"hosts\":[]}"),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":\"1\",\"autoReconnect\":false,\"hosts\":[]}"),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"autoReconnect\":false,\"hosts\":[]}"),
        )
    }

    @Test
    fun `only the named keys are admitted`() {
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"autoReconnect\":false,\"hosts\":[],\"extra\":1}"),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(
                "{\"version\":1,\"autoReconnect\":false,\"hosts\":" +
                    "[{\"id\":\"a\",\"label\":\"L\",\"host\":\"h\",\"port\":443," +
                    "\"previouslyConnected\":false,\"reconnectSuppressed\":false,\"pin\":\"x\"}]}",
            ),
        )
        // No hosting, owner policy, identity, or key field is expressible.
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid("{\"version\":1,\"autoReconnect\":false,\"hosts\":[],\"hosting\":{\"enabled\":true}}"),
        )
    }

    @Test
    fun `host entries are bounds checked and ids are unique`() {
        fun doc(entry: String) = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[$entry]}"
        val good =
            "{\"id\":\"a\",\"label\":\"L\",\"host\":\"h\",\"port\":443,\"previouslyConnected\":false,\"reconnectSuppressed\":false}"

        assertEquals(StorageFailureReason.MALFORMED, decodeInvalid(doc(good + "," + good)))
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(doc("{\"id\":\"\",\"label\":\"L\",\"host\":\"h\",\"port\":443,\"previouslyConnected\":false,\"reconnectSuppressed\":false}")),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(doc("{\"id\":\"a\",\"label\":\"bad label!\",\"host\":\"h\",\"port\":443,\"previouslyConnected\":false,\"reconnectSuppressed\":false}")),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(doc("{\"id\":\"a\",\"label\":\"L\",\"host\":\"bad host\",\"port\":443,\"previouslyConnected\":false,\"reconnectSuppressed\":false}")),
        )
        // A quoted port is a string, not a number.
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(doc("{\"id\":\"a\",\"label\":\"L\",\"host\":\"h\",\"port\":\"443\",\"previouslyConnected\":false,\"reconnectSuppressed\":false}")),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(doc("{\"id\":\"a\",\"label\":\"L\",\"host\":\"h\",\"port\":0,\"previouslyConnected\":false,\"reconnectSuppressed\":false}")),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(doc("{\"id\":\"a\",\"label\":\"L\",\"host\":\"h\",\"port\":65536,\"previouslyConnected\":false,\"reconnectSuppressed\":false}")),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            decodeInvalid(doc("{\"id\":\"a\",\"label\":\"L\",\"host\":\"h\",\"port\":443,\"previouslyConnected\":false}")),
        )
        assertEquals(StorageFailureReason.MALFORMED, decodeInvalid(doc("\"just a string\"")))
        assertEquals(StorageFailureReason.MALFORMED, decodeInvalid("{\"version\":1,\"autoReconnect\":false}"))
        assertEquals(StorageFailureReason.MALFORMED, decodeInvalid("not json at all"))
        assertEquals(StorageFailureReason.MALFORMED, decodeInvalid(""))
    }

    @Test
    fun `a document over the host bound is refused`() {
        val entries = (0..HostCatalog.MAX_HOSTS).joinToString(",") { index ->
            "{\"id\":\"id-$index\",\"label\":\"L\",\"host\":\"h\",\"port\":443," +
                "\"previouslyConnected\":false,\"reconnectSuppressed\":false}"
        }
        val text = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[$entries]}"
        assertEquals(StorageFailureReason.MALFORMED, decodeInvalid(text))

        // Exactly at the bound is accepted.
        val atBound = (0 until HostCatalog.MAX_HOSTS).joinToString(",") { index ->
            "{\"id\":\"id-$index\",\"label\":\"L\",\"host\":\"h\",\"port\":443," +
                "\"previouslyConnected\":false,\"reconnectSuppressed\":false}"
        }
        val settings = decodeValid("{\"version\":1,\"autoReconnect\":false,\"hosts\":[$atBound]}")
        assertEquals(HostCatalog.MAX_HOSTS, settings.hosts.size)
    }

    @Test
    fun `invalid utf8 bytes are refused`() {
        val bytes = byteArrayOf(0x7b.toByte(), 0xff.toByte(), 0xfe.toByte(), 0x7d.toByte())
        val result = assertIs<SettingsDecodeResult.Invalid>(NetworkSettingsDocumentCodec.decode(bytes))
        assertEquals(StorageFailureReason.MALFORMED, result.reason)
    }
}
