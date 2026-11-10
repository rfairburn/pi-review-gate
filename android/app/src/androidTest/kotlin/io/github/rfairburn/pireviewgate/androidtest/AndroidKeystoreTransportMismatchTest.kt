package io.github.rfairburn.pireviewgate.androidtest

import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import io.github.rfairburn.pireviewgate.core.transport.PeerClientIdentity
import io.github.rfairburn.pireviewgate.core.transport.PeerEndpoint
import io.github.rfairburn.pireviewgate.core.transport.PeerKey
import io.github.rfairburn.pireviewgate.core.transport.PeerTransport
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportErrorCode
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportException
import io.github.rfairburn.pireviewgate.core.transport.PeerTrustSource
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import javax.net.ssl.KeyManager

/**
 * Proves the remembered-server-key gate refuses a real TLS peer before any HTTP
 * request byte. The synthetic host records whether it ever saw a request; the
 * host-side report is the second half of this check.
 */
@RunWith(AndroidJUnit4::class)
class AndroidKeystoreTransportMismatchTest {

    @Test
    fun differentServerPinFailsBeforeHttp() {
        val base = FixtureEnvironment.targetContext()
        val nonce = FixtureEnvironment.requireNonce()
        val root = FixtureEnvironment.rootFor(base, nonce)
        val alias = FixtureEnvironment.aliasFor(nonce)
        val context = FixtureEnvironment.contextWithRoot(base, root)
        val store = AndroidClientStorage.identityStore(context, alias)
        assertEquals(PeerIdentityStatus.Ready, store.status())
        val handle = store.current()
        assertEquals(
            FixtureEnvironment.requireArgument("fixtureClientKeyId"),
            handle.key.keyId,
        )

        val wrongPin = softwareFixtureKey()
        val endpoint = PeerEndpoint(
            FixtureEnvironment.argumentOrDefault("fixtureHost", "10.0.2.2"),
            FixtureEnvironment.requireIntArgument("fixturePort"),
        )
        val identity = object : PeerClientIdentity {
            override val label: String = FixtureEnvironment.IDENTITY_LABEL
            override val keyId: String = handle.key.keyId
            override val keyManagers: Array<KeyManager> =
                arrayOf<KeyManager>(handle.newKeyManager())
        }
        val transport = PeerTransport()
        try {
            val failure = assertThrows(PeerTransportException::class.java) {
                runBlocking {
                    withTimeout(20_000L) {
                        transport.open(
                            endpoint = endpoint,
                            lane = PeerAppLane.APP,
                            identity = identity,
                            trust = PeerTrustSource { wrongPin },
                        )
                    }
                }
            }
            assertEquals(PeerTransportErrorCode.PEER_KEY_MISMATCH, failure.code)
        } finally {
            transport.dispose()
        }
    }

    private fun softwareFixtureKey(): PeerKey {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        return PeerKey.fromSpkiDer(generator.generateKeyPair().public.encoded)
    }
}
