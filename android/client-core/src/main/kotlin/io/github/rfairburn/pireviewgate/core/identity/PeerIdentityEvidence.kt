package io.github.rfairburn.pireviewgate.core.identity

import io.github.rfairburn.pireviewgate.core.hosts.DocumentRead
import io.github.rfairburn.pireviewgate.core.hosts.DocumentWriteResult
import io.github.rfairburn.pireviewgate.core.hosts.SingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.asNumberOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asObjectOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive

/**
 * Durable proof that this device's peer identity was initialized, bound to the exact
 * public key of that identity.
 *
 * A key store entry alone cannot answer the question that matters before generating:
 * "has this client ever had an identity?" If the answer came only from the presence of
 * an alias, deleting or losing that entry would look like a fresh installation and the
 * next Connect would silently mint a second identity — every host that pinned the first
 * one would then be shown a key mismatch it cannot explain. So the client records its
 * own initialization evidence in private storage and consults it first.
 *
 * The evidence names the public identity only. It is not a secret, contains no key
 * material, and grants nothing: it exists to distinguish a genuinely fresh device from
 * a lost initialization.
 */
public data class PeerIdentityEvidence(
    val key: PeerKey,
)

/** What the evidence store can see. */
public sealed interface EvidenceRead {
    /** No evidence has ever been published. */
    public data object Absent : EvidenceRead

    /** Evidence exists and decoded cleanly. */
    public data class Present(public val evidence: PeerIdentityEvidence) : EvidenceRead

    /** Evidence exists but is unusable: malformed, unknown version, or unsafe. */
    public data class Refused(public val reason: StorageFailureReason) : EvidenceRead
}

/** Outcome of an exclusive evidence publication. */
public sealed interface EvidencePublishResult {
    /** This is the evidence document; it will not be replaced. */
    public data object Published : EvidencePublishResult

    /** Evidence already exists, or the publication was refused. Nothing was changed. */
    public data class Refused(public val reason: StorageFailureReason) : EvidencePublishResult
}

/**
 * The client's one-time initialization record for its own peer identity.
 *
 * Publication is exclusive: the first record is the only record. There is no update,
 * repair, rotation, or reset path here by design.
 */
public interface PeerIdentityEvidenceStore {
    /** Observe the evidence. Never creates anything. */
    public fun read(): EvidenceRead

    /** Publish evidence only while none exists. */
    public fun publishExclusive(evidence: PeerIdentityEvidence): EvidencePublishResult
}

/** The closed, versioned persisted schema for [PeerIdentityEvidence]. */
public object PeerIdentityEvidenceCodec {
    /** Persisted document version. Unknown versions are refused, never migrated. */
    public const val EVIDENCE_DOCUMENT_VERSION: Int = 1

    /** Bound for the whole published evidence document. */
    public const val MAX_EVIDENCE_DOCUMENT_BYTES: Int = 4 * 1024

    private const val KEY_VERSION = "version"
    private const val KEY_KEY_ID = "keyId"
    private const val KEY_FINGERPRINT = "fingerprint"

    private val TOP_LEVEL_KEYS = setOf(KEY_VERSION, KEY_KEY_ID, KEY_FINGERPRINT)

    /** Decode a persisted document. Any deviation yields one fixed refusal reason. */
    public fun decode(bytes: ByteArray): EvidenceDecodeResult {
        val text = try {
            bytes.decodeToString(throwOnInvalidSequence = true)
        } catch (_: Exception) {
            return EvidenceDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        return decode(text)
    }

    /** Decode document text. Any deviation yields one fixed refusal reason. */
    public fun decode(text: String): EvidenceDecodeResult {
        val parsed = try {
            Json.parseToJsonElement(text)
        } catch (_: Exception) {
            return EvidenceDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        val root = parsed.asObjectOrNull()
            ?: return EvidenceDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if ((root.keys - TOP_LEVEL_KEYS).isNotEmpty()) {
            return EvidenceDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        val version = root[KEY_VERSION].asNumberOrNull()
            ?: return EvidenceDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if (version != EVIDENCE_DOCUMENT_VERSION) {
            return EvidenceDecodeResult.Invalid(StorageFailureReason.UNSUPPORTED_VERSION)
        }
        val keyId = root[KEY_KEY_ID].asStringOrNull() ?: return EvidenceDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        val fingerprint =
            root[KEY_FINGERPRINT].asStringOrNull() ?: return EvidenceDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        val key = PeerKey.parseOrNull(keyId, fingerprint)
            ?: return EvidenceDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        return EvidenceDecodeResult.Valid(PeerIdentityEvidence(key))
    }

    /**
     * Serialize evidence.
     *
     * @throws StorageException when the document would exceed the size bound.
     */
    public fun encode(evidence: PeerIdentityEvidence): String {
        val body = buildString {
            append('{')
            append("\"").append(KEY_VERSION).append("\":").append(EVIDENCE_DOCUMENT_VERSION)
            append(",\"").append(KEY_KEY_ID).append("\":").append(JsonPrimitive(evidence.key.keyId))
            append(",\"").append(KEY_FINGERPRINT).append("\":").append(JsonPrimitive(evidence.key.fingerprint))
            append('}')
            append('\n')
        }
        if (body.toByteArray(Charsets.UTF_8).size > MAX_EVIDENCE_DOCUMENT_BYTES) {
            throw StorageException(StorageFailureReason.WRITE_FAILED)
        }
        return body
    }
}

/** Decode outcome: validated evidence, or one fixed refusal reason. */
public sealed interface EvidenceDecodeResult {
    public class Valid(public val evidence: PeerIdentityEvidence) : EvidenceDecodeResult
    public class Invalid(public val reason: StorageFailureReason) : EvidenceDecodeResult
}

/**
 * [PeerIdentityEvidenceStore] over one private document.
 *
 * A dedicated directory without its document is reported as
 * [StorageFailureReason.MISSING_INITIALIZED]: initialized evidence that cannot be read
 * is never treated as "no evidence yet", because that would open a regeneration path.
 */
public class FilePeerIdentityEvidenceStore(
    private val storage: SingleDocumentStorage,
) : PeerIdentityEvidenceStore {

    override fun read(): EvidenceRead = when (val observed = storage.read()) {
        DocumentRead.Uninitialized -> EvidenceRead.Absent
        DocumentRead.MissingInitialized -> EvidenceRead.Refused(StorageFailureReason.MISSING_INITIALIZED)
        is DocumentRead.Refused -> EvidenceRead.Refused(observed.reason)
        is DocumentRead.Present -> when (val decoded = PeerIdentityEvidenceCodec.decode(observed.bytes)) {
            is EvidenceDecodeResult.Valid -> EvidenceRead.Present(decoded.evidence)
            is EvidenceDecodeResult.Invalid -> EvidenceRead.Refused(decoded.reason)
        }
    }

    override fun publishExclusive(evidence: PeerIdentityEvidence): EvidencePublishResult {
        // Exclusive by observation first: evidence is written once and never updated.
        // The write is then fenced on "absent", so a record that appeared between this
        // check and the publication is refused rather than replaced.
        when (val observed = read()) {
            is EvidenceRead.Present -> return EvidencePublishResult.Refused(StorageFailureReason.CHANGED)
            is EvidenceRead.Refused -> return EvidencePublishResult.Refused(observed.reason)
            EvidenceRead.Absent -> Unit
        }
        val bytes = try {
            PeerIdentityEvidenceCodec.encode(evidence).toByteArray(Charsets.UTF_8)
        } catch (_: StorageException) {
            return EvidencePublishResult.Refused(StorageFailureReason.WRITE_FAILED)
        }
        return when (val outcome = storage.write(bytes)) {
            DocumentWriteResult.Published -> EvidencePublishResult.Published
            is DocumentWriteResult.Refused -> EvidencePublishResult.Refused(outcome.reason)
        }
    }
}
