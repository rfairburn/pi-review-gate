package io.github.rfairburn.pireviewgate.core.presentation

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure model checks for remote presentation identity and the one canonical
 * insertion-ordered sequence. No IO, no processes, no persisted fixtures.
 */
class RemotePresentationOrderModelTest {

    private fun host(id: String): HostId = HostId.parse(id)

    private fun slot(hostId: String, ownerId: String): RemotePresentationIdentity =
        assertNotNull(RemotePresentationIdentity.slot(host(hostId), ownerId))

    private fun identity(
        hostId: String,
        ownerKind: RemotePresentationOwnerKind,
        ownerId: String,
    ): RemotePresentationIdentity =
        assertNotNull(RemotePresentationIdentity.parseOrNull(host(hostId), ownerKind, ownerId))

    private fun describe(identity: RemotePresentationIdentity): String =
        "${identity.hostId.value}/${identity.ownerKind.wireName}:${identity.ownerId}"

    private fun order(order: RemotePresentationOrder): List<String> = order.identities().map(::describe)

    @Test
    fun `first observations append once and repeat observations never reorder`() {
        val order = RemotePresentationOrder()
        assertTrue(order.observe(slot("host-1", "A")))
        assertTrue(order.observe(slot("host-2", "B")))
        assertTrue(order.observe(slot("host-1", "C")))
        assertEquals(listOf("host-1/slot:A", "host-2/slot:B", "host-1/slot:C"), order(order))

        // A matching return of the same identity changes nothing at all.
        assertFalse(order.observe(slot("host-1", "A")))
        assertFalse(order.observe(slot("host-2", "B")))
        assertEquals(listOf("host-1/slot:A", "host-2/slot:B", "host-1/slot:C"), order(order))
        assertEquals(3, order.size)

        // A genuinely new identity appends, never inserts or sorts.
        assertTrue(order.observe(slot("host-1", "D")))
        assertEquals(listOf("host-1/slot:A", "host-2/slot:B", "host-1/slot:C", "host-1/slot:D"), order(order))
    }

    @Test
    fun `same owner id on another host or owner kind is a distinct identity`() {
        val order = RemotePresentationOrder()
        val hostOneSlot = slot("host-1", "x")
        val hostTwoSlot = slot("host-2", "x")
        val hostOneRuntime = identity("host-1", RemotePresentationOwnerKind.LEGACY_RUNTIME, "x")

        assertTrue(order.observe(hostOneSlot))
        assertTrue(order.observe(hostTwoSlot))
        assertTrue(order.observe(hostOneRuntime))
        assertEquals(3, order.size)
        assertEquals(3, order.identities().map { it.canonicalKey }.toSet().size)

        // Moving one never moves, aliases, or reorders either counterpart.
        assertTrue(order.move(hostTwoSlot, hostOneSlot, RemotePresentationMovePosition.BEFORE))
        assertEquals(
            listOf("host-2/slot:x", "host-1/slot:x", "host-1/runtime:x"),
            order(order),
        )
        assertTrue(order.contains(hostOneRuntime))
        assertTrue(order.contains(hostOneSlot))
        assertTrue(order.contains(hostTwoSlot))
    }

    @Test
    fun `before and after moves are host-independent and never duplicate`() {
        val order = RemotePresentationOrder()
        val a = slot("host-1", "A")
        val b = slot("host-2", "B")
        val c = slot("host-1", "C")
        order.observe(a)
        order.observe(b)
        order.observe(c)

        assertTrue(order.move(c, a, RemotePresentationMovePosition.BEFORE))
        assertEquals(listOf("host-1/slot:C", "host-1/slot:A", "host-2/slot:B"), order(order))

        assertTrue(order.move(a, b, RemotePresentationMovePosition.AFTER))
        assertEquals(listOf("host-1/slot:C", "host-2/slot:B", "host-1/slot:A"), order(order))

        // Same identity, missing identities, and an absent side refuse unchanged.
        assertFalse(order.move(a, a, RemotePresentationMovePosition.BEFORE))
        assertFalse(order.move(slot("host-1", "missing"), a, RemotePresentationMovePosition.BEFORE))
        assertFalse(order.move(a, slot("host-1", "missing"), RemotePresentationMovePosition.AFTER))
        assertEquals(listOf("host-1/slot:C", "host-2/slot:B", "host-1/slot:A"), order(order))
        assertEquals(3, order.size)
    }

    @Test
    fun `hydration restores the exact order and refuses duplicates atomically`() {
        val source = RemotePresentationOrder()
        val a = slot("host-1", "A")
        val b = slot("host-2", "B")
        val c = slot("host-1", "C")
        source.observe(a)
        source.observe(b)
        source.observe(c)

        val restored = RemotePresentationOrder()
        restored.observe(slot("host-1", "stale"))
        assertTrue(restored.hydrate(source.identities()))
        assertEquals(order(source), order(restored))
        assertFalse(restored.contains(slot("host-1", "stale")))

        // A duplicate identity refuses the whole hydration, leaving the previous
        // sequence exactly as it was.
        assertFalse(restored.hydrate(listOf(a, b, a)))
        assertEquals(order(source), order(restored))

        // An empty hydration is a legitimate empty sequence.
        assertTrue(restored.hydrate(emptyList()))
        assertEquals(0, restored.size)
    }

    @Test
    fun `absent identities stay retained without removal cleanup or expiry`() {
        val order = RemotePresentationOrder()
        val a = slot("host-1", "A")
        val b = slot("host-2", "B")
        order.observe(a)
        order.observe(b)
        val before = order(order)

        // There is deliberately no remove API on this model. Repeating an
        // unrelated observation cannot expire or hide the absent identity either.
        assertFalse(order.observe(a))
        assertEquals(before, order(order))
        assertTrue(order.contains(b))
        assertEquals(2, order.size)
    }

    @Test
    fun `canonical keys are injective across separators quotes and unicode`() {
        val identities = listOf(
            slot("host-1", "x"),
            slot("host-2", "x"),
            identity("host-1", RemotePresentationOwnerKind.LEGACY_RUNTIME, "x"),
            slot("host-1\",\"slot", "x"),
            slot("host-1", "x\",\"runtime"),
            slot("[\"remote\",\"host-1\",\"slot\",\"x\"]", "x"),
            slot("host-1", "[\"remote\",\"host-1\",\"slot\",\"x\"]"),
            slot("host-1", "a,b]c[d:e/f\\g"),
            slot("😀host", "😀id"),
            slot("rtl-\u202ehost", "rtl-\u202eid"),
            slot("host-1", "\u00e9\u4e2d\u6587"),
        )
        val order = RemotePresentationOrder()
        for (identity in identities) assertTrue(order.observe(identity))

        assertEquals(identities.size, order.size)
        assertEquals(identities.size, order.identities().map { it.canonicalKey }.toSet().size)
        for (identity in identities) assertTrue(order.contains(identity))

        // No id content can forge a tuple boundary and move another identity.
        assertTrue(order.move(identities.last(), identities.first(), RemotePresentationMovePosition.BEFORE))
        assertEquals(identities.last(), order.identities().first())
        assertEquals(identities.first(), order.identities()[1])
        assertEquals(identities.size, order.size)
    }

    @Test
    fun `durable slot derivation wins and an invalid slot never falls back`() {
        val derivedSlot = RemotePresentationIdentityDerivation.forObservedRow(
            host("host-1"), "run-1", "row-1", "owner-slot",
        )
        assertEquals(
            "host-1/slot:owner-slot",
            assertNotNull(derivedSlot).let(::describe),
        )

        // A reported but malformed durable slot refuses the row; it is not a
        // licence to guess a runtime identity from the same row.
        assertNull(
            RemotePresentationIdentityDerivation.forObservedRow(host("host-1"), "run-1", "row-1", ""),
        )
        assertNull(
            RemotePresentationIdentityDerivation.forObservedRow(
                host("host-1"), "run-1", "row-1", "s".repeat(129),
            ),
        )
        assertNull(
            RemotePresentationIdentityDerivation.forObservedRow(
                host("host-1"), "run-1", "row-1", "bad\nslot",
            ),
        )
    }

    @Test
    fun `legacy runtime derivation is the exact owner run and row tuple`() {
        val withRun = RemotePresentationIdentityDerivation.forObservedRow(
            host("host-1"), "run-1", "row-1", null,
        )
        assertEquals(
            "host-1/runtime:[\"run-1\",\"row-1\"]",
            assertNotNull(withRun).let(::describe),
        )

        // An empty observed run is the source's no-run value, never the string
        // "null", so `null` and `"null"` remain different identities.
        val noRun = assertNotNull(
            RemotePresentationIdentityDerivation.forObservedRow(host("host-1"), "", "row-1", null),
        )
        assertEquals("[null,\"row-1\"]", noRun.ownerId)
        val literalNullRun = assertNotNull(
            RemotePresentationIdentity.legacyRuntime(host("host-1"), "null", "row-1"),
        )
        assertTrue(noRun != literalNullRun)

        // Quotes, backslashes, and supplementary Unicode keep their exact values.
        val escaped = assertNotNull(
            RemotePresentationIdentity.legacyRuntime(host("host-1"), "run-1", "ro\"w\\\\1"),
        )
        assertEquals("[\"run-1\",\"ro\\\"w\\\\\\\\1\"]", escaped.ownerId)
        val unicode = assertNotNull(
            RemotePresentationIdentity.legacyRuntime(host("host-1"), "run-1", "😀row"),
        )
        assertEquals("[\"run-1\",\"😀row\"]", unicode.ownerId)

        // Source protocol bounds: row id 256 UTF-8 bytes, run id a 64-byte
        // roster-bridge identifier.
        assertNotNull(RemotePresentationIdentity.legacyRuntime(host("host-1"), "r".repeat(64), "x".repeat(256)))
        assertNull(RemotePresentationIdentity.legacyRuntime(host("host-1"), "r".repeat(65), "row-1"))
        assertNull(RemotePresentationIdentity.legacyRuntime(host("host-1"), "bad run", "row-1"))
        assertNull(RemotePresentationIdentity.legacyRuntime(host("host-1"), "run-1", "x".repeat(257)))
        assertNull(RemotePresentationIdentity.legacyRuntime(host("host-1"), "run-1", "bad\nrow"))

        // The largest escaped tuple the source test exercises still fits.
        val maximumEscapedRow = "\"".repeat(128) + "\\".repeat(128)
        val maximumTuple = assertNotNull(
            RemotePresentationIdentity.legacyRuntime(host("host-1"), "r".repeat(64), maximumEscapedRow),
        )
        assertTrue(maximumTuple.ownerId.length in 500..RemotePresentationIdentity.MAX_OWNER_ID_CHARS)
    }

    @Test
    fun `legacy runtime tuple escapes isolated surrogate code units like json stringify`() {
        val high = assertNotNull(
            RemotePresentationIdentity.legacyRuntime(host("host-1"), "run-1", "\uD800"),
        )
        assertEquals("[\"run-1\",\"\\ud800\"]", high.ownerId)
        val low = assertNotNull(
            RemotePresentationIdentity.legacyRuntime(host("host-1"), "run-1", "\uDC00"),
        )
        assertEquals("[\"run-1\",\"\\udc00\"]", low.ownerId)

        // A valid pair stays literal, exactly like JSON.stringify.
        val pair = assertNotNull(
            RemotePresentationIdentity.legacyRuntime(host("host-1"), "run-1", "😀"),
        )
        assertEquals("[\"run-1\",\"😀\"]", pair.ownerId)

        // An escaped surrogate is not the same identity as literal escape text or
        // as the replacement character a raw surrogate would become on UTF-8 write.
        val literal = assertNotNull(
            RemotePresentationIdentity.legacyRuntime(host("host-1"), "run-1", "\\ud800"),
        )
        val question = assertNotNull(
            RemotePresentationIdentity.legacyRuntime(host("host-1"), "run-1", "?"),
        )
        assertEquals("[\"run-1\",\"\\\\ud800\"]", literal.ownerId)
        assertEquals("[\"run-1\",\"?\"]", question.ownerId)
        assertTrue(high.ownerId != literal.ownerId)
        assertTrue(high.ownerId != question.ownerId)
    }

    @Test
    fun `owner identity components obey the source bounds`() {
        val hostOne = host("host-1")
        assertEquals(646, RemotePresentationIdentity.MAX_OWNER_ID_CHARS)
        assertNotNull(
            RemotePresentationIdentity.parseOrNull(
                hostOne, RemotePresentationOwnerKind.SLOT, "o".repeat(646),
            ),
        )
        assertNull(
            RemotePresentationIdentity.parseOrNull(
                hostOne, RemotePresentationOwnerKind.SLOT, "o".repeat(647),
            ),
        )
        assertNull(RemotePresentationIdentity.parseOrNull(hostOne, RemotePresentationOwnerKind.SLOT, ""))
        assertNull(RemotePresentationIdentity.parseOrNull(hostOne, RemotePresentationOwnerKind.SLOT, "bad\nid"))
        assertNull(
            RemotePresentationIdentity.parseOrNull(
                hostOne, RemotePresentationOwnerKind.SLOT, "bad\u2028id",
            ),
        )
        // The durable slot observation bound is the source remote-roster bound:
        // 128 Unicode code points and 512 UTF-8 bytes.
        assertEquals(128, RemotePresentationIdentity.MAX_DURABLE_SLOT_ID_CHARS)
        assertNotNull(RemotePresentationIdentity.slot(hostOne, "s".repeat(128)))
        assertNull(RemotePresentationIdentity.slot(hostOne, "s".repeat(129)))
        assertNotNull(RemotePresentationIdentity.slot(hostOne, "😀".repeat(128)))
        assertNull(RemotePresentationIdentity.slot(hostOne, "😀".repeat(129)))
    }
}
