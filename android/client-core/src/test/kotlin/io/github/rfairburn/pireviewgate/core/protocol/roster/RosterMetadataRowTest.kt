package io.github.rfairburn.pireviewgate.core.protocol.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.internal.RosterJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The remote roster row boundary: every field is read exactly, unknown and absent
 * observations stay unknown, and private owner fields are refused.
 */
class RosterMetadataRowTest {

    private fun parse(json: String): RemoteSessionMetadata? = RosterMetadataRow.parse(RosterJson.parse(json))

    /** The fixture row with one extra member appended to its closed key set. */
    private fun rowWith(member: String): String =
        RosterFixtures.bareRowJson("row-1").removeSuffix("}") + ",$member}"

    @Test
    fun `decodes a full row with its nullable observations intact`() {
        val row = assertNotNull(parse(RosterFixtures.rowJson()))
        assertEquals(RosterFixtures.row(), row)
        assertNull(row.busy)
        assertNull(row.pendingInput)
        assertNull(row.backgroundTasks)
        assertNull(row.backgroundShells)
        assertNull(row.activeTasks)
        assertNull(row.activeShells)
        assertNull(row.exitCode)
        assertNull(row.error)
        assertNull(row.rosterSlotId)
    }

    @Test
    fun `decodes a minimal row without inventing observations`() {
        val row = assertNotNull(
            parse(
                """{"id":"row-2","label":"Only known fields","workspace":"C:\\work\\pi",""" +
                    """"lifecycle":"exited","hasLiveProcess":false,"inputSurface":false}""",
            ),
        )
        assertEquals(RosterLifecycle.EXITED, row.lifecycle)
        assertNull(row.busy)
        assertNull(row.pendingInput)
        assertNull(row.nativeSession)
        assertEquals(emptyList<String>(), row.activity)
        assertNull(row.exitCode)
        assertNull(row.error)
    }

    @Test
    fun `keeps ownership and activity-intent counts independent`() {
        val row = assertNotNull(
            parse(
                rowWith(
                    """"backgroundTasks":0,"backgroundShells":1,"activeTasks":7,"activeShells":4""",
                ),
            ),
        )
        assertEquals(0L, row.backgroundTasks)
        assertEquals(1L, row.backgroundShells)
        assertEquals(7L, row.activeTasks)
        assertEquals(4L, row.activeShells)
    }

    @Test
    fun `keeps a known zero exit code and treats a null exit code as absent`() {
        assertEquals(0.0, assertNotNull(parse(rowWith("\"exitCode\":0"))).exitCode)
        assertNull(assertNotNull(parse(rowWith("\"exitCode\":null"))).exitCode)
        assertEquals(130.0, assertNotNull(parse(rowWith("\"exitCode\":130"))).exitCode)
        assertRowRefused(rowWith("\"exitCode\":\"0\""))
        assertRowRefused(rowWith("\"exitCode\":1e400"))
    }

    @Test
    fun `carries the negotiated roster slot and treats null as honest absence`() {
        assertEquals("slot-a", assertNotNull(parse(rowWith("\"rosterSlotId\":\"slot-a\""))).rosterSlotId)
        assertNull(assertNotNull(parse(rowWith("\"rosterSlotId\":null"))).rosterSlotId)
        assertRowRefused(rowWith("\"rosterSlotId\":\"${"s".repeat(MAX_REMOTE_ROSTER_SLOT_ID_CHARS + 1)}\""))
        assertRowRefused(rowWith("\"rosterSlotId\":\"has\ttab\""))
    }

    @Test
    fun `reads the native tuple with its optional persistence and never a current file`() {
        val withPersistence = RosterFixtures.bareRowJson()
            .replace(""""epoch":2,"name":"Conversation row-1"}""", """"epoch":2,"name":"Conversation row-1","persistence":"saved"}""")
        val row = assertNotNull(parse(withPersistence))
        assertEquals(RemoteNativePersistence.SAVED, row.nativeSession?.persistence)
        assertEquals(2L, row.nativeSession?.epoch)

        val unknownPersistence = withPersistence.replace("\"persistence\":\"saved\"", "\"persistence\":\"archived\"")
        assertRowRefused(unknownPersistence)

        val withCurrentFile = withPersistence.replace(
            """"name":"Conversation row-1","persistence":"saved"}""",
            """"name":"Conversation row-1","persistence":"saved","currentFile":""" +
                RosterFixtures.jsonText(RosterFixtures.SECRET_CURRENT_FILE) + "}",
        )
        assertRowRefused(withCurrentFile)
        assertRowRefused(RosterFixtures.bareRowJson().replace("\"epoch\":2", "\"epoch\":0"))
        assertRowRefused(RosterFixtures.bareRowJson().replace("\"sessionId\":\"conversation-row-1\"", "\"sessionId\":\"../escape\""))
        assertRowRefused(RosterFixtures.bareRowJson().replace("\"name\":\"Conversation row-1\"", "\"name\":\" padded \""))
    }

    @Test
    fun `preserves literal owner workspace paths from other systems without rewriting`() {
        for (workspace in listOf(
            "C:\\Users\\Casey\\Source\\pi",
            "D:/work/review-gate",
            "/home/casey/My Project/../pi",
            "\\\\server\\share\\pi",
            "/home/casey/odd\tname\nand\u001b[31msegment",
        )
        ) {
            val row = assertNotNull(parse(rowWith("\"workspace\":${RosterFixtures.jsonText(workspace)}")))
            assertEquals(workspace, row.workspace)
        }
        assertRowRefused(rowWith("\"workspace\":${RosterFixtures.jsonText("Z".repeat(MAX_REMOTE_WORKSPACE_BYTES + 1))}"))
        assertRowRefused(rowWith("\"workspace\":\"\""))
    }

    @Test
    fun `refuses rows outside the closed schema`() {
        assertRowRefused("""{"id":"row-1","label":"L","workspace":"/srv","lifecycle":"alive","hasLiveProcess":true}""")
        assertRowRefused(rowWith("\"agentDir\":${RosterFixtures.jsonText(RosterFixtures.SECRET_AGENT_DIR)}"))
        assertRowRefused(rowWith("\"token\":\"secret\""))
        assertRowRefused(rowWith("\"env\":{\"OPENAI_API_KEY\":\"sk-provider-secret-value\"}"))
        assertRowRefused(rowWith("\"prompt\":${RosterFixtures.jsonText("private prompt body")}"))
        assertRowRefused(rowWith("\"currentFile\":${RosterFixtures.jsonText(RosterFixtures.SECRET_CURRENT_FILE)}"))
        assertRowRefused(rowWith("\"background_tasks\":3"))
        assertRowRefused(rowWith("\"ID\":\"row-1\""))
        assertRowRefused("null")
        assertRowRefused("[]")
        assertRowRefused("\"row\"")
    }

    @Test
    fun `refuses malformed observations instead of defaulting them`() {
        assertRowRefused(rowWith("\"lifecycle\":\"running\""))
        assertRowRefused(rowWith("\"busy\":\"yes\""))
        assertRowRefused(rowWith("\"inputSurface\":1"))
        assertRowRefused(rowWith("\"hasLiveProcess\":null"))
        assertRowRefused(rowWith("\"backgroundTasks\":-1"))
        assertRowRefused(rowWith("\"activeTasks\":1.5"))
        assertRowRefused(rowWith("\"activity\":\"one string\""))
        assertRowRefused(rowWith("\"activity\":[\"a\",\"b\",\"c\"]"))
        assertRowRefused(
            rowWith("\"activity\":[${RosterFixtures.jsonText("A".repeat(MAX_REMOTE_ACTIVITY_LINE_CHARS + 1))}]"),
        )
        assertRowRefused(rowWith("\"activity\":[${RosterFixtures.jsonText("bad\u001bline")}]"))
        assertRowRefused(rowWith("\"label\":${RosterFixtures.jsonText("L".repeat(MAX_REMOTE_LABEL_CHARS + 1))}"))
    }

    @Test
    fun `keeps safe diagnostics useful and bounds them`() {
        val ordinary = "Workspace directory is no longer available"
        assertEquals(ordinary, assertNotNull(parse(rowWith("\"error\":${RosterFixtures.jsonText(ordinary)}"))).error)

        val long = assertNotNull(parse(rowWith("\"error\":${RosterFixtures.jsonText("E".repeat(1000))}")))
        assertEquals(MAX_REMOTE_ERROR_CHARS, long.error?.length)
    }

    @Test
    fun `strips terminal controls and redacts recognizable credentials`() {
        val cases = listOf(
            "Launch failed: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 \u001b[31mretry\u001b[0m" to
                "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "Authentication failed: Authorization: Basic dXNlcjpwYXNzd29yZA==" to "dXNlcjpwYXNzd29yZA==",
            "Cookie: sid=abc123; theme=dark" to "sid=abc123",
            "https://casey:hunter2@example.test/repo" to "hunter2",
            "api_key=sk-abcdefghijklmnop" to "sk-abcdefghijklmnop",
        )
        for ((diagnostic, secret) in cases) {
            val error = assertNotNull(parse(rowWith("\"error\":${RosterFixtures.jsonText(diagnostic)}"))).error
            assertNotNull(error)
            assertTrue(!error.contains(secret), "the diagnostic leaked its secret: $error")
            assertTrue(error.contains("[REDACTED]"), "the diagnostic kept no redaction marker: $error")
            assertTrue(!error.contains('\u001b'), "the diagnostic kept a control character: $error")
        }
    }

    @Test
    fun `header-consuming recognizers keep the useful prefix`() {
        assertEquals(
            "Authentication failed: Authorization: [REDACTED]",
            assertNotNull(
                parse(
                    rowWith(
                        "\"error\":\"Authentication failed: Authorization: Digest username=\\\"casey\\\", " +
                            "nonce=\\\"challenge\\\", response=\\\"6629fae49393a05397450978507c4ef1\\\"\"",
                    ),
                ),
            ).error,
        )
        assertEquals(
            "Cookie: [REDACTED]",
            assertNotNull(parse(rowWith("\"error\":\"Cookie: sid=abc123; theme=dark\""))).error,
        )
        assertEquals(
            "https://[REDACTED]@example.test/repo",
            assertNotNull(parse(rowWith("\"error\":\"https://casey:hunter2@example.test/repo\""))).error,
        )
    }

    @Test
    fun `unsafe diagnostics fail closed to the fixed generic message`() {
        val privateBody = "MIIEprivateKeyMaterialThatMustNotEscape"
        val diagnostics = listOf(
            "failed\n    at Object.<anonymous> (/Users/casey/private/stack.js:1:1)",
            "failed \t password=hunter2",
            "failed \u001b]0;unterminated control string",
            "failed \u001b[31",
            "failed -----BEGIN RSA PRIVATE KEY-----\\n$privateBody",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "x".repeat(5000) + " token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "Launch failed: password=\"hunter2",
            "Launch failed: password=prefix,private-tail",
            "   ",
        )
        for (diagnostic in diagnostics) {
            val error = assertNotNull(parse(rowWith("\"error\":${RosterFixtures.jsonText(diagnostic)}"))).error
            assertEquals(REMOTE_ERROR_FALLBACK_TEXT, error, "diagnostic must fail closed: $diagnostic")
        }
    }

    @Test
    fun `control splitting cannot unmask a credential`() {
        for (diagnostic in listOf(
            "password=hu\u0000nter2",
            "token=abc\u001b[31mdefghijklmnopqrstuvwxyz",
            "password=hu\u001b]0;injected title\u0007nter2",
        )
        ) {
            val error = assertNotNull(parse(rowWith("\"error\":${RosterFixtures.jsonText(diagnostic)}"))).error
            assertNotNull(error)
            assertTrue(!error.contains("hunter2"), "a split credential was reassembled: $error")
            assertTrue(!error.contains("injected title"), "an injected title survived: $error")
            assertTrue(error.contains("[REDACTED]"), "no redaction marker remained: $error")
        }
    }

    @Test
    fun `an observation count beyond the safe-integer range is refused on the write side`() {
        val base = RosterFixtures.observedRow()

        // The largest value this lane can carry is written and read back unchanged.
        val atCeiling = base.copy(
            backgroundTasks = MAX_SAFE_INTEGER,
            backgroundShells = MAX_SAFE_INTEGER,
            activeTasks = MAX_SAFE_INTEGER,
            activeShells = MAX_SAFE_INTEGER,
        )
        val written = parse(RosterMetadataRow.encode(atCeiling))
        assertNotNull(written)
        assertEquals(MAX_SAFE_INTEGER, written.backgroundTasks)
        assertEquals(MAX_SAFE_INTEGER, written.backgroundShells)
        assertEquals(MAX_SAFE_INTEGER, written.activeTasks)
        assertEquals(MAX_SAFE_INTEGER, written.activeShells)

        // One past it, and the largest Long, cannot be represented on the wire: the
        // row is refused here rather than shipped as bytes that cannot round-trip.
        val setters = listOf<(Long) -> RemoteSessionMetadata>(
            { value -> base.copy(backgroundTasks = value) },
            { value -> base.copy(backgroundShells = value) },
            { value -> base.copy(activeTasks = value) },
            { value -> base.copy(activeShells = value) },
        )
        for (setter in setters) {
            for (value in listOf(MAX_SAFE_INTEGER + 1L, Long.MAX_VALUE, -1L)) {
                val failure = runCatching { RosterMetadataRow.encode(setter(value)) }.exceptionOrNull()
                assertTrue(
                    failure is RosterProtocolException && failure.code == RosterFailureCode.INVALID_FRAME,
                    "count $value must be refused on encode, got $failure",
                )
            }
        }
    }

    @Test
    fun `a native session epoch beyond the safe-integer range is refused on the write side`() {
        val base = RosterFixtures.observedRow()
        val session = checkNotNull(base.nativeSession)

        val atCeiling = base.copy(nativeSession = session.copy(epoch = MAX_SAFE_INTEGER))
        val written = parse(RosterMetadataRow.encode(atCeiling))
        assertNotNull(written)
        assertEquals(MAX_SAFE_INTEGER, checkNotNull(written.nativeSession).epoch)

        for (epoch in listOf(0L, -1L, MAX_SAFE_INTEGER + 1L, Long.MAX_VALUE)) {
            val row = base.copy(nativeSession = session.copy(epoch = epoch))
            val failure = runCatching { RosterMetadataRow.encode(row) }.exceptionOrNull()
            assertTrue(
                failure is RosterProtocolException && failure.code == RosterFailureCode.INVALID_FRAME,
                "epoch $epoch must be refused on encode, got $failure",
            )
        }
    }

    private fun assertRowRefused(json: String) {
        val frame = """{"type":"snapshot_page","subscriptionId":"sub-1","transferId":"t-1","pageIndex":0,"rows":[$json]}"""
        assertDecodeRefused(frame.encodeToByteArray(), RosterFailureCode.BAD_FRAME)
    }
}
