package io.github.rfairburn.pireviewgate.core.protocol.roster

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Hostile payloads.
 *
 * Every case here is a message a peer could plausibly send and that must be refused
 * rather than interpreted generously: unknown or missing keys, oversized or unsafe
 * numbers, control text, malformed UTF-8, private owner fields, and counts that
 * contradict each other.
 */
class RosterHostileFrameTest {

    @Test
    fun `refuses an empty oversized or non-JSON message`() {
        // The byte bound is its own refusal code, before any parsing happens.
        assertDecodeRefused(ByteArray(0), RosterFailureCode.FRAME_TOO_LARGE)
        assertDecodeRefused(
            ByteArray(RosterBounds.DEFAULT.maxFrameBytes.toInt() + 1),
            RosterFailureCode.FRAME_TOO_LARGE,
        )
        for (text in listOf("not json at all", "[1,2,3]", "\"just a string\"", "42", "null", "true", "{", "}")) {
            assertBadFrame(text, "payload $text")
        }
    }

    @Test
    fun `refuses bytes that are not valid UTF-8`() {
        assertBadFrame(byteArrayOf(0x7B, 0x22, 0x74, 0xFF.toByte(), 0x22, 0x7D))
        assertBadFrame(byteArrayOf(0xC3.toByte(), 0x28.toByte()))
        assertBadFrame(byteArrayOf(0xED.toByte(), 0xA0.toByte(), 0x80.toByte()))
    }

    @Test
    fun `refuses a frame whose type is missing or unknown`() {
        assertBadFrame("""{"subscriptionId":"sub-1"}""")
        assertBadFrame("""{"type":"","subscriptionId":"sub-1"}""")
        assertBadFrame("""{"type":"snapshot_pages","subscriptionId":"sub-1"}""")
        assertBadFrame("""{"type":"ROSTER_V1"}""")
        assertBadFrame("""{"type":"payload","subscriptionId":"sub-1"}""")
    }

    @Test
    fun `refuses any key the closed schema does not declare`() {
        assertBadFrame("""{"type":"subscribe","subscriptionId":"sub-1","extra":true}""")
        assertBadFrame("""{"type":"subscribe","subscriptionId":"sub-1","SubscriptionId":"sub-2"}""")
        assertBadFrame(
            """{"type":"hello","service":"${RosterWire.SERVICE}","major":1,"minor":0,"capabilities":[],"pid":4242}""",
        )
        assertBadFrame(
            """{"type":"saved_policy","hostRunId":"${RosterFixtures.HOST_RUN_ID}","deleteExposed":true,""" +
                """"path":"/home/owner"}""",
        )
        // A Close request cannot smuggle a workspace, a path, or a sequence.
        assertBadFrame(
            """{"type":"close_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"rowId":"row-1","confirmed":true,"workspace":"/srv/owner"}""",
        )
        assertBadFrame(
            """{"type":"close_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"rowId":"row-1","confirmed":"yes"}""",
        )
    }

    @Test
    fun `refuses a missing or wrongly typed required field`() {
        assertBadFrame("""{"type":"subscribe"}""")
        assertBadFrame("""{"type":"subscribe","subscriptionId":null}""")
        assertBadFrame("""{"type":"subscribe","subscriptionId":1}""")
        assertBadFrame("""{"type":"subscribe","subscriptionId":""}""")
        assertBadFrame("""{"type":"hello","major":1,"minor":0,"capabilities":[]}""")
        assertBadFrame("""{"type":"hello","service":"${RosterWire.SERVICE}","minor":0,"capabilities":[]}""")
        assertBadFrame("""{"type":"hello","service":"${RosterWire.SERVICE}","major":1,"capabilities":[]}""")
        assertBadFrame("""{"type":"saved_policy","hostRunId":"${RosterFixtures.HOST_RUN_ID}"}""")
        // A present-but-null subscription id is not the same as an absent one.
        assertBadFrame("""{"type":"error","code":"bad_frame","subscriptionId":null}""")
        assertBadFrame("""{"type":"error","code":"not_a_known_code"}""")
    }

    @Test
    fun `refuses integers that are unsafe non-integers or out of range`() {
        for (major in listOf(
            "9007199254740993", // beyond the safe-integer ceiling
            "4294967296", // beyond a protocol version
            "1.5",
            "\"1\"",
            "null",
            "-1",
            "100.00000000000001", // a precision-losing spelling of a number
        )
        ) {
            assertBadFrame(
                """{"type":"hello","service":"${RosterWire.SERVICE}","major":$major,"minor":0,"capabilities":[]}""",
                "major $major",
            )
        }
    }

    @Test
    fun `accepts an exponent spelling only when it denotes an exact integer in range`() {
        val frame = RosterProtocol.decode(
            """{"type":"hello","service":"${RosterWire.SERVICE}","major":1e0,"minor":0,"capabilities":[]}"""
                .encodeToByteArray(),
        ) as RosterFrame.Hello
        assertEquals(1L, frame.major)
    }

    @Test
    fun `refuses counters that exceed the negotiated bound`() {
        val bounds = RosterBounds(maxSnapshotRows = 2L, maxRowsPerPage = 1L)
        assertBadFrame(
            """{"type":"snapshot_begin","subscriptionId":"sub-1","transferId":"t-1",""" +
                """"hostRunId":"${RosterFixtures.HOST_RUN_ID}","revision":1,"totalRows":33,"pageCount":1}""",
            bounds = bounds,
            context = "a transfer over maxSnapshotRows",
        )
        assertBadFrame(
            """{"type":"create_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"workspace":"/srv/o","sequence":0}""",
            bounds = bounds,
            context = "a sequence below one",
        )
        assertBadFrame(
            """{"type":"saved_window_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"catalogId":"cat-1","resultId":"res-1","offset":-1,"count":1,"sequence":1}""",
            bounds = bounds,
            context = "a negative offset",
        )
        assertBadFrame(
            """{"type":"saved_window_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"catalogId":"cat-1","resultId":"res-1","offset":0,"count":0,"sequence":1}""",
            bounds = bounds,
            context = "a window of zero rows",
        )
    }

    @Test
    fun `refuses a page row that carries a private owner field onto the wire`() {
        val extras = listOf(
            "\"agentDir\":${RosterFixtures.jsonText(RosterFixtures.SECRET_AGENT_DIR)}",
            "\"currentFile\":${RosterFixtures.jsonText(RosterFixtures.SECRET_CURRENT_FILE)}",
            "\"prompt\":${RosterFixtures.jsonText("the user prompt body")}",
            "\"transcript\":${RosterFixtures.jsonText("the transcript body")}",
            "\"env\":{\"TOKEN\":\"secret\"}",
            "\"pid\":4242",
            "\"background_tasks\":3",
        )
        for (extra in extras) {
            val row = RosterFixtures.rowJson("row-1").removeSuffix("}") + ",$extra}"
            assertBadFrame(pageJson(row), "private field $extra")
        }
    }

    @Test
    fun `refuses a page that carries more rows than the negotiated page bound`() {
        val bounds = RosterBounds(maxRowsPerPage = 1L)
        val twoRows = "${RosterFixtures.rowJson("row-1")},${RosterFixtures.rowJson("row-2")}"
        val failure = runCatching { RosterProtocol.decode(pageJson(twoRows).encodeToByteArray(), bounds) }
            .exceptionOrNull()
        assertTrue(
            failure is RosterProtocolException && failure.code == RosterFailureCode.BAD_FRAME,
            "a page over maxRowsPerPage must be refused, got $failure",
        )
    }

    @Test
    fun `refuses a nested native session that carries the private current file`() {
        val row = RosterFixtures.bareRowJson("row-1").replace(
            "\"name\":\"Conversation row-1\"}",
            "\"name\":\"Conversation row-1\",\"currentFile\":\"${RosterFixtures.SECRET_CURRENT_FILE}\"}",
        )
        assertBadFrame(pageJson(row), "a native current file must not ride along")
    }

    @Test
    fun `refuses rename requests whose tuple and name are not canonical`() {
        fun rename(expectedSessionId: String, epoch: String, name: String) =
            """{"type":"rename_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"rowId":"row-1","expectedSessionId":"$expectedSessionId","expectedSessionEpoch":$epoch,""" +
                """"name":$name,"sequence":1}"""
        assertBadFrame(rename("../escape", "1", RosterFixtures.jsonText("New name")))
        assertBadFrame(rename("has/slash", "1", RosterFixtures.jsonText("New name")))
        assertBadFrame(rename("", "1", RosterFixtures.jsonText("New name")))
        assertBadFrame(rename("native-session-1", "0", RosterFixtures.jsonText("New name")))
        assertBadFrame(rename("native-session-1", "-3", RosterFixtures.jsonText("New name")))
        assertBadFrame(rename("native-session-1", "1.5", RosterFixtures.jsonText("New name")))
        assertBadFrame(rename("native-session-1", "1", RosterFixtures.jsonText("")))
        assertBadFrame(rename("native-session-1", "1", RosterFixtures.jsonText("   ")))
        assertBadFrame(rename("native-session-1", "1", RosterFixtures.jsonText("two\nlines")))
    }

    @Test
    fun `refuses create workspaces that are not canonical single-line text`() {
        for (workspace in listOf("", "/srv/owner\nsecond line", "/srv/owner\u0000path", "/srv/owner\u2028path")) {
            assertBadFrame(createRequestJson(RosterFixtures.jsonText(workspace)), "workspace over there")
        }
        // The New form's own bound is 2048 code points, so one more is refused.
        assertBadFrame(createRequestJson(RosterFixtures.jsonText("Z".repeat(2049))), "workspace over the bound")
        // A maximum-length workspace, including astral text, is still accepted.
        val astral = String(Character.toChars(0x1F5C2))
        val widest = RosterProtocol.decode(
            createRequestJson(RosterFixtures.jsonText(astral.repeat(2048))).encodeToByteArray(),
        ) as RosterFrame.CreateRequest
        assertEquals(2048, widest.workspace.codePointCount(0, widest.workspace.length))
    }

    @Test
    fun `refuses Saved window frames whose counts contradict each other`() {
        fun begin(total: String, issueCount: String, offset: String, rows: String) =
            """{"type":"saved_window_begin","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"catalogId":"cat-1","resultId":"res-1","total":$total,"issueCount":$issueCount,""" +
                """"offset":$offset,"rows":$rows,"pageCount":1}"""
        assertBadFrame(begin("10", "0", "11", "0"), "an offset past the total")
        assertBadFrame(begin("10", "0", "3", "8"), "more rows than the window can hold")
        assertBadFrame(
            """{"type":"saved_window_end","requestId":"req-1","rows":2,"pageCount":0}""",
            "rows need at least one page",
        )
        assertBadFrame(
            """{"type":"saved_window_end","requestId":"req-1","rows":0,"pageCount":1}""",
            "an empty window needs no page",
        )
    }

    @Test
    fun `refuses a Saved window fragment that cannot be a part of one entry`() {
        fun fragment(part: String, parts: String, text: String) =
            """{"type":"saved_window_fragment","requestId":"req-1","pageIndex":0,"part":$part,"parts":$parts,""" +
                """"text":$text}"""
        assertBadFrame(fragment("1", "1", RosterFixtures.jsonText("x")), "a part index outside the part count")
        assertBadFrame(fragment("0", "0", RosterFixtures.jsonText("x")), "zero parts")
        assertBadFrame(fragment("0", "2", RosterFixtures.jsonText("")), "an empty fragment")
    }

    @Test
    fun `refuses a Saved page entry that is not exactly the closed shape`() {
        val withExtra = RosterFixtures.savedEntryJson(1).removeSuffix("}") + ",\"extra\":1}"
        assertBadFrame(
            """{"type":"saved_window_page","requestId":"req-1","pageIndex":0,"entries":[$withExtra]}""",
            "an entry with an unknown key",
        )
        val badId = RosterFixtures.savedEntryJson(2).replace("\"entryId\":\"entry-2\"", "\"entryId\":\"has space\"")
        assertBadFrame(
            """{"type":"saved_window_page","requestId":"req-1","pageIndex":0,"entries":[$badId]}""",
            "an entry id that is not an identifier",
        )
        val duplicated = "${RosterFixtures.savedEntryJson(0)},${RosterFixtures.savedEntryJson(0)}"
        assertBadFrame(
            """{"type":"saved_window_page","requestId":"req-1","pageIndex":0,"entries":[$duplicated]}""",
            "the same entry id twice in one page",
        )
    }

    @Test
    fun `refuses Saved text that is not well-formed Unicode`() {
        assertBadFrame(
            """{"type":"saved_window_fragment","requestId":"req-1","pageIndex":0,"part":0,"parts":1,""" +
                """"text":"\ud800"}""",
            "a lone high surrogate",
        )
        assertBadFrame(
            """{"type":"saved_list_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"query":"\udfff","offset":0,"count":1,"sequence":1}""",
            "a lone low surrogate in a query",
        )
    }

    @Test
    fun `refuses a closed owner outcome that is not exactly one declared kind`() {
        assertBadFrame(
            """{"type":"saved_window_result","requestId":"req-1","outcome":{"kind":"refused","reason":"nope"}}""",
            "an invented refusal reason",
        )
        assertBadFrame(
            """{"type":"saved_window_result","requestId":"req-1",""" +
                """"outcome":{"kind":"refused","reason":"admission","extra":1}}""",
            "an extra field beside a refusal",
        )
        assertBadFrame(
            """{"type":"saved_window_result","requestId":"req-1","outcome":{"kind":"window","resultId":"res-1"}}""",
            "a window answer that is not a fact",
        )
        assertBadFrame(
            """{"type":"saved_delete_result","requestId":"req-1","outcome":{"kind":"deleted","method":"rm"}}""",
            "a delete method the owner never reports",
        )
        assertBadFrame(
            """{"type":"saved_resume_result","requestId":"req-1","outcome":{"kind":"refused"}}""",
            "a refusal with no reason where one is required",
        )
        assertBadFrame(
            """{"type":"close_result","requestId":"req-1","outcome":{"kind":"removed","rowId":"row-1"}}""",
            "a fact set that smuggles a row id",
        )
        assertBadFrame(
            """{"type":"rename_result","requestId":"req-1","outcome":{"kind":"renamed","name":"Quiet work"}}""",
            "a rename answer that carries a name",
        )
        assertBadFrame(
            """{"type":"create_result","requestId":"req-1","outcome":{"kind":"started","hostRunId":"${RosterFixtures.HOST_RUN_ID}"}}""",
            "a started create with no row id",
        )
    }

    @Test
    fun `refuses a hello that cannot carry the protocol it claims`() {
        assertBadFrame(
            """{"type":"hello","service":"${RosterWire.SERVICE}","major":1,"minor":-1,"capabilities":[]}""",
            "a negative minor version",
        )
        assertBadFrame(
            """{"type":"hello","service":"${RosterWire.SERVICE}","major":1,"minor":0,"capabilities":{}}""",
            "capabilities that are not an array",
        )
        assertBadFrame(
            """{"type":"hello","service":"${RosterWire.SERVICE}","major":1,"minor":0,""" +
                """"capabilities":["roster-v1","${"c".repeat(65)}"]}""",
            "a capability over the identifier bound",
        )
        assertBadFrame(
            """{"type":"hello","service":"${RosterWire.SERVICE}","major":1,"minor":0,"capabilities":"roster-v1"}""",
            "capabilities that are a bare string",
        )
        assertBadFrame(
            """{"type":"hello","service":"","major":1,"minor":0,"capabilities":["roster-v1"]}""",
            "an empty service name",
        )
    }

    private fun createRequestJson(workspaceJson: String): String =
        """{"type":"create_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
            """"workspace":$workspaceJson,"sequence":1}"""

    private fun pageJson(rowsJson: String): String =
        """{"type":"snapshot_page","subscriptionId":"sub-1","transferId":"t-1","pageIndex":0,"rows":[$rowsJson]}"""

    @Test
    fun `refuses a quoted boolean where the JSON type is a boolean`() {
        // "true" and "false" are strings. The source decoder tests the JSON type, and
        // so must this one, or a viewer could be told a close was confirmed by text.
        for (quoted in listOf("\"true\"", "\"false\"")) {
            assertBadFrame(
                """{"type":"close_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                    """"rowId":"row-1","confirmed":$quoted}""",
                "a quoted confirmed in a close request",
            )
            assertBadFrame(
                """{"type":"saved_delete_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                    """"catalogId":"${RosterFixtures.CATALOG_ID}","resultId":"${RosterFixtures.RESULT_ID}",""" +
                    """"entryId":"${RosterFixtures.ENTRY_ID}","confirmed":$quoted,"sequence":1}""",
                "a quoted confirmed in a Saved delete request",
            )
            assertBadFrame(
                """{"type":"saved_policy","hostRunId":"${RosterFixtures.HOST_RUN_ID}","deleteExposed":$quoted}""",
                "a quoted deleteExposed in a Saved policy",
            )
        }
    }

    private fun assertBadFrame(
        bytes: ByteArray,
        context: String = "",
        bounds: RosterBounds = RosterBounds.DEFAULT,
    ) {
        val failure = runCatching { RosterProtocol.decode(bytes, bounds) }.exceptionOrNull()
        assertTrue(
            failure is RosterProtocolException && failure.code == RosterFailureCode.BAD_FRAME,
            "payload must be refused as BAD_FRAME, got $failure $context",
        )
    }

    private fun assertBadFrame(
        json: String,
        context: String = "",
        bounds: RosterBounds = RosterBounds.DEFAULT,
    ) = assertBadFrame(json.encodeToByteArray(), context, bounds)
}
