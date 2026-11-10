package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.identity.IdentityException
import io.github.rfairburn.pireviewgate.core.identity.IdentityFailureReason
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityHandle
import io.github.rfairburn.pireviewgate.core.transport.PeerClientIdentity
import javax.net.ssl.KeyManager

/**
 * This device's identity, as the transport needs to see it.
 *
 * The transport asks for three facts — a bounded display label, the canonical
 * key id this side claims, and the key managers that prove possession during the
 * handshake. This adapter supplies exactly those, from a [PeerIdentityHandle],
 * and adds nothing: it never serializes, encodes, caches, or logs the private
 * half. [keyManagers] hands over the key store's own manager object, which
 * signs when the TLS stack asks and keeps the key where it lives.
 *
 * The label is display metadata for the far side's list, never identity: trust
 * on both sides is the exact SPKI. It is fixed so every host sees the same name
 * for this device regardless of which saved host triggered the handshake.
 */
public class DevicePeerIdentity(
    private val handle: PeerIdentityHandle,
) : PeerClientIdentity {
    override val label: String = LABEL

    override val keyId: String = handle.key.keyId

    override val keyManagers: Array<KeyManager> = arrayOf(handle.newKeyManager())

    /** Public display fingerprint of this device's identity. Never key material. */
    public val fingerprint: String get() = handle.key.fingerprint

    public companion object {
        /** The fixed label this device presents to every peer. */
        public const val LABEL: String = "Pi Review Gate"
    }
}

/**
 * Maps one canonical identity between the two layers that need it.
 *
 * Durable trust lives in the storage model's [io.github.rfairburn.pireviewgate.core.identity.PeerKey];
 * a live handshake proves the transport model's
 * [io.github.rfairburn.pireviewgate.core.transport.PeerKey]. They are different
 * types on purpose, so a mistake has to be deliberate. The conversion is the
 * exact SubjectPublicKeyInfo and nothing else: each direction re-derives from
 * the validated key bytes and re-checks them, so a label, a certificate hash, a
 * digest, or a hand-edited record can never bridge the two.
 *
 * A malformed stored value is reported as [PeerKeyConversionRejected] rather
 * than being repaired: the caller fails closed and says so.
 */
public object PeerKeyBridge {
    /** Durable identity to transport identity, from the exact SPKI DER. */
    public fun toTransport(stored: io.github.rfairburn.pireviewgate.core.identity.PeerKey):
        io.github.rfairburn.pireviewgate.core.transport.PeerKey = try {
        io.github.rfairburn.pireviewgate.core.transport.PeerKey.fromSpkiDer(stored.spkiDer)
    } catch (_: Throwable) {
        throw PeerKeyConversionRejected()
    }

    /** Transport identity to durable identity, from the exact SPKI DER. */
    public fun toStored(
        observed: io.github.rfairburn.pireviewgate.core.transport.PeerKey,
    ): io.github.rfairburn.pireviewgate.core.identity.PeerKey = try {
        io.github.rfairburn.pireviewgate.core.identity.PeerKey.fromSpki(observed.pinnedDer())
    } catch (_: Throwable) {
        throw PeerKeyConversionRejected()
    }

    /** True only when both values describe the exact same key. */
    public fun sameKey(
        stored: io.github.rfairburn.pireviewgate.core.identity.PeerKey,
        observed: io.github.rfairburn.pireviewgate.core.transport.PeerKey,
    ): Boolean = try {
        toTransport(stored) == observed
    } catch (_: PeerKeyConversionRejected) {
        false
    }
}

/** A stored or observed identity could not be re-derived from its own key bytes. */
public class PeerKeyConversionRejected : IllegalStateException("peer identity could not be read", null)

/** Why this device's identity is not usable, in the registry's own fixed terms. */
internal fun identityReason(reason: IdentityFailureReason): DeviceIdentityReason = when (reason) {
    IdentityFailureReason.MISSING_INITIALIZED -> DeviceIdentityReason.MISSING_INITIALIZED
    IdentityFailureReason.INCONSISTENT_EVIDENCE -> DeviceIdentityReason.INCONSISTENT
    IdentityFailureReason.KEY_STORE_UNAVAILABLE -> DeviceIdentityReason.KEY_STORE_UNAVAILABLE
    IdentityFailureReason.UNSAFE_KEY_MATERIAL -> DeviceIdentityReason.UNSAFE_KEY_MATERIAL
    IdentityFailureReason.KEY_UNUSABLE -> DeviceIdentityReason.KEY_UNUSABLE
    IdentityFailureReason.ALREADY_INITIALIZED -> DeviceIdentityReason.INCONSISTENT
    IdentityFailureReason.LABEL_INVALID -> DeviceIdentityReason.UNSAFE_KEY_MATERIAL
}

/** A fixed refusal of this device's identity, carrying no cause text. */
internal class RegistryIdentityException(
    val reason: DeviceIdentityReason,
) : IllegalStateException("this device's peer identity is unavailable", null)

internal fun asRegistryIdentityFailure(failure: IdentityException): RegistryIdentityException =
    RegistryIdentityException(identityReason(failure.reason))
