package io.github.rfairburn.pireviewgate.core.protocol.roster

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Capability negotiation.
 *
 * Negotiation can only narrow what either side may assume. A different service or
 * major version is refused, the required baseline capability is refused when
 * missing, and an acknowledgement that claims more than this side offered is a
 * protocol violation rather than a feature.
 */
class RosterNegotiationTest {

    @Test
    fun `accepts a hello for this lane and keeps only the known optional capabilities`() {
        assertEquals(
            RosterNegotiation.Accepted(
                major = RosterWire.MAJOR,
                minor = RosterWire.MINOR,
                capabilities = listOf(RosterWire.CLOSE_CAPABILITY, RosterWire.SAVED_CAPABILITY),
            ),
            RosterProtocol.negotiateHello(
                RosterFrame.Hello(
                    service = RosterWire.SERVICE,
                    major = RosterWire.MAJOR,
                    minor = RosterWire.MINOR,
                    capabilities = listOf(
                        RosterWire.REQUIRED_CAPABILITY,
                        RosterWire.CLOSE_CAPABILITY,
                        RosterWire.SAVED_CAPABILITY,
                    ),
                ),
            ),
        )
    }

    @Test
    fun `drops a capability this lane has never heard of instead of adopting it`() {
        val accepted = RosterProtocol.negotiateHello(
            RosterFrame.Hello(
                service = RosterWire.SERVICE,
                major = RosterWire.MAJOR,
                minor = RosterWire.MINOR,
                capabilities = listOf(RosterWire.REQUIRED_CAPABILITY, "roster-future-v9"),
            ),
        )
        assertEquals(
            RosterNegotiation.Accepted(RosterWire.MAJOR, RosterWire.MINOR, emptyList()),
            accepted,
        )
    }

    @Test
    fun `a minor version grants no capability on its own`() {
        assertEquals(
            RosterNegotiation.Accepted(RosterWire.MAJOR, 0L, emptyList()),
            RosterProtocol.negotiateHello(
                RosterFrame.Hello(RosterWire.SERVICE, RosterWire.MAJOR, 0L, listOf(RosterWire.REQUIRED_CAPABILITY)),
            ),
        )
        // A minor above this build is narrowed to this build, never adopted.
        assertEquals(
            RosterNegotiation.Accepted(RosterWire.MAJOR, RosterWire.MINOR, emptyList()),
            RosterProtocol.negotiateHello(
                RosterFrame.Hello(RosterWire.SERVICE, RosterWire.MAJOR, 99L, listOf(RosterWire.REQUIRED_CAPABILITY)),
            ),
        )
    }

    @Test
    fun `refuses a hello for another service or another major version`() {
        for (hello in listOf(
            RosterFrame.Hello("pi-peer-control-v1", RosterWire.MAJOR, RosterWire.MINOR, listOf(RosterWire.REQUIRED_CAPABILITY)),
            RosterFrame.Hello(RosterWire.SERVICE, RosterWire.MAJOR + 1L, RosterWire.MINOR, listOf(RosterWire.REQUIRED_CAPABILITY)),
            RosterFrame.Hello(RosterWire.SERVICE, 0L, RosterWire.MINOR, listOf(RosterWire.REQUIRED_CAPABILITY)),
        )
        ) {
            assertEquals(
                RosterNegotiation.Refused(RosterWireErrorCode.UNSUPPORTED_VERSION),
                RosterProtocol.negotiateHello(hello),
                "must refuse $hello",
            )
        }
    }

    @Test
    fun `refuses a hello that does not announce the required baseline capability`() {
        assertEquals(
            RosterNegotiation.Refused(RosterWireErrorCode.MISSING_CAPABILITY),
            RosterProtocol.negotiateHello(
                RosterFrame.Hello(RosterWire.SERVICE, RosterWire.MAJOR, RosterWire.MINOR, listOf(RosterWire.CLOSE_CAPABILITY)),
            ),
        )
        assertEquals(
            RosterNegotiation.Refused(RosterWireErrorCode.MISSING_CAPABILITY),
            RosterProtocol.negotiateHello(
                RosterFrame.Hello(RosterWire.SERVICE, RosterWire.MAJOR, RosterWire.MINOR, emptyList()),
            ),
        )
    }

    @Test
    fun `accepts a hello ack that stays inside what this side offered`() {
        val offered = listOf(RosterWire.REQUIRED_CAPABILITY, RosterWire.SAVED_CAPABILITY)
        assertEquals(
            RosterAckVerdict.Accepted(0L, listOf(RosterWire.REQUIRED_CAPABILITY)),
            RosterProtocol.reviewHelloAck(
                RosterFrame.HelloAck(RosterWire.SERVICE, RosterWire.MAJOR, 0L, listOf(RosterWire.REQUIRED_CAPABILITY)),
                offered,
            ),
        )
        assertEquals(
            RosterAckVerdict.Accepted(RosterWire.MINOR, offered),
            RosterProtocol.reviewHelloAck(
                RosterFrame.HelloAck(RosterWire.SERVICE, RosterWire.MAJOR, RosterWire.MINOR, offered),
                offered,
            ),
        )
    }

    @Test
    fun `refuses a hello ack that widens what this side offered`() {
        val offered = listOf(RosterWire.REQUIRED_CAPABILITY)
        assertEquals(
            RosterAckVerdict.Refused(RosterWireErrorCode.PROTOCOL_VIOLATION),
            RosterProtocol.reviewHelloAck(
                RosterFrame.HelloAck(
                    RosterWire.SERVICE,
                    RosterWire.MAJOR,
                    RosterWire.MINOR,
                    listOf(RosterWire.REQUIRED_CAPABILITY, RosterWire.SAVED_CAPABILITY),
                ),
                offered,
            ),
            "an unoffered capability must be refused",
        )
        assertEquals(
            RosterAckVerdict.Refused(RosterWireErrorCode.PROTOCOL_VIOLATION),
            RosterProtocol.reviewHelloAck(
                RosterFrame.HelloAck(RosterWire.SERVICE, RosterWire.MAJOR, 1L, listOf(RosterWire.REQUIRED_CAPABILITY)),
                offered,
            ),
            "a minor above the offered minor must be refused",
        )
        assertEquals(
            RosterAckVerdict.Refused(RosterWireErrorCode.MISSING_CAPABILITY),
            RosterProtocol.reviewHelloAck(
                RosterFrame.HelloAck(RosterWire.SERVICE, RosterWire.MAJOR, 0L, listOf(RosterWire.SAVED_CAPABILITY)),
                offered,
            ),
            "a missing baseline acknowledgement must be refused",
        )
        assertEquals(
            RosterAckVerdict.Refused(RosterWireErrorCode.UNSUPPORTED_VERSION),
            RosterProtocol.reviewHelloAck(
                RosterFrame.HelloAck(RosterWire.SERVICE, RosterWire.MAJOR + 1L, 0L, listOf(RosterWire.REQUIRED_CAPABILITY)),
                offered,
            ),
            "a different major version must be refused",
        )
    }

    @Test
    fun `the optional capabilities are exactly the ones this lane knows`() {
        assertEquals(
            listOf(
                RosterWire.CLOSE_CAPABILITY,
                RosterWire.CREATE_CAPABILITY,
                RosterWire.SAVED_CAPABILITY,
                RosterWire.RENAME_CAPABILITY,
                RosterWire.ROSTER_SLOT_CAPABILITY,
            ),
            RosterWire.KNOWN_OPTIONAL_CAPABILITIES,
        )
        assertEquals("roster-v1", RosterWire.REQUIRED_CAPABILITY)
        for (capability in RosterWire.KNOWN_OPTIONAL_CAPABILITIES) {
            assertTrue(capability != RosterWire.REQUIRED_CAPABILITY, "an optional capability must not be the baseline")
        }
    }
}
