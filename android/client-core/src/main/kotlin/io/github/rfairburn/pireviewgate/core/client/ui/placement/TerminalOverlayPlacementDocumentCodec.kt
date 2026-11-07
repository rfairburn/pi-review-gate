package io.github.rfairburn.pireviewgate.core.client.ui.placement

import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.asArrayOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asNumberOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asObjectOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asStringOrNull
import kotlinx.serialization.json.Json

/**
 * Closed, versioned persisted schema for the private terminal overlay placement.
 *
 * ```
 * {"version":1,"overlays":[
 *   {"overlay":"controls","orientation":"portrait","x":1000,"y":0},
 *   {"overlay":"keys","orientation":"landscape","x":500,"y":1000}
 * ]}
 * ```
 *
 * Only moved overlays appear. An absent slot is the existing layout default, not an
 * error: defaults stay live so the Controls strip can move without dragging the
 * Status notice or Keys panel with it, and a later document stays usable when only
 * one orientation was ever moved.
 *
 * Parsing is strict and closed:
 *
 * - only `version` and `overlays` at the top level, and only `overlay`,
 *   `orientation`, `x`, and `y` in an entry;
 * - `version` must be exactly [DOCUMENT_VERSION];
 * - both permille components must be real JSON integers in `0..1000`, never quoted
 *   or fractional;
 * - an unknown overlay/orientation, a missing key, or a duplicate slot refuses the
 *   document as [StorageFailureReason.MALFORMED];
 * - the whole document is bounded at [MAX_DOCUMENT_BYTES] and at six entries.
 *
 * This schema can express no host, trust, pin, identity, order, viewport, transcript,
 * input, action, or proof value. A malformed cosmetic document is never treated as a
 * reason to reset any other private state.
 */
public object TerminalOverlayPlacementDocumentCodec {
    /** Persisted document version. Unknown versions are repaired only by a later deliberate save. */
    public const val DOCUMENT_VERSION: Int = 1

    /** Bound for the whole published overlay placement document. */
    public const val MAX_DOCUMENT_BYTES: Int = 4 * 1024

    private const val KEY_VERSION = "version"
    private const val KEY_OVERLAYS = "overlays"

    private const val ENTRY_KEY_OVERLAY = "overlay"
    private const val ENTRY_KEY_ORIENTATION = "orientation"
    private const val ENTRY_KEY_X = "x"
    private const val ENTRY_KEY_Y = "y"

    private val TOP_LEVEL_KEYS = setOf(KEY_VERSION, KEY_OVERLAYS)
    private val ENTRY_KEYS = setOf(ENTRY_KEY_OVERLAY, ENTRY_KEY_ORIENTATION, ENTRY_KEY_X, ENTRY_KEY_Y)

    private val MAX_SLOTS = TerminalOverlay.entries.size * TerminalOverlayOrientation.entries.size

    /** Decode persisted bytes. Any deviation yields one fixed refusal reason. */
    public fun decode(bytes: ByteArray): TerminalOverlayPlacementDecodeResult {
        if (bytes.isEmpty() || bytes.size > MAX_DOCUMENT_BYTES) {
            return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        val text = try {
            bytes.decodeToString(throwOnInvalidSequence = true)
        } catch (_: Exception) {
            // The bytes exist and are bounded, but their text cannot be read.
            return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.UNREADABLE)
        }
        return decode(text)
    }

    /** Decode persisted text. Any deviation yields one fixed refusal reason. */
    public fun decode(text: String): TerminalOverlayPlacementDecodeResult {
        if (text.isEmpty() || text.toByteArray(Charsets.UTF_8).size > MAX_DOCUMENT_BYTES) {
            return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        val parsed = try {
            Json.parseToJsonElement(text)
        } catch (_: Exception) {
            return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }
        val root = parsed.asObjectOrNull()
            ?: return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if ((root.keys - TOP_LEVEL_KEYS).isNotEmpty()) {
            return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }

        val version = root[KEY_VERSION].asNumberOrNull()
            ?: return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if (version != DOCUMENT_VERSION) {
            return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.UNSUPPORTED_VERSION)
        }

        val rawEntries = root[KEY_OVERLAYS].asArrayOrNull()
            ?: return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        if (rawEntries.size > MAX_SLOTS) {
            return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
        }

        var placement = TerminalOverlayPlacement.DEFAULT
        val seen = HashSet<String>(rawEntries.size)
        for (raw in rawEntries) {
            val entry = raw.asObjectOrNull()
                ?: return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            if ((entry.keys - ENTRY_KEYS).isNotEmpty()) {
                return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            val overlay = entry[ENTRY_KEY_OVERLAY].asStringOrNull()
                ?.let { TerminalOverlay.fromWireName(it) }
                ?: return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            val orientation = entry[ENTRY_KEY_ORIENTATION].asStringOrNull()
                ?.let { TerminalOverlayOrientation.fromWireName(it) }
                ?: return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            val x = entry[ENTRY_KEY_X].asNumberOrNull()
                ?: return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            val y = entry[ENTRY_KEY_Y].asNumberOrNull()
                ?: return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            if (x > TerminalOverlayPosition.MAX_PERMILLE || y > TerminalOverlayPosition.MAX_PERMILLE) {
                return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            if (!seen.add(slotKey(overlay, orientation))) {
                return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            placement = placement.withPosition(overlay, orientation, TerminalOverlayPosition(x, y))
        }

        return TerminalOverlayPlacementDecodeResult.Valid(placement)
    }

    /**
     * Serialize one complete placement state.
     *
     * Default slots are omitted; every explicit slot is written in a fixed order so
     * the same state always produces the same bounded bytes.
     *
     * @throws StorageException with [StorageFailureReason.WRITE_FAILED] when the
     *   document would exceed [MAX_DOCUMENT_BYTES].
     */
    public fun encode(placement: TerminalOverlayPlacement): String {
        val entries = buildList {
            TerminalOverlay.entries.forEach { overlay ->
                TerminalOverlayOrientation.entries.forEach { orientation ->
                    placement.position(overlay, orientation)?.let { position ->
                        add(Triple(overlay, orientation, position))
                    }
                }
            }
        }
        if (entries.size > MAX_SLOTS) {
            throw StorageException(StorageFailureReason.MALFORMED)
        }
        val body = buildString {
            append('{')
            append("\"").append(KEY_VERSION).append("\":").append(DOCUMENT_VERSION)
            append(",\"").append(KEY_OVERLAYS).append("\":[")
            entries.forEachIndexed { index, entry ->
                val overlay = entry.first
                val orientation = entry.second
                val position = entry.third
                if (index > 0) append(',')
                append('{')
                append("\"").append(ENTRY_KEY_OVERLAY).append("\":\"").append(overlay.wireName).append('"')
                append(",\"").append(ENTRY_KEY_ORIENTATION).append("\":\"").append(orientation.wireName).append('"')
                append(",\"").append(ENTRY_KEY_X).append("\":").append(position.xPermille)
                append(",\"").append(ENTRY_KEY_Y).append("\":").append(position.yPermille)
                append('}')
            }
            append("]}")
            append('\n')
        }
        if (body.toByteArray(Charsets.UTF_8).size > MAX_DOCUMENT_BYTES) {
            throw StorageException(StorageFailureReason.WRITE_FAILED)
        }
        return body
    }

    private fun slotKey(overlay: TerminalOverlay, orientation: TerminalOverlayOrientation): String =
        "${overlay.wireName}:${orientation.wireName}"
}

/** Decode outcome: a validated placement, or one fixed refusal reason. */
public sealed interface TerminalOverlayPlacementDecodeResult {
    public class Valid(public val placement: TerminalOverlayPlacement) : TerminalOverlayPlacementDecodeResult
    public class Invalid(public val reason: StorageFailureReason) : TerminalOverlayPlacementDecodeResult
}
