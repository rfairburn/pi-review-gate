package io.github.rfairburn.pireviewgate.core.protocol.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.internal.RosterJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Encoding is the same closed contract seen from the other side.
 *
 * A model that cannot exist on the wire is refused instead of being written with a
 * default, and the bytes that are written are canonical: one key order, no spaces,
 * and no private owner field.
 */
class RosterEncodeTest {

    @Test
    fun `writes the canonical shape the source host writes`() {
        assertEquals(
            RosterFixtures.helloJson(),
            RosterProtocol.encode(RosterFixtures.hello()).decodeToString(),
        )
        assertEquals(
            """{"type":"subscribe","subscriptionId":"sub-1"}""",
            RosterProtocol.encode(RosterFrame.Subscribe("sub-1")).decodeToString(),
        )
        assertEquals(
            """{"type":"saved_policy","hostRunId":"${RosterFixtures.HOST_RUN_ID}","deleteExposed":true}""",
            RosterProtocol.encode(RosterFrame.SavedPolicy(RosterFixtures.HOST_RUN_ID, true)).decodeToString(),
        )
        assertEquals(
            """{"type":"error","code":"row_unrepresentable"}""",
            RosterProtocol.encode(RosterFrame.Failure(RosterWireErrorCode.ROW_UNREPRESENTABLE)).decodeToString(),
        )
        assertEquals(
            """{"type":"close_request","requestId":"req-1","hostRunId":"${RosterFixtures.HOST_RUN_ID}",""" +
                """"rowId":"row-1","confirmed":false}""",
            RosterProtocol.encode(
                RosterFrame.CloseRequest(RosterFixtures.REQUEST_ID, RosterFixtures.HOST_RUN_ID, "row-1", false),
            ).decodeToString(),
        )
    }

    @Test
    fun `omits an optional roster slot instead of writing a null`() {
        val withoutSlot = RosterProtocol.encode(pageOf(RosterFixtures.row("row-1"))).decodeToString()
        assertTrue(!withoutSlot.contains("rosterSlotId"), "an absent slot must not be written: $withoutSlot")

        val withSlot = RosterFixtures.row("row-1").copy(rosterSlotId = "slot-1")
        val frame = RosterFrame.SnapshotPage(RosterFixtures.SUBSCRIPTION_ID, RosterFixtures.TRANSFER_ID, 0L, listOf(withSlot))
        val encoded = RosterProtocol.encode(frame).decodeToString()
        assertTrue(encoded.contains("\"rosterSlotId\":\"slot-1\""), "a present slot must be written: $encoded")
        assertEquals(withSlot, (RosterProtocol.decode(RosterProtocol.encode(frame)) as RosterFrame.SnapshotPage).rows[0])
    }

    @Test
    fun `writes nullable observations only when the owner observed them`() {
        val unobserved = RosterProtocol.encode(
            RosterFrame.SnapshotPage(
                subscriptionId = RosterFixtures.SUBSCRIPTION_ID,
                transferId = RosterFixtures.TRANSFER_ID,
                pageIndex = 0L,
                rows = listOf(RosterFixtures.row("row-1")),
            ),
        ).decodeToString()
        for (key in listOf("exitCode", "error", "rosterSlotId")) {
            assertTrue(!unobserved.contains("\"$key\""), "an unobserved $key must not be written: $unobserved")
        }
        // An unobserved boolean is honest absence, and absence is written as null.
        assertTrue(unobserved.contains("\"busy\":null"), "an unobserved busy must be written as null")

        val observed = RosterProtocol.encode(
            RosterFrame.SnapshotPage(
                subscriptionId = RosterFixtures.SUBSCRIPTION_ID,
                transferId = RosterFixtures.TRANSFER_ID,
                pageIndex = 0L,
                rows = listOf(RosterFixtures.observedRow("row-3")),
            ),
        ).decodeToString()
        for (key in listOf("exitCode", "error", "rosterSlotId", "persistence")) {
            assertTrue(observed.contains("\"$key\""), "an observed $key must be written: $observed")
        }
        assertTrue(!observed.contains("\"busy\":null"), "an observed busy must not be written as null")
    }

    @Test
    fun `round trips every frame the lane can carry`() {
        for (frame in RosterFixtures.allFrames()) {
            assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)), "must round trip: $frame")
        }
    }

    @Test
    fun `round trips every owner outcome the lane can report`() {
        roundTrip(RosterFrame.CloseRequest(RosterFixtures.REQUEST_ID, RosterFixtures.HOST_RUN_ID, "row-1", true))
        for (outcome in OwnerCloseFacts.entries) {
            roundTrip(RosterFrame.CloseResult(RosterFixtures.REQUEST_ID, outcome))
        }
        roundTrip(RosterFrame.CreateRequest(RosterFixtures.REQUEST_ID, RosterFixtures.HOST_RUN_ID, "/srv/owner", 1L))
        roundTrip(
            RosterFrame.CreateResult(
                RosterFixtures.REQUEST_ID,
                OwnerCreateFacts.Started(RosterFixtures.HOST_RUN_ID, "row-9"),
            ),
        )
        for (outcome in listOf(OwnerCreateFacts.Unconfirmed, OwnerCreateFacts.Refused, OwnerCreateFacts.Unknown)) {
            roundTrip(RosterFrame.CreateResult(RosterFixtures.REQUEST_ID, outcome))
        }
        roundTrip(
            RosterFrame.RenameRequest(
                RosterFixtures.REQUEST_ID,
                RosterFixtures.HOST_RUN_ID,
                "row-1",
                "native-session-1",
                1L,
                "New name",
                1L,
            ),
        )
        for (outcome in OwnerRenameFacts.entries) {
            roundTrip(RosterFrame.RenameResult(RosterFixtures.REQUEST_ID, outcome))
        }
        for (outcome in listOf(
            OwnerSavedWindowOutcome.Refused(),
            OwnerSavedWindowOutcome.Refused(SavedWindowRefusalReason.BUSY),
            OwnerSavedWindowOutcome.Unavailable,
            OwnerSavedWindowOutcome.Unknown,
        )
        ) {
            roundTrip(RosterFrame.SavedWindowResult(RosterFixtures.REQUEST_ID, outcome))
        }
        for (outcome in listOf(
            OwnerSavedResumeFacts.Unconfirmed,
            OwnerSavedResumeFacts.Unknown,
            OwnerSavedResumeFacts.Refused(SavedResumeRefusalReason.STALE),
        )
        ) {
            roundTrip(RosterFrame.SavedResumeResult(RosterFixtures.REQUEST_ID, outcome))
        }
        for (outcome in listOf(
            OwnerSavedDeleteFacts.ConfirmationRequired,
            OwnerSavedDeleteFacts.Unconfirmed,
            OwnerSavedDeleteFacts.Unknown,
            OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH),
            OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.UNLINK),
            OwnerSavedDeleteFacts.Refused(SavedDeleteRefusalReason.POLICY),
        )
        ) {
            roundTrip(RosterFrame.SavedDeleteResult(RosterFixtures.REQUEST_ID, outcome))
        }
        roundTrip(RosterFrame.SavedPolicy(RosterFixtures.HOST_RUN_ID, true))
        roundTrip(RosterFrame.Failure(RosterWireErrorCode.RUN_CHANGED))
        roundTrip(RosterFrame.Failure(RosterWireErrorCode.TOO_MANY_SUBSCRIPTIONS, RosterFixtures.SUBSCRIPTION_ID))
    }

    private fun pageOf(row: RemoteSessionMetadata): RosterFrame.SnapshotPage =
        RosterFrame.SnapshotPage(RosterFixtures.SUBSCRIPTION_ID, RosterFixtures.TRANSFER_ID, 0L, listOf(row))

    private fun roundTrip(frame: RosterFrame) {
        assertEquals(frame, RosterProtocol.decode(RosterProtocol.encode(frame)), "must round trip: $frame")
    }

    @Test
    fun `escapes text exactly the way the source host writes it`() {
        // A Saved display string is the field the contract carries verbatim: any
        // well-formed Unicode, with no control, path, or line rule of its own.
        val astral = String(Character.toChars(0x1F5C2))
        val tricky = "quote\" backslash\\ newline\n tab\t bell\u0007 unit\u001F emoji$astral soft hyphen\u00AD"
        val entry = RosterFixtures.savedEntry(0).copy(caption = tricky)
        val frame = RosterFrame.SavedWindowPage(RosterFixtures.REQUEST_ID, 0L, listOf(entry))
        val bytes = RosterProtocol.encode(frame)
        val decoded = RosterProtocol.decode(bytes)
        assertEquals(tricky, (decoded as RosterFrame.SavedWindowPage).entries[0].caption)
        val text = bytes.decodeToString()
        assertTrue(!text.contains("\n"), "a raw newline must never reach the wire")
        assertTrue(!text.contains("\u0007"), "a raw bell must never reach the wire")
        assertTrue(!text.contains("\u001F"), "a raw unit separator must never reach the wire")
        assertTrue(text.contains("\\n"), "a newline must travel escaped")
        assertTrue(text.contains("\\u0007"), "a bell must travel as a four-digit escape")
        assertTrue(text.contains("\\u001f"), "a unit separator must travel as a four-digit escape")
        assertTrue(text.contains(astral), "a well-formed astral character travels as itself")
    }

    @Test
    fun `refuses a frame that could never have been accepted`() {
        assertEncodeRefused(RosterFrame.Hello("", 1L, 0L, listOf(RosterWire.REQUIRED_CAPABILITY)))
        assertEncodeRefused(RosterFrame.Hello(RosterWire.SERVICE, -1L, 0L, listOf(RosterWire.REQUIRED_CAPABILITY)))
        assertEncodeRefused(
            RosterFrame.Hello(
                RosterWire.SERVICE,
                1L,
                0L,
                listOf(RosterWire.REQUIRED_CAPABILITY, RosterWire.REQUIRED_CAPABILITY),
            ),
            "a duplicate capability must be refused",
        )
        assertEncodeRefused(
            RosterFrame.Hello(RosterWire.SERVICE, 1L, 0L, (1L..17L).map { "capability-$it" }),
            "more capabilities than the bound must be refused",
        )
        assertEncodeRefused(RosterFrame.Subscribe(""), "an empty subscription id must be refused")
        assertEncodeRefused(RosterFrame.Subscribe("has space"), "an unsafe identifier must be refused")
        assertEncodeRefused(
            RosterFrame.SnapshotBegin("sub-1", "t-1", RosterFixtures.HOST_RUN_ID, 0L, 0L, 0L),
            "a snapshot revision below one must be refused",
        )
        assertEncodeRefused(
            RosterFrame.SnapshotBegin("sub-1", "t-1", RosterFixtures.HOST_RUN_ID, 1L, 0L, 1L),
            "page count must follow the announced row count",
        )
    }

    @Test
    fun `refuses Saved window counts that contradict each other`() {
        assertEncodeRefused(
            RosterFrame.SavedWindowBegin(RosterFixtures.REQUEST_ID, RosterFixtures.HOST_RUN_ID, "cat-1", "res-1", 10L, 0L, 11L, 0L, 1L),
            "a window cannot start past its total",
        )
        assertEncodeRefused(
            RosterFrame.SavedWindowBegin(RosterFixtures.REQUEST_ID, RosterFixtures.HOST_RUN_ID, "cat-1", "res-1", 10L, 0L, 0L, 11L, 1L),
            "a window cannot carry more rows than its total",
        )
        assertEncodeRefused(
            RosterFrame.SavedWindowEnd(RosterFixtures.REQUEST_ID, rows = 2L, pageCount = 0L),
            "rows need at least one page",
        )
        assertEncodeRefused(
            RosterFrame.SavedWindowFragment(RosterFixtures.REQUEST_ID, 0L, 1L, 1L, "text"),
            "a part index must be inside the part count",
        )
        assertEncodeRefused(
            RosterFrame.SavedWindowFragment(RosterFixtures.REQUEST_ID, 0L, 0L, 1L, ""),
            "an empty fragment carries nothing",
        )
        assertEncodeRefused(
            RosterFrame.SavedWindowPage(
                RosterFixtures.REQUEST_ID,
                0L,
                listOf(RosterFixtures.savedEntry(0), RosterFixtures.savedEntry(0)),
            ),
            "one window cannot announce the same entry id twice",
        )
    }

    @Test
    fun `refuses a rename or create that is not canonical text`() {
        assertEncodeRefused(
            RosterFrame.RenameRequest(
                RosterFixtures.REQUEST_ID,
                RosterFixtures.HOST_RUN_ID,
                "row-1",
                "../escape",
                1L,
                "New name",
                1L,
            ),
            "a native session id cannot be a path",
        )
        assertEncodeRefused(
            RosterFrame.RenameRequest(
                RosterFixtures.REQUEST_ID,
                RosterFixtures.HOST_RUN_ID,
                "row-1",
                "native-session-1",
                0L,
                "New name",
                1L,
            ),
            "an epoch below one must be refused",
        )
        assertEncodeRefused(
            RosterFrame.RenameRequest(
                RosterFixtures.REQUEST_ID,
                RosterFixtures.HOST_RUN_ID,
                "row-1",
                "native-session-1",
                1L,
                "   ",
                1L,
            ),
            "a blank name must be refused",
        )
        assertEncodeRefused(RosterFrame.CreateRequest(RosterFixtures.REQUEST_ID, RosterFixtures.HOST_RUN_ID, "", 1L))
        assertEncodeRefused(
            RosterFrame.CreateRequest(RosterFixtures.REQUEST_ID, RosterFixtures.HOST_RUN_ID, "/srv/a\nb", 1L),
            "a workspace must stay on one line",
        )
        assertEncodeRefused(
            RosterFrame.CreateRequest(RosterFixtures.REQUEST_ID, RosterFixtures.HOST_RUN_ID, "/srv/a\u0000b", 1L),
            "a workspace cannot carry a null byte",
        )
    }

    @Test
    fun `refuses a model that tries to carry a private owner field as text`() {
        val page = RosterFrame.SnapshotPage(
            subscriptionId = RosterFixtures.SUBSCRIPTION_ID,
            transferId = RosterFixtures.TRANSFER_ID,
            pageIndex = 0L,
            rows = listOf(RosterFixtures.row("row-1").copy(label = RosterFixtures.SECRET_AGENT_DIR)),
        )
        val encoded = RosterProtocol.encode(page).decodeToString()
        assertTrue(
            !encoded.contains(RosterFixtures.SECRET_CURRENT_FILE),
            "an encoded row must never carry the owner's current file",
        )
        assertTrue(!encoded.contains("agentDir"), "an encoded row must never carry an agent directory key")
        assertTrue(!encoded.contains("currentFile"), "an encoded row must never carry a current-file key")
    }

    @Test
    fun `preserves an unpaired surrogate the way the source serializer does`() {
        // A native conversation id and a persisted rename name may each carry a code
        // unit that is not part of a pair. The source's serializer escapes such a unit,
        // so the value survives the wire unchanged instead of becoming a "?".
        val loneHigh = "\uD83D"
        val loneLow = "\uDE00"
        val pair = "\uD83D\uDE00"
        for (name in listOf("idle $loneHigh", "idle $loneLow", "idle $pair", "$loneHigh$loneHigh$loneLow")) {
            val frame = rename(name)
            val bytes = RosterProtocol.encode(frame)
            val text = bytes.decodeToString()
            assertTrue(!text.contains("?"), "an unpaired code unit became a question mark: $text")
            if (!name.contains(pair)) {
                assertTrue(
                    text.contains("\\ud83d") || text.contains("\\ude00"),
                    "an unpaired code unit must travel escaped: $text",
                )
            }
            assertEquals(name, (RosterProtocol.decode(bytes) as RosterFrame.RenameRequest).name)
            assertEquals(frame, RosterProtocol.decode(bytes))
        }
    }

    @Test
    fun `measures UTF-8 bytes the way the source measures them`() {
        assertEquals(1, RosterJson.utf8Length("a"))
        assertEquals(2, RosterJson.utf8Length("é"))
        assertEquals(3, RosterJson.utf8Length("日"))
        // A well-formed pair is one four-byte character.
        assertEquals(4, RosterJson.utf8Length("\uD83D\uDE00"))
        // Each unpaired code unit is replaced by U+FFFD: three bytes, never one.
        assertEquals(3, RosterJson.utf8Length("\uD800"))
        assertEquals(3, RosterJson.utf8Length("\uDC00"))
        assertEquals(4, RosterJson.utf8Length("\uD83DA"))
        assertEquals(4, RosterJson.utf8Length("A\uDE00"))
    }

    @Test
    fun `a byte bound is applied with the source measurement`() {
        // The persisted rename bound is 1024 UTF-8 bytes. Repeated high surrogates are
        // each unpaired, so 341 of them are 1023 bytes and one more is 1026: counting a
        // lone surrogate as one byte would let an oversized name through.
        val inside = RosterJson.utf8Length("\uD800".repeat(341))
        val outside = RosterJson.utf8Length("\uD800".repeat(342))
        assertEquals(1_023, inside)
        assertEquals(1_026, outside)
        val accepted = rename("\uD800".repeat(341))
        val roundTripped = (RosterProtocol.decode(RosterProtocol.encode(accepted)) as RosterFrame.RenameRequest).name
        assertEquals(1_023, RosterJson.utf8Length(roundTripped))
        assertEquals(accepted.name, roundTripped)
        assertEncodeRefused(rename("\uD800".repeat(342)), "a rename name past the byte bound")
    }

    private fun assertEncodeRefused(frame: RosterFrame, context: String = "") {
        val failure = runCatching { RosterProtocol.encode(frame) }.exceptionOrNull()
        assertTrue(
            failure is RosterProtocolException && failure.code == RosterFailureCode.INVALID_FRAME,
            "frame must be refused on encode, got $failure $context",
        )
    }

    private fun rename(name: String): RosterFrame.RenameRequest = RosterFrame.RenameRequest(
        requestId = RosterFixtures.REQUEST_ID,
        hostRunId = RosterFixtures.HOST_RUN_ID,
        rowId = "row-1",
        expectedSessionId = "conversation-1",
        expectedSessionEpoch = 2L,
        name = name,
        sequence = 1L,
    )
}
