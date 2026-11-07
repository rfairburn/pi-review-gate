package io.github.rfairburn.pireviewgate.core.protocol.roster

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

/**
 * Decoding of the roster lane's frames.
 *
 * Each positive case is written from the source contract's own wire shape, and each
 * frame is then encoded again and decoded once more: the model must be stable, and an
 * absent nullable field must stay absent rather than become a default.
 */
class RosterFrameDecodeTest {

    @Test
    fun `decodes a hello and keeps its announced capabilities`() {
        val frame = RosterProtocol.decode(RosterFixtures.helloJson().encodeToByteArray())
        assertEquals(RosterFixtures.hello(), frame)
        assertEquals(RosterFixtures.helloJson(), RosterProtocol.encode(frame).decodeToString())
    }

    @Test
    fun `decodes a hello ack with a narrowed capability list`() {
        assertEquals(
            RosterFrame.HelloAck(
                service = RosterWire.SERVICE,
                major = RosterWire.MAJOR,
                minor = 0L,
                capabilities = listOf(RosterWire.REQUIRED_CAPABILITY),
            ),
            RosterProtocol.decode(
                ("""{"type":"hello_ack","service":"${RosterWire.SERVICE}","major":1,"minor":0,""" +
                    """"capabilities":["roster-v1"]}""").encodeToByteArray(),
            ),
        )
    }

    @Test
    fun `decodes the subscription handshake frames`() {
        assertEquals(
            RosterFrame.Subscribe(RosterFixtures.SUBSCRIPTION_ID),
            RosterProtocol.decode(
                """{"type":"subscribe","subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}"}""".encodeToByteArray(),
            ),
        )
        assertEquals(
            RosterFrame.Unsubscribe(RosterFixtures.SUBSCRIPTION_ID),
            RosterProtocol.decode(
                """{"type":"unsubscribe","subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}"}"""
                    .encodeToByteArray(),
            ),
        )
        assertEquals(
            RosterFrame.Unsubscribed(RosterFixtures.SUBSCRIPTION_ID),
            RosterProtocol.decode(
                """{"type":"unsubscribed","subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}"}"""
                    .encodeToByteArray(),
            ),
        )
    }

    @Test
    fun `decodes a snapshot transfer as its own three frames`() {
        assertEquals(
            RosterFrame.SnapshotBegin(
                subscriptionId = RosterFixtures.SUBSCRIPTION_ID,
                transferId = RosterFixtures.TRANSFER_ID,
                hostRunId = RosterFixtures.HOST_RUN_ID,
                revision = 7L,
                totalRows = 2L,
                pageCount = 1L,
            ),
            RosterProtocol.decode(beginJson()),
        )

        val page = RosterProtocol.decode(RosterFixtures.snapshotPageJson().encodeToByteArray())
        val snapshotPage = assertIs<RosterFrame.SnapshotPage>(page)
        assertEquals(RosterFixtures.SUBSCRIPTION_ID, snapshotPage.subscriptionId)
        assertEquals(RosterFixtures.TRANSFER_ID, snapshotPage.transferId)
        assertEquals(0L, snapshotPage.pageIndex)
        assertEquals(
            listOf(
                RosterFixtures.row("row-1"),
                RosterFixtures.row("row-2"),
                RosterFixtures.observedRow("row-3"),
            ),
            snapshotPage.rows,
        )
        assertEquals(RosterFixtures.snapshotPageJson(), RosterProtocol.encode(page).decodeToString())

        assertEquals(
            RosterFrame.SnapshotEnd(
                subscriptionId = RosterFixtures.SUBSCRIPTION_ID,
                transferId = RosterFixtures.TRANSFER_ID,
                revision = 7L,
                totalRows = 2L,
            ),
            RosterProtocol.decode(
                ("""{"type":"snapshot_end","subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}",""" +
                    """"transferId":"${RosterFixtures.TRANSFER_ID}","revision":7,"totalRows":2}""").encodeToByteArray()
            ),
        )
    }

    @Test
    fun `decodes a close request and every fact the owner can establish`() {
        assertEquals(
            RosterFrame.CloseRequest(
                requestId = RosterFixtures.REQUEST_ID,
                hostRunId = RosterFixtures.HOST_RUN_ID,
                rowId = "row-1",
                confirmed = true,
            ),
            RosterProtocol.decode(
                ("""{"type":"close_request","requestId":"${RosterFixtures.REQUEST_ID}",""" +
                    """"hostRunId":"${RosterFixtures.HOST_RUN_ID}","rowId":"row-1","confirmed":true}""").encodeToByteArray()
            ),
        )
        for (outcome in OwnerCloseFacts.entries) {
            val frame = RosterFrame.CloseResult(RosterFixtures.REQUEST_ID, outcome)
            assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)))
        }
    }

    @Test
    fun `decodes a create request and every fact the owner can establish`() {
        assertEquals(
            RosterFrame.CreateRequest(
                requestId = RosterFixtures.REQUEST_ID,
                hostRunId = RosterFixtures.HOST_RUN_ID,
                workspace = "/srv/owner/workspace",
                sequence = 3L,
            ),
            RosterProtocol.decode(
                ("""{"type":"create_request","requestId":"${RosterFixtures.REQUEST_ID}",""" +
                    """"hostRunId":"${RosterFixtures.HOST_RUN_ID}","workspace":"/srv/owner/workspace","sequence":3}""").encodeToByteArray()
            ),
        )
        assertEquals(
            RosterFrame.CreateResult(
                RosterFixtures.REQUEST_ID,
                OwnerCreateFacts.Started(RosterFixtures.HOST_RUN_ID, "row-9"),
            ),
            RosterProtocol.decode(
                ("""{"type":"create_result","requestId":"${RosterFixtures.REQUEST_ID}",""" +
                    """"outcome":{"kind":"started","hostRunId":"${RosterFixtures.HOST_RUN_ID}","rowId":"row-9"}}""").encodeToByteArray()
            ),
        )
        for (outcome in listOf(
            OwnerCreateFacts.Unconfirmed,
            OwnerCreateFacts.Refused,
            OwnerCreateFacts.Unknown,
        )
        ) {
            val frame = RosterFrame.CreateResult(RosterFixtures.REQUEST_ID, outcome)
            assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)))
        }
    }

    @Test
    fun `decodes a rename request and every fact the owner can establish`() {
        assertEquals(
            RosterFrame.RenameRequest(
                requestId = RosterFixtures.REQUEST_ID,
                hostRunId = RosterFixtures.HOST_RUN_ID,
                rowId = "row-1",
                expectedSessionId = "native-session-1",
                expectedSessionEpoch = 4L,
                name = "Renamed conversation",
                sequence = 2L,
            ),
            RosterProtocol.decode(
                ("""{"type":"rename_request","requestId":"${RosterFixtures.REQUEST_ID}",""" +
                    """"hostRunId":"${RosterFixtures.HOST_RUN_ID}","rowId":"row-1",""" +
                    """"expectedSessionId":"native-session-1","expectedSessionEpoch":4,""" +
                    """"name":"Renamed conversation","sequence":2}""").encodeToByteArray(),
            ),
        )
        for (outcome in OwnerRenameFacts.entries) {
            val frame = RosterFrame.RenameResult(RosterFixtures.REQUEST_ID, outcome)
            assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)))
        }
    }

    @Test
    fun `decodes the five Saved requests`() {
        assertEquals(
            RosterFrame.SavedListRequest(
                requestId = "req-1",
                hostRunId = RosterFixtures.HOST_RUN_ID,
                query = "recent",
                offset = 0L,
                count = 25L,
                sequence = 1L,
            ),
            RosterProtocol.decode(savedJson("saved_list_request", "\"query\":\"recent\"", 1L)),
        )
        assertEquals(
            RosterFrame.SavedSearchRequest(
                requestId = "req-2",
                hostRunId = RosterFixtures.HOST_RUN_ID,
                catalogId = RosterFixtures.CATALOG_ID,
                query = "deploy",
                offset = 10L,
                count = 25L,
                sequence = 2L,
            ),
            RosterProtocol.decode(
                savedJson(
                    "saved_search_request",
                    "\"catalogId\":\"${RosterFixtures.CATALOG_ID}\",\"query\":\"deploy\"",
                    2L,
                    offset = 10L,
                    requestId = "req-2",
                ),
            ),
        )
        assertEquals(
            RosterFrame.SavedWindowRequest(
                requestId = "req-3",
                hostRunId = RosterFixtures.HOST_RUN_ID,
                catalogId = RosterFixtures.CATALOG_ID,
                resultId = RosterFixtures.RESULT_ID,
                offset = 25L,
                count = 25L,
                sequence = 3L,
            ),
            RosterProtocol.decode(
                savedJson(
                    "saved_window_request",
                    "\"catalogId\":\"${RosterFixtures.CATALOG_ID}\",\"resultId\":\"${RosterFixtures.RESULT_ID}\"",
                    3L,
                    offset = 25L,
                    requestId = "req-3",
                ),
            ),
        )
        assertEquals(
            RosterFrame.SavedResumeRequest(
                requestId = "req-4",
                hostRunId = RosterFixtures.HOST_RUN_ID,
                catalogId = RosterFixtures.CATALOG_ID,
                resultId = RosterFixtures.RESULT_ID,
                entryId = "entry-1",
                sequence = 4L,
            ),
            RosterProtocol.decode(
                ("""{"type":"saved_resume_request","requestId":"req-4","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                    """"catalogId":"${RosterFixtures.CATALOG_ID}","resultId":"${RosterFixtures.RESULT_ID}",""" +
                    """"entryId":"entry-1","sequence":4}""").encodeToByteArray(),
            ),
        )
        assertEquals(
            RosterFrame.SavedDeleteRequest(
                requestId = "req-5",
                hostRunId = RosterFixtures.HOST_RUN_ID,
                catalogId = RosterFixtures.CATALOG_ID,
                resultId = RosterFixtures.RESULT_ID,
                entryId = "entry-1",
                confirmed = true,
                sequence = 5L,
            ),
            RosterProtocol.decode(
                ("""{"type":"saved_delete_request","requestId":"req-5","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                    """"catalogId":"${RosterFixtures.CATALOG_ID}","resultId":"${RosterFixtures.RESULT_ID}",""" +
                    """"entryId":"entry-1","confirmed":true,"sequence":5}""").encodeToByteArray(),
            ),
        )
    }

    @Test
    fun `decodes a Saved window begin with its totals and issue count`() {
        assertEquals(
            RosterFrame.SavedWindowBegin(
                requestId = RosterFixtures.REQUEST_ID,
                hostRunId = RosterFixtures.HOST_RUN_ID,
                catalogId = RosterFixtures.CATALOG_ID,
                resultId = RosterFixtures.RESULT_ID,
                total = 1200L,
                issueCount = 2L,
                offset = 25L,
                rows = 3L,
                pageCount = 1L,
            ),
            RosterProtocol.decode(
                ("""{"type":"saved_window_begin","requestId":"${RosterFixtures.REQUEST_ID}",""" +
                    """"hostRunId":"${RosterFixtures.HOST_RUN_ID}","catalogId":"${RosterFixtures.CATALOG_ID}",""" +
                    """"resultId":"${RosterFixtures.RESULT_ID}","total":1200,"issueCount":2,"offset":25,"rows":3,""" +
                    """"pageCount":1}""").encodeToByteArray(),
            ),
        )
    }

    @Test
    fun `decodes a Saved window page and one whole entry fragment`() {
        val page = RosterProtocol.decode(RosterFixtures.savedWindowPageJson().encodeToByteArray())
        val savedPage = assertIs<RosterFrame.SavedWindowPage>(page)
        assertEquals(RosterFixtures.REQUEST_ID, savedPage.requestId)
        assertEquals(0L, savedPage.pageIndex)
        assertEquals(listOf(RosterFixtures.savedEntry(0)), savedPage.entries)
        assertEquals(RosterFixtures.savedWindowPageJson(), RosterProtocol.encode(page).decodeToString())

        assertEquals(
            RosterFrame.SavedWindowFragment(
                requestId = RosterFixtures.REQUEST_ID,
                pageIndex = 1L,
                part = 0L,
                parts = 2L,
                text = "{\"entryId\":\"entry-1\"",
            ),
            RosterProtocol.decode(
                ("""{"type":"saved_window_fragment","requestId":"${RosterFixtures.REQUEST_ID}","pageIndex":1,""" +
                    """"part":0,"parts":2,"text":"{\"entryId\":\"entry-1\""}""").encodeToByteArray(),
            ),
        )
    }

    @Test
    fun `decodes a Saved window end`() {
        assertEquals(
            RosterFrame.SavedWindowEnd(RosterFixtures.REQUEST_ID, rows = 3L, pageCount = 1L),
            RosterProtocol.decode(
                """{"type":"saved_window_end","requestId":"${RosterFixtures.REQUEST_ID}","rows":3,"pageCount":1}"""
                    .encodeToByteArray(),
            ),
        )
    }

    @Test
    fun `decodes every Saved window answer including a refusal with no reason`() {
        for (outcome in listOf(
            OwnerSavedWindowOutcome.Refused(),
            OwnerSavedWindowOutcome.Refused(SavedWindowRefusalReason.ADMISSION),
            OwnerSavedWindowOutcome.Refused(SavedWindowRefusalReason.RANGE),
            OwnerSavedWindowOutcome.Refused(SavedWindowRefusalReason.UNREPRESENTABLE),
            OwnerSavedWindowOutcome.Unavailable,
            OwnerSavedWindowOutcome.Unknown,
        )
        ) {
            val frame = RosterFrame.SavedWindowResult(RosterFixtures.REQUEST_ID, outcome)
            assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)))
        }
    }

    @Test
    fun `decodes every Saved resume and delete fact`() {
        for (outcome in listOf(
            OwnerSavedResumeFacts.Started(RosterFixtures.HOST_RUN_ID, "row-9"),
            OwnerSavedResumeFacts.Refused(SavedResumeRefusalReason.ADMISSION),
            OwnerSavedResumeFacts.Refused(SavedResumeRefusalReason.POLICY),
            OwnerSavedResumeFacts.Unconfirmed,
            OwnerSavedResumeFacts.Unknown,
        )
        ) {
            val frame = RosterFrame.SavedResumeResult(RosterFixtures.REQUEST_ID, outcome)
            assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)))
        }
        for (outcome in listOf(
            OwnerSavedDeleteFacts.ConfirmationRequired,
            OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH),
            OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.UNLINK),
            OwnerSavedDeleteFacts.Refused(SavedDeleteRefusalReason.ADMISSION),
            OwnerSavedDeleteFacts.Refused(SavedDeleteRefusalReason.ACTIVE),
            OwnerSavedDeleteFacts.Unconfirmed,
            OwnerSavedDeleteFacts.Unknown,
        )
        ) {
            val frame = RosterFrame.SavedDeleteResult(RosterFixtures.REQUEST_ID, outcome)
            assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)))
        }
    }

    @Test
    fun `decodes the Saved delete-exposure announcement as description only`() {
        assertEquals(
            RosterFrame.SavedPolicy(RosterFixtures.HOST_RUN_ID, deleteExposed = true),
            RosterProtocol.decode(
                """{"type":"saved_policy","hostRunId":"${RosterFixtures.HOST_RUN_ID}","deleteExposed":true}"""
                    .encodeToByteArray(),
            ),
        )
        assertEquals(
            RosterFrame.SavedPolicy(RosterFixtures.HOST_RUN_ID, deleteExposed = false),
            RosterProtocol.decode(
                """{"type":"saved_policy","hostRunId":"${RosterFixtures.HOST_RUN_ID}","deleteExposed":false}"""
                    .encodeToByteArray(),
            ),
        )
    }

    @Test
    fun `decodes a fixed refusal with and without the subscription it belongs to`() {
        assertEquals(
            RosterFrame.Failure(RosterWireErrorCode.ROW_UNREPRESENTABLE),
            RosterProtocol.decode(
                """{"type":"error","code":"row_unrepresentable"}""".encodeToByteArray(),
            ),
        )
        assertEquals(
            RosterFrame.Failure(RosterWireErrorCode.SNAPSHOT_TOO_LARGE, RosterFixtures.SUBSCRIPTION_ID),
            RosterProtocol.decode(
                ("""{"type":"error","code":"snapshot_too_large",""" +
                    """"subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}"}""").encodeToByteArray(),
            ),
        )
    }

    @Test
    fun `an absent nullable observation stays absent instead of becoming a default`() {
        val rows = RosterFixtures.snapshotPage().rows
        val minimal = rows[0]
        assertNull(minimal.rosterSlotId)
        assertNull(minimal.busy)
        assertNull(minimal.pendingInput)
        assertNull(minimal.exitCode)
        assertNull(minimal.error)
        assertNull(minimal.nativeSession?.persistence)
        // `activity` is the one observation the owner always reports: a row never
        // carries it as absent, so the minimal row still has a (possibly empty) list.
        assertEquals(listOf("Running tests"), minimal.activity)

        val observed = rows[2]
        assertEquals(false, observed.busy)
        assertEquals(true, observed.pendingInput)
        assertEquals(0L, observed.backgroundTasks)
        assertEquals(1L, observed.backgroundShells)
        assertEquals(7L, observed.activeTasks)
        assertEquals(4L, observed.activeShells)
        assertEquals(130.0, observed.exitCode)
        assertEquals("worker exited with code 130", observed.error)
        assertEquals("slot-3", observed.rosterSlotId)
        assertEquals(RemoteNativePersistence.SAVED, observed.nativeSession?.persistence)
    }

    @Test
    fun `a row carries the exact native tuple and workspace the owner reported`() {
        val page = RosterProtocol.decode(RosterFixtures.snapshotPageJson().encodeToByteArray())
        val third = assertIs<RosterFrame.SnapshotPage>(page).rows[2]
        assertEquals("row-3", third.id)
        assertEquals("Conversation row-3", third.label)
        assertEquals("/srv/owner/work-row-3", third.workspace)
        assertEquals(RosterLifecycle.EXITED, third.lifecycle)
        assertEquals(true, third.hasLiveProcess)
        assertEquals(true, third.inputSurface)
        assertEquals(
            RemoteNativeSession("native-session-3", 9L, "Renamed conversation 3", RemoteNativePersistence.SAVED),
            third.nativeSession,
        )
        assertEquals(listOf("Running tests", "Reading 12 files"), third.activity)
    }

    @Test
    fun `every frame round trips through one decode and one encode`() {
        for (frame in RosterFixtures.allFrames()) {
            val first = RosterProtocol.decode(RosterProtocol.encode(frame))
            val second = RosterProtocol.decode(RosterProtocol.encode(first))
            assertEquals(first, second, "frame must be stable across a round trip: $frame")
            assertEquals(frame, first, "frame must survive the wire unchanged: $frame")
        }
    }

    private fun beginJson(): ByteArray =
        (
            """{"type":"snapshot_begin","subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}",""" +
                """"transferId":"${RosterFixtures.TRANSFER_ID}","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"revision":7,"totalRows":2,"pageCount":1}"""
            ).encodeToByteArray()

    private fun savedJson(
        type: String,
        middle: String,
        sequence: Long,
        offset: Long = 0L,
        requestId: String = "req-1",
    ): ByteArray =
        (
            """{"type":"$type","requestId":"$requestId","hostRunId":"${RosterFixtures.HOST_RUN_ID}",$middle,""" +
                """"offset":$offset,"count":25,"sequence":$sequence}"""
            ).encodeToByteArray()
}
