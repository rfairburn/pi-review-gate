package io.github.rfairburn.pireviewgate.androidtest

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/** Removes exactly the fixture-owned alias and fixture root for one nonce. */
@RunWith(AndroidJUnit4::class)
class AndroidFixtureCleanupTest {

    @Test
    fun deleteOwnedFixtureIdentityAndStorage() {
        val base = FixtureEnvironment.targetContext()
        val nonce = FixtureEnvironment.requireNonce()
        val root = FixtureEnvironment.rootFor(base, nonce)
        val alias = FixtureEnvironment.aliasFor(nonce)

        FixtureEnvironment.deleteOwnedAlias(alias)
        FixtureEnvironment.deleteOwnedRoot(base, root)

        assertFalse(FixtureEnvironment.keyStoreContains(alias))
        assertFalse(root.exists())
    }
}
