package io.github.rfairburn.pireviewgate.androidtest

import android.content.Context
import android.content.ContextWrapper
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyStore

/**
 * One isolated, app-private fixture location for instrumented checks.
 *
 * Every invocation names its own nonce. The fixture never uses the production
 * no-backup root, the default identity alias, a configured host, or a shared
 * document, so it cannot observe or disturb real client state on the device.
 *
 * The wrapper overrides [Context.getNoBackupFilesDir] to a unique child of the
 * target app's cache directory. That keeps the production adapter's
 * `noBackupFilesDir`-rooted layout unchanged while confining every fixture write
 * to an owned path this test deletes afterwards.
 */
internal object FixtureEnvironment {

    /** Prefix for fixture-only AndroidKeyStore aliases. */
    const val IDENTITY_ALIAS_PREFIX: String = "pi-review-gate-android-fixture-"

    /** Bounded display label used for the fixture identity certificate. */
    const val IDENTITY_LABEL: String = "android-fixture-phone"

    /** Fixed host label the synthetic fixture presents. */
    const val FIXTURE_HOST_LABEL: String = "android-peer-fixture-host"

    private const val ROOT_DIR_NAME = "android-peer-fixture"
    private val NONCE_PATTERN = Regex("^[A-Za-z0-9-]{8,64}$")

    fun requireNonce(): String {
        val nonce = argument("fixtureNonce")
        require(NONCE_PATTERN.matches(nonce)) { "fixtureNonce is not a bounded fixture token" }
        return nonce
    }

    fun nonceOrNull(): String? =
        InstrumentationRegistry.getArguments().getString("fixtureNonce")
            ?.takeIf { NONCE_PATTERN.matches(it) }

    fun requireArgument(name: String): String {
        val value = argument(name)
        require(value.isNotBlank()) { "fixture argument is empty: $name" }
        return value
    }

    fun requireIntArgument(name: String): Int {
        val value = requireArgument(name).toIntOrNull()
        require(value != null && value in 1..65_535) { "fixture argument is not a port: $name" }
        return value
    }

    fun argumentOrDefault(name: String, default: String): String =
        InstrumentationRegistry.getArguments().getString(name)?.takeIf { it.isNotBlank() } ?: default

    fun targetContext(): Context = InstrumentationRegistry.getInstrumentation().targetContext

    fun rootFor(base: Context, nonce: String): File =
        File(base.cacheDir, "$ROOT_DIR_NAME/$nonce")

    /** Context whose no-backup root is exactly [root]; nothing is created here. */
    fun contextWithRoot(base: Context, root: File): Context = object : ContextWrapper(base) {
        override fun getNoBackupFilesDir(): File = root
    }

    fun aliasFor(nonce: String): String {
        val token = nonce.filter { it.isLetterOrDigit() }
        require(token.isNotEmpty()) { "fixture nonce has no alias-safe characters" }
        return IDENTITY_ALIAS_PREFIX + token
    }

    fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun keyStoreContains(alias: String): Boolean = keyStore().containsAlias(alias)

    /** Delete exactly one fixture-owned alias, never a default or production alias. */
    fun deleteOwnedAlias(alias: String) {
        require(alias.startsWith(IDENTITY_ALIAS_PREFIX)) { "refusing to delete a non-fixture alias" }
        val keyStore = keyStore()
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }

    /**
     * Delete one fixture root. [root] must be exactly one nonce child below this
     * app's cache fixture directory, so no production or unrelated path can be
     * targeted by mistake.
     */
    fun deleteOwnedRoot(base: Context, root: File) {
        val fixtureBase = File(base.cacheDir, ROOT_DIR_NAME).canonicalFile
        val target = root.canonicalFile
        require(target.parentFile == fixtureBase) { "refusing to delete a non-fixture root" }
        if (!target.exists()) return
        target.walkBottomUp().forEach { entry -> entry.delete() }
    }

    fun sendStatus(key: String, value: String) {
        val bundle = Bundle().apply { putString(key, value) }
        InstrumentationRegistry.getInstrumentation().sendStatus(2, bundle)
    }

    private fun argument(name: String): String =
        InstrumentationRegistry.getArguments().getString(name)
            ?: throw IllegalArgumentException("missing fixture argument: $name")
}
