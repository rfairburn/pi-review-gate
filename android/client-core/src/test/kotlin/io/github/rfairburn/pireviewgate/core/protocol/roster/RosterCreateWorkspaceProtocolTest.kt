package io.github.rfairburn.pireviewgate.core.protocol.roster

import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The request-specific create-workspace flag on the roster wire (#493): the shared
 * capability identifier, its create-lane dependency, and the optional boolean on
 * both create requests. Unchecked requests must stay byte-identical to the legacy
 * frames an older owner accepts; a present value must be a real JSON boolean.
 * Everything here is synthetic and checks the settled shared contract only.
 */
class RosterCreateWorkspaceProtocolTest {

    private val run = RosterFixtures.HOST_RUN_ID

    private fun hello(vararg capabilities: String) = RosterFrame.Hello(
        RosterWire.SERVICE, RosterWire.MAJOR, RosterWire.MINOR, listOf(RosterWire.REQUIRED_CAPABILITY, *capabilities),
    )

    private fun ack(vararg capabilities: String) = RosterFrame.HelloAck(
        RosterWire.SERVICE, RosterWire.MAJOR, RosterWire.MINOR, listOf(RosterWire.REQUIRED_CAPABILITY, *capabilities),
    )

    private fun negotiated(vararg capabilities: String): List<String> =
        (RosterProtocol.negotiateHello(hello(*capabilities)) as RosterNegotiation.Accepted).capabilities

    @Test
    fun `the capability identifier is the settled shared string`() {
        assertEquals("roster-create-workspace-v1", RosterWire.CREATE_WORKSPACE_CAPABILITY)
        assertTrue(RosterWire.CREATE_WORKSPACE_CAPABILITY in RosterWire.KNOWN_OPTIONAL_CAPABILITIES)
    }

    @Test
    fun `the flag is negotiated only beside a Pi or native create lane`() {
        val flag = RosterWire.CREATE_WORKSPACE_CAPABILITY
        assertEquals(listOf(RosterWire.CREATE_CAPABILITY, flag), negotiated(RosterWire.CREATE_CAPABILITY, flag))
        assertEquals(listOf(RosterWire.NATIVE_CAPABILITY, flag), negotiated(RosterWire.NATIVE_CAPABILITY, flag))
        assertEquals(
            listOf(RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_CAPABILITY, flag),
            negotiated(RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_CAPABILITY, flag),
        )
        // Without any create lane the owner side never negotiates the flag.
        assertEquals(listOf(RosterWire.CLOSE_CAPABILITY), negotiated(RosterWire.CLOSE_CAPABILITY, flag))
        assertEquals(emptyList(), negotiated(flag))
        // The two dependencies are independent: dropping one never drops the other.
        assertEquals(
            listOf(RosterWire.CREATE_CAPABILITY, flag),
            negotiated(RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_AVAILABILITY_CAPABILITY, flag),
        )
        assertFalse(RosterWire.dependenciesHold(listOf(flag)))
        assertTrue(RosterWire.dependenciesHold(listOf(RosterWire.NATIVE_CAPABILITY, flag)))
    }

    @Test
    fun `an acknowledgement of the flag without a create lane is a protocol violation`() {
        val offered = listOf(
            RosterWire.REQUIRED_CAPABILITY,
            RosterWire.CLOSE_CAPABILITY,
            RosterWire.CREATE_CAPABILITY,
            RosterWire.NATIVE_CAPABILITY,
            RosterWire.CREATE_WORKSPACE_CAPABILITY,
        )
        assertEquals(
            RosterAckVerdict.Refused(RosterWireErrorCode.PROTOCOL_VIOLATION),
            RosterProtocol.reviewHelloAck(ack(RosterWire.CREATE_WORKSPACE_CAPABILITY), offered),
        )
        assertEquals(
            RosterAckVerdict.Refused(RosterWireErrorCode.PROTOCOL_VIOLATION),
            RosterProtocol.reviewHelloAck(ack(RosterWire.CLOSE_CAPABILITY, RosterWire.CREATE_WORKSPACE_CAPABILITY), offered),
        )
        for (lane in listOf(RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_CAPABILITY)) {
            val accepted = assertIs<RosterAckVerdict.Accepted>(
                RosterProtocol.reviewHelloAck(ack(lane, RosterWire.CREATE_WORKSPACE_CAPABILITY), offered),
            )
            assertTrue(RosterWire.CREATE_WORKSPACE_CAPABILITY in accepted.capabilities)
        }
        // An older owner that never heard of the flag stays fully accepted.
        val legacy = assertIs<RosterAckVerdict.Accepted>(
            RosterProtocol.reviewHelloAck(ack(RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_CAPABILITY), offered),
        )
        assertFalse(RosterWire.CREATE_WORKSPACE_CAPABILITY in legacy.capabilities)
        // An acknowledgement of a flag this side never offered widens nothing.
        assertEquals(
            RosterAckVerdict.Refused(RosterWireErrorCode.PROTOCOL_VIOLATION),
            RosterProtocol.reviewHelloAck(
                ack(RosterWire.CREATE_CAPABILITY, RosterWire.CREATE_WORKSPACE_CAPABILITY),
                listOf(RosterWire.REQUIRED_CAPABILITY, RosterWire.CREATE_CAPABILITY),
            ),
        )
    }

    @Test
    fun `an unchecked Pi create stays byte-identical to the legacy frame`() {
        val legacy = """{"type":"create_request","requestId":"req-1","hostRunId":"$run",""" +
            """"workspace":"/srv/owner/new","sequence":2}"""
        val unchecked = RosterFrame.CreateRequest(RosterFixtures.REQUEST_ID, run, "/srv/owner/new", 2L)
        assertEquals(legacy, RosterProtocol.encode(unchecked).decodeToString())
        assertEquals(
            legacy,
            RosterProtocol.encode(unchecked.copy(createWorkspace = false)).decodeToString(),
        )
        assertEquals(unchecked, RosterProtocol.decode(legacy.encodeToByteArray()))
    }

    @Test
    fun `an unchecked native create stays byte-identical to the legacy frame`() {
        val legacy = """{"type":"create_native_request","requestId":"req-1","hostRunId":"$run",""" +
            """"workspace":"/srv/owner/new","backend":"codex","targetId":"codex","sequence":5}"""
        val unchecked = RosterFrame.NativeCreateRequest(
            RosterFixtures.REQUEST_ID, run, "/srv/owner/new", NativeCliBackend.CODEX, "codex", 5L,
        )
        assertEquals(legacy, RosterProtocol.encode(unchecked).decodeToString())
        assertEquals(unchecked, RosterProtocol.decode(legacy.encodeToByteArray()))
    }

    @Test
    fun `a checked create carries the boolean and round trips on both lanes`() {
        val pi = RosterFrame.CreateRequest(RosterFixtures.REQUEST_ID, run, "/srv/owner/new", 2L, createWorkspace = true)
        val piJson = """{"type":"create_request","requestId":"req-1","hostRunId":"$run",""" +
            """"workspace":"/srv/owner/new","sequence":2,"createWorkspace":true}"""
        assertEquals(piJson, RosterProtocol.encode(pi).decodeToString())
        assertEquals(pi, RosterProtocol.decode(piJson.encodeToByteArray()))

        val native = RosterFrame.NativeCreateRequest(
            RosterFixtures.REQUEST_ID, run, "/srv/owner/new", NativeCliBackend.CLAUDE, "claude", 3L,
            createWorkspace = true,
        )
        val nativeJson = """{"type":"create_native_request","requestId":"req-1","hostRunId":"$run",""" +
            """"workspace":"/srv/owner/new","backend":"claude","targetId":"claude","sequence":3,"createWorkspace":true}"""
        assertEquals(nativeJson, RosterProtocol.encode(native).decodeToString())
        assertEquals(native, RosterProtocol.decode(nativeJson.encodeToByteArray()))
    }

    @Test
    fun `an explicit false decodes as unchecked and re-encodes without the field`() {
        val explicit = """{"type":"create_request","requestId":"req-1","hostRunId":"$run",""" +
            """"workspace":"/srv/owner/new","createWorkspace":false,"sequence":2}"""
        val decoded = assertIs<RosterFrame.CreateRequest>(RosterProtocol.decode(explicit.encodeToByteArray()))
        assertFalse(decoded.createWorkspace)
        assertFalse(RosterProtocol.encode(decoded).decodeToString().contains("createWorkspace"))
        val nativeExplicit = """{"type":"create_native_request","requestId":"req-1","hostRunId":"$run",""" +
            """"workspace":"/srv/owner/new","backend":"claude","targetId":"claude","sequence":3,"createWorkspace":false}"""
        assertFalse(
            assertIs<RosterFrame.NativeCreateRequest>(RosterProtocol.decode(nativeExplicit.encodeToByteArray()))
                .createWorkspace,
        )
    }

    @Test
    fun `a non-boolean flag is refused on both lanes rather than coerced`() {
        for (value in listOf("null", "\"true\"", "\"false\"", "1", "0", "{}", "[]", "[true]")) {
            assertBadFrame(
                """{"type":"create_request","requestId":"req-1","hostRunId":"$run",""" +
                    """"workspace":"/srv/owner/new","sequence":2,"createWorkspace":$value}""",
            )
            assertBadFrame(
                """{"type":"create_native_request","requestId":"req-1","hostRunId":"$run",""" +
                    """"workspace":"/srv/owner/new","backend":"claude","targetId":"claude","sequence":3,""" +
                    """"createWorkspace":$value}""",
            )
        }
        // The flag rides only the two create requests; no other frame may carry it.
        assertBadFrame(
            """{"type":"rename_native_request","requestId":"req-1","hostRunId":"$run",""" +
                """"rowId":"row-1","backend":"codex","name":"Row","sequence":1,"createWorkspace":true}""",
        )
    }
}
