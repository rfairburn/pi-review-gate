package io.github.rfairburn.pireviewgate.core.protocol.roster

import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Synthetic fixtures shaped exactly like the source protocol's own test vectors.
 *
 * Every value here is invented for these tests: no live owner run, row, workspace,
 * saved entry, or credential appears anywhere in this file. Canonical wire text is
 * written by hand, in the source's key order, so an encoder that reorders or
 * defaults a field is caught rather than agreed with.
 */
internal object RosterFixtures {
    const val HOST_RUN_ID = "11111111-1111-4111-8111-111111111111"
    const val SUBSCRIPTION_ID = "sub-1"
    const val TRANSFER_ID = "t-1"
    const val REQUEST_ID = "req-1"
    const val CATALOG_ID = "cat-1"
    const val RESULT_ID = "res-1"
    const val ENTRY_ID = "entry-0"

    const val SECRET_AGENT_DIR = "/Users/owner/.pi/agent"
    const val SECRET_CURRENT_FILE = "/Users/owner/src/private/secret-file.ts"

    /** The handshake this lane accepts, in canonical text. */
    fun helloJson(
        capabilities: List<String> = listOf(
            RosterWire.REQUIRED_CAPABILITY,
            RosterWire.CLOSE_CAPABILITY,
            RosterWire.CREATE_CAPABILITY,
            RosterWire.SAVED_CAPABILITY,
            RosterWire.RENAME_CAPABILITY,
            RosterWire.ROSTER_SLOT_CAPABILITY,
        ),
    ): String =
        """{"type":"hello","service":"${RosterWire.SERVICE}","major":${RosterWire.MAJOR},""" +
            """"minor":${RosterWire.MINOR},"capabilities":[${capabilities.joinToString(",") { "\"$it\"" }}]}"""

    fun hello(capabilities: List<String> = listOf(
        RosterWire.REQUIRED_CAPABILITY,
        RosterWire.CLOSE_CAPABILITY,
        RosterWire.CREATE_CAPABILITY,
        RosterWire.SAVED_CAPABILITY,
        RosterWire.RENAME_CAPABILITY,
        RosterWire.ROSTER_SLOT_CAPABILITY,
    )): RosterFrame.Hello = RosterFrame.Hello(RosterWire.SERVICE, RosterWire.MAJOR, RosterWire.MINOR, capabilities)

    /**
     * A roster row in canonical wire form: the closed key set in the source's order,
     * with every optional observation present and null. This is the exact text an
     * encoder of the same model must produce.
     */
    fun rowJson(id: String = "row-1"): String =
        """{"id":"$id","label":"Row $id","workspace":"/srv/owner/work-$id","lifecycle":"alive",""" +
            """"hasLiveProcess":true,"busy":null,"pendingInput":null,"inputSurface":false,""" +
            """"activity":["Running tests"],""" +
            """"nativeSession":{"sessionId":"conversation-$id","epoch":2,"name":"Conversation $id"},""" +
            """"backgroundTasks":null,"backgroundShells":null,"activeTasks":null,"activeShells":null}"""

    /**
     * The same row with only the keys this boundary always requires. Tests append one
     * optional member at a time to this, so no key is ever written twice.
     */
    fun bareRowJson(id: String = "row-1"): String =
        """{"id":"$id","label":"Row $id","workspace":"/srv/owner/work-$id","lifecycle":"alive",""" +
            """"hasLiveProcess":true,"inputSurface":false,"activity":["Running tests"],""" +
            """"nativeSession":{"sessionId":"conversation-$id","epoch":2,"name":"Conversation $id"}}"""

    /** The same row as this side models it. */
    fun row(id: String = "row-1"): RemoteSessionMetadata = RemoteSessionMetadata(
        id = id,
        label = "Row $id",
        workspace = "/srv/owner/work-$id",
        lifecycle = RosterLifecycle.ALIVE,
        hasLiveProcess = true,
        inputSurface = false,
        busy = null,
        pendingInput = null,
        activity = listOf("Running tests"),
        nativeSession = RemoteNativeSession(
            sessionId = "conversation-$id",
            epoch = 2L,
            name = "Conversation $id",
        ),
        backgroundTasks = null,
        backgroundShells = null,
        activeTasks = null,
        activeShells = null,
    )

    /** A row where the owner observed everything, including a slot and an exit code. */
    fun observedRowJson(id: String = "row-3"): String {
        val suffix = id.substringAfterLast('-')
        return """{"id":"$id","rosterSlotId":"slot-$suffix","label":"Conversation $id",""" +
            """"workspace":"/srv/owner/work-$id","lifecycle":"exited","hasLiveProcess":true,"busy":false,""" +
            """"pendingInput":true,"inputSurface":true,"activity":["Running tests","Reading 12 files"],""" +
            """"nativeSession":{"sessionId":"native-session-$suffix","epoch":9,"name":"Renamed conversation $suffix",""" +
            """"persistence":"saved"},"backgroundTasks":0,"backgroundShells":1,"activeTasks":7,"activeShells":4,""" +
            """"exitCode":130,"error":"worker exited with code 130"}"""
    }

    /** The same observed row as this side models it. */
    fun observedRow(id: String = "row-3"): RemoteSessionMetadata {
        val suffix = id.substringAfterLast('-')
        return RemoteSessionMetadata(
            id = id,
            label = "Conversation $id",
            workspace = "/srv/owner/work-$id",
            lifecycle = RosterLifecycle.EXITED,
            hasLiveProcess = true,
            inputSurface = true,
            rosterSlotId = "slot-$suffix",
            busy = false,
            pendingInput = true,
            activity = listOf("Running tests", "Reading 12 files"),
            nativeSession = RemoteNativeSession(
                sessionId = "native-session-$suffix",
                epoch = 9L,
                name = "Renamed conversation $suffix",
                persistence = RemoteNativePersistence.SAVED,
            ),
            backgroundTasks = 0L,
            backgroundShells = 1L,
            activeTasks = 7L,
            activeShells = 4L,
            exitCode = 130.0,
            error = "worker exited with code 130",
        )
    }

    /** One snapshot page frame in canonical text, carrying the given row texts. */
    fun snapshotPageJson(rows: String = "${rowJson("row-1")},${rowJson("row-2")},${observedRowJson("row-3")}"): String =
        """{"type":"snapshot_page","subscriptionId":"$SUBSCRIPTION_ID","transferId":"$TRANSFER_ID",""" +
            """"pageIndex":0,"rows":[$rows]}"""

    /** The same page as this side models it. */
    fun snapshotPage(): RosterFrame.SnapshotPage = RosterFrame.SnapshotPage(
        subscriptionId = SUBSCRIPTION_ID,
        transferId = TRANSFER_ID,
        pageIndex = 0L,
        rows = listOf(row("row-1"), row("row-2"), observedRow("row-3")),
    )

    /** One Saved catalog entry in wire form, with the closed key set in order. */
    fun savedEntryJson(index: Int = 0): String =
        """{"entryId":"entry-$index","sessionId":"0190a1b2-0000-7000-8000-00000000000$index",""" +
            """"file":"/srv/owner/agent/sessions/--srv-owner--/2026-10-22T00-00-00-000Z_$index.jsonl",""" +
            """"caption":"Saved $index","cwd":"/srv/owner/project $index"}"""

    fun savedEntry(index: Int = 0): OwnerSavedEntry = OwnerSavedEntry(
        entryId = "entry-$index",
        sessionId = "0190a1b2-0000-7000-8000-00000000000$index",
        file = "/srv/owner/agent/sessions/--srv-owner--/2026-10-22T00-00-00-000Z_$index.jsonl",
        caption = "Saved $index",
        cwd = "/srv/owner/project $index",
    )

    /** One Saved window page frame, with the closed key set in canonical order. */
    fun savedWindowPageJson(entries: String = savedEntryJson(0)): String =
        """{"type":"saved_window_page","requestId":"$REQUEST_ID","pageIndex":0,"entries":[$entries]}"""

    /** One JSON string literal, so a test can carry exact text without escaping games. */
    fun jsonText(value: String): String = JsonPrimitive(value).toString()

    /** One representative frame of every kind this lane carries. */
    fun allFrames(): List<RosterFrame> = listOf(
        hello(),
        RosterFrame.HelloAck(RosterWire.SERVICE, RosterWire.MAJOR, 0L, listOf(RosterWire.REQUIRED_CAPABILITY)),
        RosterFrame.Subscribe(SUBSCRIPTION_ID),
        RosterFrame.Unsubscribe(SUBSCRIPTION_ID),
        RosterFrame.Unsubscribed(SUBSCRIPTION_ID),
        RosterFrame.SnapshotBegin(SUBSCRIPTION_ID, TRANSFER_ID, HOST_RUN_ID, 7L, 2L, 1L),
        snapshotPage(),
        RosterFrame.SnapshotEnd(SUBSCRIPTION_ID, TRANSFER_ID, 7L, 2L),
        RosterFrame.CloseRequest(REQUEST_ID, HOST_RUN_ID, "row-1", confirmed = true),
        RosterFrame.CloseResult(REQUEST_ID, OwnerCloseFacts.REMOVED),
        RosterFrame.CreateRequest(REQUEST_ID, HOST_RUN_ID, "/srv/owner/workspace", 1L),
        RosterFrame.CreateResult(REQUEST_ID, OwnerCreateFacts.Started(HOST_RUN_ID, "row-9")),
        RosterFrame.RenameRequest(REQUEST_ID, HOST_RUN_ID, "row-1", "native-session-1", 4L, "Renamed", 1L),
        RosterFrame.RenameResult(REQUEST_ID, OwnerRenameFacts.RENAMED),
        RosterFrame.SavedListRequest(REQUEST_ID, HOST_RUN_ID, "recent", 0L, 25L, 1L),
        RosterFrame.SavedSearchRequest(REQUEST_ID, HOST_RUN_ID, CATALOG_ID, "deploy", 0L, 25L, 1L),
        RosterFrame.SavedWindowRequest(REQUEST_ID, HOST_RUN_ID, CATALOG_ID, RESULT_ID, 0L, 25L, 1L),
        RosterFrame.SavedResumeRequest(REQUEST_ID, HOST_RUN_ID, CATALOG_ID, RESULT_ID, ENTRY_ID, 1L),
        RosterFrame.SavedDeleteRequest(REQUEST_ID, HOST_RUN_ID, CATALOG_ID, RESULT_ID, ENTRY_ID, confirmed = true, sequence = 1L),
        RosterFrame.SavedWindowBegin(REQUEST_ID, HOST_RUN_ID, CATALOG_ID, RESULT_ID, 1200L, 2L, 0L, 1L, 1L),
        RosterFrame.SavedWindowPage(REQUEST_ID, 0L, listOf(savedEntry(0))),
        RosterFrame.SavedWindowFragment(REQUEST_ID, 0L, 0L, 1L, savedEntryJson(0)),
        RosterFrame.SavedWindowEnd(REQUEST_ID, 1L, 1L),
        RosterFrame.SavedWindowResult(
            REQUEST_ID,
            OwnerSavedWindowOutcome.Refused(SavedWindowRefusalReason.STALE),
        ),
        RosterFrame.SavedResumeResult(REQUEST_ID, OwnerSavedResumeFacts.Started(HOST_RUN_ID, "row-9")),
        RosterFrame.SavedDeleteResult(REQUEST_ID, OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)),
        RosterFrame.SavedPolicy(HOST_RUN_ID, deleteExposed = true),
        RosterFrame.Failure(RosterWireErrorCode.ROW_UNREPRESENTABLE),
        RosterFrame.Failure(RosterWireErrorCode.SNAPSHOT_TOO_LARGE, SUBSCRIPTION_ID),
    )
}

/** Assert one decode is refused with exactly this fixed code. */
internal fun assertDecodeRefused(bytes: ByteArray, code: RosterFailureCode) {
    val failure = runCatching { RosterProtocol.decode(bytes) }.exceptionOrNull()
    assertTrue(failure is RosterProtocolException, "expected a fixed-code refusal, got $failure")
    assertEquals(code, (failure as RosterProtocolException).code)
}

/** Assert one JSON message is refused as a bad frame. */
internal fun assertBadFrame(json: String) = assertDecodeRefused(json.encodeToByteArray(), RosterFailureCode.BAD_FRAME)

/** Assert one frame this side built is refused at encode time. */
internal fun assertEncodeRefused(frame: RosterFrame, code: RosterFailureCode = RosterFailureCode.INVALID_FRAME) {
    val failure = runCatching { RosterProtocol.encode(frame) }.exceptionOrNull()
    assertTrue(failure is RosterProtocolException, "expected a fixed-code refusal, got $failure")
    assertEquals(code, (failure as RosterProtocolException).code)
}

/** Decode, re-encode, and decode again: a representable frame must survive whole. */
internal fun assertRoundTrip(json: String): RosterFrame {
    val bytes = json.encodeToByteArray()
    val decoded = RosterProtocol.decode(bytes)
    val reEncoded = RosterProtocol.encode(decoded)
    assertEquals(decoded, RosterProtocol.decode(reEncoded))
    return decoded
}
