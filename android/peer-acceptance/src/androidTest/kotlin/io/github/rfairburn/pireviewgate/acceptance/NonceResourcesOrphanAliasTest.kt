package io.github.rfairburn.pireviewgate.acceptance

import android.os.Process
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import javax.security.auth.x500.X500Principal

/** Real fixture-UID KeyStore regression; no app aliases or fixture cleanup ownership. */
@RunWith(AndroidJUnit4::class)
class NonceResourcesOrphanAliasTest {
    @Test fun preparationAndFallbackCleanupPreserveOrphanAlias() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals(FIXTURE_PACKAGE, context.packageName)
        assertEquals(context.applicationInfo.uid, Process.myUid())
        val nonce = checkedNonce(UUID.randomUUID().toString().replace("-", "").take(16))
        val root = File(context.noBackupFilesDir.canonicalFile, "peer-acceptance-$nonce")
        val marker = File(root, "ownership")
        val alias = "pi-review-gate-acceptance-$nonce"
        fun assertNoOwnershipEvidence() {
            assertTrue("fixture root must remain absent", Files.notExists(root.toPath(), LinkOption.NOFOLLOW_LINKS))
            assertTrue("ownership marker must remain absent", Files.notExists(marker.toPath(), LinkOption.NOFOLLOW_LINKS))
        }

        // Never clear a collision or use NonceResources to authorize this independent key.
        assertNoOwnershipEvidence()
        val keys = keyStore()
        assertFalse("fresh exact alias already exists", keys.containsAlias(alias))
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
                .setCertificateSubject(X500Principal("CN=$FIXTURE_LABEL"))
                .setUserAuthenticationRequired(false)
                .build(),
        )
        val createdPublicKey = generator.generateKeyPair().public.encoded
        val createdCertificate = checkNotNull(keys.getCertificate(alias)).encoded
        try {
            retainedIdentity(alias, createdPublicKey, createdCertificate)
            assertNoOwnershipEvidence()

            // The real prepareIdentity resource/production identity lifecycle, not a fake store.
            assertThrows(IllegalStateException::class.java) {
                NonceResources.open(context, nonce, create = true).use { owned ->
                    val key = owned.identity.use {
                        when (it.status()) {
                            PeerIdentityStatus.NeverInitialized -> it.initialize(HostLabel.parse(FIXTURE_LABEL)).key
                            is PeerIdentityStatus.Ready -> it.current().key
                            is PeerIdentityStatus.Refused -> error("fixture identity refused")
                        }
                    }
                    check(canonicalPublicKey(key.keyId) == key)
                }
            }
            assertNoOwnershipEvidence()
            retainedIdentity(alias, createdPublicKey, createdCertificate)

            assertThrows(IllegalStateException::class.java) { NonceResources.cleanup(context, nonce) }
            assertNoOwnershipEvidence()
            retainedIdentity(alias, createdPublicKey, createdCertificate)
        } finally {
            // Positive creation plus retained public identity, never a new fixture marker,
            // authorizes teardown of ONLY this test's alias. Do not repair/delete any root.
            val retained = retainedIdentity(alias, createdPublicKey, createdCertificate)
            retained.deleteEntry(alias)
            assertFalse("test-owned alias teardown unverified", keyStore().containsAlias(alias))
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun retainedIdentity(alias: String, publicKey: ByteArray, certificate: ByteArray): KeyStore {
        val keys = keyStore()
        assertTrue("orphan alias must survive", keys.containsAlias(alias))
        assertTrue("orphan key entry must survive", keys.isKeyEntry(alias))
        val retained = checkNotNull(keys.getCertificate(alias)) { "orphan certificate missing" }
        // Boolean assertions avoid printing certificate/key bytes on failure; no private key is read.
        assertTrue("orphan public key changed", publicKey.contentEquals(retained.publicKey.encoded))
        assertTrue("orphan certificate changed", certificate.contentEquals(retained.encoded))
        return keys
    }
}
