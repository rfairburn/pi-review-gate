package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostAddress
import io.github.rfairburn.pireviewgate.core.identity.PinRead
import io.github.rfairburn.pireviewgate.core.transport.PeerByteConnection
import io.github.rfairburn.pireviewgate.core.transport.PeerKey
import io.github.rfairburn.pireviewgate.core.transport.PeerTransport
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportErrorCode
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportException
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Uses the real transport's known-key, immediately-before-request reproof seam.
 * The byte pipe is scripted: these are NOT socket/TLS-handshake negative proofs.
 */
class HostAddressPinnedRequestTest {
    @Test
    fun `matching key at new locator accepts pairing POST and keeps exact pin`() = checkPinnedRequest(matching = true)

    @Test
    fun `wrong key at new locator is refused by actual transport before any request output`() = checkPinnedRequest(matching = false)

    private fun checkPinnedRequest(matching: Boolean) =
        runBlocking(Dispatchers.IO) {
            RegistryHarness().use { harness ->
                val one = RegistryFixtures.host(1, previouslyConnected = true)
                val endpoint = Endpoint("10.0.0.45", one.endpoint.port)
                harness.seedSettings(RegistryFixtures.settings(one))
                harness.seedPins(listOf(one))
                val original = harness.peerKey(one.endpoint)
                val observed = if (matching) original else RegistryFixtures.transportKey()
                val echo = harness.identity.key.keyId
                val body = "{\"status\":\"accepted\",\"acceptedPeerKey\":\"$echo\"}"
                val response = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n$body"
                val connection = RequestConnection(observed, response)
                var creates = 0
                var acquisitions = 0
                val registry = HostConnectionRegistry(
                    settingsStore = harness.settings,
                    pinStore = harness.pins,
                    identityStore = harness.identity,
                    promptValidator = harness.prompt,
                    transportFactory = HostTransportFactory { target, bounds ->
                        creates += 1
                        assertEquals(endpoint.host, target.host)
                        assertEquals(endpoint.port, target.port)
                        DefaultHostTransport(PeerTransport(bounds).apply {
                            connector = { actual, identity, pinned ->
                                // PeerEndpoint is not a value type: the registry
                                // supplies a fresh instance for pair and open.
                                assertEquals(target.host, actual.host)
                                assertEquals(target.port, actual.port)
                                // The registry's existing public-only handle is
                                // structurally admissible; no TLS signer is used.
                                assertEquals(DevicePeerIdentity.LABEL, identity.label)
                                assertEquals(echo, identity.keyId)
                                assertEquals(1, identity.keyManagers.size)
                                assertContentEquals(original.pinnedDer(), assertNotNull(pinned))
                                acquisitions += 1
                                // The matching-key branch checks the real pairing
                                // reproof/write/echo only, not WebSocket framing.
                                if (acquisitions > 1) throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
                                connection
                            }
                        })
                    },
                    dispatcher = Dispatchers.IO,
                )
                registry.start()
                try {
                    assertEquals(HostAddressUpdateResult.Saved(endpoint),
                        registry.updateHostAddress(one.id, one.endpoint, HostAddress.parse(endpoint.host)))
                    assertEquals(0, creates, "save must never create a transport")
                    assertEquals(0, harness.identity.generations)
                    registry.connect(one.id)
                    val terminal = withTimeout(10_000) {
                        registry.snapshot.first { it.hosts.single().phase == HostConnectionPhase.ERROR }
                    }.hosts.single()
                    assertEquals(if (matching) HostConnectionReason.NOT_AUTHORIZED else HostConnectionReason.PEER_KEY_CHANGED,
                        terminal.reason)
                    assertEquals(1, creates)
                    assertEquals(1, harness.identity.generations)
                    assertTrue(connection.terminated)
                    assertEquals(PinRead.Remembered(PeerKeyBridge.toStored(original)), harness.readPin(one.id, endpoint))
                    assertEquals(one.endpoint, harness.pins.snapshot().single().endpoint)
                    assertTrue(registry.snapshot.value.pendingConsents.isEmpty())
                    assertEquals(0, harness.prompt.asked)
                    assertTrue(harness.pins.clears.isEmpty())
                    if (matching) {
                        assertTrue(connection.output.size() > 0)
                        assertTrue(connection.output.toString("ISO-8859-1").startsWith("POST "))
                        assertEquals(1, harness.pins.recorded.size)
                        assertEquals(2, acquisitions)
                    } else {
                        assertEquals(0, connection.output.size(), "real reproof must precede every HTTP byte")
                        assertEquals(HostConnectionReason.PEER_KEY_CHANGED, registry.snapshot.value.hosts.single().reason)
                        assertTrue(harness.pins.recorded.isEmpty())
                        assertEquals(1, acquisitions)
                    }
                    assertFalse(harness.pins.snapshot().isEmpty())
                } finally {
                    registry.close()
                }
            }
        }

    private class RequestConnection(
        override val peerKey: PeerKey,
        response: String,
    ) : PeerByteConnection {
        override val peerLabel: String = "scripted-peer"
        override val input = ByteArrayInputStream(response.toByteArray(Charsets.ISO_8859_1))
        override val output = ByteArrayOutputStream()
        var terminated: Boolean = false
        override fun terminate() { terminated = true }
    }
}
