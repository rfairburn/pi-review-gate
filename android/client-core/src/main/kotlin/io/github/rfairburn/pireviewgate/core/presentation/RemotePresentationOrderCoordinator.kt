package io.github.rfairburn.pireviewgate.core.presentation

import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason

/** Fixed reason one explicit reorder intent was refused without changing order. */
public enum class RemotePresentationMoveRefusal {
    /** The supplied source runtime key is not a current observed card. */
    UNKNOWN_SOURCE_RUNTIME,

    /** The supplied target runtime key is not a current observed card. */
    UNKNOWN_TARGET_RUNTIME,

    /** More than one current observation claims the source identity or card. */
    AMBIGUOUS_SOURCE_IDENTITY,

    /** More than one current observation claims the target identity or card. */
    AMBIGUOUS_TARGET_IDENTITY,

    /** Source and target name the same remembered presentation identity. */
    SAME_ENTRY,

    /** The current cards map to identities that were never first-observed. */
    NOT_REMEMBERED,
}

/** Outcome of one explicit reorder intent. */
public sealed interface RemotePresentationMoveResult {
    /**
     * The reorder intent was accepted. [save] is `null` when no store is attached
     * or when the requested placement left the sequence exactly as it was.
     */
    public class Moved(public val save: RemotePresentationOrderWriteResult?) : RemotePresentationMoveResult

    /** Nothing moved; the in-memory and published order are unchanged. */
    public data class Refused(public val reason: RemotePresentationMoveRefusal) : RemotePresentationMoveResult
}

/** Result of observing one complete set of current remote rows. */
public data class RemotePresentationObservation(
    /** True only when at least one identity entered the order for the first time. */
    public val rememberedNewPosition: Boolean,
    /** Persistence attempt for a new position; `null` when nothing changed or no store is attached. */
    public val save: RemotePresentationOrderWriteResult?,
)

/**
 * The client-side coordinator for portable remote presentation order.
 *
 * It combines the pure [RemotePresentationOrder] with optional durable identity
 * storage and with the current wire observations a future connection layer provides.
 * It owns no rows, connections, subscriptions, viewports, terminals, or actions:
 *
 * - [observe] appends first-seen remote identities and saves once when a new
 *   position entered the sequence; a matching return changes nothing.
 * - [visibleOrder] derives the current display order from the canonical sequence
 *   and the exact current host/run/row facts on every call. Absent identities are
 *   skipped here without being removed or expired, and ambiguous cards are skipped
 *   rather than guessed. The caller keeps its own row objects and display metadata;
 *   this coordinator never duplicates that row store.
 * - [reorder] revalidates an explicit before/after intent against the exact current
 *   runtime bindings, moves only presentation order, and saves once. It never
 *   selects, connects, disconnects, stops, renames, retypes, or changes the input
 *   or action target of any row.
 *
 * A persistence failure is reported truthfully in [RemotePresentationObservation]
 * and [RemotePresentationMoveResult.Moved]. It never hides current wire facts:
 * [visibleOrder] is derived from observations, not from storage success.
 */
public class RemotePresentationOrderCoordinator(
    private val order: RemotePresentationOrder = RemotePresentationOrder(),
    private val store: RemotePresentationOrderStore? = null,
) : AutoCloseable {

    private val monitor = Any()
    private var closed = false

    init {
        if (store != null) {
            val stored = store.read()
            if (stored != null && !order.hydrate(stored)) {
                // The codec refuses duplicates before returning a valid order, so
                // this is an inconsistent store rather than a fresh sequence.
                throw StorageException(StorageFailureReason.MALFORMED)
            }
        }
    }

    /**
     * Apply one complete observation list, in source order.
     *
     * Call only with the rows of a complete roster observation. An identity that is
     * already present keeps its exact position; a new identity appends exactly once.
     * A malformed row contributes no identity and no binding. No placeholder row,
     * removal, expiry, or cleanup happens here.
     */
    public fun observe(rows: List<RemotePresentationObservedRow>): RemotePresentationObservation =
        synchronized(monitor) {
            assertUsable()
            var remembered = false
            for (row in rows) {
                val identity = RemotePresentationIdentityDerivation.forObservedRow(row) ?: continue
                if (order.observe(identity)) remembered = true
            }
            RemotePresentationObservation(
                rememberedNewPosition = remembered,
                save = if (remembered) saveLocked() else null,
            )
        }

    /** Ordered snapshot of every remembered presentation identity, including absent cards. */
    public fun identities(): List<RemotePresentationIdentity> = synchronized(monitor) {
        assertUsable()
        order.identities()
    }

    /**
     * Current runtime keys in canonical presentation order.
     *
     * Only cards present in [rows] with an unambiguous identity are returned. An
     * absent remembered identity contributes nothing, and no display row, label, or
     * cached metadata is invented for it.
     */
    public fun visibleOrder(rows: List<RemotePresentationObservedRow>): List<RemotePresentationRuntimeKey> =
        synchronized(monitor) {
            assertUsable()
            val bindings = RemotePresentationBindingResolver.bind(rows)
            val visible = ArrayList<RemotePresentationRuntimeKey>()
            for (identity in order.identities()) {
                val binding = bindings.bindingForIdentity(identity) ?: continue
                visible.add(binding.runtime)
            }
            visible
        }

    /**
     * Commit one explicit before/after move.
     *
     * [rows] must be the complete current observation from which the UI captured
     * [source] and [target]. Both runtime keys are revalidated as host plus exact
     * owner run plus exact row id; only an unambiguous current card is accepted. A
     * replaced row, a changed run, a missing card, or an ambiguous duplicate refuses
     * and leaves the order untouched. A successful move changes presentation order
     * only.
     */
    public fun reorder(
        rows: List<RemotePresentationObservedRow>,
        source: RemotePresentationRuntimeKey,
        target: RemotePresentationRuntimeKey,
        position: RemotePresentationMovePosition,
    ): RemotePresentationMoveResult = synchronized(monitor) {
        reorderLocked(rows, source, target, position)
    }

    /** Retry publication of the current complete order. `null` without a store. */
    public fun save(): RemotePresentationOrderWriteResult? = synchronized(monitor) {
        assertUsable()
        saveLocked()
    }

    override fun close(): Unit = synchronized(monitor) {
        if (!closed) {
            closed = true
            store?.close()
        }
    }

    private fun reorderLocked(
        rows: List<RemotePresentationObservedRow>,
        source: RemotePresentationRuntimeKey,
        target: RemotePresentationRuntimeKey,
        position: RemotePresentationMovePosition,
    ): RemotePresentationMoveResult {
        assertUsable()
        val bindings = RemotePresentationBindingResolver.bind(rows)
        val sourceBinding = when (val resolution = bindings.bindingFor(source)) {
            is RemotePresentationBindingResolution.Bound -> resolution.binding
            RemotePresentationBindingResolution.Ambiguous ->
                return RemotePresentationMoveResult.Refused(RemotePresentationMoveRefusal.AMBIGUOUS_SOURCE_IDENTITY)
            RemotePresentationBindingResolution.Unknown ->
                return RemotePresentationMoveResult.Refused(RemotePresentationMoveRefusal.UNKNOWN_SOURCE_RUNTIME)
        }
        val targetBinding = when (val resolution = bindings.bindingFor(target)) {
            is RemotePresentationBindingResolution.Bound -> resolution.binding
            RemotePresentationBindingResolution.Ambiguous ->
                return RemotePresentationMoveResult.Refused(RemotePresentationMoveRefusal.AMBIGUOUS_TARGET_IDENTITY)
            RemotePresentationBindingResolution.Unknown ->
                return RemotePresentationMoveResult.Refused(RemotePresentationMoveRefusal.UNKNOWN_TARGET_RUNTIME)
        }
        if (sourceBinding.identity == targetBinding.identity) {
            return RemotePresentationMoveResult.Refused(RemotePresentationMoveRefusal.SAME_ENTRY)
        }
        val before = order.identities()
        if (!order.move(sourceBinding.identity, targetBinding.identity, position)) {
            return RemotePresentationMoveResult.Refused(RemotePresentationMoveRefusal.NOT_REMEMBERED)
        }
        // A placement that leaves the sequence exactly as it was is a successful
        // no-op intent, not a save failure. Source persistence dedupes the
        // unchanged projection the same way.
        val changed = order.identities() != before
        return RemotePresentationMoveResult.Moved(if (changed) saveLocked() else null)
    }

    private fun saveLocked(): RemotePresentationOrderWriteResult? {
        val activeStore = store ?: return null
        return try {
            activeStore.write(order.identities())
        } catch (error: StorageException) {
            // The store contract returns refusals; a closed or poisoned handle still
            // surfaces as a fixed failure rather than pretending the save landed.
            RemotePresentationOrderWriteResult.Refused(error.reason)
        }
    }

    private fun assertUsable() {
        if (closed) throw StorageException(StorageFailureReason.UNAVAILABLE)
    }
}
