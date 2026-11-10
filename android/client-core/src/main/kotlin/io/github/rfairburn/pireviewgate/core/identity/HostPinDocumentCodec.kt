package io.github.rfairburn.pireviewgate.core.identity

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.asArrayOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asNumberOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asObjectOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * The closed, versioned persisted schema for remembered host keys.
 *
 * ```
 * {"version":1,"pins":[{"hostId":"...","host":"10.0.0.7","port":8443,
 *                      "keyId":"...","fingerprint":"..."}]}
 * ```
 *
 * The saved endpoint is the first-pinned address, retained as provenance for
 * display, not as a lookup key or trust binding. Identity is the stable host id
 * and exact DER SPKI; a changed configured address must prove the same key.
 * Keeping this provenance does not require rewriting or migrating the document.
 *
 * The document holds public identity only. There is no private key, no PEM, no seed,
 * and no device identity material in this schema or anywhere in the client's own
 * files: the device's private half lives in the platform key store and never leaves
 * it.
 *
 * Parsing is strict and closed: only the named keys, an exact version, bounds-checked
 * endpoints, well-formed and internally consistent identities (`fingerprint` must be
 * the digest of `keyId`), at most [MAX_PINNED_HOSTS] entries, and one entry per host
 * id. Any deviation refuses the whole document, which is then left untouched.
 */
public object HostPinDocumentCodec {
    /** Persisted document version. Unknown versions are refused, never migrated. */
    public const val PIN_DOCUMENT_VERSION: Int = 1

    /** Bound for the whole published pin document. */
    public const val MAX_PIN_DOCUMENT_BYTES: Int = 64 * 1024

    /** Bound for remembered host slots; a larger document is refused. */
    public const val MAX_PINNED_HOSTS: Int = 64

    private const val KEY_VERSION = "version"
    private const val KEY_PINS = "pins"
    private const val PIN_KEY_HOST_ID = "hostId"
    private const val PIN_KEY_HOST = "host"
    private const val PIN_KEY_PORT = "port"
    private const val PIN_KEY_KEY_ID = "keyId"
    private const val PIN_KEY_FINGERPRINT = "fingerprint"

    private val TOP_LEVEL_KEYS = setOf(KEY_VERSION, KEY_PINS)
    private val PIN_KEYS = setOf(PIN_KEY_HOST_ID, PIN_KEY_HOST, PIN_KEY_PORT, PIN_KEY_KEY_ID, PIN_KEY_FINGERPRINT)

    /** Decode a persisted document. Any deviation yields one fixed refusal reason. */
    public fun decode(bytes: ByteArray): PinDecodeResult {
        // Strict UTF-8; the exact decoding refusal type differs across runtimes.
        val text = try {
            bytes.decodeToString(throwOnInvalidSequence = true)
        } catch (_: Exception) {
            return PinDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        return decode(text)
    }

    /** Decode document text. Any deviation yields one fixed refusal reason. */
    public fun decode(text: String): PinDecodeResult {
        val parsed = try {
            Json.parseToJsonElement(text)
        } catch (_: Exception) {
            return PinDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        val root = parsed.asObjectOrNull()
            ?: return PinDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if ((root.keys - TOP_LEVEL_KEYS).isNotEmpty()) {
            return PinDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }

        val version = root[KEY_VERSION].asNumberOrNull()
            ?: return PinDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if (version != PIN_DOCUMENT_VERSION) {
            return PinDecodeResult.Invalid(StorageFailureReason.UNSUPPORTED_VERSION)
        }

        val rawPins = root[KEY_PINS].asArrayOrNull()
            ?: return PinDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if (rawPins.size > MAX_PINNED_HOSTS) {
            return PinDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }

        val pins = LinkedHashMap<HostId, HostPin>(rawPins.size)
        for (raw in rawPins) {
            val pin = parsePin(raw) ?: return PinDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            if (pin.hostId in pins) return PinDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            pins[pin.hostId] = pin
        }
        return PinDecodeResult.Valid(pins)
    }

    /**
     * Serialize one complete pin set.
     *
     * @throws StorageException when the document would exceed the size bound.
     */
    public fun encode(pins: Map<HostId, HostPin>): String {
        if (pins.size > MAX_PINNED_HOSTS) throw StorageException(StorageFailureReason.WRITE_FAILED)
        val body = buildString {
            append('{')
            append("\"").append(KEY_VERSION).append("\":").append(PIN_DOCUMENT_VERSION)
            append(",\"").append(KEY_PINS).append("\":[")
            pins.values.forEachIndexed { index, pin ->
                if (index > 0) append(',')
                append(serializePin(pin))
            }
            append("]}")
            append('\n')
        }
        if (body.toByteArray(Charsets.UTF_8).size > MAX_PIN_DOCUMENT_BYTES) {
            throw StorageException(StorageFailureReason.WRITE_FAILED)
        }
        return body
    }

    private fun parsePin(raw: JsonElement?): HostPin? {
        val entry = raw.asObjectOrNull() ?: return null
        if ((entry.keys - PIN_KEYS).isNotEmpty()) return null
        val hostId = entry[PIN_KEY_HOST_ID].asStringOrNull()?.let(HostId::parseOrNull) ?: return null
        val host = entry[PIN_KEY_HOST].asStringOrNull() ?: return null
        val port = entry[PIN_KEY_PORT].asNumberOrNull() ?: return null
        val endpoint = Endpoint.parseOrNull(host, port) ?: return null
        val keyId = entry[PIN_KEY_KEY_ID].asStringOrNull() ?: return null
        val fingerprint = entry[PIN_KEY_FINGERPRINT].asStringOrNull() ?: return null
        val key = PeerKey.parseOrNull(keyId, fingerprint) ?: return null
        return HostPin(hostId, endpoint, key)
    }

    private fun serializePin(pin: HostPin): String = buildString {
        append('{')
        append("\"").append(PIN_KEY_HOST_ID).append("\":").append(JsonPrimitive(pin.hostId.value))
        append(",\"").append(PIN_KEY_HOST).append("\":").append(JsonPrimitive(pin.endpoint.host))
        append(",\"").append(PIN_KEY_PORT).append("\":").append(pin.endpoint.port)
        append(",\"").append(PIN_KEY_KEY_ID).append("\":").append(JsonPrimitive(pin.key.keyId))
        append(",\"").append(PIN_KEY_FINGERPRINT).append("\":").append(JsonPrimitive(pin.key.fingerprint))
        append('}')
    }
}

/** Decode outcome: a validated pin set in saved order, or one fixed refusal reason. */
public sealed interface PinDecodeResult {
    public class Valid(public val pins: Map<HostId, HostPin>) : PinDecodeResult
    public class Invalid(public val reason: StorageFailureReason) : PinDecodeResult
}
