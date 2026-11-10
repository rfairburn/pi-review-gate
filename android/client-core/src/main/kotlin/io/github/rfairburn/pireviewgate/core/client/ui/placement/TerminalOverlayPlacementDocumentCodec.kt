package io.github.rfairburn.pireviewgate.core.client.ui.placement

import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.asArrayOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asBooleanOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asNumberOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asObjectOrNull
import io.github.rfairburn.pireviewgate.core.hosts.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * Closed, versioned persisted schema for the private terminal overlay placement.
 *
 * Only version [DOCUMENT_VERSION] is read and written; every other version is refused
 * as [StorageFailureReason.UNSUPPORTED_VERSION]. The app is unreleased, so no earlier
 * document shape is ever read and no position saved by one is carried over: an obsolete
 * document is refused and its slots become the layout defaults again.
 *
 * ```
 * {"version":2,"overlays":[
 *   {"overlay":"controls","orientation":"portrait","x":1000,"y":0},
 *   {"overlay":"keys","orientation":"portrait","x":200,"y":700,"docked":false,"w":420,"h":300},
 *   {"overlay":"keys","orientation":"landscape","w":600,"h":400}
 * ]}
 * ```
 *
 * Only remembered slots appear. An absent slot is the existing layout default, not an
 * error: defaults stay live so the Controls strip can move without dragging the
 * Status notice or Keys panel with it, and a later document stays usable when only
 * one orientation was ever moved.
 *
 * Parsing is strict and closed:
 *
 * - only `version` and `overlays` at the top level;
 * - an entry has `overlay`, `orientation`, `x`, and `y`, and only a `keys` entry may
 *   additionally carry `docked`, `w`, and `h`;
 * - every controls or status entry is the exact position shape with both coordinates and
 *   no Keys-only field;
 * - a `keys` entry may omit `x` and `y` together when only its layout was
 *   deliberately changed, so a popout, a docking toggle, or a resize can be remembered
 *   without inventing a coordinate before the first drag. It never omits just one
 *   coordinate, never omits just one size component, and never appears with none of a
 *   position, `docked`, or a size;
 * - every coordinate is a real nonnegative JSON integer in `0..1000` and every size
 *   component is a real JSON integer in `1..1000`, never quoted, null, or fractional,
 *   and `docked` is a real JSON boolean;
 * - an unknown overlay or orientation, an unknown field, a missing required key, or a
 *   duplicate slot refuses the document as [StorageFailureReason.MALFORMED];
 * - the whole document is bounded at [MAX_DOCUMENT_BYTES] and at six entries.
 *
 * Writing omits each default layout field, keeps one fixed field and slot order, and
 * emits a slot when it has an explicit position or a non-default Keys layout, so the
 * same state always produces the same bounded bytes. A remembered floating size and a
 * remembered position survive docking and are still written while docked.
 *
 * This schema can express no host, trust, pin, identity, order, viewport, transcript,
 * input, action, or proof value, and no open/close, modifier, or dismissed state. A
 * malformed cosmetic document is never treated as a reason to reset any other private
 * state.
 */
public object TerminalOverlayPlacementDocumentCodec {
    /** The only persisted document version this codec reads and writes. */
    public const val DOCUMENT_VERSION: Int = 2

    /** Bound for the whole published overlay placement document. */
    public const val MAX_DOCUMENT_BYTES: Int = 4 * 1024

    private const val KEY_VERSION = "version"
    private const val KEY_OVERLAYS = "overlays"

    private const val ENTRY_KEY_OVERLAY = "overlay"
    private const val ENTRY_KEY_ORIENTATION = "orientation"
    private const val ENTRY_KEY_X = "x"
    private const val ENTRY_KEY_Y = "y"
    private const val ENTRY_KEY_DOCKED = "docked"
    private const val ENTRY_KEY_W = "w"
    private const val ENTRY_KEY_H = "h"

    private val TOP_LEVEL_KEYS = setOf(KEY_VERSION, KEY_OVERLAYS)
    private val ENTRY_KEYS = setOf(
        ENTRY_KEY_OVERLAY,
        ENTRY_KEY_ORIENTATION,
        ENTRY_KEY_X,
        ENTRY_KEY_Y,
        ENTRY_KEY_DOCKED,
        ENTRY_KEY_W,
        ENTRY_KEY_H,
    )

    private val MAX_SLOTS = TerminalOverlay.entries.size * TerminalOverlayOrientation.entries.size

    /** A remembered coordinate is never negative. */
    private const val MIN_POSITION_PERMILLE: Int = 0

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

            val xPresent = entry.containsKey(ENTRY_KEY_X)
            val yPresent = entry.containsKey(ENTRY_KEY_Y)
            val wPresent = entry.containsKey(ENTRY_KEY_W)
            val hPresent = entry.containsKey(ENTRY_KEY_H)
            val dockedPresent = entry.containsKey(ENTRY_KEY_DOCKED)
            val keysLayoutSlot = overlay == TerminalOverlay.KEYS

            // A half position or a half size is never a remembered value, and only a
            // Keys entry may carry Keys-only fields at all.
            if (xPresent != yPresent || wPresent != hPresent) {
                return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            if (!keysLayoutSlot && (dockedPresent || wPresent || hPresent)) {
                return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            // A Keys entry may drop the position only when it deliberately remembers
            // layout data; it is never an empty entry.
            if (keysLayoutSlot && !xPresent && !wPresent && !dockedPresent) {
                return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }

            val position = if (xPresent) {
                val x = entry[ENTRY_KEY_X].asStrictPermille(
                    minimum = MIN_POSITION_PERMILLE,
                    maximum = TerminalOverlayPosition.MAX_PERMILLE,
                )
                val y = entry[ENTRY_KEY_Y].asStrictPermille(
                    minimum = MIN_POSITION_PERMILLE,
                    maximum = TerminalOverlayPosition.MAX_PERMILLE,
                )
                if (x == null || y == null) {
                    return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
                }
                TerminalOverlayPosition(x, y)
            } else {
                null
            }
            // A non-Keys entry is the exact position shape, so its coordinates are
            // required.
            if (!keysLayoutSlot && position == null) {
                return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }

            val docked = if (dockedPresent) {
                entry[ENTRY_KEY_DOCKED].asBooleanOrNull()
                    ?: return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            } else {
                true
            }
            val floatingSize = if (wPresent && hPresent) {
                val w = entry[ENTRY_KEY_W].asStrictPermille(
                    minimum = TerminalKeysFloatingSize.MIN_PERMILLE,
                    maximum = TerminalKeysFloatingSize.MAX_PERMILLE,
                )
                val h = entry[ENTRY_KEY_H].asStrictPermille(
                    minimum = TerminalKeysFloatingSize.MIN_PERMILLE,
                    maximum = TerminalKeysFloatingSize.MAX_PERMILLE,
                )
                if (w == null || h == null) {
                    return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
                }
                TerminalKeysFloatingSize(w, h)
            } else {
                null
            }

            if (!seen.add(slotKey(overlay, orientation))) {
                return TerminalOverlayPlacementDecodeResult.Invalid(StorageFailureReason.MALFORMED)
            }
            position?.let { placement = placement.withPosition(overlay, orientation, it) }
            if (overlay == TerminalOverlay.KEYS) {
                placement = placement.withKeysLayout(orientation, TerminalKeysLayout(docked, floatingSize))
            }
        }

        return TerminalOverlayPlacementDecodeResult.Valid(placement)
    }

    /**
     * Serialize one complete placement state at [DOCUMENT_VERSION].
     *
     * Default slots are omitted, as are default Keys layout fields. Every slot with an
     * explicit position or a non-default Keys layout is written in a fixed order, with
     * a Keys position and a remembered floating size both preserved while docked.
     *
     * @throws StorageException with [StorageFailureReason.WRITE_FAILED] when the
     *   document would exceed [MAX_DOCUMENT_BYTES].
     */
    public fun encode(placement: TerminalOverlayPlacement): String {
        val entries = buildList {
            TerminalOverlay.entries.forEach { overlay ->
                TerminalOverlayOrientation.entries.forEach { orientation ->
                    val position = placement.position(overlay, orientation)
                    val layout = if (overlay == TerminalOverlay.KEYS) {
                        placement.keysLayout(orientation)
                    } else {
                        TerminalKeysLayout.DEFAULT
                    }
                    val rememberedLayout = overlay == TerminalOverlay.KEYS &&
                        layout != TerminalKeysLayout.DEFAULT
                    if (position != null || rememberedLayout) {
                        add(EncodedSlot(overlay, orientation, position, layout))
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
                if (index > 0) append(',')
                appendEncodedSlot(entry)
            }
            append("]}")
            append('\n')
        }
        if (body.toByteArray(Charsets.UTF_8).size > MAX_DOCUMENT_BYTES) {
            throw StorageException(StorageFailureReason.WRITE_FAILED)
        }
        return body
    }

    private fun StringBuilder.appendEncodedSlot(entry: EncodedSlot) {
        append('{')
        append("\"").append(ENTRY_KEY_OVERLAY).append("\":\"").append(entry.overlay.wireName).append('"')
        append(",\"").append(ENTRY_KEY_ORIENTATION).append("\":\"").append(entry.orientation.wireName).append('"')
        entry.position?.let { position ->
            append(",\"").append(ENTRY_KEY_X).append("\":").append(position.xPermille)
            append(",\"").append(ENTRY_KEY_Y).append("\":").append(position.yPermille)
        }
        if (entry.overlay == TerminalOverlay.KEYS) {
            if (!entry.layout.docked) {
                append(",\"").append(ENTRY_KEY_DOCKED).append("\":").append(false)
            }
            entry.layout.floatingSize?.let { size ->
                append(",\"").append(ENTRY_KEY_W).append("\":").append(size.widthPermille)
                append(",\"").append(ENTRY_KEY_H).append("\":").append(size.heightPermille)
            }
        }
        append('}')
    }

    /** One real nonnegative JSON integer in `minimum..maximum`, never quoted, null, or fractional. */
    private fun JsonElement?.asStrictPermille(minimum: Int, maximum: Int): Int? {
        val value = this.asNumberOrNull() ?: return null
        if (value < minimum || value > maximum) return null
        return value
    }

    private fun slotKey(overlay: TerminalOverlay, orientation: TerminalOverlayOrientation): String =
        "${overlay.wireName}:${orientation.wireName}"

    private data class EncodedSlot(
        val overlay: TerminalOverlay,
        val orientation: TerminalOverlayOrientation,
        val position: TerminalOverlayPosition?,
        val layout: TerminalKeysLayout,
    )
}

/** Decode outcome: a validated placement, or one fixed refusal reason. */
public sealed interface TerminalOverlayPlacementDecodeResult {
    public class Valid(public val placement: TerminalOverlayPlacement) : TerminalOverlayPlacementDecodeResult
    public class Invalid(public val reason: StorageFailureReason) : TerminalOverlayPlacementDecodeResult
}
