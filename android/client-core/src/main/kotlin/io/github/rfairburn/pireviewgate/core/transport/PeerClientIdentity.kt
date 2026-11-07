package io.github.rfairburn.pireviewgate.core.transport

import javax.net.ssl.KeyManager

/**
 * Explicit target of one peer connection.
 *
 * Endpoints are always supplied by the caller; nothing here defaults a host or
 * discovers an address, and an endpoint is never identity.
 */
class PeerEndpoint(val host: String, val port: Int) {
    init {
        if (
            host.isEmpty() ||
            host.length > 255 ||
            host.any { it.isWhitespace() || it == '/' || it == '\\' || it == '?' || it == '#' || it == '@' } ||
            port <= 0 ||
            port > 65_535
        ) {
            throw invalidArgument()
        }
    }

    /** `Host` header form, with the bracket form required for IPv6 literals. */
    internal fun hostHeaderValue(): String {
        val hostPart = if (host.contains(':')) "[" + host + "]" else host
        return hostPart + ":" + port
    }

    override fun toString(): String = "PeerEndpoint(port=$port)"
}

/**
 * Owned client identity material supplied by the caller.
 *
 * The transport deliberately does not parse PEM, generate keys, or touch any
 * keystore: the platform adapter (Android identity storage) owns persistence
 * and hands over exactly the three facts the transport needs — a bounded
 * display label, this side's canonical key id used as the pairing claim, and
 * the [KeyManager] array that proves possession of that key during the TLS
 * handshake. The transport verifies that the key proved on the handshake is the
 * key it is claiming; it never infers identity from a name.
 */
interface PeerClientIdentity {
    /** Friendly display label; bounded, line-safe, never identity. */
    val label: String

    /** Canonical base64 SPKI key id of the key the [keyManagers] prove. */
    val keyId: String

    /** Client certificate chain and private key material for mTLS. */
    val keyManagers: Array<KeyManager>
}

internal fun requireUsableIdentity(identity: PeerClientIdentity) {
    if (!isPeerLabel(identity.label, DEFAULT_LABEL_BYTES)) throw invalidArgument()
    if (!isBoundedPeerKeyId(identity.keyId)) throw invalidArgument()
    if (identity.keyManagers.isEmpty()) throw invalidArgument()
}

private const val DEFAULT_LABEL_BYTES = 64
