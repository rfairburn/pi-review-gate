package io.github.rfairburn.pireviewgate.core.protocol.roster

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Bounds are negotiated limits inside fixed rules. A zero or negative bound, a page
 * larger than a frame, a snapshot that cannot hold one page, or a snapshot budget
 * below one page is a construction error, never a runtime mode: there is no
 * "0 means unlimited" and nothing here raises the fixed protocol ceilings.
 */
class RosterBoundsTest {

    @Test
    fun `the defaults match the transport-compatible defaults of the source lane`() {
        val bounds = RosterBounds.DEFAULT
        assertEquals(65_536L, bounds.maxFrameBytes)
        assertEquals(65_536L, bounds.maxPageBytes)
        assertEquals(32L, bounds.maxRowsPerPage)
        assertEquals(4_096L, bounds.maxSnapshotRows)
        assertEquals(8L * 1_024L * 1_024L, bounds.maxSnapshotBytes)
        assertEquals(16L, bounds.maxCapabilities)
        assertEquals(64L, bounds.maxCapabilityIdBytes)
        assertEquals(64L, bounds.maxIdentifierBytes)
    }

    @Test
    fun `the Saved window frame cap is derived and never used to size an allocation`() {
        val expected = RosterBounds.DEFAULT.maxSnapshotRows +
            (2L * RosterBounds.DEFAULT.maxSnapshotBytes + 1_023L) / 1_024L
        assertEquals(expected, RosterBounds.DEFAULT.savedWindowMaxFrames)
        assertEquals(expected, RosterProtocol.savedWindowMaxFrames())
        // A tightened transfer bound tightens the derived cap with it.
        val tight = RosterBounds(maxSnapshotRows = 40L, maxSnapshotBytes = 64L * 1_024L)
        assertEquals(40L + (2L * 65_536L + 1_023L) / 1_024L, tight.savedWindowMaxFrames)
        assertTrue(tight.savedWindowMaxFrames < RosterBounds.DEFAULT.savedWindowMaxFrames)
    }

    @Test
    fun `a zero or negative bound is refused at construction`() {
        val builders = listOf<(Long) -> RosterBounds>(
            { value -> RosterBounds(maxFrameBytes = value, maxPageBytes = value) },
            { value -> RosterBounds(maxRowsPerPage = value) },
            { value -> RosterBounds(maxPageBytes = value, maxFrameBytes = value) },
            { value -> RosterBounds(maxSnapshotRows = value) },
            { value -> RosterBounds(maxSnapshotBytes = value) },
            { value -> RosterBounds(maxCapabilities = value) },
            { value -> RosterBounds(maxCapabilityIdBytes = value) },
            { value -> RosterBounds(maxIdentifierBytes = value) },
            { value -> RosterBounds(helloTimeoutMs = value) },
            { value -> RosterBounds(closeResultTimeoutMs = value) },
        )
        for (builder in builders) {
            assertRefused("zero must be refused", builder, 0L)
            assertRefused("negative must be refused", builder, -1L)
        }
    }

    private fun assertRefused(context: String, builder: (Long) -> RosterBounds, value: Long) {
        val failure = runCatching { builder(value) }.exceptionOrNull()
        assertTrue(
            failure is RosterProtocolException && failure.code == RosterFailureCode.INVALID_BOUNDS,
            "$context ($value) must be refused as INVALID_BOUNDS, got $failure",
        )
    }

    @Test
    fun `bounds that contradict each other are refused`() {
        // A page cannot be larger than the frame that carries it.
        assertInvalidBounds { RosterBounds(maxFrameBytes = 1_024L, maxPageBytes = 2_048L) }
        // A snapshot must be able to hold at least one full page.
        assertInvalidBounds { RosterBounds(maxRowsPerPage = 64L, maxSnapshotRows = 32L) }
        // A snapshot budget cannot be below one page.
        assertInvalidBounds {
            RosterBounds(maxFrameBytes = 4_096L, maxPageBytes = 4_096L, maxSnapshotBytes = 2_048L)
        }
        // The coherent shape of the same tightening is accepted.
        RosterBounds(maxFrameBytes = 4_096L, maxPageBytes = 4_096L, maxSnapshotBytes = 8_192L, maxRowsPerPage = 8L)
    }

    private fun assertInvalidBounds(builder: () -> RosterBounds) {
        val failure = runCatching(builder).exceptionOrNull()
        assertTrue(
            failure is RosterProtocolException && failure.code == RosterFailureCode.INVALID_BOUNDS,
            "incoherent bounds must be refused as INVALID_BOUNDS, got $failure",
        )
    }

    @Test
    fun `a frame over maxFrameBytes is refused whole and one inside it is accepted`() {
        val bounds = RosterBounds(maxFrameBytes = 512L, maxPageBytes = 512L)
        val frame = RosterFrame.Unsubscribe(RosterFixtures.SUBSCRIPTION_ID)
        val encoded = RosterProtocol.encode(frame, bounds)
        assertTrue(encoded.size <= 512, "the fixture must fit inside the tightened bound")
        assertEquals(frame, RosterProtocol.decode(encoded, bounds))

        val oversized = (
            """{"type":"saved_window_fragment","requestId":"req-1","pageIndex":0,"part":0,"parts":1,"text":"""" +
                """${"x".repeat(600)}"}"""
            ).encodeToByteArray()
        assertTrue(oversized.size > 512, "the fixture must exceed the tightened bound")
        val failure = runCatching { RosterProtocol.decode(oversized, bounds) }.exceptionOrNull()
        assertTrue(
            failure is RosterProtocolException && failure.code == RosterFailureCode.FRAME_TOO_LARGE,
            "an oversized frame must be refused whole, got $failure",
        )
        // Encoding past the bound is refused too, rather than split or truncated.
        val encodeFailure = runCatching {
            RosterProtocol.encode(
                RosterFrame.SavedWindowFragment("req-1", 0L, 0L, 1L, "y".repeat(600)),
                bounds,
            )
        }.exceptionOrNull()
        assertTrue(
            encodeFailure is RosterProtocolException && encodeFailure.code == RosterFailureCode.FRAME_TOO_LARGE,
            "an oversized encoded frame must be refused, got $encodeFailure",
        )
    }

    @Test
    fun `an identifier over maxIdentifierBytes is refused in both directions`() {
        val bounds = RosterBounds(maxIdentifierBytes = 8L)
        assertTrue(!RosterProtocol.isIdentifier("i".repeat(9), bounds))
        assertTrue(RosterProtocol.isIdentifier("i".repeat(8), bounds))
        val failure = runCatching {
            RosterProtocol.encode(RosterFrame.Subscribe("i".repeat(9)), bounds)
        }.exceptionOrNull()
        assertTrue(
            failure is RosterProtocolException && failure.code == RosterFailureCode.INVALID_FRAME,
            "an oversized identifier must be refused on encode, got $failure",
        )
        val decodeFailure = runCatching {
            RosterProtocol.decode("""{"type":"subscribe","subscriptionId":"${"i".repeat(9)}"}""".encodeToByteArray(), bounds)
        }.exceptionOrNull()
        assertTrue(
            decodeFailure is RosterProtocolException && decodeFailure.code == RosterFailureCode.BAD_FRAME,
            "an oversized identifier must be refused on decode, got $decodeFailure",
        )
    }

    @Test
    fun `the identifier rule keeps real ids and refuses shaped lookalikes`() {
        for (value in listOf("row-1", "t-7", "cat.a:b", "c", "0", "a-b_c.1:2", RosterFixtures.HOST_RUN_ID)) {
            assertTrue(RosterProtocol.isIdentifier(value), "must accept $value")
        }
        for (value in listOf("", " ", "has space", "../escape", "a/b", "a\\b", "a\u0000b", "-lead", ":lead", ".lead")) {
            assertTrue(!RosterProtocol.isIdentifier(value), "must refuse $value")
        }
    }

    @Test
    fun `a bound beyond the positive safe-integer range is refused at construction`() {
        val builders = listOf<(Long) -> RosterBounds>(
            { value -> RosterBounds(maxFrameBytes = value, maxPageBytes = value) },
            { value -> RosterBounds(maxRowsPerPage = value) },
            { value -> RosterBounds(maxSnapshotRows = value) },
            { value -> RosterBounds(maxSnapshotBytes = value) },
            { value -> RosterBounds(maxCapabilities = value) },
            { value -> RosterBounds(maxCapabilityIdBytes = value) },
            { value -> RosterBounds(maxIdentifierBytes = value) },
            { value -> RosterBounds(helloTimeoutMs = value) },
            { value -> RosterBounds(closeResultTimeoutMs = value) },
        )
        for (builder in builders) {
            assertRefused("beyond the safe-integer ceiling", builder, MAX_SAFE_INTEGER + 1L)
            assertRefused("the largest Long", builder, Long.MAX_VALUE)
        }
    }

    @Test
    fun `a byte bound above the Int range still accepts an ordinary identifier or capability`() {
        // Int.MAX_VALUE + 1. Narrowing this to an Int would turn it negative and make
        // the lane refuse the shortest identifier it is asked to carry.
        val wide = RosterBounds(maxIdentifierBytes = 2_147_483_648L, maxCapabilityIdBytes = 2_147_483_648L)
        val frame = RosterFrame.Subscribe(RosterFixtures.SUBSCRIPTION_ID)
        assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame, wide), wide))
        val hello = RosterFixtures.hello()
        assertEquals(hello, RosterProtocol.decode(RosterProtocol.encode(hello, wide), wide))
        assertTrue(RosterProtocol.isIdentifier(RosterFixtures.SUBSCRIPTION_ID, wide))

        // It is still a real bound, not an unbounded mode: the same frame is refused
        // when the declared identifier budget is smaller than the identifier.
        val tight = RosterBounds(maxIdentifierBytes = 1L, maxCapabilityIdBytes = 1L)
        val failure = runCatching {
            RosterProtocol.decode(RosterProtocol.encode(frame, wide), tight)
        }.exceptionOrNull()
        assertTrue(
            failure is RosterProtocolException && failure.code == RosterFailureCode.BAD_FRAME,
            "an identifier past the declared bound must still be refused, got $failure",
        )
    }

    @Test
    fun `the fixed protocol ceilings are not configurable`() {
        assertEquals(1, RosterWire.MAX_SUBSCRIPTIONS_PER_CHANNEL)
        assertEquals(1, RosterWire.MAX_IN_FLIGHT_TRANSFERS)
        assertEquals(1, RosterWire.MAX_PENDING_SNAPSHOTS)
        assertEquals(9_007_199_254_740_991L, MAX_SAFE_INTEGER)
    }
}
