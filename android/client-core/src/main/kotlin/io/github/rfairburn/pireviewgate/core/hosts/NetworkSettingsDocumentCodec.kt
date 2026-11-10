package io.github.rfairburn.pireviewgate.core.hosts

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * The closed, versioned persisted schema for [NetworkSettings].
 *
 * ```
 * {"version":1,"autoReconnect":false,"viewerRemoteInputEnabled":false,
 *  "debugInputMessagingEnabled":true,"savedFirstReplyTimeoutSeconds":120,
 *  "hosts":[{"id":"...","label":"...","host":"...","port":8443,
 *            "previouslyConnected":true,"reconnectSuppressed":false}]}
 * ```
 *
 * Parsing is strict and closed, mirroring the source preferences document:
 *
 * - Only the named keys are admitted, at the top level and in every host entry.
 * - `version` must be exactly [SETTINGS_DOCUMENT_VERSION]; any other version is
 *   [StorageFailureReason.UNSUPPORTED_VERSION] and the document stays untouched.
 * - Required booleans must be real JSON booleans (not a quoted string, not a
 *   number). An unknown or missing required flag refuses the document; it never
 *   becomes a silent default.
 * - `viewerRemoteInputEnabled` is the one optional default-on flag: a genuinely
 *   absent key means on, while a present key must be a real boolean. Only an
 *   explicit `false` is ever written.
 * - `debugInputMessagingEnabled` is the optional default-off flag for the whole
 *   diagnostic status/notice area: a genuinely absent key means off, while a present
 *   key must be a real boolean. Only an explicit `true` is ever written.
 * - `savedFirstReplyTimeoutSeconds` is optional only at its default of 60. An
 *   absent key means 60, a present key must be a positive whole number inside the
 *   document's existing nine-digit integer width, and the default is never written.
 *   Zero is refused rather than meaning infinite, and nothing is clamped.
 * - Ports are JSON numbers in `1..65535` (a quoted port is refused); ids, labels,
 *   and hosts are bounds-checked; a duplicate id refuses the whole document.
 *
 * A refused document is never treated as empty and never rewritten with defaults.
 * No key material, pin, or trust fact is expressible in this schema: pins live in
 * their own document with their own lifecycle.
 */
public object NetworkSettingsDocumentCodec {
    /** Persisted document version. Unknown versions are refused, never migrated. */
    public const val SETTINGS_DOCUMENT_VERSION: Int = 1

    /** Bound for the whole published settings document. */
    public const val MAX_SETTINGS_DOCUMENT_BYTES: Int = 64 * 1024

    private const val KEY_VERSION = "version"
    private const val KEY_AUTO_RECONNECT = "autoReconnect"
    private const val KEY_VIEWER_REMOTE_INPUT = "viewerRemoteInputEnabled"
    private const val KEY_DEBUG_INPUT_MESSAGING = "debugInputMessagingEnabled"
    private const val KEY_SAVED_FIRST_REPLY_TIMEOUT = "savedFirstReplyTimeoutSeconds"
    private const val KEY_HOSTS = "hosts"

    private const val HOST_KEY_ID = "id"
    private const val HOST_KEY_LABEL = "label"
    private const val HOST_KEY_HOST = "host"
    private const val HOST_KEY_PORT = "port"
    private const val HOST_KEY_PREVIOUSLY_CONNECTED = "previouslyConnected"
    private const val HOST_KEY_RECONNECT_SUPPRESSED = "reconnectSuppressed"

    private val TOP_LEVEL_KEYS = setOf(
        KEY_VERSION,
        KEY_AUTO_RECONNECT,
        KEY_VIEWER_REMOTE_INPUT,
        KEY_DEBUG_INPUT_MESSAGING,
        KEY_SAVED_FIRST_REPLY_TIMEOUT,
        KEY_HOSTS,
    )
    private val HOST_KEYS = setOf(
        HOST_KEY_ID,
        HOST_KEY_LABEL,
        HOST_KEY_HOST,
        HOST_KEY_PORT,
        HOST_KEY_PREVIOUSLY_CONNECTED,
        HOST_KEY_RECONNECT_SUPPRESSED,
    )

    /** Decode a persisted document. Any deviation yields one fixed refusal reason. */
    public fun decode(bytes: ByteArray): SettingsDecodeResult {
        // Strict UTF-8: an invalid sequence is a malformed document. The exact
        // exception type differs across runtimes, so any decoding refusal is treated
        // the same way and nothing is written.
        val text = try {
            bytes.decodeToString(throwOnInvalidSequence = true)
        } catch (_: Exception) {
            return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        return decode(text)
    }

    /** Decode document text. Any deviation yields one fixed refusal reason. */
    public fun decode(text: String): SettingsDecodeResult {
        val parsed = try {
            Json.parseToJsonElement(text)
        } catch (_: Exception) {
            return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        val root = parsed.asObjectOrNull()
            ?: return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if ((root.keys - TOP_LEVEL_KEYS).isNotEmpty()) {
            return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }

        val version = root[KEY_VERSION].asNumberOrNull()
            ?: return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if (version != SETTINGS_DOCUMENT_VERSION) {
            return SettingsDecodeResult.Invalid(StorageFailureReason.UNSUPPORTED_VERSION)
        }

        val autoReconnect = root[KEY_AUTO_RECONNECT].asBooleanOrNull()
            ?: return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)

        // Optional default-on flag: absent is on, present must be a real boolean.
        val viewerRemoteInputEnabled = if (KEY_VIEWER_REMOTE_INPUT in root) {
            root[KEY_VIEWER_REMOTE_INPUT].asBooleanOrNull()
                ?: return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        } else {
            NetworkSettings.DEFAULT_VIEWER_REMOTE_INPUT_ENABLED
        }

        // Optional default-off flag: absent is off, present must be a real boolean.
        val debugInputMessagingEnabled = if (KEY_DEBUG_INPUT_MESSAGING in root) {
            root[KEY_DEBUG_INPUT_MESSAGING].asBooleanOrNull()
                ?: return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        } else {
            NetworkSettings.DEFAULT_DEBUG_INPUT_MESSAGING_ENABLED
        }

        // Optional only at its default: absent is 60, present must be admitted.
        val savedFirstReplyTimeoutSeconds = if (KEY_SAVED_FIRST_REPLY_TIMEOUT in root) {
            val seconds = root[KEY_SAVED_FIRST_REPLY_TIMEOUT].asNumberOrNull()
                ?: return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            if (!NetworkSettings.isValidSavedFirstReplyTimeoutSeconds(seconds)) {
                return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            seconds
        } else {
            NetworkSettings.DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_SECONDS
        }

        val rawHosts = root[KEY_HOSTS].asArrayOrNull()
            ?: return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if (rawHosts.size > HostCatalog.MAX_HOSTS) {
            return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }

        val hosts = ArrayList<ConfiguredHost>(rawHosts.size)
        val seenIds = HashSet<HostId>(rawHosts.size)
        for (raw in rawHosts) {
            val host = parseHost(raw)
                ?: return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            if (!seenIds.add(host.id)) {
                return SettingsDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            hosts.add(host)
        }

        return SettingsDecodeResult.Valid(
            NetworkSettings(
                autoReconnect = autoReconnect,
                viewerRemoteInputEnabled = viewerRemoteInputEnabled,
                hosts = HostCatalog.of(hosts),
                savedFirstReplyTimeoutSeconds = savedFirstReplyTimeoutSeconds,
                debugInputMessagingEnabled = debugInputMessagingEnabled,
            ),
        )
    }

    /**
     * Serialize one validated value.
     *
     * @throws StorageException with [StorageFailureReason.WRITE_FAILED] when the
     *   document would exceed [MAX_SETTINGS_DOCUMENT_BYTES]; nothing is written.
     */
    public fun encode(settings: NetworkSettings): String {
        val body = buildString {
            append('{')
            append("\"").append(KEY_VERSION).append("\":").append(SETTINGS_DOCUMENT_VERSION)
            append(",\"").append(KEY_AUTO_RECONNECT).append("\":").append(settings.autoReconnect)
            // Sparse default-on flag: an on value writes no key at all.
            if (!settings.viewerRemoteInputEnabled) {
                append(",\"").append(KEY_VIEWER_REMOTE_INPUT).append("\":false")
            }
            // Sparse default-off flag: an off value writes no key at all.
            if (settings.debugInputMessagingEnabled) {
                append(",\"").append(KEY_DEBUG_INPUT_MESSAGING).append("\":true")
            }
            // Sparse default: the default 60 writes no key at all.
            if (settings.savedFirstReplyTimeoutSeconds != NetworkSettings.DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_SECONDS) {
                append(",\"").append(KEY_SAVED_FIRST_REPLY_TIMEOUT)
                    .append("\":").append(settings.savedFirstReplyTimeoutSeconds)
            }
            append(",\"").append(KEY_HOSTS).append("\":[")
            settings.hosts.hosts.forEachIndexed { index, host ->
                if (index > 0) append(',')
                append(serializeHost(host))
            }
            append("]}")
            append('\n')
        }
        if (body.toByteArray(Charsets.UTF_8).size > MAX_SETTINGS_DOCUMENT_BYTES) {
            throw StorageException(StorageFailureReason.WRITE_FAILED)
        }
        return body
    }

    private fun parseHost(raw: JsonElement?): ConfiguredHost? {
        val entry = raw.asObjectOrNull() ?: return null
        if ((entry.keys - HOST_KEYS).isNotEmpty()) return null

        val id = entry[HOST_KEY_ID].asStringOrNull()?.let(HostId::parseOrNull) ?: return null
        val label = entry[HOST_KEY_LABEL].asStringOrNull()?.let(HostLabel::parseOrNull) ?: return null
        val hostText = entry[HOST_KEY_HOST].asStringOrNull() ?: return null
        if (!Endpoint.isValidHost(hostText)) return null
        val port = entry[HOST_KEY_PORT].asNumberOrNull() ?: return null
        if (!Endpoint.isValidPort(port)) return null

        val previouslyConnected = entry[HOST_KEY_PREVIOUSLY_CONNECTED].asBooleanOrNull() ?: return null
        val reconnectSuppressed = entry[HOST_KEY_RECONNECT_SUPPRESSED].asBooleanOrNull() ?: return null

        return ConfiguredHost(
            id = id,
            label = label,
            endpoint = Endpoint(hostText, port),
            previouslyConnected = previouslyConnected,
            reconnectSuppressed = reconnectSuppressed,
        )
    }

    private fun serializeHost(host: ConfiguredHost): String = buildString {
        append('{')
        append("\"").append(HOST_KEY_ID).append("\":").append(JsonPrimitive(host.id.value))
        append(",\"").append(HOST_KEY_LABEL).append("\":").append(JsonPrimitive(host.label.value))
        append(",\"").append(HOST_KEY_HOST).append("\":").append(JsonPrimitive(host.endpoint.host))
        append(",\"").append(HOST_KEY_PORT).append("\":").append(host.endpoint.port)
        append(",\"").append(HOST_KEY_PREVIOUSLY_CONNECTED).append("\":").append(host.previouslyConnected)
        append(",\"").append(HOST_KEY_RECONNECT_SUPPRESSED).append("\":").append(host.reconnectSuppressed)
        append('}')
    }

    // Strict element access lives in StrictJson.kt: JSON string, number, and boolean
    // are never interchangeable in a closed schema.
}

/** Decode outcome: a validated value, or one fixed refusal reason. */
public sealed interface SettingsDecodeResult {
    public class Valid(public val settings: NetworkSettings) : SettingsDecodeResult
    public class Invalid(public val reason: StorageFailureReason) : SettingsDecodeResult
}
