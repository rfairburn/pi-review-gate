package io.github.rfairburn.pireviewgate.core.presentation

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Intent and revalidation checks for the remote presentation order coordinator.
 * Every observation is synthetic wire-shaped data; no connection, row store,
 * viewport, input, or action authority exists in this model.
 */
class RemotePresentationOrderCoordinatorTest {

    private fun host(id: String): HostId = HostId.parse(id)

    private fun row(
        hostId: String,
        runId: String?,
        rowId: String,
        ownerSlotId: String? = null,
    ): RemotePresentationObservedRow = RemotePresentationObservedRow(host(hostId), runId, rowId, ownerSlotId)

    private fun key(hostId: String, runId: String?, rowId: String): RemotePresentationRuntimeKey =
        assertNotNull(RemotePresentationRuntimeKey.parseOrNull(host(hostId), runId, rowId))

    private fun slot(hostId: String, ownerId: String): RemotePresentationIdentity =
        assertNotNull(RemotePresentationIdentity.slot(host(hostId), ownerId))

    private fun describe(identity: RemotePresentationIdentity): String =
        "${identity.hostId.value}/${identity.ownerKind.wireName}:${identity.ownerId}"

    private fun describe(key: RemotePresentationRuntimeKey): String =
        "${key.hostId.value}/${key.hostRunId ?: "none"}/${key.rowId}"

    private fun refusal(result: RemotePresentationMoveResult): RemotePresentationMoveRefusal =
        assertIs<RemotePresentationMoveResult.Refused>(result).reason

    @Test
    fun `first observation appends and a repeat observation is a no-op save`() {
        val store = RecordingOrderStore()
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        val rows = listOf(
            row("host-1", "run-1", "row-a", "A"),
            row("host-2", "run-1", "row-b", "B"),
        )

        val first = coordinator.observe(rows)
        assertTrue(first.rememberedNewPosition)
        assertEquals(RemotePresentationOrderWriteResult.Published, first.save)
        assertEquals(1, store.writes)
        assertEquals(listOf("host-1/slot:A", "host-2/slot:B"), coordinator.identities().map(::describe))

        val repeat = coordinator.observe(rows)
        assertFalse(repeat.rememberedNewPosition)
        assertNull(repeat.save)
        assertEquals(1, store.writes, "a matching return must not spend another save")
        assertEquals(listOf("host-1/slot:A", "host-2/slot:B"), coordinator.identities().map(::describe))
        assertEquals(
            listOf("host-1/run-1/row-a", "host-2/run-1/row-b"),
            coordinator.visibleOrder(rows).map(::describe),
        )

        // The same cards in a different observation order still never reorder.
        val reorderedObservation = coordinator.observe(rows.reversed())
        assertFalse(reorderedObservation.rememberedNewPosition)
        assertNull(reorderedObservation.save)
        assertEquals(listOf("host-1/slot:A", "host-2/slot:B"), coordinator.identities().map(::describe))
        coordinator.close()
    }

    @Test
    fun `durable hydration preserves order and absent identities without phantom rows`() {
        val saved = listOf(slot("host-1", "A"), slot("host-2", "B"), slot("host-1", "C"))
        val store = RecordingOrderStore(initial = saved)
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        assertEquals(saved.map(::describe), coordinator.identities().map(::describe))

        // C and A are present now; B is retained in the order but contributes no row.
        val current = listOf(
            row("host-1", "run-1", "row-c", "C"),
            row("host-1", "run-1", "row-a", "A"),
        )
        assertEquals(listOf("host-1/run-1/row-a", "host-1/run-1/row-c"), coordinator.visibleOrder(current).map(::describe))
        assertEquals(saved.map(::describe), coordinator.identities().map(::describe))

        // B returns at its remembered position; nothing was inserted for its absence.
        val all = current + row("host-2", "run-1", "row-b", "B")
        assertEquals(
            listOf("host-1/run-1/row-a", "host-2/run-1/row-b", "host-1/run-1/row-c"),
            coordinator.visibleOrder(all).map(::describe),
        )
        coordinator.close()
    }

    @Test
    fun `a move never auto-observes a current card`() {
        val coordinator = RemotePresentationOrderCoordinator()
        val rows = listOf(
            row("host-1", "run-1", "row-a", "A"),
            row("host-1", "run-1", "row-b", "B"),
        )
        assertEquals(
            RemotePresentationMoveRefusal.NOT_REMEMBERED,
            refusal(coordinator.reorder(
                rows,
                key("host-1", "run-1", "row-a"),
                key("host-1", "run-1", "row-b"),
                RemotePresentationMovePosition.BEFORE,
            )),
        )
        assertEquals(0, coordinator.identities().size)
        coordinator.close()
    }

    @Test
    fun `a move that leaves the sequence unchanged does not claim a save`() {
        val store = RecordingOrderStore(initial = listOf(slot("host-1", "A"), slot("host-1", "B")))
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        val rows = listOf(
            row("host-1", "run-1", "row-a", "A"),
            row("host-1", "run-1", "row-b", "B"),
        )
        val source = key("host-1", "run-1", "row-a")
        val target = key("host-1", "run-1", "row-b")

        // A is already immediately before B: the intent succeeds without changing
        // the sequence, so a failing store is never blamed for a no-op save.
        store.outcome = RemotePresentationOrderWriteResult.Refused(StorageFailureReason.WRITE_FAILED)
        val noop = assertIs<RemotePresentationMoveResult.Moved>(
            coordinator.reorder(rows, source, target, RemotePresentationMovePosition.BEFORE),
        )
        assertNull(noop.save)
        assertEquals(0, store.writes)
        assertEquals(listOf("host-1/slot:A", "host-1/slot:B"), coordinator.identities().map(::describe))

        // A real move still reports the truthful save failure.
        val moved = assertIs<RemotePresentationMoveResult.Moved>(
            coordinator.reorder(rows, target, source, RemotePresentationMovePosition.BEFORE),
        )
        assertIs<RemotePresentationOrderWriteResult.Refused>(moved.save)
        assertEquals(1, store.writes)
        assertEquals(listOf("host-1/slot:B", "host-1/slot:A"), coordinator.identities().map(::describe))
        coordinator.close()
    }

    @Test
    fun `multiple hosts with the same owner id stay distinct and move across hosts`() {
        val store = RecordingOrderStore()
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        val rows = listOf(
            row("host-1", "run-1", "row-one", "shared"),
            row("host-2", "run-1", "row-two", "shared"),
        )
        coordinator.observe(rows)
        assertEquals(2, coordinator.identities().size)
        assertEquals(
            listOf("host-1/run-1/row-one", "host-2/run-1/row-two"),
            coordinator.visibleOrder(rows).map(::describe),
        )

        val moved = coordinator.reorder(
            rows,
            key("host-2", "run-1", "row-two"),
            key("host-1", "run-1", "row-one"),
            RemotePresentationMovePosition.BEFORE,
        )
        assertIs<RemotePresentationMoveResult.Moved>(moved)
        assertEquals(
            listOf("host-2/run-1/row-two", "host-1/run-1/row-one"),
            coordinator.visibleOrder(rows).map(::describe),
        )
        assertEquals(
            listOf("host-2/slot:shared", "host-1/slot:shared"),
            coordinator.identities().map(::describe),
        )
        assertEquals(2, store.writes)
        coordinator.close()
    }

    @Test
    fun `slot and legacy runtime identity with the same owner id never move together`() {
        val store = RecordingOrderStore()
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        val slotRow = row("host-1", "run-1", "row-slot", "same-id")
        val runtimeRow = row("host-1", "run-1", "row-runtime", null)
        val rows = listOf(slotRow, runtimeRow)
        coordinator.observe(rows)
        assertEquals(
            listOf("host-1/slot:same-id", "host-1/runtime:[\"run-1\",\"row-runtime\"]"),
            coordinator.identities().map(::describe),
        )

        val moved = coordinator.reorder(
            rows,
            key("host-1", "run-1", "row-runtime"),
            key("host-1", "run-1", "row-slot"),
            RemotePresentationMovePosition.BEFORE,
        )
        assertIs<RemotePresentationMoveResult.Moved>(moved)
        assertEquals(
            listOf("host-1/run-1/row-runtime", "host-1/run-1/row-slot"),
            coordinator.visibleOrder(rows).map(::describe),
        )
        assertEquals(
            listOf("host-1/runtime:[\"run-1\",\"row-runtime\"]", "host-1/slot:same-id"),
            coordinator.identities().map(::describe),
        )
        coordinator.close()
    }

    @Test
    fun `reorder revalidates the exact host run and row`() {
        val store = RecordingOrderStore()
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        val rows = listOf(
            row("host-1", "run-1", "row-a", "A"),
            row("host-1", "run-1", "row-b", "B"),
        )
        coordinator.observe(rows)

        // A wrong run, a wrong row, and a wrong host are all unknown cards.
        assertEquals(
            RemotePresentationMoveRefusal.UNKNOWN_SOURCE_RUNTIME,
            refusal(coordinator.reorder(
                rows,
                key("host-1", "run-2", "row-a"),
                key("host-1", "run-1", "row-b"),
                RemotePresentationMovePosition.BEFORE,
            )),
        )
        assertEquals(
            RemotePresentationMoveRefusal.UNKNOWN_TARGET_RUNTIME,
            refusal(coordinator.reorder(
                rows,
                key("host-1", "run-1", "row-a"),
                key("host-1", "run-1", "row-old"),
                RemotePresentationMovePosition.AFTER,
            )),
        )
        assertEquals(
            RemotePresentationMoveRefusal.UNKNOWN_SOURCE_RUNTIME,
            refusal(coordinator.reorder(
                rows,
                key("host-2", "run-1", "row-a"),
                key("host-1", "run-1", "row-b"),
                RemotePresentationMovePosition.BEFORE,
            )),
        )
        assertEquals(1, store.writes, "refused moves never save")
        assertEquals(
            listOf("host-1/slot:A", "host-1/slot:B"),
            coordinator.identities().map(::describe),
        )
        coordinator.close()
    }

    @Test
    fun `a row replacement between intent and commit refuses without retargeting`() {
        val store = RecordingOrderStore()
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        val beforeIntent = listOf(
            row("host-1", "run-1", "row-a", "A"),
            row("host-1", "run-1", "row-b", "B"),
        )
        coordinator.observe(beforeIntent)
        val capturedSource = key("host-1", "run-1", "row-a")
        val target = key("host-1", "run-1", "row-b")

        // The source card is replaced by a new row that carries the same durable
        // slot. The old runtime pair is no longer a current observed target.
        val afterReplacement = listOf(
            row("host-1", "run-1", "row-a2", "A"),
            row("host-1", "run-1", "row-b", "B"),
        )
        assertEquals(
            RemotePresentationMoveRefusal.UNKNOWN_SOURCE_RUNTIME,
            refusal(coordinator.reorder(
                afterReplacement,
                capturedSource,
                target,
                RemotePresentationMovePosition.BEFORE,
            )),
        )
        assertEquals(
            listOf("host-1/slot:A", "host-1/slot:B"),
            coordinator.identities().map(::describe),
        )
        assertEquals(1, store.writes)

        // The same row id on a new owner run is also a different runtime card.
        val afterRunChange = listOf(
            row("host-1", "run-2", "row-a", "A"),
            row("host-1", "run-1", "row-b", "B"),
        )
        assertEquals(
            RemotePresentationMoveRefusal.UNKNOWN_SOURCE_RUNTIME,
            refusal(coordinator.reorder(
                afterRunChange,
                capturedSource,
                target,
                RemotePresentationMovePosition.BEFORE,
            )),
        )

        // The newly observed runtime pair maps to the same durable identity and
        // can move it; the durable slot's position is what changes.
        val moved = coordinator.reorder(
            afterRunChange,
            key("host-1", "run-2", "row-a"),
            key("host-1", "run-1", "row-b"),
            RemotePresentationMovePosition.AFTER,
        )
        assertIs<RemotePresentationMoveResult.Moved>(moved)
        assertEquals(
            listOf("host-1/slot:B", "host-1/slot:A"),
            coordinator.identities().map(::describe),
        )
        coordinator.close()
    }

    @Test
    fun `duplicate identities are ambiguous rather than retargeted`() {
        val store = RecordingOrderStore()
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        val duplicate = listOf(
            row("host-1", "run-1", "row-a", "duplicate"),
            row("host-1", "run-1", "row-b", "duplicate"),
            row("host-1", "run-1", "row-c", "other"),
        )
        coordinator.observe(duplicate)
        assertEquals(
            listOf("host-1/slot:duplicate", "host-1/slot:other"),
            coordinator.identities().map(::describe),
        )
        // Neither duplicate card is guessed into a visible position.
        assertEquals(
            listOf("host-1/run-1/row-c"),
            coordinator.visibleOrder(duplicate).map(::describe),
        )

        assertEquals(
            RemotePresentationMoveRefusal.AMBIGUOUS_SOURCE_IDENTITY,
            refusal(coordinator.reorder(
                duplicate,
                key("host-1", "run-1", "row-a"),
                key("host-1", "run-1", "row-c"),
                RemotePresentationMovePosition.BEFORE,
            )),
        )
        assertEquals(
            RemotePresentationMoveRefusal.AMBIGUOUS_TARGET_IDENTITY,
            refusal(coordinator.reorder(
                duplicate,
                key("host-1", "run-1", "row-c"),
                key("host-1", "run-1", "row-b"),
                RemotePresentationMovePosition.AFTER,
            )),
        )
        assertEquals(1, store.writes)
        assertEquals(
            listOf("host-1/slot:duplicate", "host-1/slot:other"),
            coordinator.identities().map(::describe),
        )
        coordinator.close()
    }

    @Test
    fun `a persistence failure is truthful and never hides current wire facts`() {
        val store = RecordingOrderStore(outcome = RemotePresentationOrderWriteResult.Refused(StorageFailureReason.WRITE_FAILED))
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        val rows = listOf(
            row("host-1", "run-1", "row-a", "A"),
            row("host-2", "run-1", "row-b", null),
        )

        val observation = coordinator.observe(rows)
        assertTrue(observation.rememberedNewPosition)
        val save = assertIs<RemotePresentationOrderWriteResult.Refused>(observation.save)
        assertEquals(StorageFailureReason.WRITE_FAILED, save.reason)

        // In-memory order and current wire-derived display both stay complete.
        assertEquals(
            listOf("host-1/slot:A", "host-2/runtime:[\"run-1\",\"row-b\"]"),
            coordinator.identities().map(::describe),
        )
        assertEquals(
            listOf("host-1/run-1/row-a", "host-2/run-1/row-b"),
            coordinator.visibleOrder(rows).map(::describe),
        )
        coordinator.close()
    }

    @Test
    fun `runtime changes append only for legacy runtime identities while durable slots keep position`() {
        val store = RecordingOrderStore()
        val coordinator = RemotePresentationOrderCoordinator(store = store)
        val durable = row("host-1", "run-1", "row-slot", "S")
        val legacy = row("host-1", "run-1", "row-legacy", null)
        val other = row("host-2", "run-1", "row-other", "T")
        coordinator.observe(listOf(durable, legacy, other))
        assertEquals(
            listOf(
                "host-1/slot:S",
                "host-1/runtime:[\"run-1\",\"row-legacy\"]",
                "host-2/slot:T",
            ),
            coordinator.identities().map(::describe),
        )

        // A durable slot moves with the owner's new runtime row and run: same
        // identity, same remembered position, new current display card.
        val durableMoved = row("host-1", "run-2", "row-slot-new", "S")
        val sameRuntime = listOf(durableMoved, other)
        assertEquals(
            listOf("host-1/run-2/row-slot-new", "host-2/run-1/row-other"),
            coordinator.visibleOrder(sameRuntime).map(::describe),
        )
        assertEquals(
            listOf("host-1/slot:S", "host-1/runtime:[\"run-1\",\"row-legacy\"]", "host-2/slot:T"),
            coordinator.identities().map(::describe),
        )

        // A legacy runtime row id on a new owner run is a NEW appended identity.
        // The old runtime identity stays remembered but contributes no row.
        val legacyRestarted = row("host-1", "run-2", "row-legacy", null)
        val restarted = listOf(durableMoved, legacyRestarted, other)
        coordinator.observe(restarted)
        assertEquals(
            listOf(
                "host-1/slot:S",
                "host-1/runtime:[\"run-1\",\"row-legacy\"]",
                "host-2/slot:T",
                "host-1/runtime:[\"run-2\",\"row-legacy\"]",
            ),
            coordinator.identities().map(::describe),
        )
        assertEquals(
            listOf(
                "host-1/run-2/row-slot-new",
                "host-2/run-1/row-other",
                "host-1/run-2/row-legacy",
            ),
            coordinator.visibleOrder(restarted).map(::describe),
        )
        coordinator.close()
    }

    private class RecordingOrderStore(
        initial: List<RemotePresentationIdentity>? = null,
        var outcome: RemotePresentationOrderWriteResult = RemotePresentationOrderWriteResult.Published,
    ) : RemotePresentationOrderStore {
        private var current: List<RemotePresentationIdentity>? = initial
        var writes: Int = 0
            private set

        override fun read(): List<RemotePresentationIdentity>? = current

        override fun write(identities: List<RemotePresentationIdentity>): RemotePresentationOrderWriteResult {
            writes += 1
            val result = outcome
            if (result == RemotePresentationOrderWriteResult.Published) {
                current = identities.toList()
            }
            return result
        }

        override fun close() = Unit
    }
}
