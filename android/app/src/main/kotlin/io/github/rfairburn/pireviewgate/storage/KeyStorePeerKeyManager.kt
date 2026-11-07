package io.github.rfairburn.pireviewgate.storage

import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityHandle
import io.github.rfairburn.pireviewgate.core.identity.PeerKey
import java.net.Socket
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager

/**
 * A client-side [X509ExtendedKeyManager] backed by one Android key-store entry.
 *
 * The manager exists so a future transport can present this device's identity in a
 * TLS handshake without ever holding the private key:
 *
 * - [getPrivateKey] returns the key store's own private key object handle. That
 *   handle is not exportable and nothing here encodes, caches, writes, or logs it.
 * - Only this one alias is ever offered, and only for client (outbound) use. Server
 *   selection methods answer "nothing", because this client never terminates TLS.
 *
 * @param alias the exact key-store alias holding this device's identity.
 * @param chain the certificate chain to present, as read from the key store.
 */
internal class KeyStorePeerKeyManager(
    private val keyStore: KeyStore,
    private val alias: String,
    private val chain: Array<X509Certificate>,
) : X509ExtendedKeyManager() {

    private val aliasArray: Array<String> = arrayOf(alias)

    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> =
        if (supports(keyType)) aliasArray else EMPTY_ALIASES

    override fun chooseClientAlias(
        keyType: Array<out String>?,
        issuers: Array<out Principal>?,
        socket: Socket?,
    ): String? {
        if (keyType == null || keyType.none { supports(it) }) return null
        return alias
    }

    override fun chooseEngineClientAlias(
        keyType: Array<out String>?,
        issuers: Array<out Principal>?,
        engine: SSLEngine?,
    ): String? {
        if (keyType == null || keyType.none { supports(it) }) return null
        return alias
    }

    /** This client never acts as a TLS server. */
    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> =
        EMPTY_ALIASES

    /** This client never acts as a TLS server. */
    override fun chooseServerAlias(
        keyType: String?,
        issuers: Array<out Principal>?,
        socket: Socket?,
    ): String? = null

    /** This client never acts as a TLS server. */
    override fun chooseEngineServerAlias(
        keyType: String?,
        issuers: Array<out Principal>?,
        engine: SSLEngine?,
    ): String? = null

    override fun getCertificateChain(alias: String?): Array<X509Certificate>? =
        if (alias == this.alias) chain else null

    /**
     * The key-store's private key object handle for [alias], or `null` for any other
     * alias. The handle cannot be extracted; only the platform can use it to sign.
     */
    override fun getPrivateKey(alias: String?): PrivateKey? {
        if (alias != this.alias) return null
        return try {
            keyStore.getKey(this.alias, null) as? PrivateKey
        } catch (_: Exception) {
            // A key-store refusal is reported by returning nothing. It never causes
            // a regeneration attempt, and no detail is surfaced or logged.
            null
        }
    }

    private fun supports(keyType: String?): Boolean = keyType != null && keyType in SUPPORTED_KEY_TYPES

    private companion object {
        /** AndroidKeyStore P-256 entries are offered for the EC key types only. */
        val SUPPORTED_KEY_TYPES: Set<String> = setOf("EC", "ECDSA", "ECDHE_ECDSA")
        val EMPTY_ALIASES: Array<String> = emptyArray()
    }
}

/**
 * One initialized device identity: the canonical peer key, the chain to present, and
 * a key manager that can sign with the key-store entry.
 */
internal class KeyStorePeerIdentityHandle(
    private val keyStore: KeyStore,
    private val alias: String,
    override val key: PeerKey,
    private val certificates: List<X509Certificate>,
) : PeerIdentityHandle {

    override val certificateChain: List<X509Certificate> get() = certificates

    override fun newKeyManager(): X509ExtendedKeyManager =
        KeyStorePeerKeyManager(keyStore, alias, certificates.toTypedArray())
}
