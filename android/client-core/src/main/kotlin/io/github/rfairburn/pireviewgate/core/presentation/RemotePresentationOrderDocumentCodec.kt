package io.github.rfairburn.pireviewgate.core.presentation

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.asArrayOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asNumberOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asObjectOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asStringOrNull
import kotlinx.serialization.json.Json

/**
 * Closed, versioned persisted schema for the private remote presentation order.
 *
 * ```
 * {"version":1,"entries":[{"hostId":"...","owner":{"kind":"slot","id":"..."}}]}
 * ```
 *
 * Every entry is presentation identity ONLY: the client's saved host handle plus
 * the owner-side identity, exactly as [RemotePresentationIdentity] carries it. No
 * label, workspace, native conversation, status, viewport, transcript, action, or
 * input target is expressible in this schema.
 *
 * Parsing is strict and closed:
 *
 * - only the named keys are admitted at the top level, in an entry, and in the
 *   owner object;
 * - `version` must be exactly [DOCUMENT_VERSION]; any other version is
 *   [StorageFailureReason.UNSUPPORTED_VERSION] and the document stays untouched;
 * - a non-string id, an unknown owner kind, a missing key, an out-of-bound value,
 *   or a duplicate presentation identity refuses the whole document as
 *   [StorageFailureReason.MALFORMED];
 * - the whole document is bounded at [MAX_DOCUMENT_BYTES], the source roster's
 *   compatibility bound. The source's 64-local-slot allowance is deliberately not
 *   applied: this order names remote cards only, and a remote-only client must not
 *   drop visible cards at that local count.
 *
 * A refused document is never treated as empty and never rewritten. Encoding an
 * order over the byte bound fails truthfully before anything is written; it never
 * truncates the list or silently drops a visible card. String values use the shared
 * JSON serializer, which escapes isolated surrogate code units so every admitted
 * identity value survives UTF-8 publication and reopens without replacement or
 * collision.
 */
public object RemotePresentationOrderDocumentCodec {
    /** Persisted document version. Unknown versions are refused, never migrated. */
    public const val DOCUMENT_VERSION: Int = 1

    /**
     * Bound for the whole published order document.
     *
     * This is the source session-host roster's file bound, reused as the actual
     * compatibility bound rather than inventing a smaller client-specific one.
     */
    public const val MAX_DOCUMENT_BYTES: Int = 64 * 1024

    private const val KEY_VERSION = "version"
    private const val KEY_ENTRIES = "entries"

    private const val ENTRY_KEY_HOST_ID = "hostId"
    private const val ENTRY_KEY_OWNER = "owner"

    private const val OWNER_KEY_KIND = "kind"
    private const val OWNER_KEY_ID = "id"

    private val TOP_LEVEL_KEYS = setOf(KEY_VERSION, KEY_ENTRIES)
    private val ENTRY_KEYS = setOf(ENTRY_KEY_HOST_ID, ENTRY_KEY_OWNER)
    private val OWNER_KEYS = setOf(OWNER_KEY_KIND, OWNER_KEY_ID)

    /** Decode persisted bytes. Any deviation yields one fixed refusal reason. */
    public fun decode(bytes: ByteArray): RemotePresentationOrderDecodeResult {
        if (bytes.isEmpty() || bytes.size > MAX_DOCUMENT_BYTES) {
            return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        // Strict UTF-8: an invalid sequence is a malformed document, never a
        // replacement-character reinterpretation of saved order.
        val text = try {
            bytes.decodeToString(throwOnInvalidSequence = true)
        } catch (_: Exception) {
            return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        return decode(text)
    }

    /** Decode persisted text. Any deviation yields one fixed refusal reason. */
    public fun decode(text: String): RemotePresentationOrderDecodeResult {
        if (text.isEmpty() || text.toByteArray(Charsets.UTF_8).size > MAX_DOCUMENT_BYTES) {
            return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        val parsed = try {
            Json.parseToJsonElement(text)
        } catch (_: Exception) {
            return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        val root = parsed.asObjectOrNull()
            ?: return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if ((root.keys - TOP_LEVEL_KEYS).isNotEmpty()) {
            return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }

        val version = root[KEY_VERSION].asNumberOrNull()
            ?: return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if (version != DOCUMENT_VERSION) {
            return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.UNSUPPORTED_VERSION)
        }

        val rawEntries = root[KEY_ENTRIES].asArrayOrNull()
            ?: return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)

        val identities = ArrayList<RemotePresentationIdentity>(rawEntries.size)
        val seen = HashSet<String>(rawEntries.size)
        for (raw in rawEntries) {
            val entry = raw.asObjectOrNull()
                ?: return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            if ((entry.keys - ENTRY_KEYS).isNotEmpty()) {
                return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            val hostId = entry[ENTRY_KEY_HOST_ID].asStringOrNull()?.let(HostId::parseOrNull)
                ?: return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            val owner = entry[ENTRY_KEY_OWNER].asObjectOrNull()
                ?: return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            if ((owner.keys - OWNER_KEYS).isNotEmpty()) {
                return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            val ownerKind = owner[OWNER_KEY_KIND].asStringOrNull()
                ?.let(RemotePresentationOwnerKind::fromWireName)
                ?: return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            val ownerId = owner[OWNER_KEY_ID].asStringOrNull()
                ?: return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            val identity = RemotePresentationIdentity.parseOrNull(hostId, ownerKind, ownerId)
                ?: return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            if (!seen.add(identity.canonicalKey)) {
                return RemotePresentationOrderDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            identities.add(identity)
        }

        return RemotePresentationOrderDecodeResult.Valid(identities)
    }

    /**
     * Serialize one complete order in its exact presentation order.
     *
     * @throws StorageException with [StorageFailureReason.WRITE_FAILED] when the
     *   document would exceed [MAX_DOCUMENT_BYTES]; nothing is written and the
     *   caller's complete order is not shortened.
     * @throws StorageException with [StorageFailureReason.MALFORMED] when the input
     *   repeats an identity or carries an out-of-bound owner component.
     */
    public fun encode(identities: List<RemotePresentationIdentity>): String {
        val seen = HashSet<String>(identities.size)
        val body = buildString {
            append('{')
            append("\"").append(KEY_VERSION).append("\":").append(DOCUMENT_VERSION)
            append(",\"").append(KEY_ENTRIES).append("\":[")
            identities.forEachIndexed { index, identity ->
                if (!RemotePresentationIdentity.isValidOwnerId(identity.ownerId)) {
                    throw StorageException(StorageFailureReason.MALFORMED)
                }
                if (!seen.add(identity.canonicalKey)) {
                    throw StorageException(StorageFailureReason.MALFORMED)
                }
                if (index > 0) append(',')
                append('{')
                append("\"").append(ENTRY_KEY_HOST_ID).append("\":").append(jsonString(identity.hostId.value))
                append(",\"").append(ENTRY_KEY_OWNER).append("\":{")
                append("\"").append(OWNER_KEY_KIND).append("\":").append(jsonString(identity.ownerKind.wireName))
                append(",\"").append(OWNER_KEY_ID).append("\":").append(jsonString(identity.ownerId))
                append("}}")
            }
            append("]}")
            append('\n')
        }
        if (body.toByteArray(Charsets.UTF_8).size > MAX_DOCUMENT_BYTES) {
            throw StorageException(StorageFailureReason.WRITE_FAILED)
        }
        return body
    }
}

/** Decode outcome: a validated order, or one fixed refusal reason. */
public sealed interface RemotePresentationOrderDecodeResult {
    public class Valid(public val identities: List<RemotePresentationIdentity>) : RemotePresentationOrderDecodeResult
    public class Invalid(public val reason: StorageFailureReason) : RemotePresentationOrderDecodeResult
}
