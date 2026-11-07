package io.github.rfairburn.pireviewgate.androidtest

import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * First phase of the two-phase synthetic-host check.
 *
 * The fixture host must approve the exact device public key, so this phase
 * initializes (or reuses) one uniquely named fixture identity and reports its
 * public key id to the host-side runner. No fixture host or device credential is
 * involved here, and the identity is never the production default alias.
 *
 * Run this class first, start the synthetic host with the reported key id, then
 * run [AndroidKeystoreTransportLanesTest]. [AndroidFixtureCleanupTest] removes the
 * fixture identity and its storage afterwards.
 */
@RunWith(AndroidJUnit4::class)
class AndroidFixtureIdentitySetupTest {

    @Test
    fun initializeOrReuseFixtureIdentityAndReportPublicKey() {
        val base = FixtureEnvironment.targetContext()
        val nonce = FixtureEnvironment.requireNonce()
        val root = FixtureEnvironment.rootFor(base, nonce)
        val alias = FixtureEnvironment.aliasFor(nonce)
        val context = FixtureEnvironment.contextWithRoot(base, root)
        val store = AndroidClientStorage.identityStore(context, alias)
        val label = HostLabel.parse(FixtureEnvironment.IDENTITY_LABEL)

        val handle = when (val status = store.status()) {
            PeerIdentityStatus.NeverInitialized -> store.initialize(label)
            PeerIdentityStatus.Ready -> store.current()
            is PeerIdentityStatus.Refused ->
                throw AssertionError("fixture identity is refused: ${status.reason}")
        }

        assertTrue(handle.key.keyId.isNotEmpty())
        FixtureEnvironment.sendStatus("fixtureClientKeyId", handle.key.keyId)
        FixtureEnvironment.sendStatus("fixtureClientFingerprint", handle.key.fingerprint)
        FixtureEnvironment.sendStatus("fixtureIdentityAlias", alias)
    }
}
