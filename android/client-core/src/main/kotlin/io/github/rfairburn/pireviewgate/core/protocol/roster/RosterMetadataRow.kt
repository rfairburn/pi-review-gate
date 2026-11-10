package io.github.rfairburn.pireviewgate.core.protocol.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.internal.RosterErrorText
import io.github.rfairburn.pireviewgate.core.protocol.roster.internal.RosterJson
import io.github.rfairburn.pireviewgate.core.protocol.roster.internal.RosterText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** Display labels follow the canonical native title bound. */
const val MAX_REMOTE_LABEL_CHARS: Int = 256
const val MAX_REMOTE_LABEL_BYTES: Int = MAX_REMOTE_LABEL_CHARS * 4

/** Stable row ids are opaque and bounded; they are data, never a path. */
const val MAX_REMOTE_ROW_ID_BYTES: Int = 256

/** The owner's durable roster slot id is opaque bounded text. */
const val MAX_REMOTE_ROSTER_SLOT_ID_CHARS: Int = 128
const val MAX_REMOTE_ROSTER_SLOT_ID_BYTES: Int = MAX_REMOTE_ROSTER_SLOT_ID_CHARS * 4

/** Exact owner-side workspace path bytes; oversized paths are unrepresentable. */
const val MAX_REMOTE_WORKSPACE_BYTES: Int = 4096

/** Generic activity follows the local status bound. */
const val MAX_REMOTE_ACTIVITY_LINES: Int = 2
const val MAX_REMOTE_ACTIVITY_LINE_CHARS: Int = 120

/** Canonical native display names follow the local protocol bound. */
const val MAX_REMOTE_NATIVE_NAME_CHARS: Int = 256
const val MAX_REMOTE_NATIVE_NAME_BYTES: Int = MAX_REMOTE_NATIVE_NAME_CHARS * 4

/** Raw error diagnostics larger than this are not inspected for display. */
const val MAX_REMOTE_ERROR_INPUT_BYTES: Int = 4096

/** Final display-safe error text bound (code points and UTF-8 bytes). */
const val MAX_REMOTE_ERROR_CHARS: Int = 320
const val MAX_REMOTE_ERROR_BYTES: Int = 1024

/** Fixed useful message used whenever diagnostic detail cannot be shown safely. */
const val REMOTE_ERROR_FALLBACK_TEXT: String = "Remote session failed; error details are unavailable"

/**
 * Strict decoder for one already-framed remote roster row, plus the canonical
 * row text this side sends.
 *
 * Unknown top-level or nested native-session keys (including a native current
 * file) are refused, so a private owner field cannot ride along. Every invalid
 * shape yields `null`; raw values and parser details are never returned. Optional
 * or absent observations decode as unknown (`null`) or empty activity, never as
 * fabricated values.
 */
object RosterMetadataRow {

    /** Thrown by one field rule; the caller turns it into a refused row. */
    private class Rejected : RuntimeException()

    /** The only row keys this boundary accepts. */
    private val ALLOWED_ROW_KEYS: Set<String> = setOf(
        "id",
        "rosterSlotId",
        "label",
        "workspace",
        "lifecycle",
        "hasLiveProcess",
        "busy",
        "pendingInput",
        "inputSurface",
        "activity",
        "nativeSession",
        "backgroundTasks",
        "backgroundShells",
        "activeTasks",
        "activeShells",
        "exitCode",
        "error",
    )

    private val REQUIRED_ROW_KEYS: List<String> = listOf(
        "id",
        "label",
        "workspace",
        "lifecycle",
        "hasLiveProcess",
        "inputSurface",
    )

    /** Native current-file authority (and any other private key) never crosses. */
    private val NATIVE_SESSION_KEYS: Set<String> = setOf("sessionId", "epoch", "name", "persistence")

    /** `null` means this row cannot be represented, so the whole frame is refused. */
    fun parse(element: JsonElement?): RemoteSessionMetadata? = try {
        buildRow(element)
    } catch (ignored: Exception) {
        null
    }

    private fun buildRow(element: JsonElement?): RemoteSessionMetadata {
        val record = element as? JsonObject ?: reject()
        if (record.keys.any { it !in ALLOWED_ROW_KEYS }) reject()
        if (REQUIRED_ROW_KEYS.any { !record.containsKey(it) }) reject()

        return RemoteSessionMetadata(
            id = requiredText(record["id"], MAX_REMOTE_ROW_ID_BYTES, null),
            label = requiredText(record["label"], MAX_REMOTE_LABEL_BYTES, MAX_REMOTE_LABEL_CHARS),
            workspace = exactText(record["workspace"], MAX_REMOTE_WORKSPACE_BYTES),
            lifecycle = lifecycleOf(record["lifecycle"]),
            hasLiveProcess = requiredBoolean(record["hasLiveProcess"]),
            inputSurface = requiredBoolean(record["inputSurface"]),
            rosterSlotId = rosterSlotId(record["rosterSlotId"]),
            busy = observation(record["busy"]),
            pendingInput = observation(record["pendingInput"]),
            activity = activity(record["activity"]),
            nativeSession = nativeSession(record["nativeSession"]),
            backgroundTasks = count(record["backgroundTasks"]),
            backgroundShells = count(record["backgroundShells"]),
            activeTasks = count(record["activeTasks"]),
            activeShells = count(record["activeShells"]),
            exitCode = exitCode(record["exitCode"]),
            error = errorText(record["error"]),
        )
    }

    private fun reject(): Nothing = throw Rejected()

    private fun isAbsentOrNull(element: JsonElement?): Boolean = element == null || element is JsonNull

    private fun stringOf(element: JsonElement?): String? =
        (element as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun requiredText(element: JsonElement?, maxBytes: Int, maxChars: Int?): String {
        val value = stringOf(element) ?: reject()
        if (value.isEmpty()) reject()
        if (maxChars != null && RosterText.codePointCount(value) > maxChars) reject()
        if (RosterJson.utf8Length(value) > maxBytes) reject()
        if (RosterText.isUnsafeText(value)) reject()
        return value
    }

    /** Workspace paths are exact owner data: bounded in size, never rewritten. */
    private fun exactText(element: JsonElement?, maxBytes: Int): String {
        val value = stringOf(element) ?: reject()
        if (value.isEmpty()) reject()
        if (RosterJson.utf8Length(value) > maxBytes) reject()
        return value
    }

    private fun lifecycleOf(element: JsonElement?): RosterLifecycle =
        RosterLifecycle.fromWireName(stringOf(element) ?: reject()) ?: reject()

    private fun requiredBoolean(element: JsonElement?): Boolean =
        (element as? JsonPrimitive)?.takeIf { !it.isString }?.let {
            it.booleanOrNull ?: reject()
        } ?: reject()

    /** Observed boolean or unknown; absent and `null` are both unknown. */
    private fun observation(element: JsonElement?): Boolean? {
        if (isAbsentOrNull(element)) return null
        return (element as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.booleanOrNull ?: reject() }
            ?: reject()
    }

    /** Nonnegative safe integer or unknown; a cleared tracker is never zero. */
    private fun count(element: JsonElement?): Long? {
        if (isAbsentOrNull(element)) return null
        val value = number(element) ?: reject()
        if (value < 0L) reject()
        return value
    }

    /** Present only when the owner observed a finite exit code. */
    private fun exitCode(element: JsonElement?): Double? {
        if (isAbsentOrNull(element)) return null
        val raw = element as? JsonPrimitive ?: reject()
        if (raw.isString) reject()
        val value = raw.content.toDoubleOrNull() ?: reject()
        if (value.isNaN() || value.isInfinite()) reject()
        return value
    }

    /** Bounded, terminal-safe, redacted diagnostic text; absent when none. */
    private fun errorText(element: JsonElement?): String? {
        if (isAbsentOrNull(element)) return null
        return RosterErrorText.displaySafe(stringOf(element) ?: reject())
    }

    /**
     * Bounded opaque roster-slot metadata. Absent or null is honest absence; a slot
     * is non-empty display-safe text inside the owner's slot bound. No shape is
     * imposed beyond that, and an out-of-bound slot is refused rather than
     * truncated into a different slot.
     */
    private fun rosterSlotId(element: JsonElement?): String? {
        if (isAbsentOrNull(element)) return null
        val value = stringOf(element) ?: reject()
        if (value.isEmpty()) reject()
        if (RosterText.codePointCount(value) > MAX_REMOTE_ROSTER_SLOT_ID_CHARS) reject()
        if (RosterJson.utf8Length(value) > MAX_REMOTE_ROSTER_SLOT_ID_BYTES) reject()
        if (RosterText.isUnsafeText(value)) reject()
        return value
    }

    private fun activity(element: JsonElement?): List<String> {
        if (element == null) return emptyList()
        val array = element as? JsonArray ?: reject()
        if (array.size > MAX_REMOTE_ACTIVITY_LINES) reject()
        return array.map { line ->
            val value = stringOf(line) ?: reject()
            if (RosterText.codePointCount(value) > MAX_REMOTE_ACTIVITY_LINE_CHARS) reject()
            if (RosterText.isUnsafeText(value)) reject()
            value
        }
    }

    private fun nativeSession(element: JsonElement?): RemoteNativeSession? {
        if (isAbsentOrNull(element)) return null
        val record = element as? JsonObject ?: reject()
        if (record.keys.any { it !in NATIVE_SESSION_KEYS }) reject()

        val sessionId = stringOf(record["sessionId"]) ?: reject()
        if (!RosterText.isNativeSessionId(sessionId)) reject()

        val epoch = number(record["epoch"]) ?: reject()
        if (epoch < 1L) reject()

        val name = stringOf(record["name"]) ?: reject()
        if (name.isEmpty() || RosterText.hasJsTrimmedEdge(name)) reject()
        if (RosterText.codePointCount(name) > MAX_REMOTE_NATIVE_NAME_CHARS) reject()
        if (RosterJson.utf8Length(name) > MAX_REMOTE_NATIVE_NAME_BYTES) reject()
        if (RosterText.isUnsafeText(name)) reject()

        val persistenceElement = record["persistence"]
        val persistence = if (persistenceElement == null) {
            null
        } else {
            RemoteNativePersistence.fromWireName(stringOf(persistenceElement) ?: reject()) ?: reject()
        }

        return RemoteNativeSession(
            sessionId = sessionId,
            epoch = epoch,
            name = name,
            persistence = persistence,
        )
    }

    /** A JSON number read as an exact safe integer, or a refused row. */
    private fun number(element: JsonElement?): Long {
        val raw = element as? JsonPrimitive ?: reject()
        if (raw.isString) reject()
        return integer(raw.content) ?: reject()
    }

    /**
     * A JSON number read as an exact integer: finite, integral, and inside the
     * safe-integer range the source accepts. A value spelled in exponent form is
     * the same number, so it is accepted when it denotes an integer in range.
     */
    internal fun integer(text: String): Long? {
        val value = text.toDoubleOrNull() ?: return null
        if (value.isNaN() || value.isInfinite()) return null
        if (value != Math.floor(value)) return null
        if (value < -MAX_SAFE_INTEGER.toDouble() || value > MAX_SAFE_INTEGER.toDouble()) return null
        return value.toLong()
    }

    /**
     * Canonical row text for one frame this side is about to send.
     *
     * Every bound this boundary enforces on read is re-proved here, so a row built
     * wrongly is refused instead of shipping an unrepresentable or oversized row.
     * Field order matches the source's canonical row object.
     */
    internal fun encode(row: RemoteSessionMetadata): String {
        val fields = mutableListOf<Pair<String, String>>()
        fields += "id" to RosterJson.stringOf(writeText(row.id, MAX_REMOTE_ROW_ID_BYTES, null))
        row.rosterSlotId?.let { slot ->
            if (slot.isEmpty()) fail(RosterFailureCode.INVALID_FRAME)
            if (RosterText.codePointCount(slot) > MAX_REMOTE_ROSTER_SLOT_ID_CHARS) fail(RosterFailureCode.INVALID_FRAME)
            if (RosterJson.utf8Length(slot) > MAX_REMOTE_ROSTER_SLOT_ID_BYTES) fail(RosterFailureCode.INVALID_FRAME)
            if (RosterText.isUnsafeText(slot)) fail(RosterFailureCode.INVALID_FRAME)
            fields += "rosterSlotId" to RosterJson.stringOf(slot)
        }
        fields += "label" to RosterJson.stringOf(
            writeText(row.label, MAX_REMOTE_LABEL_BYTES, MAX_REMOTE_LABEL_CHARS),
        )
        fields += "workspace" to RosterJson.stringOf(writeExact(row.workspace, MAX_REMOTE_WORKSPACE_BYTES))
        fields += "lifecycle" to RosterJson.stringOf(row.lifecycle.wireName)
        fields += "hasLiveProcess" to row.hasLiveProcess.toString()
        fields += "busy" to (row.busy?.toString() ?: "null")
        fields += "pendingInput" to (row.pendingInput?.toString() ?: "null")
        fields += "inputSurface" to row.inputSurface.toString()
        if (row.activity.size > MAX_REMOTE_ACTIVITY_LINES) fail(RosterFailureCode.INVALID_FRAME)
        fields += "activity" to row.activity.joinToString(",", "[", "]") { line ->
            if (RosterText.codePointCount(line) > MAX_REMOTE_ACTIVITY_LINE_CHARS) {
                fail(RosterFailureCode.INVALID_FRAME)
            }
            if (RosterText.isUnsafeText(line)) fail(RosterFailureCode.INVALID_FRAME)
            RosterJson.stringOf(line)
        }
        fields += "nativeSession" to (
            row.nativeSession?.let { session -> writeNativeSession(session) } ?: "null"
            )
        fields += "backgroundTasks" to writeCount(row.backgroundTasks)
        fields += "backgroundShells" to writeCount(row.backgroundShells)
        fields += "activeTasks" to writeCount(row.activeTasks)
        fields += "activeShells" to writeCount(row.activeShells)
        row.exitCode?.let { code ->
            if (code.isNaN() || code.isInfinite()) fail(RosterFailureCode.INVALID_FRAME)
            fields += "exitCode" to RosterJson.numberString(code)
        }
        row.error?.let { fields += "error" to RosterJson.stringOf(it) }
        return fields.joinToString(",", "{", "}") { (key, value) -> "${RosterJson.stringOf(key)}:$value" }
    }

    private fun writeNativeSession(session: RemoteNativeSession): String {
        if (!RosterText.isNativeSessionId(session.sessionId)) fail(RosterFailureCode.INVALID_FRAME)
        if (session.epoch < 1L || session.epoch > MAX_SAFE_INTEGER) fail(RosterFailureCode.INVALID_FRAME)
        if (session.name.isEmpty() || RosterText.hasJsTrimmedEdge(session.name)) fail(RosterFailureCode.INVALID_FRAME)
        if (RosterText.codePointCount(session.name) > MAX_REMOTE_NATIVE_NAME_CHARS) {
            fail(RosterFailureCode.INVALID_FRAME)
        }
        if (RosterJson.utf8Length(session.name) > MAX_REMOTE_NATIVE_NAME_BYTES) fail(RosterFailureCode.INVALID_FRAME)
        if (RosterText.isUnsafeText(session.name)) fail(RosterFailureCode.INVALID_FRAME)
        val nativeFields = mutableListOf(
            "sessionId" to RosterJson.stringOf(session.sessionId),
            "epoch" to session.epoch.toString(),
            "name" to RosterJson.stringOf(session.name),
        )
        session.persistence?.let { nativeFields += "persistence" to RosterJson.stringOf(it.wireName) }
        return nativeFields.joinToString(",", "{", "}") { (key, value) -> "${RosterJson.stringOf(key)}:$value" }
    }

    private fun writeText(value: String, maxBytes: Int, maxChars: Int?): String {
        if (value.isEmpty()) fail(RosterFailureCode.INVALID_FRAME)
        if (maxChars != null && RosterText.codePointCount(value) > maxChars) fail(RosterFailureCode.INVALID_FRAME)
        if (RosterJson.utf8Length(value) > maxBytes) fail(RosterFailureCode.INVALID_FRAME)
        if (RosterText.isUnsafeText(value)) fail(RosterFailureCode.INVALID_FRAME)
        return value
    }

    private fun writeExact(value: String, maxBytes: Int): String {
        if (value.isEmpty()) fail(RosterFailureCode.INVALID_FRAME)
        if (RosterJson.utf8Length(value) > maxBytes) fail(RosterFailureCode.INVALID_FRAME)
        return value
    }

    /**
     * An observation count in the range this boundary reads back: a non-negative
     * safe integer. A larger Long is unrepresentable on the wire, so it is refused
     * rather than emitted as bytes that cannot round-trip.
     */
    private fun writeCount(value: Long?): String {
        if (value == null) return "null"
        if (value < 0L || value > MAX_SAFE_INTEGER) fail(RosterFailureCode.INVALID_FRAME)
        return value.toString()
    }
}
