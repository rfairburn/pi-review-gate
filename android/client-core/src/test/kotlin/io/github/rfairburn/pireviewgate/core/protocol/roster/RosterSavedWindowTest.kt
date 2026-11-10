package io.github.rfairburn.pireviewgate.core.protocol.roster

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Saved window assembly.
 *
 * A fragmented entry is carried whole: the concatenated fragment text must be exactly
 * the canonical encoding of one entry, and anything else — invalid JSON, another
 * shape, a non-canonical encoding — fails closed. Ids and handles stay opaque: this
 * contract never implies a local file.
 */
class RosterSavedWindowTest {

    @Test
    fun `reassembles a canonical entry text`() {
        assertEquals(
            RosterFixtures.savedEntry(0),
            RosterProtocol.decodeSavedEntryText(RosterFixtures.savedEntryJson(0)),
        )
    }

    @Test
    fun `reassembles an entry split at code point boundaries`() {
        val canonical = RosterFixtures.savedEntryJson(3)
        val first = canonical.substring(0, canonical.length / 3)
        val second = canonical.substring(canonical.length / 3, canonical.length * 2 / 3)
        val third = canonical.substring(canonical.length * 2 / 3)
        assertTrue(first.isNotEmpty() && second.isNotEmpty() && third.isNotEmpty(), "the split must keep every part")
        val fragments = listOf(
            RosterFrame.SavedWindowFragment("req-1", 1L, 0L, 3L, first),
            RosterFrame.SavedWindowFragment("req-1", 1L, 1L, 3L, second),
            RosterFrame.SavedWindowFragment("req-1", 1L, 2L, 3L, third),
        )
        for (fragment in fragments) {
            assertEquals(fragment, RosterProtocol.decode(RosterProtocol.encode(fragment)))
        }
        val joined = fragments.joinToString("") { it.text }
        assertEquals(canonical, joined)
        assertEquals(RosterFixtures.savedEntry(3), RosterProtocol.decodeSavedEntryText(joined))
    }

    @Test
    fun `refuses a non-canonical or foreign entry text`() {
        val canonical = RosterFixtures.savedEntryJson(0)
        for (text in listOf(
            "",
            "not json",
            "[]",
            "null",
            canonical.replace(",", ", "),
            canonical.replace("\"entryId\"", "\"EntryId\""),
            canonical.removeSuffix("}") + ",\"extra\":1}",
            canonical.replace("\"entryId\":\"entry-0\"", "\"entryId\":\"has space\""),
            canonical.replace("\"caption\":\"Saved 0\"", "\"caption\":\"broken\\ud800tail\""),
        )
        ) {
            val failure = runCatching { RosterProtocol.decodeSavedEntryText(text) }.exceptionOrNull()
            assertTrue(
                failure is RosterProtocolException && failure.code == RosterFailureCode.BAD_FRAME,
                "entry text must fail closed, got $failure for $text",
            )
        }
    }

    @Test
    fun `a window page keeps the closed entry shape and unique ids`() {
        val page = RosterProtocol.decode(
            RosterFixtures.savedWindowPageJson(
                "${RosterFixtures.savedEntryJson(0)},${RosterFixtures.savedEntryJson(1)}",
            ).encodeToByteArray(),
        ) as RosterFrame.SavedWindowPage
        assertEquals(listOf(RosterFixtures.savedEntry(0), RosterFixtures.savedEntry(1)), page.entries)
        assertEquals(page, RosterProtocol.decode(RosterProtocol.encode(page)))
    }

    @Test
    fun `an empty window is a real empty result and not an unknown one`() {
        assertEquals(
            RosterFrame.SavedWindowEnd("req-1", rows = 0L, pageCount = 0L),
            RosterProtocol.decode(
                """{"type":"saved_window_end","requestId":"req-1","rows":0,"pageCount":0}""".encodeToByteArray(),
            ),
        )
        assertEquals(
            RosterFrame.SavedWindowPage("req-1", 0L, emptyList()),
            RosterProtocol.decode(RosterFixtures.savedWindowPageJson("").encodeToByteArray()),
        )
    }

    @Test
    fun `a total larger than one transfer is only compared and never allocated`() {
        val begin = RosterProtocol.decode(
            (
                """{"type":"saved_window_begin","requestId":"req-1","hostRunId":"run-1","catalogId":"cat-1",""" +
                    """"resultId":"res-1","total":9007199254740991,"issueCount":0,"offset":0,"rows":1,""" +
                    """"pageCount":1}"""
                ).encodeToByteArray(),
        ) as RosterFrame.SavedWindowBegin
        assertEquals(MAX_SAFE_INTEGER, begin.total)
        assertEquals(1L, begin.rows)
        assertEquals(0L, begin.issueCount)
    }

    @Test
    fun `a Saved window result carries only a fixed fact and no owner handle`() {
        for (outcome in listOf(
            OwnerSavedWindowOutcome.Refused(),
            OwnerSavedWindowOutcome.Refused(SavedWindowRefusalReason.RANGE),
            OwnerSavedWindowOutcome.Unavailable,
            OwnerSavedWindowOutcome.Unknown,
        )
        ) {
            val frame = RosterFrame.SavedWindowResult(RosterFixtures.REQUEST_ID, outcome)
            val encoded = RosterProtocol.encode(frame).decodeToString()
            assertEquals(frame, RosterProtocol.decode(encoded.encodeToByteArray()))
            for (forbidden in listOf("catalogId", "resultId", "entryId", "file", "cwd", "workspace")) {
                assertTrue(!encoded.contains(forbidden), "a window result must not carry $forbidden: $encoded")
            }
        }
    }

    @Test
    fun `the Saved policy is one run and one honest exposure bit`() {
        assertEquals(
            """{"type":"saved_policy","hostRunId":"${RosterFixtures.HOST_RUN_ID}","deleteExposed":false}""",
            RosterProtocol.encode(RosterFrame.SavedPolicy(RosterFixtures.HOST_RUN_ID, false)).decodeToString(),
        )
    }
}
