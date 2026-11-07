package io.github.rfairburn.pireviewgate.core.hosts

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
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
