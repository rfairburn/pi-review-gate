package io.github.rfairburn.pireviewgate.core.protocol.roster

import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliTarget
import io.github.rfairburn.pireviewgate.core.protocol.native.SessionBackend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The additive native lane on the roster wire: capability negotiation, the typed
 * row backend, the catalog that commits with `snapshot_end`, and the two separate
 * native create/host-caption exchanges. Everything here is synthetic.
 */
class RosterNativeProtocolTest {

    private val target = NativeCliTarget("claude-default", NativeCliBackend.CLAUDE, "Claude default")

    @Test
    fun `native capabilities are known and only their exact names are retained`() {
        assertEquals("roster-native-v1", RosterWire.NATIVE_CAPABILITY)
        assertEquals("roster-native-name-v1", RosterWire.NATIVE_NAME_CAPABILITY)
        assertTrue(RosterWire.KNOWN_OPTIONAL_CAPABILITIES.contains(RosterWire.NATIVE_CAPABILITY))
        assertTrue(RosterWire.KNOWN_OPTIONAL_CAPABILITIES.contains(RosterWire.NATIVE_NAME_CAPABILITY))
        val hello = RosterFrame.Hello(
            RosterWire.SERVICE,
            RosterWire.MAJOR,
            RosterWire.MINOR,
            listOf(
                RosterWire.REQUIRED_CAPABILITY,
                RosterWire.NATIVE_CAPABILITY,
                RosterWire.NATIVE_NAME_CAPABILITY,
                "roster-native-future",
            ),
        )
        val accepted = assertIs<RosterNegotiation.Accepted>(RosterProtocol.negotiateHello(hello))
        assertEquals(listOf(RosterWire.NATIVE_CAPABILITY, RosterWire.NATIVE_NAME_CAPABILITY), accepted.capabilities)
    }

    @Test
    fun `decodes a closed advertised catalog with the snapshot it completes`() {
        val json = """{"type":"snapshot_end","subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}",""" +
            """"transferId":"${RosterFixtures.TRANSFER_ID}","revision":7,"totalRows":2,""" +
            """"nativeCliTargets":[{"id":"claude-default","backend":"claude","label":"Claude default"},""" +
            """{"id":"codex-review","backend":"codex","label":"Codex review"}]}"""
        val frame = assertIs<RosterFrame.SnapshotEnd>(RosterProtocol.decode(json.encodeToByteArray()))
        assertEquals(
            listOf(
                NativeCliTarget("claude-default", NativeCliBackend.CLAUDE, "Claude default"),
                NativeCliTarget("codex-review", NativeCliBackend.CODEX, "Codex review"),
            ),
            frame.nativeCliTargets,
        )
        assertEquals(json, RosterProtocol.encode(frame).decodeToString())
        assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)))
    }

    @Test
    fun `absent catalog is honest absence and an old snapshot end keeps its exact shape`() {
        val json = """{"type":"snapshot_end","subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}",""" +
            """"transferId":"${RosterFixtures.TRANSFER_ID}","revision":7,"totalRows":2}"""
        val frame = assertIs<RosterFrame.SnapshotEnd>(RosterProtocol.decode(json.encodeToByteArray()))
        assertNull(frame.nativeCliTargets)
        assertEquals(json, RosterProtocol.encode(frame).decodeToString())
    }

    @Test
    fun `an empty advertised catalog is distinct from absence`() {
        val frame = RosterFrame.SnapshotEnd(
            RosterFixtures.SUBSCRIPTION_ID, RosterFixtures.TRANSFER_ID, 7L, 0L, emptyList(),
        )
        val decoded = assertIs<RosterFrame.SnapshotEnd>(RosterProtocol.decode(RosterProtocol.encode(frame)))
        assertEquals(emptyList(), decoded.nativeCliTargets)
    }

    @Test
    fun `a malformed or private-bearing catalog refuses the whole frame`() {
        val prefix = """{"type":"snapshot_end","subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}",""" +
            """"transferId":"${RosterFixtures.TRANSFER_ID}","revision":7,"totalRows":2,"nativeCliTargets":"""
        for (catalog in listOf(
            "null",
            "{}",
            """[{"id":"a","backend":"claude"}]""",
            """[{"id":"a","backend":"claude","label":"A","command":"rm -rf /"}]""",
            """[{"id":"a","backend":"gemini","label":"A"}]""",
            """[{"id":"a","backend":"claude","label":"A"},{"id":"a","backend":"codex","label":"B"}]""",
            """[{"id":"a","backend":"claude","label":"A\nB"}]""",
        )) {
            assertBadFrame(prefix + catalog + "}")
        }
    }

    @Test
    fun `row backend is the closed owner identity and absent stays the legacy Pi row`() {
        val withBackend = RosterFixtures.bareRowJson().replace(
            """"label":"Row row-1",""",
            """"label":"Row row-1","backend":"claude",""",
        )
        val row = assertIs<RemoteSessionMetadata>(RosterMetadataRow.parse(kotlinx.serialization.json.Json.parseToJsonElement(withBackend)))
        assertEquals(SessionBackend.CLAUDE, row.backend)
        assertEquals(NativeCliBackend.CLAUDE, row.backend?.nativeCliOrNull())
        val encoded = RosterMetadataRow.encode(row)
        assertTrue(encoded.contains(""""label":"Row row-1","backend":"claude","""), encoded)
        assertEquals(row, RosterMetadataRow.parse(kotlinx.serialization.json.Json.parseToJsonElement(encoded)))

        val legacy = assertIs<RemoteSessionMetadata>(
            RosterMetadataRow.parse(kotlinx.serialization.json.Json.parseToJsonElement(RosterFixtures.bareRowJson())),
        )
        assertNull(legacy.backend)
        assertTrue(!RosterMetadataRow.encode(legacy).contains("backend"))
    }

    @Test
    fun `present row backend is never null foreign or inferred`() {
        for (value in listOf("null", "\"gemini\"", "\"CLAUDE\"", "3")) {
            val json = RosterFixtures.bareRowJson().replace(
                """"label":"Row row-1",""",
                """"label":"Row row-1","backend":$value,""",
            )
            assertNull(RosterMetadataRow.parse(kotlinx.serialization.json.Json.parseToJsonElement(json)))
        }
    }

    @Test
    fun `a malformed row backend refuses the whole page frame`() {
        val row = RosterFixtures.bareRowJson().replace(
            """"label":"Row row-1",""",
            """"label":"Row row-1","backend":"gemini",""",
        )
        assertBadFrame(
            """{"type":"snapshot_page","subscriptionId":"${RosterFixtures.SUBSCRIPTION_ID}",""" +
                """"transferId":"${RosterFixtures.TRANSFER_ID}","pageIndex":0,"rows":[$row]}""",
        )
        // The same page without a backend is the exact legacy shape and still decodes.
        val legacy = assertIs<RosterFrame.SnapshotPage>(
            RosterProtocol.decode(RosterFixtures.snapshotPageJson().encodeToByteArray()),
        )
        assertTrue(legacy.rows.all { it.backend == null })
    }

    @Test
    fun `native create request and result use the exact closed wire`() {
        val request = RosterFrame.NativeCreateRequest(
            requestId = RosterFixtures.REQUEST_ID,
            hostRunId = RosterFixtures.HOST_RUN_ID,
            workspace = "/srv/owner/workspace",
            backend = NativeCliBackend.CLAUDE,
            targetId = "claude-default",
            sequence = 3L,
        )
        val json = """{"type":"create_native_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
            """"workspace":"/srv/owner/workspace","backend":"claude","targetId":"claude-default","sequence":3}"""
        assertEquals(json, RosterProtocol.encode(request).decodeToString())
        assertEquals(request, RosterProtocol.decode(json.encodeToByteArray()))
        for (outcome in listOf(
            OwnerCreateFacts.Started(RosterFixtures.HOST_RUN_ID, "row-9"),
            OwnerCreateFacts.Unconfirmed,
            OwnerCreateFacts.Refused,
            OwnerCreateFacts.Unknown,
        )) {
            val frame = RosterFrame.NativeCreateResult(RosterFixtures.REQUEST_ID, outcome)
            assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)))
        }
    }

    @Test
    fun `native host caption is separate from the Pi rename tuple`() {
        val request = RosterFrame.NativeRenameRequest(
            requestId = RosterFixtures.REQUEST_ID,
            hostRunId = RosterFixtures.HOST_RUN_ID,
            rowId = "row-1",
            backend = NativeCliBackend.CODEX,
            name = "Review row",
            sequence = 4L,
        )
        val json = """{"type":"rename_native_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
            """"rowId":"row-1","backend":"codex","name":"Review row","sequence":4}"""
        assertEquals(json, RosterProtocol.encode(request).decodeToString())
        assertEquals(request, RosterProtocol.decode(json.encodeToByteArray()))
        for (outcome in OwnerNativeRenameFacts.entries) {
            val frame = RosterFrame.NativeRenameResult(RosterFixtures.REQUEST_ID, outcome)
            assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)))
            assertTrue(!RosterProtocol.encode(frame).decodeToString().contains("expectedSession"))
        }
        assertBadFrame("""{"type":"rename_native_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
            """"rowId":"row-1","backend":"codex","expectedSessionId":"conversation-1","name":"Row","sequence":1}""")
    }

    @Test
    fun `native caption bounds are enforced without trimming`() {
        val accepted = "a".repeat(80)
        assertRoundTrip(
            """{"type":"rename_native_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"rowId":"row-1","backend":"claude","name":"$accepted","sequence":1}""",
        )
        for (name in listOf("a".repeat(81), " padded", "padded ", "   ", "a\nb")) {
            assertEncodeRefused(
                RosterFrame.NativeRenameRequest(
                    RosterFixtures.REQUEST_ID, RosterFixtures.HOST_RUN_ID, "row-1",
                    NativeCliBackend.CLAUDE, name, 1L,
                ),
            )
        }
    }

    @Test
    fun `catalog and target rules are bounded and closed`() {
        for (target in listOf(
            NativeCliTarget("", NativeCliBackend.CLAUDE, "A"),
            NativeCliTarget("a".repeat(129), NativeCliBackend.CLAUDE, "A"),
            NativeCliTarget("a", NativeCliBackend.CLAUDE, ""),
            NativeCliTarget("a", NativeCliBackend.CLAUDE, "a".repeat(129)),
            NativeCliTarget("a", NativeCliBackend.CLAUDE, "a\nb"),
        )) {
            assertEncodeRefused(
                RosterFrame.SnapshotEnd(
                    RosterFixtures.SUBSCRIPTION_ID, RosterFixtures.TRANSFER_ID, 1L, 0L, listOf(target),
                ),
            )
        }
        assertEncodeRefused(
            RosterFrame.SnapshotEnd(
                RosterFixtures.SUBSCRIPTION_ID, RosterFixtures.TRANSFER_ID, 1L, 0L,
                listOf(target, target),
            ),
        )
    }
}
