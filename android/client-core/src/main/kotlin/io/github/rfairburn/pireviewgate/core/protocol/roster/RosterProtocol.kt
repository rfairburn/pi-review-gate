package io.github.rfairburn.pireviewgate.core.protocol.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.internal.RosterJson
import io.github.rfairburn.pireviewgate.core.protocol.roster.internal.RosterText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * The roster metadata wire contract: one complete binary message in, one typed
 * frame out, and the reverse.
 *
 * This is a pure contract. It performs no IO, reads no ambient configuration,
 * opens no socket, and starts no timer. A frame that cannot be decoded or encoded
 * within its bound fails closed with one fixed code; it is never split, trimmed,
 * partially applied, or described by its own content.
 *
 * Unknown keys — including any private owner field — are refused rather than
 * passed through, so nothing outside this schema can ride along on a frame.
 */
object RosterProtocol {

    /** Largest accepted `major` or `minor` in a hello or acknowledgement. */
    private const val MAX_VERSION: Long = 4_294_967_295L

    /** Bytes one service name may occupy. */
    private const val MAX_SERVICE_BYTES = 128

    /**
     * Decode one complete binary message into one frame.
     *
     * Bytes that are empty, oversized, not valid UTF-8, not a single JSON object,
     * structurally invalid, or carrying any key outside this schema are refused
     * with a fixed code. Nothing partial is ever returned.
     */
    fun decode(bytes: ByteArray, bounds: RosterBounds = RosterBounds.DEFAULT): RosterFrame {
        if (bytes.isEmpty() || bytes.size.toLong() > bounds.maxFrameBytes) fail(RosterFailureCode.FRAME_TOO_LARGE)
        val text = RosterJson.decodeUtf8Strict(bytes) ?: fail(RosterFailureCode.BAD_FRAME)
        val value = RosterJson.parse(text) ?: fail(RosterFailureCode.BAD_FRAME)
        val record = value as? JsonObject ?: fail(RosterFailureCode.BAD_FRAME)
        return buildFrame(record, bounds)
    }

    /**
     * Encode one frame as the complete payload of one binary channel message.
     *
     * The frame is re-proved first, so this side can never hand its peer a frame
     * the peer would refuse; an oversized frame is an error, never a truncated or
     * split message. A frame this side built wrongly is a programming failure, not
     * a peer one, so it is reported as `INVALID_FRAME`.
     */
    fun encode(frame: RosterFrame, bounds: RosterBounds = RosterBounds.DEFAULT): ByteArray {
        val bytes = encodeFrame(frame, bounds).toByteArray(Charsets.UTF_8)
        if (bytes.size.toLong() > bounds.maxFrameBytes) fail(RosterFailureCode.FRAME_TOO_LARGE)
        return bytes
    }

    /**
     * Owner-side decision on one hello. A different service or major version is
     * refused, and a hello without the required baseline capability is refused.
     * Unknown optional capabilities are ignored rather than trusted, and the
     * negotiated minor is the lower of the two so a newer peer cannot imply
     * behavior this implementation does not have.
     */
    fun negotiateHello(hello: RosterFrame.Hello): RosterNegotiation {
        if (hello.service != RosterWire.SERVICE || hello.major != RosterWire.MAJOR) {
            return RosterNegotiation.Refused(RosterWireErrorCode.UNSUPPORTED_VERSION)
        }
        if (!hello.capabilities.contains(RosterWire.REQUIRED_CAPABILITY)) {
            return RosterNegotiation.Refused(RosterWireErrorCode.MISSING_CAPABILITY)
        }
        val negotiated = hello.capabilities.filter { capability ->
            capability != RosterWire.REQUIRED_CAPABILITY &&
                RosterWire.KNOWN_OPTIONAL_CAPABILITIES.contains(capability)
        }
        return RosterNegotiation.Accepted(
            major = RosterWire.MAJOR,
            minor = minOf(hello.minor, RosterWire.MINOR),
            capabilities = negotiated,
        )
    }

    /**
     * Viewer-side decision on one `hello_ack`. The owner must confirm this side's
     * service and major version and must acknowledge the required capability. An
     * acknowledgement that claims a capability this side never offered, or a minor
     * above the one offered, is a protocol violation: negotiation can only narrow
     * what either side may assume, never widen it.
     */
    fun reviewHelloAck(ack: RosterFrame.HelloAck, offeredCapabilities: List<String>): RosterAckVerdict {
        if (ack.service != RosterWire.SERVICE || ack.major != RosterWire.MAJOR) {
            return RosterAckVerdict.Refused(RosterWireErrorCode.UNSUPPORTED_VERSION)
        }
        if (!ack.capabilities.contains(RosterWire.REQUIRED_CAPABILITY)) {
            return RosterAckVerdict.Refused(RosterWireErrorCode.MISSING_CAPABILITY)
        }
        if (ack.minor > RosterWire.MINOR) return RosterAckVerdict.Refused(RosterWireErrorCode.PROTOCOL_VIOLATION)
        for (capability in ack.capabilities) {
            if (!offeredCapabilities.contains(capability)) {
                return RosterAckVerdict.Refused(RosterWireErrorCode.PROTOCOL_VIOLATION)
            }
        }
        return RosterAckVerdict.Accepted(minor = ack.minor, capabilities = ack.capabilities)
    }

    // ------------------------------------------------------------------ encode

    private fun encodeFrame(frame: RosterFrame, bounds: RosterBounds): String {
        val cap = bounds.savedWindowMaxFrames
        return when (frame) {
            is RosterFrame.Hello -> encodeHelloLike("hello", frame.service, frame.major, frame.minor, frame.capabilities, bounds)
            is RosterFrame.HelloAck -> encodeHelloLike("hello_ack", frame.service, frame.major, frame.minor, frame.capabilities, bounds)
            is RosterFrame.Subscribe -> obj("type" to q("subscribe"), "subscriptionId" to q(encIdentifier(frame.subscriptionId, bounds)))
            is RosterFrame.Unsubscribe -> obj("type" to q("unsubscribe"), "subscriptionId" to q(encIdentifier(frame.subscriptionId, bounds)))
            is RosterFrame.Unsubscribed -> obj("type" to q("unsubscribed"), "subscriptionId" to q(encIdentifier(frame.subscriptionId, bounds)))
            is RosterFrame.SnapshotBegin -> {
                val totalRows = encRange(frame.totalRows, 0L, bounds.maxSnapshotRows)
                val minimumPages = if (totalRows == 0L) 0L else (totalRows + bounds.maxRowsPerPage - 1) / bounds.maxRowsPerPage
                if (frame.pageCount < minimumPages || frame.pageCount > maxOf(totalRows, 0L)) {
                    fail(RosterFailureCode.INVALID_FRAME)
                }
                obj(
                    "type" to q("snapshot_begin"),
                    "subscriptionId" to q(encIdentifier(frame.subscriptionId, bounds)),
                    "transferId" to q(encIdentifier(frame.transferId, bounds)),
                    "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                    "revision" to n(encRange(frame.revision, 1L, MAX_SAFE_INTEGER)),
                    "totalRows" to n(totalRows),
                    "pageCount" to n(frame.pageCount),
                )
            }
            is RosterFrame.SnapshotPage -> obj(
                "type" to q("snapshot_page"),
                "subscriptionId" to q(encIdentifier(frame.subscriptionId, bounds)),
                "transferId" to q(encIdentifier(frame.transferId, bounds)),
                "pageIndex" to n(encRange(frame.pageIndex, 0L, MAX_SAFE_INTEGER)),
                "rows" to encodeRows(frame.rows, bounds),
            )
            is RosterFrame.SnapshotEnd -> obj(
                "type" to q("snapshot_end"),
                "subscriptionId" to q(encIdentifier(frame.subscriptionId, bounds)),
                "transferId" to q(encIdentifier(frame.transferId, bounds)),
                "revision" to n(encRange(frame.revision, 1L, MAX_SAFE_INTEGER)),
                "totalRows" to n(encRange(frame.totalRows, 0L, bounds.maxSnapshotRows)),
            )
            is RosterFrame.CloseRequest -> obj(
                "type" to q("close_request"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                "rowId" to q(encIdentifier(frame.rowId, bounds)),
                "confirmed" to b(frame.confirmed),
            )
            is RosterFrame.CloseResult -> obj(
                "type" to q("close_result"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "outcome" to obj("kind" to q(frame.outcome.wireName)),
            )
            is RosterFrame.CreateRequest -> obj(
                "type" to q("create_request"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                "workspace" to q(encWorkspace(frame.workspace)),
                "sequence" to n(encRange(frame.sequence, 1L, MAX_SAFE_INTEGER)),
            )
            is RosterFrame.CreateResult -> obj(
                "type" to q("create_result"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "outcome" to encodeCreateOutcome(frame.outcome, bounds),
            )
            is RosterFrame.RenameRequest -> obj(
                "type" to q("rename_request"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                "rowId" to q(encIdentifier(frame.rowId, bounds)),
                "expectedSessionId" to q(encNativeSessionId(frame.expectedSessionId)),
                "expectedSessionEpoch" to n(encRange(frame.expectedSessionEpoch, 1L, MAX_SAFE_INTEGER)),
                "name" to q(encRenameName(frame.name)),
                "sequence" to n(encRange(frame.sequence, 1L, MAX_SAFE_INTEGER)),
            )
            is RosterFrame.RenameResult -> obj(
                "type" to q("rename_result"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "outcome" to obj("kind" to q(frame.outcome.wireName)),
            )
            is RosterFrame.SavedListRequest -> obj(
                "type" to q("saved_list_request"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                "query" to q(encSavedText(frame.query)),
                "offset" to n(encRange(frame.offset, 0L, MAX_SAFE_INTEGER)),
                "count" to n(encRange(frame.count, 1L, bounds.maxSnapshotRows)),
                "sequence" to n(encRange(frame.sequence, 1L, MAX_SAFE_INTEGER)),
            )
            is RosterFrame.SavedSearchRequest -> obj(
                "type" to q("saved_search_request"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                "catalogId" to q(encIdentifier(frame.catalogId, bounds)),
                "query" to q(encSavedText(frame.query)),
                "offset" to n(encRange(frame.offset, 0L, MAX_SAFE_INTEGER)),
                "count" to n(encRange(frame.count, 1L, bounds.maxSnapshotRows)),
                "sequence" to n(encRange(frame.sequence, 1L, MAX_SAFE_INTEGER)),
            )
            is RosterFrame.SavedWindowRequest -> obj(
                "type" to q("saved_window_request"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                "catalogId" to q(encIdentifier(frame.catalogId, bounds)),
                "resultId" to q(encIdentifier(frame.resultId, bounds)),
                "offset" to n(encRange(frame.offset, 0L, MAX_SAFE_INTEGER)),
                "count" to n(encRange(frame.count, 1L, bounds.maxSnapshotRows)),
                "sequence" to n(encRange(frame.sequence, 1L, MAX_SAFE_INTEGER)),
            )
            is RosterFrame.SavedResumeRequest -> obj(
                "type" to q("saved_resume_request"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                "catalogId" to q(encIdentifier(frame.catalogId, bounds)),
                "resultId" to q(encIdentifier(frame.resultId, bounds)),
                "entryId" to q(encIdentifier(frame.entryId, bounds)),
                "sequence" to n(encRange(frame.sequence, 1L, MAX_SAFE_INTEGER)),
            )
            is RosterFrame.SavedDeleteRequest -> obj(
                "type" to q("saved_delete_request"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                "catalogId" to q(encIdentifier(frame.catalogId, bounds)),
                "resultId" to q(encIdentifier(frame.resultId, bounds)),
                "entryId" to q(encIdentifier(frame.entryId, bounds)),
                "confirmed" to b(frame.confirmed),
                "sequence" to n(encRange(frame.sequence, 1L, MAX_SAFE_INTEGER)),
            )
            is RosterFrame.SavedWindowResult -> obj(
                "type" to q("saved_window_result"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "outcome" to encodeSavedWindowOutcome(frame.outcome),
            )
            is RosterFrame.SavedWindowBegin -> {
                if (frame.offset > frame.total) fail(RosterFailureCode.INVALID_FRAME)
                val rows = encRange(frame.rows, 0L, bounds.maxSnapshotRows)
                if (rows > frame.total - frame.offset) fail(RosterFailureCode.INVALID_FRAME)
                obj(
                    "type" to q("saved_window_begin"),
                    "requestId" to q(encIdentifier(frame.requestId, bounds)),
                    "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                    "catalogId" to q(encIdentifier(frame.catalogId, bounds)),
                    "resultId" to q(encIdentifier(frame.resultId, bounds)),
                    "total" to n(encRange(frame.total, 0L, MAX_SAFE_INTEGER)),
                    "issueCount" to n(encRange(frame.issueCount, 0L, MAX_SAFE_INTEGER)),
                    "offset" to n(encRange(frame.offset, 0L, MAX_SAFE_INTEGER)),
                    "rows" to n(rows),
                    "pageCount" to n(encSavedPageCount(frame.pageCount, rows, bounds)),
                )
            }
            is RosterFrame.SavedWindowPage -> obj(
                "type" to q("saved_window_page"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "pageIndex" to n(encRange(frame.pageIndex, 0L, cap)),
                "entries" to encodeSavedEntries(frame.entries, bounds),
            )
            is RosterFrame.SavedWindowFragment -> {
                val parts = encRange(frame.parts, 1L, cap)
                val part = encRange(frame.part, 0L, cap)
                if (part >= parts) fail(RosterFailureCode.INVALID_FRAME)
                obj(
                    "type" to q("saved_window_fragment"),
                    "requestId" to q(encIdentifier(frame.requestId, bounds)),
                    "pageIndex" to n(encRange(frame.pageIndex, 0L, cap)),
                    "part" to n(part),
                    "parts" to n(parts),
                    "text" to q(encSavedFragmentText(frame.text)),
                )
            }
            is RosterFrame.SavedWindowEnd -> {
                val rows = encRange(frame.rows, 0L, bounds.maxSnapshotRows)
                obj(
                    "type" to q("saved_window_end"),
                    "requestId" to q(encIdentifier(frame.requestId, bounds)),
                    "rows" to n(rows),
                    "pageCount" to n(encSavedPageCount(frame.pageCount, rows, bounds)),
                )
            }
            is RosterFrame.SavedResumeResult -> obj(
                "type" to q("saved_resume_result"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "outcome" to encodeSavedResumeOutcome(frame.outcome, bounds),
            )
            is RosterFrame.SavedDeleteResult -> obj(
                "type" to q("saved_delete_result"),
                "requestId" to q(encIdentifier(frame.requestId, bounds)),
                "outcome" to encodeSavedDeleteOutcome(frame.outcome),
            )
            is RosterFrame.SavedPolicy -> obj(
                "type" to q("saved_policy"),
                "hostRunId" to q(encIdentifier(frame.hostRunId, bounds)),
                "deleteExposed" to b(frame.deleteExposed),
            )
            is RosterFrame.Failure -> {
                val fields = mutableListOf(
                    "type" to q("error"),
                    "code" to q(frame.code.wireName),
                )
                if (frame.subscriptionId != null) {
                    fields += "subscriptionId" to q(encIdentifier(frame.subscriptionId, bounds))
                }
                obj(fields)
            }
        }
    }

    private fun encodeHelloLike(
        type: String,
        service: String,
        major: Long,
        minor: Long,
        capabilities: List<String>,
        bounds: RosterBounds,
    ): String = obj(
        "type" to q(type),
        "service" to q(encService(service)),
        "major" to n(encRange(major, 0L, MAX_VERSION)),
        "minor" to n(encRange(minor, 0L, MAX_VERSION)),
        "capabilities" to encodeCapabilities(capabilities, bounds),
    )

    private fun encodeCapabilities(capabilities: List<String>, bounds: RosterBounds): String {
        if (capabilities.size.toLong() > bounds.maxCapabilities) fail(RosterFailureCode.INVALID_FRAME)
        val seen = mutableSetOf<String>()
        return capabilities.map { capability ->
            if (RosterJson.utf8Length(capability) > bounds.maxCapabilityIdBytes) {
                fail(RosterFailureCode.INVALID_FRAME)
            }
            if (!RosterText.IDENTIFIER_RE.matches(capability)) fail(RosterFailureCode.INVALID_FRAME)
            if (!seen.add(capability)) fail(RosterFailureCode.INVALID_FRAME)
            q(capability)
        }.joinToString(",", "[", "]")
    }

    private fun encodeRows(rows: List<RemoteSessionMetadata>, bounds: RosterBounds): String {
        if (rows.size.toLong() > bounds.maxRowsPerPage) fail(RosterFailureCode.INVALID_FRAME)
        return rows.joinToString(",", "[", "]") { row -> RosterMetadataRow.encode(row) }
    }

    private fun encodeCreateOutcome(outcome: OwnerCreateFacts, bounds: RosterBounds): String = when (outcome) {
        is OwnerCreateFacts.Started -> obj(
            "kind" to q("started"),
            "hostRunId" to q(encIdentifier(outcome.hostRunId, bounds)),
            "rowId" to q(encIdentifier(outcome.rowId, bounds)),
        )
        OwnerCreateFacts.Unconfirmed -> obj("kind" to q("unconfirmed"))
        OwnerCreateFacts.Refused -> obj("kind" to q("refused"))
        OwnerCreateFacts.Unknown -> obj("kind" to q("unknown"))
    }

    private fun encodeSavedWindowOutcome(outcome: OwnerSavedWindowOutcome): String = when (outcome) {
        is OwnerSavedWindowOutcome.Refused -> if (outcome.reason == null) {
            obj("kind" to q("refused"))
        } else {
            obj("kind" to q("refused"), "reason" to q(outcome.reason.wireName))
        }
        OwnerSavedWindowOutcome.Unavailable -> obj("kind" to q("unavailable"))
        OwnerSavedWindowOutcome.Unknown -> obj("kind" to q("unknown"))
    }

    private fun encodeSavedResumeOutcome(outcome: OwnerSavedResumeFacts, bounds: RosterBounds): String =
        when (outcome) {
            is OwnerSavedResumeFacts.Started -> obj(
                "kind" to q("started"),
                "hostRunId" to q(encIdentifier(outcome.hostRunId, bounds)),
                "rowId" to q(encIdentifier(outcome.rowId, bounds)),
            )
            is OwnerSavedResumeFacts.Refused -> obj("kind" to q("refused"), "reason" to q(outcome.reason.wireName))
            OwnerSavedResumeFacts.Unconfirmed -> obj("kind" to q("unconfirmed"))
            OwnerSavedResumeFacts.Unknown -> obj("kind" to q("unknown"))
        }

    private fun encodeSavedDeleteOutcome(outcome: OwnerSavedDeleteFacts): String = when (outcome) {
        OwnerSavedDeleteFacts.ConfirmationRequired -> obj("kind" to q("confirmation-required"))
        is OwnerSavedDeleteFacts.Deleted -> obj("kind" to q("deleted"), "method" to q(outcome.method.wireName))
        is OwnerSavedDeleteFacts.Refused -> obj("kind" to q("refused"), "reason" to q(outcome.reason.wireName))
        OwnerSavedDeleteFacts.Unconfirmed -> obj("kind" to q("unconfirmed"))
        OwnerSavedDeleteFacts.Unknown -> obj("kind" to q("unknown"))
    }

    private fun encodeSavedEntries(entries: List<OwnerSavedEntry>, bounds: RosterBounds): String {
        if (entries.size.toLong() > bounds.maxRowsPerPage) fail(RosterFailureCode.INVALID_FRAME)
        val seen = mutableSetOf<String>()
        return entries.joinToString(",", "[", "]") { entry ->
            if (!seen.add(entry.entryId)) fail(RosterFailureCode.INVALID_FRAME)
            writeSavedEntry(entry, bounds)
        }
    }

    // ------------------------------------------------------- encode validators

    private fun encIdentifier(value: String, bounds: RosterBounds): String = value.also {
        if (!RosterText.isIdentifier(it, bounds.maxIdentifierBytes)) fail(RosterFailureCode.INVALID_FRAME)
    }

    private fun encService(value: String): String = value.also {
        if (it.isEmpty()) fail(RosterFailureCode.INVALID_FRAME)
        if (RosterJson.utf8Length(it) > MAX_SERVICE_BYTES) fail(RosterFailureCode.INVALID_FRAME)
        if (RosterText.isUnsafeText(it)) fail(RosterFailureCode.INVALID_FRAME)
    }

    private fun encRange(value: Long, min: Long, max: Long): Long = value.also {
        if (it < min || it > max) fail(RosterFailureCode.INVALID_FRAME)
    }

    private fun encWorkspace(value: String): String = value.also {
        if (!RosterText.isCreateWorkspace(it)) fail(RosterFailureCode.INVALID_FRAME)
    }

    private fun encNativeSessionId(value: String): String = value.also {
        if (!RosterText.isNativeSessionId(it)) fail(RosterFailureCode.INVALID_FRAME)
    }

    private fun encRenameName(value: String): String = value.also {
        if (!RosterText.isRenameName(it)) fail(RosterFailureCode.INVALID_FRAME)
    }

    private fun encSavedText(value: String): String = value.also {
        if (!RosterText.isWellFormedUnicode(it)) fail(RosterFailureCode.INVALID_FRAME)
    }

    private fun encSavedFragmentText(value: String): String = value.also {
        if (it.isEmpty() || !RosterText.isWellFormedUnicode(it)) fail(RosterFailureCode.INVALID_FRAME)
    }

    private fun encSavedPageCount(pageCount: Long, rows: Long, bounds: RosterBounds): Long {
        val bounded = encRange(pageCount, 0L, bounds.savedWindowMaxFrames)
        if (rows == 0L) {
            if (bounded != 0L) fail(RosterFailureCode.INVALID_FRAME)
            return bounded
        }
        val minimum = (rows + bounds.maxRowsPerPage - 1) / bounds.maxRowsPerPage
        if (bounded < minimum) fail(RosterFailureCode.INVALID_FRAME)
        return bounded
    }

    private fun writeSavedEntry(entry: OwnerSavedEntry, bounds: RosterBounds): String = obj(
        "entryId" to q(encIdentifier(entry.entryId, bounds)),
        "sessionId" to q(encSavedText(entry.sessionId)),
        "file" to q(encSavedText(entry.file)),
        "caption" to q(encSavedText(entry.caption)),
        "cwd" to q(encSavedText(entry.cwd)),
    )

    // ------------------------------------------------------------- rendering

    private fun obj(fields: List<Pair<String, String>>): String =
        fields.joinToString(",", "{", "}") { (key, value) -> "${q(key)}:$value" }

    private fun obj(vararg fields: Pair<String, String>): String = obj(fields.asList())

    private fun q(value: String): String = RosterJson.stringOf(value)

    private fun n(value: Long): String = value.toString()

    private fun b(value: Boolean): String = if (value) "true" else "false"

    /**
     * True only for a value this protocol can carry as one opaque identifier: a
     * bounded, non-empty, unremarkable token.
     */
    fun isIdentifier(value: String, bounds: RosterBounds = RosterBounds.DEFAULT): Boolean =
        RosterText.isIdentifier(value, bounds.maxIdentifierBytes)

    /** Frame count (pages plus fragments) cap for one Saved window under these bounds. */
    fun savedWindowMaxFrames(bounds: RosterBounds = RosterBounds.DEFAULT): Long = bounds.savedWindowMaxFrames

    /**
     * Reassemble one fragmented Saved entry. The concatenated fragment text must be
     * exactly the canonical encoding of one valid entry; anything else — invalid
     * JSON, another shape, a non-canonical encoding — fails closed.
     */
    fun decodeSavedEntryText(text: String, bounds: RosterBounds = RosterBounds.DEFAULT): OwnerSavedEntry {
        if (!RosterText.isWellFormedUnicode(text)) fail(RosterFailureCode.BAD_FRAME)
        val value = RosterJson.parse(text) ?: fail(RosterFailureCode.BAD_FRAME)
        val entry = readSavedEntry(value, bounds)
        if (writeSavedEntry(entry, bounds) != text) fail(RosterFailureCode.BAD_FRAME)
        return entry
    }

    // ------------------------------------------------------------- frame schema

    private class Schema(val allowed: Set<String>, val required: Set<String>)

    private val schemas: Map<String, Schema> = buildMap {
        fun put(type: String, keys: List<String>, required: List<String>) {
            put(type, Schema(keys.toSet(), required.toSet()))
        }
        put(
            "hello",
            listOf("type", "service", "major", "minor", "capabilities"),
            listOf("service", "major", "minor", "capabilities"),
        )
        put(
            "hello_ack",
            listOf("type", "service", "major", "minor", "capabilities"),
            listOf("service", "major", "minor", "capabilities"),
        )
        put("subscribe", listOf("type", "subscriptionId"), listOf("subscriptionId"))
        put(
            "snapshot_begin",
            listOf("type", "subscriptionId", "transferId", "hostRunId", "revision", "totalRows", "pageCount"),
            listOf("subscriptionId", "transferId", "hostRunId", "revision", "totalRows", "pageCount"),
        )
        put(
            "snapshot_page",
            listOf("type", "subscriptionId", "transferId", "pageIndex", "rows"),
            listOf("subscriptionId", "transferId", "pageIndex", "rows"),
        )
        put(
            "snapshot_end",
            listOf("type", "subscriptionId", "transferId", "revision", "totalRows"),
            listOf("subscriptionId", "transferId", "revision", "totalRows"),
        )
        put("unsubscribe", listOf("type", "subscriptionId"), listOf("subscriptionId"))
        put("unsubscribed", listOf("type", "subscriptionId"), listOf("subscriptionId"))
        put(
            "close_request",
            listOf("type", "requestId", "hostRunId", "rowId", "confirmed"),
            listOf("requestId", "hostRunId", "rowId", "confirmed"),
        )
        put("close_result", listOf("type", "requestId", "outcome"), listOf("requestId", "outcome"))
        put(
            "create_request",
            listOf("type", "requestId", "hostRunId", "workspace", "sequence"),
            listOf("requestId", "hostRunId", "workspace", "sequence"),
        )
        put("create_result", listOf("type", "requestId", "outcome"), listOf("requestId", "outcome"))
        put(
            "rename_request",
            listOf(
                "type", "requestId", "hostRunId", "rowId", "expectedSessionId", "expectedSessionEpoch", "name",
                "sequence",
            ),
            listOf(
                "requestId", "hostRunId", "rowId", "expectedSessionId", "expectedSessionEpoch", "name", "sequence",
            ),
        )
        put("rename_result", listOf("type", "requestId", "outcome"), listOf("requestId", "outcome"))
        put(
            "saved_list_request",
            listOf("type", "requestId", "hostRunId", "query", "offset", "count", "sequence"),
            listOf("requestId", "hostRunId", "query", "offset", "count", "sequence"),
        )
        put(
            "saved_search_request",
            listOf("type", "requestId", "hostRunId", "catalogId", "query", "offset", "count", "sequence"),
            listOf("requestId", "hostRunId", "catalogId", "query", "offset", "count", "sequence"),
        )
        put(
            "saved_window_request",
            listOf("type", "requestId", "hostRunId", "catalogId", "resultId", "offset", "count", "sequence"),
            listOf("requestId", "hostRunId", "catalogId", "resultId", "offset", "count", "sequence"),
        )
        put(
            "saved_resume_request",
            listOf("type", "requestId", "hostRunId", "catalogId", "resultId", "entryId", "sequence"),
            listOf("requestId", "hostRunId", "catalogId", "resultId", "entryId", "sequence"),
        )
        put(
            "saved_delete_request",
            listOf("type", "requestId", "hostRunId", "catalogId", "resultId", "entryId", "confirmed", "sequence"),
            listOf("requestId", "hostRunId", "catalogId", "resultId", "entryId", "confirmed", "sequence"),
        )
        put("saved_window_result", listOf("type", "requestId", "outcome"), listOf("requestId", "outcome"))
        put(
            "saved_window_begin",
            listOf(
                "type", "requestId", "hostRunId", "catalogId", "resultId", "total", "issueCount", "offset", "rows",
                "pageCount",
            ),
            listOf(
                "requestId", "hostRunId", "catalogId", "resultId", "total", "issueCount", "offset", "rows",
                "pageCount",
            ),
        )
        put(
            "saved_window_page",
            listOf("type", "requestId", "pageIndex", "entries"),
            listOf("requestId", "pageIndex", "entries"),
        )
        put(
            "saved_window_fragment",
            listOf("type", "requestId", "pageIndex", "part", "parts", "text"),
            listOf("requestId", "pageIndex", "part", "parts", "text"),
        )
        put("saved_window_end", listOf("type", "requestId", "rows", "pageCount"), listOf("requestId", "rows", "pageCount"))
        put("saved_resume_result", listOf("type", "requestId", "outcome"), listOf("requestId", "outcome"))
        put("saved_delete_result", listOf("type", "requestId", "outcome"), listOf("requestId", "outcome"))
        put("saved_policy", listOf("type", "hostRunId", "deleteExposed"), listOf("hostRunId", "deleteExposed"))
        put("error", listOf("type", "code", "subscriptionId"), listOf("code"))
    }

    // ------------------------------------------------------------------ decode

    private fun buildFrame(record: JsonObject, bounds: RosterBounds): RosterFrame {
        val type = stringOf(record["type"]) ?: fail(RosterFailureCode.BAD_FRAME)
        val schema = schemas[type] ?: fail(RosterFailureCode.BAD_FRAME)
        // Unknown keys, including any private owner field, are refused, so nothing
        // outside this schema can ride along on a metadata frame.
        if (record.keys.any { it !in schema.allowed }) fail(RosterFailureCode.BAD_FRAME)
        if (schema.required.any { !record.containsKey(it) }) fail(RosterFailureCode.BAD_FRAME)

        fun id(key: String): String = readIdentifier(record[key], bounds)

        return when (type) {
            "hello", "hello_ack" -> {
                val service = readService(record["service"])
                val major = readInteger(record["major"], 0L, MAX_VERSION)
                val minor = readInteger(record["minor"], 0L, MAX_VERSION)
                val capabilities = readCapabilities(record["capabilities"], bounds)
                if (type == "hello") {
                    RosterFrame.Hello(service, major, minor, capabilities)
                } else {
                    RosterFrame.HelloAck(service, major, minor, capabilities)
                }
            }
            "subscribe" -> RosterFrame.Subscribe(id("subscriptionId"))
            "unsubscribe" -> RosterFrame.Unsubscribe(id("subscriptionId"))
            "unsubscribed" -> RosterFrame.Unsubscribed(id("subscriptionId"))
            "snapshot_begin" -> RosterFrame.SnapshotBegin(
                subscriptionId = id("subscriptionId"),
                transferId = id("transferId"),
                hostRunId = id("hostRunId"),
                revision = readInteger(record["revision"], 1L, MAX_SAFE_INTEGER),
                totalRows = readInteger(record["totalRows"], 0L, bounds.maxSnapshotRows),
                pageCount = readInteger(record["pageCount"], 0L, bounds.maxSnapshotRows),
            )
            "snapshot_page" -> RosterFrame.SnapshotPage(
                subscriptionId = id("subscriptionId"),
                transferId = id("transferId"),
                pageIndex = readInteger(record["pageIndex"], 0L, bounds.maxSnapshotRows),
                rows = readRows(record["rows"], bounds),
            )
            "snapshot_end" -> RosterFrame.SnapshotEnd(
                subscriptionId = id("subscriptionId"),
                transferId = id("transferId"),
                revision = readInteger(record["revision"], 1L, MAX_SAFE_INTEGER),
                totalRows = readInteger(record["totalRows"], 0L, bounds.maxSnapshotRows),
            )
            "close_request" -> RosterFrame.CloseRequest(
                requestId = id("requestId"),
                hostRunId = id("hostRunId"),
                rowId = id("rowId"),
                confirmed = readBoolean(record["confirmed"]),
            )
            "close_result" -> RosterFrame.CloseResult(id("requestId"), readCloseOutcome(record["outcome"]))
            "create_request" -> RosterFrame.CreateRequest(
                requestId = id("requestId"),
                hostRunId = id("hostRunId"),
                workspace = readWorkspace(record["workspace"]),
                sequence = readInteger(record["sequence"], 1L, MAX_SAFE_INTEGER),
            )
            "create_result" -> RosterFrame.CreateResult(id("requestId"), readCreateOutcome(record["outcome"], bounds))
            "rename_request" -> RosterFrame.RenameRequest(
                requestId = id("requestId"),
                hostRunId = id("hostRunId"),
                rowId = id("rowId"),
                expectedSessionId = readNativeSessionId(record["expectedSessionId"]),
                expectedSessionEpoch = readInteger(record["expectedSessionEpoch"], 1L, MAX_SAFE_INTEGER),
                name = readRenameName(record["name"]),
                sequence = readInteger(record["sequence"], 1L, MAX_SAFE_INTEGER),
            )
            "rename_result" -> RosterFrame.RenameResult(id("requestId"), readRenameOutcome(record["outcome"]))
            "saved_policy" -> RosterFrame.SavedPolicy(
                hostRunId = id("hostRunId"),
                deleteExposed = readBoolean(record["deleteExposed"]),
            )
            "error" -> {
                val wireCode = stringOf(record["code"])?.let { RosterWireErrorCode.fromWireName(it) }
                    ?: fail(RosterFailureCode.BAD_FRAME)
                // A present-but-null subscription id is refused; only an absent one
                // means "this failure belongs to no subscription".
                val subscriptionId = if (record.containsKey("subscriptionId")) {
                    readIdentifier(record["subscriptionId"], bounds)
                } else {
                    null
                }
                RosterFrame.Failure(wireCode, subscriptionId)
            }
            else -> buildSavedFrame(type, record, bounds)
        }
    }

    // ----------------------------------------------------------- field readers

    private fun stringOf(element: JsonElement?): String? =
        (element as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun readIdentifier(element: JsonElement?, bounds: RosterBounds): String {
        val value = stringOf(element) ?: fail(RosterFailureCode.BAD_FRAME)
        if (!RosterText.isIdentifier(value, bounds.maxIdentifierBytes)) fail(RosterFailureCode.BAD_FRAME)
        return value
    }

    private fun readService(element: JsonElement?): String {
        val value = stringOf(element) ?: fail(RosterFailureCode.BAD_FRAME)
        if (value.isEmpty()) fail(RosterFailureCode.BAD_FRAME)
        if (RosterJson.utf8Length(value) > MAX_SERVICE_BYTES) fail(RosterFailureCode.BAD_FRAME)
        if (RosterText.isUnsafeText(value)) fail(RosterFailureCode.BAD_FRAME)
        return value
    }

    /**
     * A JSON number read with the source's exact-integer rule: a number literal
     * (never a string), finite, integral, inside the safe-integer range, and inside
     * the requested bounds. A value spelled in exponent form is the same number, so
     * it is accepted when it denotes an integer in range.
     */
    private fun readInteger(element: JsonElement?, min: Long, max: Long): Long {
        val primitive = element as? JsonPrimitive ?: fail(RosterFailureCode.BAD_FRAME)
        if (primitive.isString) fail(RosterFailureCode.BAD_FRAME)
        val asDouble = primitive.content.toDoubleOrNull() ?: fail(RosterFailureCode.BAD_FRAME)
        if (asDouble.isNaN() || asDouble.isInfinite()) fail(RosterFailureCode.BAD_FRAME)
        if (asDouble != Math.floor(asDouble)) fail(RosterFailureCode.BAD_FRAME)
        if (asDouble < -MAX_SAFE_INTEGER.toDouble() || asDouble > MAX_SAFE_INTEGER.toDouble()) {
            fail(RosterFailureCode.BAD_FRAME)
        }
        val value = asDouble.toLong()
        if (value < min || value > max) fail(RosterFailureCode.BAD_FRAME)
        return value
    }

    /**
     * A real JSON boolean. A quoted "true" or "false" is a string and is refused:
     * the source decoder tests the JSON type, and so does this one.
     */
    private fun readBoolean(element: JsonElement?): Boolean {
        val primitive = element as? JsonPrimitive ?: fail(RosterFailureCode.BAD_FRAME)
        if (primitive.isString) fail(RosterFailureCode.BAD_FRAME)
        return primitive.booleanOrNull ?: fail(RosterFailureCode.BAD_FRAME)
    }

    private fun readCapabilities(element: JsonElement?, bounds: RosterBounds): List<String> {
        val array = element as? JsonArray ?: fail(RosterFailureCode.BAD_FRAME)
        if (array.size.toLong() > bounds.maxCapabilities) fail(RosterFailureCode.BAD_FRAME)
        val seen = mutableSetOf<String>()
        return array.map { entry ->
            val value = stringOf(entry) ?: fail(RosterFailureCode.BAD_FRAME)
            if (RosterJson.utf8Length(value) > bounds.maxCapabilityIdBytes) fail(RosterFailureCode.BAD_FRAME)
            if (!RosterText.IDENTIFIER_RE.matches(value)) fail(RosterFailureCode.BAD_FRAME)
            if (!seen.add(value)) fail(RosterFailureCode.BAD_FRAME)
            value
        }
    }

    /** One canonical workspace: the New form's own rule, applied verbatim. */
    private fun readWorkspace(element: JsonElement?): String {
        val value = stringOf(element) ?: fail(RosterFailureCode.BAD_FRAME)
        if (!RosterText.isCreateWorkspace(value)) fail(RosterFailureCode.BAD_FRAME)
        return value
    }

    /** A canonical native conversation id: the native rule, not the lane's token class. */
    private fun readNativeSessionId(element: JsonElement?): String {
        val value = stringOf(element) ?: fail(RosterFailureCode.BAD_FRAME)
        if (!RosterText.isNativeSessionId(value)) fail(RosterFailureCode.BAD_FRAME)
        return value
    }

    /** A canonical native rename name: the stored-name rule, never trimmed or clipped. */
    private fun readRenameName(element: JsonElement?): String {
        val value = stringOf(element) ?: fail(RosterFailureCode.BAD_FRAME)
        if (!RosterText.isRenameName(value)) fail(RosterFailureCode.BAD_FRAME)
        return value
    }

    /**
     * The row boundary owns every field rule; a refusal here means an invalid,
     * private-field-bearing, or oversized row, and the whole frame is refused.
     */
    private fun readRows(element: JsonElement?, bounds: RosterBounds): List<RemoteSessionMetadata> {
        val array = element as? JsonArray ?: fail(RosterFailureCode.BAD_FRAME)
        if (array.size.toLong() > bounds.maxRowsPerPage) fail(RosterFailureCode.BAD_FRAME)
        return array.map { row -> RosterMetadataRow.parse(row) ?: fail(RosterFailureCode.BAD_FRAME) }
    }

    /** The closed fact set of one owner close: exactly one `kind`, nothing else. */
    private fun readCloseOutcome(element: JsonElement?): OwnerCloseFacts {
        val record = element as? JsonObject ?: fail(RosterFailureCode.BAD_FRAME)
        if (record.keys != setOf("kind")) fail(RosterFailureCode.BAD_FRAME)
        return OwnerCloseFacts.fromWireName(stringOf(record["kind"]) ?: fail(RosterFailureCode.BAD_FRAME))
            ?: fail(RosterFailureCode.BAD_FRAME)
    }

    /** The closed fact set of one owner create: one kind, and for `started` its ids. */
    private fun readCreateOutcome(element: JsonElement?, bounds: RosterBounds): OwnerCreateFacts {
        val record = element as? JsonObject ?: fail(RosterFailureCode.BAD_FRAME)
        val kind = stringOf(record["kind"]) ?: fail(RosterFailureCode.BAD_FRAME)
        return when (kind) {
            "started" -> {
                if (record.keys != setOf("kind", "hostRunId", "rowId")) fail(RosterFailureCode.BAD_FRAME)
                OwnerCreateFacts.Started(
                    hostRunId = readIdentifier(record["hostRunId"], bounds),
                    rowId = readIdentifier(record["rowId"], bounds),
                )
            }
            "unconfirmed" -> singleKindOutcome(record, kind) { OwnerCreateFacts.Unconfirmed }
            "refused" -> singleKindOutcome(record, kind) { OwnerCreateFacts.Refused }
            "unknown" -> singleKindOutcome(record, kind) { OwnerCreateFacts.Unknown }
            else -> fail(RosterFailureCode.BAD_FRAME)
        }
    }

    /** The closed fact set of one owner rename: one fixed kind, never a name. */
    private fun readRenameOutcome(element: JsonElement?): OwnerRenameFacts {
        val record = element as? JsonObject ?: fail(RosterFailureCode.BAD_FRAME)
        if (record.keys != setOf("kind")) fail(RosterFailureCode.BAD_FRAME)
        return OwnerRenameFacts.fromWireName(stringOf(record["kind"]) ?: fail(RosterFailureCode.BAD_FRAME))
            ?: fail(RosterFailureCode.BAD_FRAME)
    }

    private fun <T> singleKindOutcome(record: JsonObject, kind: String, build: () -> T): T {
        if (record.keys != setOf("kind")) fail(RosterFailureCode.BAD_FRAME)
        return build()
    }

    // ------------------------------------------------------------ saved frames

    /**
     * Build one Saved frame from a closed-key record. Every field is read through
     * its own rule, so this side can never encode a Saved frame its peer would
     * refuse.
     */
    private fun buildSavedFrame(type: String, record: JsonObject, bounds: RosterBounds): RosterFrame {
        fun id(key: String): String = readIdentifier(record[key], bounds)
        val cap = bounds.savedWindowMaxFrames
        return when (type) {
            "saved_list_request" -> RosterFrame.SavedListRequest(
                requestId = id("requestId"),
                hostRunId = id("hostRunId"),
                query = readSavedQuery(record["query"]),
                offset = readInteger(record["offset"], 0L, MAX_SAFE_INTEGER),
                count = readInteger(record["count"], 1L, bounds.maxSnapshotRows),
                sequence = readInteger(record["sequence"], 1L, MAX_SAFE_INTEGER),
            )
            "saved_search_request" -> RosterFrame.SavedSearchRequest(
                requestId = id("requestId"),
                hostRunId = id("hostRunId"),
                catalogId = id("catalogId"),
                query = readSavedQuery(record["query"]),
                offset = readInteger(record["offset"], 0L, MAX_SAFE_INTEGER),
                count = readInteger(record["count"], 1L, bounds.maxSnapshotRows),
                sequence = readInteger(record["sequence"], 1L, MAX_SAFE_INTEGER),
            )
            "saved_window_request" -> RosterFrame.SavedWindowRequest(
                requestId = id("requestId"),
                hostRunId = id("hostRunId"),
                catalogId = id("catalogId"),
                resultId = id("resultId"),
                offset = readInteger(record["offset"], 0L, MAX_SAFE_INTEGER),
                count = readInteger(record["count"], 1L, bounds.maxSnapshotRows),
                sequence = readInteger(record["sequence"], 1L, MAX_SAFE_INTEGER),
            )
            "saved_resume_request" -> RosterFrame.SavedResumeRequest(
                requestId = id("requestId"),
                hostRunId = id("hostRunId"),
                catalogId = id("catalogId"),
                resultId = id("resultId"),
                entryId = id("entryId"),
                sequence = readInteger(record["sequence"], 1L, MAX_SAFE_INTEGER),
            )
            "saved_delete_request" -> RosterFrame.SavedDeleteRequest(
                requestId = id("requestId"),
                hostRunId = id("hostRunId"),
                catalogId = id("catalogId"),
                resultId = id("resultId"),
                entryId = id("entryId"),
                confirmed = readBoolean(record["confirmed"]),
                sequence = readInteger(record["sequence"], 1L, MAX_SAFE_INTEGER),
            )
            "saved_window_result" -> RosterFrame.SavedWindowResult(
                requestId = id("requestId"),
                outcome = readSavedWindowOutcome(record["outcome"]),
            )
            "saved_window_begin" -> {
                val total = readInteger(record["total"], 0L, MAX_SAFE_INTEGER)
                val offset = readInteger(record["offset"], 0L, MAX_SAFE_INTEGER)
                // A window can never run past the full total it states.
                if (offset > total) fail(RosterFailureCode.BAD_FRAME)
                val rows = readInteger(record["rows"], 0L, bounds.maxSnapshotRows)
                if (rows > total - offset) fail(RosterFailureCode.BAD_FRAME)
                RosterFrame.SavedWindowBegin(
                    requestId = id("requestId"),
                    hostRunId = id("hostRunId"),
                    catalogId = id("catalogId"),
                    resultId = id("resultId"),
                    total = total,
                    issueCount = readInteger(record["issueCount"], 0L, MAX_SAFE_INTEGER),
                    offset = offset,
                    rows = rows,
                    pageCount = readSavedPageCount(record["pageCount"], rows, bounds),
                )
            }
            "saved_window_page" -> RosterFrame.SavedWindowPage(
                requestId = id("requestId"),
                pageIndex = readInteger(record["pageIndex"], 0L, cap),
                entries = readSavedEntries(record["entries"], bounds),
            )
            "saved_window_fragment" -> {
                val parts = readInteger(record["parts"], 1L, cap)
                val part = readInteger(record["part"], 0L, cap)
                if (part >= parts) fail(RosterFailureCode.BAD_FRAME)
                RosterFrame.SavedWindowFragment(
                    requestId = id("requestId"),
                    pageIndex = readInteger(record["pageIndex"], 0L, cap),
                    part = part,
                    parts = parts,
                    text = readSavedFragmentText(record["text"]),
                )
            }
            "saved_window_end" -> {
                val rows = readInteger(record["rows"], 0L, bounds.maxSnapshotRows)
                RosterFrame.SavedWindowEnd(
                    requestId = id("requestId"),
                    rows = rows,
                    pageCount = readSavedPageCount(record["pageCount"], rows, bounds),
                )
            }
            "saved_resume_result" -> RosterFrame.SavedResumeResult(
                requestId = id("requestId"),
                outcome = readSavedResumeOutcome(record["outcome"], bounds),
            )
            "saved_delete_result" -> RosterFrame.SavedDeleteResult(
                requestId = id("requestId"),
                outcome = readSavedDeleteOutcome(record["outcome"]),
            )
            else -> fail(RosterFailureCode.BAD_FRAME)
        }
    }

    /** Exact query text: well-formed Unicode, never trimmed, normalized, or capped. */
    private fun readSavedQuery(element: JsonElement?): String {
        val value = stringOf(element) ?: fail(RosterFailureCode.BAD_FRAME)
        if (!RosterText.isWellFormedUnicode(value)) fail(RosterFailureCode.BAD_FRAME)
        return value
    }

    /**
     * One closed entry, field by field. The owner's native session id, saved file,
     * caption, and working directory are carried whole and exactly: the only rule
     * is that each is a well-formed string, so no legal row is clipped, hidden, or
     * refused here. Anything outside the closed key set is refused.
     */
    private fun readSavedEntry(element: JsonElement?, bounds: RosterBounds): OwnerSavedEntry {
        val record = element as? JsonObject ?: fail(RosterFailureCode.BAD_FRAME)
        if (record.keys != OwnerSavedEntry.KEYS.toSet()) fail(RosterFailureCode.BAD_FRAME)
        val entryId = readIdentifier(record["entryId"], bounds)
        val sessionId = readSavedText(record["sessionId"])
        val file = readSavedText(record["file"])
        val caption = readSavedText(record["caption"])
        val cwd = readSavedText(record["cwd"])
        return OwnerSavedEntry(entryId, sessionId, file, caption, cwd)
    }

    /** One native Saved display string: any well-formed Unicode text. */
    private fun readSavedText(element: JsonElement?): String {
        val value = stringOf(element) ?: fail(RosterFailureCode.BAD_FRAME)
        if (!RosterText.isWellFormedUnicode(value)) fail(RosterFailureCode.BAD_FRAME)
        return value
    }

    /** One page of entries: bounded by the page row bound, ids unique within it. */
    private fun readSavedEntries(element: JsonElement?, bounds: RosterBounds): List<OwnerSavedEntry> {
        val array = element as? JsonArray ?: fail(RosterFailureCode.BAD_FRAME)
        if (array.size.toLong() > bounds.maxRowsPerPage) fail(RosterFailureCode.BAD_FRAME)
        val seen = mutableSetOf<String>()
        return array.map { raw ->
            val entry = readSavedEntry(raw, bounds)
            if (!seen.add(entry.entryId)) fail(RosterFailureCode.BAD_FRAME)
            entry
        }
    }

    /**
     * Frame count (pages plus fragments) coherent with the honest row count: none
     * for an empty window, at least enough pages for the rows, and never beyond the
     * derived Saved frame cap.
     */
    private fun readSavedPageCount(element: JsonElement?, rows: Long, bounds: RosterBounds): Long {
        val pageCount = readInteger(element, 0L, bounds.savedWindowMaxFrames)
        if (rows == 0L) {
            if (pageCount != 0L) fail(RosterFailureCode.BAD_FRAME)
            return pageCount
        }
        val minimum = (rows + bounds.maxRowsPerPage - 1) / bounds.maxRowsPerPage
        if (pageCount < minimum) fail(RosterFailureCode.BAD_FRAME)
        return pageCount
    }

    /** Fragment text: one non-empty, well-formed slice of a canonical entry encoding. */
    private fun readSavedFragmentText(element: JsonElement?): String {
        val value = stringOf(element) ?: fail(RosterFailureCode.BAD_FRAME)
        if (value.isEmpty() || !RosterText.isWellFormedUnicode(value)) fail(RosterFailureCode.BAD_FRAME)
        return value
    }

    /** One fixed non-data Saved window answer and nothing else. */
    private fun readSavedWindowOutcome(element: JsonElement?): OwnerSavedWindowOutcome {
        val record = element as? JsonObject ?: fail(RosterFailureCode.BAD_FRAME)
        return when (val kind = stringOf(record["kind"])) {
            "unavailable", "unknown" -> {
                if (record.keys != setOf("kind")) fail(RosterFailureCode.BAD_FRAME)
                if (kind == "unavailable") OwnerSavedWindowOutcome.Unavailable else OwnerSavedWindowOutcome.Unknown
            }
            "refused" -> when (record.keys) {
                setOf("kind") -> OwnerSavedWindowOutcome.Refused()
                setOf("kind", "reason") -> OwnerSavedWindowOutcome.Refused(
                    SavedWindowRefusalReason.fromWireName(
                        stringOf(record["reason"]) ?: fail(RosterFailureCode.BAD_FRAME),
                    ) ?: fail(RosterFailureCode.BAD_FRAME),
                )
                else -> fail(RosterFailureCode.BAD_FRAME)
            }
            else -> fail(RosterFailureCode.BAD_FRAME)
        }
    }

    /** One fixed Saved resume fact set and nothing else. */
    private fun readSavedResumeOutcome(element: JsonElement?, bounds: RosterBounds): OwnerSavedResumeFacts {
        val record = element as? JsonObject ?: fail(RosterFailureCode.BAD_FRAME)
        return when (val kind = stringOf(record["kind"])) {
            "started" -> {
                if (record.keys != setOf("kind", "hostRunId", "rowId")) fail(RosterFailureCode.BAD_FRAME)
                OwnerSavedResumeFacts.Started(
                    hostRunId = readIdentifier(record["hostRunId"], bounds),
                    rowId = readIdentifier(record["rowId"], bounds),
                )
            }
            "refused" -> {
                if (record.keys != setOf("kind", "reason")) fail(RosterFailureCode.BAD_FRAME)
                OwnerSavedResumeFacts.Refused(
                    SavedResumeRefusalReason.fromWireName(
                        stringOf(record["reason"]) ?: fail(RosterFailureCode.BAD_FRAME),
                    ) ?: fail(RosterFailureCode.BAD_FRAME),
                )
            }
            "unconfirmed", "unknown" -> {
                if (record.keys != setOf("kind")) fail(RosterFailureCode.BAD_FRAME)
                if (kind == "unconfirmed") OwnerSavedResumeFacts.Unconfirmed else OwnerSavedResumeFacts.Unknown
            }
            else -> fail(RosterFailureCode.BAD_FRAME)
        }
    }

    /** One fixed Saved delete fact set and nothing else. */
    private fun readSavedDeleteOutcome(element: JsonElement?): OwnerSavedDeleteFacts {
        val record = element as? JsonObject ?: fail(RosterFailureCode.BAD_FRAME)
        return when (val kind = stringOf(record["kind"])) {
            "confirmation-required", "unconfirmed", "unknown" -> {
                if (record.keys != setOf("kind")) fail(RosterFailureCode.BAD_FRAME)
                when (kind) {
                    "confirmation-required" -> OwnerSavedDeleteFacts.ConfirmationRequired
                    "unconfirmed" -> OwnerSavedDeleteFacts.Unconfirmed
                    else -> OwnerSavedDeleteFacts.Unknown
                }
            }
            "deleted" -> {
                if (record.keys != setOf("kind", "method")) fail(RosterFailureCode.BAD_FRAME)
                OwnerSavedDeleteFacts.Deleted(
                    SavedDeleteMethod.fromWireName(
                        stringOf(record["method"]) ?: fail(RosterFailureCode.BAD_FRAME),
                    ) ?: fail(RosterFailureCode.BAD_FRAME),
                )
            }
            "refused" -> {
                if (record.keys != setOf("kind", "reason")) fail(RosterFailureCode.BAD_FRAME)
                OwnerSavedDeleteFacts.Refused(
                    SavedDeleteRefusalReason.fromWireName(
                        stringOf(record["reason"]) ?: fail(RosterFailureCode.BAD_FRAME),
                    ) ?: fail(RosterFailureCode.BAD_FRAME),
                )
            }
            else -> fail(RosterFailureCode.BAD_FRAME)
        }
    }
}
