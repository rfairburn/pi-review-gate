package io.github.rfairburn.pireviewgate.androidtest

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.identity.IdentityException
import io.github.rfairburn.pireviewgate.core.identity.IdentityFailureReason
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.identity.PeerKey
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.security.Signature
import java.util.UUID

/**
 * Instrumented checks for the landed AndroidKeyStore-backed peer identity.
 *
 * The only key this test creates is one uniquely named fixture alias; the
 * production default alias and every other key-store entry are untouched. The
 * private half is never serialized or logged: the checks ask the production key
 * manager for its object handle and assert that no encoded private bytes exist.
 */
@RunWith(AndroidJUnit4::class)
class AndroidKeyStorePeerIdentityTest {

    private lateinit var base: Context
    private lateinit var root: File
    private lateinit var context: Context
    private lateinit var nonce: String
    private lateinit var alias: String

    @Before
    fun setUp() {
        base = FixtureEnvironment.targetContext()
        nonce = "identity-" + UUID.randomUUID().toString()
        root = FixtureEnvironment.rootFor(base, nonce)
        FixtureEnvironment.deleteOwnedRoot(base, root)
        context = FixtureEnvironment.contextWithRoot(base, root)
        alias = FixtureEnvironment.aliasFor(nonce)
        FixtureEnvironment.deleteOwnedAlias(alias)
    }

    @After
    fun tearDown() {
        try {
            FixtureEnvironment.deleteOwnedAlias(alias)
            assertFalse("fixture alias remains after cleanup", FixtureEnvironment.keyStoreContains(alias))
        } finally {
            FixtureEnvironment.deleteOwnedRoot(base, root)
            assertFalse("fixture root remains after cleanup", root.exists())
        }
    }

    @Test
    fun freshStatusCreatesNoKeyAndCurrentRefuses() {
        val store = AndroidClientStorage.identityStore(context, alias)
        assertEquals(PeerIdentityStatus.NeverInitialized, store.status())
        val failure = assertThrows(IdentityException::class.java) { store.current() }
        assertEquals(IdentityFailureReason.MISSING_INITIALIZED, failure.reason)
        assertFalse("fresh status created a key", FixtureEnvironment.keyStoreContains(alias))
        assertFalse("fresh status created storage", root.exists())
    }

    @Test
    fun initializeOnceProducesOpaqueP256IdentityAndReopensWithSameKey() {
        val label = HostLabel.parse(FixtureEnvironment.IDENTITY_LABEL)
        val store = AndroidClientStorage.identityStore(context, alias)
        val handle = store.initialize(label)

        assertEquals(PeerIdentityStatus.Ready, store.status())
        assertTrue(handle.key.contentEquals(store.current().key))
        assertTrue(handle.certificateChain.isNotEmpty())
        assertEquals(
            handle.key,
            PeerKey.fromSpki(handle.certificateChain.first().publicKey.encoded),
        )

        val keyManager = handle.newKeyManager()
        assertArrayEquals(arrayOf(alias), keyManager.getClientAliases("EC", null))
        assertEquals(alias, keyManager.chooseClientAlias(arrayOf("EC"), null, null))
        assertEquals(alias, keyManager.chooseEngineClientAlias(arrayOf("ECDHE_ECDSA"), null, null))
        assertNull("unsupported key type must not select the fixture key", keyManager.chooseClientAlias(arrayOf("RSA"), null, null))
        assertEquals(0, keyManager.getServerAliases("EC", null).size)
        assertNull(keyManager.chooseServerAlias("EC", null, null))
        assertNull(keyManager.chooseEngineServerAlias("EC", null, null))
        assertNull(keyManager.getPrivateKey("not-a-fixture-alias"))
        assertArrayEquals(
            handle.certificateChain.toTypedArray(),
            keyManager.getCertificateChain(alias)!!,
        )

        val privateKey = keyManager.getPrivateKey(alias)
            ?: throw AssertionError("the fixture key manager returned no private-key handle")
        assertEquals("EC", privateKey.algorithm)
        assertNull(
            "AndroidKeyStore private key must not be exportable",
            runCatching { privateKey.encoded }.getOrNull(),
        )

        // Initialization is one-time: a second call refuses and preserves the key.
        val again = assertThrows(IdentityException::class.java) { store.initialize(label) }
        assertEquals(IdentityFailureReason.ALREADY_INITIALIZED, again.reason)
        assertTrue(handle.key.contentEquals(store.current().key))

        // A separate adapter and context wrapper over the same fixture root see the
        // same durable identity, not a newly generated key.
        val reopened = AndroidClientStorage.identityStore(
            FixtureEnvironment.contextWithRoot(base, root),
            alias,
        )
        assertEquals(PeerIdentityStatus.Ready, reopened.status())
        assertTrue(handle.key.contentEquals(reopened.current().key))
    }

    /**
     * Regression for the demonstrated AndroidKeyStore/Conscrypt mTLS failure.
     *
     * During the handshake Conscrypt hashes the CertificateVerify transcript itself and
     * hands the platform key store the *already computed* digest through
     * `NONEwithECDSA`. A P-256 key authorized only for SHA-256 refused that with KeyMint
     * `INCOMPATIBLE_DIGEST` ("Digest 0 was specified, but not authorized by key"), so
     * real mTLS died before any HTTP byte. `NONE` authorizes only that local
     * already-hashed step: the bytes handed to the key store are a SHA-256 digest, TLS
     * still picks and hashes its own signature algorithm, and the peer still checks the
     * result with `SHA256withECDSA` against the stored certificate's public key.
     */
    @Test
    fun identityPrivateKeySignsAnAlreadyComputedSha256Digest() {
        val store = AndroidClientStorage.identityStore(context, alias)
        val handle = store.initialize(HostLabel.parse(FixtureEnvironment.IDENTITY_LABEL))

        val privateKey = handle.newKeyManager().getPrivateKey(alias)
            ?: throw AssertionError("the fixture key manager returned no private-key handle")
        assertEquals("EC", privateKey.algorithm)
        assertNull(
            "AndroidKeyStore private key must not be exportable",
            runCatching { privateKey.encoded }.getOrNull(),
        )

        val message = ("peer-verify-transcript-" + nonce).toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(message)

        val signer = Signature.getInstance("NONEwithECDSA")
        signer.initSign(privateKey)
        signer.update(digest)
        val signature = signer.sign()
        assertTrue(
            "signature is not a DER ECDSA signature value",
            signature.isNotEmpty() && signature[0].toInt() == 0x30,
        )

        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(handle.certificateChain.first().publicKey)
        verifier.update(message)
        assertTrue(
            "signature over the digest must verify over the original message",
            verifier.verify(signature),
        )

        val tampered = Signature.getInstance("SHA256withECDSA")
        tampered.initVerify(handle.certificateChain.first().publicKey)
        tampered.update(message, 0, message.size - 1)
        assertFalse("a signature over different bytes must not verify", tampered.verify(signature))
    }
}
