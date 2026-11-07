package io.github.rfairburn.pireviewgate.storage

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import io.github.rfairburn.pireviewgate.core.hosts.ExclusiveLock
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.identity.IdentityException
import io.github.rfairburn.pireviewgate.core.identity.IdentityFailureReason
import io.github.rfairburn.pireviewgate.core.identity.MaterialObservation
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityEvidenceStore
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityHandle
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityLifecycle
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityMaterialSeam
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStore
import io.github.rfairburn.pireviewgate.core.identity.PeerKey
import java.math.BigInteger
import java.security.InvalidAlgorithmParameterException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.NoSuchAlgorithmException
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.security.auth.x500.X500Principal

/**
 * This device's peer identity, held by the Android key store.
 *
 * The key is a non-exportable P-256 signing key: AndroidKeyStore entries cannot be
 * read out, and nothing here asks for a password, serializes a key, or logs one. The
 * self-signed certificate is only a container that carries the public key through TLS —
 * identity is the exact SPKI the far side pins, so a re-issued certificate around the
 * same key does not change who this device is.
 *
 * No OS user-authentication requirement is imposed: an ordinary handshake must succeed
 * without a biometric or device-unlock prompt, and inventing one would make the client
 * unusable. The key is protected by the platform's own key-store guarantees, which is
 * the boundary that actually exists for a LAN peer.
 *
 * The lifecycle policy — evidence of initialization, presence decisions, refusal to
 * regenerate, and serialized one-time generation — lives in the platform-independent
 * [PeerIdentityLifecycle]; this adapter only talks to the key store. Constructing the
 * store and calling `status()` touch no key material, and only `initialize()` generates,
 * reached from an explicit user connect/pair action.
 */
public class AndroidKeyStorePeerIdentityStore(
    alias: String = DEFAULT_IDENTITY_ALIAS,
    evidenceStore: PeerIdentityEvidenceStore,
    initializationLock: ExclusiveLock,
    material: PeerIdentityMaterialSeam = AndroidKeyStoreMaterialSeam(),
) : PeerIdentityStore by PeerIdentityLifecycle(alias, material, evidenceStore, initializationLock) {

    public companion object {
        /** Key-store alias holding this device's single peer identity. */
        public const val DEFAULT_IDENTITY_ALIAS: String = "pi-review-gate-peer-identity"
    }
}

/**
 * The AndroidKeyStore seam: observe one alias, and generate it once when the lifecycle
 * policy has decided that no identity has ever been initialized.
 *
 * Generation asks the platform for a self-signed certificate around a fresh non-exportable
 * P-256 pair, with the bounded display label as the certificate subject. Reading derives
 * the canonical identity from the stored certificate's exact public key; it never creates
 * one.
 */
internal class AndroidKeyStoreMaterialSeam(
    private val keyStore: KeyStore = openAndroidKeyStore(),
) : PeerIdentityMaterialSeam {

    override fun observe(alias: String): MaterialObservation {
        val exists = try {
            keyStore.containsAlias(alias)
        } catch (_: Exception) {
            return MaterialObservation.Unusable(IdentityFailureReason.KEY_STORE_UNAVAILABLE)
        }
        if (!exists) return MaterialObservation.Absent

        val chain = try {
            keyStore.getCertificateChain(alias)
        } catch (_: Exception) {
            return MaterialObservation.Unusable(IdentityFailureReason.KEY_STORE_UNAVAILABLE)
        }
        if (chain == null || chain.isEmpty() || chain.size > MAX_CHAIN_LENGTH) {
            return MaterialObservation.Unusable(IdentityFailureReason.UNSAFE_KEY_MATERIAL)
        }
        val certificates = ArrayList<X509Certificate>(chain.size)
        for (entry in chain) {
            val certificate = entry as? X509Certificate
                ?: return MaterialObservation.Unusable(IdentityFailureReason.UNSAFE_KEY_MATERIAL)
            certificates.add(certificate)
        }

        val spki = try {
            certificates.first().publicKey.encoded
        } catch (_: Exception) {
            return MaterialObservation.Unusable(IdentityFailureReason.UNSAFE_KEY_MATERIAL)
        }
        if (spki.isEmpty() || spki.size > PeerKey.MAX_SPKI_DER_BYTES) {
            return MaterialObservation.Unusable(IdentityFailureReason.UNSAFE_KEY_MATERIAL)
        }
        val key = try {
            PeerKey.fromSpki(spki)
        } catch (_: Exception) {
            return MaterialObservation.Unusable(IdentityFailureReason.UNSAFE_KEY_MATERIAL)
        }

        // The signing handle must be obtainable for the handshake to work at all.
        val usable = try {
            keyStore.getKey(alias, null) != null
        } catch (_: Exception) {
            false
        }
        if (!usable) return MaterialObservation.Unusable(IdentityFailureReason.KEY_UNUSABLE)

        return MaterialObservation.Present(KeyStorePeerIdentityHandle(keyStore, alias, key, certificates))
    }

    override fun generate(alias: String, label: HostLabel) {
        val now = System.currentTimeMillis()
        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE_SECP256R1))
            // SHA-256 authorizes the self-signed certificate's own signature. NONE is
            // what the TLS handshake needs: Conscrypt hashes the CertificateVerify
            // transcript itself and asks the key store to sign that finished digest
            // through NONEwithECDSA, which KeyMint rejects as INCOMPATIBLE_DIGEST
            // ("Digest 0 was specified, but not authorized by key") unless DIGEST_NONE
            // is authorized. NONE authorizes only that local already-hashed signing
            // step: TLS still chooses and hashes its own signature algorithm, and this
            // changes no pin, TLS version, certificate chain, or exportability. It
            // applies to newly generated aliases; an existing identity keeps whatever
            // authorization it was created with.
            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
            .setCertificateSerialNumber(freshSerialNumber())
            .setCertificateSubject(X500Principal("CN=${label.value}"))
            .setCertificateNotBefore(Date(now - CERTIFICATE_BACKDATED_MS))
            .setCertificateNotAfter(Date(now + CERTIFICATE_VALIDITY_MS))
            // An ordinary handshake must never require a biometric or unlock prompt.
            .setUserAuthenticationRequired(false)
            .build()

        try {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEY_STORE)
            generator.initialize(spec)
            generator.generateKeyPair()
        } catch (_: InvalidAlgorithmParameterException) {
            throw IdentityException(IdentityFailureReason.KEY_UNUSABLE)
        } catch (_: NoSuchAlgorithmException) {
            throw IdentityException(IdentityFailureReason.KEY_STORE_UNAVAILABLE)
        } catch (_: Exception) {
            // Fixed reason only: no platform message, alias, or cause text escapes.
            throw IdentityException(IdentityFailureReason.KEY_STORE_UNAVAILABLE)
        }
    }

    private companion object {
        /** The platform key store that holds non-exportable keys. */
        const val ANDROID_KEY_STORE: String = "AndroidKeyStore"
        const val CURVE_SECP256R1 = "secp256r1"
        const val MAX_CHAIN_LENGTH = 4
        const val CERTIFICATE_BACKDATED_MS = 60_000L

        /** One year: well inside the product's bounded identity validity. */
        const val CERTIFICATE_VALIDITY_MS = 365L * 86_400_000L

        fun openAndroidKeyStore(): KeyStore =
            KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

        fun freshSerialNumber(): BigInteger = BigInteger(128, SecureRandom()).setBit(0)
    }
}
