package io.github.rfairburn.pireviewgate.core.identity

import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import javax.net.ssl.X509ExtendedKeyManager
import java.security.cert.X509Certificate

/** Fixed identity-adapter refusal. The message is fixed text; no cause text leaks. */
public class IdentityException(
    public val reason: IdentityFailureReason,
) : IllegalStateException(messageOf(reason), null) {

    private companion object {
        fun messageOf(reason: IdentityFailureReason): String = when (reason) {
            IdentityFailureReason.MISSING_INITIALIZED -> "this device's peer identity is not initialized"
            IdentityFailureReason.ALREADY_INITIALIZED -> "this device's peer identity already exists"
            IdentityFailureReason.LABEL_INVALID -> "the identity label is not allowed"
            IdentityFailureReason.KEY_STORE_UNAVAILABLE -> "the device key store is unavailable"
            IdentityFailureReason.UNSAFE_KEY_MATERIAL -> "this device's peer identity could not be read"
            IdentityFailureReason.KEY_UNUSABLE -> "this device's peer identity could not be used"
            IdentityFailureReason.INCONSISTENT_EVIDENCE -> "this device's peer identity could not be verified"
        }
    }
}

/** Why the device peer identity is not usable. Fixed reasons only. */
public enum class IdentityFailureReason {
    /** A previous initialization is expected but its key entry is not present. Never regenerated. */
    MISSING_INITIALIZED,

    /** An identity already exists; initialization is one-time and never replaces it. */
    ALREADY_INITIALIZED,

    /** The supplied display label is not admissible as a certificate subject. */
    LABEL_INVALID,

    /** The platform key store could not be opened. */
    KEY_STORE_UNAVAILABLE,

    /** The stored entry is not the expected, usable, non-exportable P-256 identity. */
    UNSAFE_KEY_MATERIAL,

    /**
     * The recorded initialization evidence and the stored key entry do not agree, or
     * the evidence itself is unreadable.
     *
     * This covers a key entry with no recorded initialization, evidence naming a
     * different public key, and malformed or unknown-version evidence. The client
     * refuses instead of adopting either side or generating a third identity.
     */
    INCONSISTENT_EVIDENCE,

    /** The key exists but cannot perform the signing operation the handshake needs. */
    KEY_UNUSABLE,
}

/** What the identity adapter can currently see. Observing never creates a key. */
public sealed interface PeerIdentityStatus {
    /** No identity has ever been initialized on this device. Nothing was created. */
    public data object NeverInitialized : PeerIdentityStatus

    /** A usable identity exists. */
    public data object Ready : PeerIdentityStatus

    /** The identity exists but is not usable, or its presence cannot be established. */
    public data class Refused(public val reason: IdentityFailureReason) : PeerIdentityStatus
}

/**
 * This device's own peer identity, ready for a future transport.
 *
 * [key] is the canonical identity the far side pins: the exact SPKI of the
 * certificate in [certificateChain]. The private half is a key-store object handle
 * only — [newKeyManager] hands a manager that signs with it, and nothing in this
 * contract can serialize, export, or log it.
 */
public interface PeerIdentityHandle {
    /** Canonical identity derived from the exact certificate public key. */
    public val key: PeerKey

    /** Certificate chain presented during the handshake. Never private material. */
    public val certificateChain: List<X509Certificate>

    /**
     * A key manager suitable for the client side of a future TLS session.
     *
     * It returns the key-store's private key object handle when the TLS stack asks
     * for it; it never encodes or persists that key anywhere.
     */
    public fun newKeyManager(): X509ExtendedKeyManager
}

/**
 * This device's own peer identity lifecycle.
 *
 * The phone is a client only: it still needs its own identity because the far side
 * authenticates the connecting peer, and this side presents it during the
 * handshake. Key generation is deliberate and one-time:
 *
 * - [status] and [current] observe only. Neither creates a key, a certificate, a
 *   file, nor a directory.
 * - [initialize] is the only generating operation, and callers reach it from an
 *   explicit user connect/pair action — never from startup or a settings read.
 * - A previously initialized identity that has gone missing is refused
 *   ([IdentityFailureReason.MISSING_INITIALIZED]); evidence and entry that disagree are
 *   refused ([IdentityFailureReason.INCONSISTENT_EVIDENCE]). Neither is repaired by
 *   generating, because a new key would silently break every host that pinned this
 *   device.
 *
 * Initialization is recorded in private durable evidence bound to the generated public
 * key, so "has this device ever had an identity?" is answered from two independent
 * facts rather than from the presence of one key-store entry, and the whole
 * check-and-generate sequence runs serialized.
 */
public interface PeerIdentityStore : AutoCloseable {
    /** Observe identity presence. Never creates anything. */
    public fun status(): PeerIdentityStatus

    /** The usable identity. */
    public fun current(): PeerIdentityHandle

    /**
     * Generate this device's identity once, for [label].
     *
     * @throws IdentityException when an identity already exists, the label is not
     *   admissible, or the platform key store refuses.
     */
    public fun initialize(label: HostLabel): PeerIdentityHandle

    /** Release this handle. */
    override fun close()
}
