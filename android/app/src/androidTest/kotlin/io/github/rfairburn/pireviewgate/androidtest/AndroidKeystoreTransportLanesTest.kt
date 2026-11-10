package io.github.rfairburn.pireviewgate.androidtest

import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityHandle
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import io.github.rfairburn.pireviewgate.core.transport.PeerClientIdentity
import io.github.rfairburn.pireviewgate.core.transport.PeerDelivery
import io.github.rfairburn.pireviewgate.core.transport.PeerEndpoint
import io.github.rfairburn.pireviewgate.core.transport.PeerKey
import io.github.rfairburn.pireviewgate.core.transport.PeerKeyApprover
import io.github.rfairburn.pireviewgate.core.transport.PeerKeyDecision
import io.github.rfairburn.pireviewgate.core.transport.PeerPairStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerSendReceipt
import io.github.rfairburn.pireviewgate.core.transport.PeerTransport
import io.github.rfairburn.pireviewgate.core.transport.PeerTrustSource
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import javax.net.ssl.KeyManager
import kotlinx.coroutines.CancellationException

/**
 * Real instrumented mTLS over the landed production [PeerTransport] and the
 * AndroidKeyStore identity handle.
 *
 * The peer is the unchanged synthetic TS `PeerHost` fixture. It approves exactly
 * the public key this device generated for this nonce. The test proves the
 * server SPKI pin, the client key actually selected on the handshake, the wire
 * label/claim association, and one exact binary echo per lane. It proves
 * transport framing and local send receipts only; it says nothing about an
 * application service above the channel.
 */
@RunWith(AndroidJUnit4::class)
class AndroidKeystoreTransportLanesTest {

    @Test
    fun pairingAndBothLanesUseTheAndroidKeystoreIdentity() {
        val base = FixtureEnvironment.targetContext()
        val nonce = FixtureEnvironment.requireNonce()
        val root = FixtureEnvironment.rootFor(base, nonce)
        val alias = FixtureEnvironment.aliasFor(nonce)
        val context = FixtureEnvironment.contextWithRoot(base, root)
        val store = AndroidClientStorage.identityStore(context, alias)
        assertEquals(PeerIdentityStatus.Ready, store.status())
        val handle = store.current()

        val expectedClientKeyId = FixtureEnvironment.requireArgument("fixtureClientKeyId")
        assertEquals(expectedClientKeyId, handle.key.keyId)

        val serverKey = PeerKey.fromKeyId(FixtureEnvironment.requireArgument("fixtureServerKeyId"))
        val host = FixtureEnvironment.argumentOrDefault("fixtureHost", "10.0.2.2")
        val port = FixtureEnvironment.requireIntArgument("fixturePort")
        val endpoint = PeerEndpoint(host, port)
        val identity = FixtureClientIdentity(handle)
        val transport = PeerTransport()

        try {
            runBlocking {
                withTimeout(FIXTURE_TIMEOUT_MS) {
                    val pair = transport.pair(
                        endpoint = endpoint,
                        identity = identity,
                        trust = PeerTrustSource { null },
                        approver = PeerKeyApprover { PeerKeyDecision.ACCEPT },
                    )
                    assertTrue("pairing did not succeed", pair.ok)
                    assertEquals(PeerPairStatus.ACCEPTED, pair.status)
                    assertEquals(serverKey, pair.serverKey)

                    proveLane(
                        transport = transport,
                        endpoint = endpoint,
                        identity = identity,
                        serverKey = serverKey,
                        clientKeyId = handle.key.keyId,
                        lane = PeerAppLane.APP,
                        payload = fixturePayload(seed = 17, size = 256),
                    )
                    proveLane(
                        transport = transport,
                        endpoint = endpoint,
                        identity = identity,
                        serverKey = serverKey,
                        clientKeyId = handle.key.keyId,
                        lane = PeerAppLane.CONTENT,
                        payload = fixturePayload(seed = 29, size = 192),
                    )
                }
            }
        } finally {
            transport.dispose()
        }
    }

    private suspend fun proveLane(
        transport: PeerTransport,
        endpoint: PeerEndpoint,
        identity: PeerClientIdentity,
        serverKey: PeerKey,
        clientKeyId: String,
        lane: PeerAppLane,
        payload: ByteArray,
    ) {
        val channel = transport.open(
            endpoint = endpoint,
            lane = lane,
            identity = identity,
            trust = PeerTrustSource { serverKey },
        )
        try {
            assertEquals(serverKey, channel.peerKey)
            assertEquals(serverKey.fingerprint, channel.peerKey.fingerprint)
            assertEquals(lane, channel.lane)
            assertEquals(FixtureEnvironment.FIXTURE_HOST_LABEL, channel.label)

            val metadataBytes = channel.receive()
            assertNotNull("fixture sent no channel metadata", metadataBytes)
            val metadata = JSONObject(String(metadataBytes!!, Charsets.UTF_8))
            assertEquals("android-peer-fixture-channel", metadata.getString("kind"))
            assertEquals(lane.name.lowercase(), metadata.getString("lane"))
            assertEquals(serverKey.keyId, metadata.getString("serverKeyId"))
            assertEquals(clientKeyId, metadata.getString("peerKeyId"))
            assertEquals(FixtureEnvironment.IDENTITY_LABEL, metadata.getString("peerLabel"))

            val receipt = PeerSendReceipt()
            channel.send(payload, receipt = receipt)
            assertEquals(PeerDelivery.WRITTEN, receipt.delivery)
            assertTrue("send never crossed the writer invocation boundary", receipt.wasInvoked)

            val echoed = channel.receive()
            assertNotNull("fixture sent no binary echo", echoed)
            assertArrayEquals(payload, echoed!!)
        } finally {
            try {
                channel.close()
            } catch (_: CancellationException) {
                // Teardown after an assertion failure only.
            }
        }
    }

    private class FixtureClientIdentity(
        private val handle: PeerIdentityHandle,
    ) : PeerClientIdentity {
        override val label: String = FixtureEnvironment.IDENTITY_LABEL
        override val keyId: String = handle.key.keyId
        override val keyManagers: Array<KeyManager> =
            arrayOf<KeyManager>(handle.newKeyManager())
    }

    private companion object {
        const val FIXTURE_TIMEOUT_MS = 30_000L

        fun fixturePayload(seed: Int, size: Int): ByteArray {
            val bytes = ByteArray(size) { index -> ((index * seed) and 0xFF).toByte() }
            bytes[0] = 0
            bytes[bytes.lastIndex] = 0xFF.toByte()
            return bytes
        }
    }
}
