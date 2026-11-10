package io.github.rfairburn.pireviewgate.core.presentation

/**
 * Direction of one explicit presentation move request.
 *
 * There is no wrapping and no implicit insertion: a move places the source
 * identity immediately before or immediately after an identity that is already
 * present in the canonical sequence.
 */
public enum class RemotePresentationMovePosition {
    BEFORE,
    AFTER,
}

/**
 * The one canonical insertion-ordered sequence of remote presentation identities.
 *
 * This model is pure: no IO, no connection state, no runtime row map, no metadata,
 * and no action or input authority. The map's own iteration order is the
 * presentation order, and every ordered view is derived from it on read. There is
 * deliberately no second key list, rank, index, sorting pass, grouping, filtering,
 * cleanup, expiry, or placeholder row.
 *
 * Invariants:
 *
 * - First observation of an identity appends it exactly once.
 * - A repeat observation of an already-present identity changes nothing: it is
 *   never re-appended, moved, or reordered by a matching return.
 * - Absent identities are retained. Nothing here removes an identity because no
 *   row currently matches it, and nothing invents a display row for it.
 * - Identities are kind-qualified and host-qualified, so a durable slot and a
 *   legacy runtime identity with the same owner id are distinct, and the same
 *   owner id on two hosts is distinct.
 * - Movement is host-independent and does not duplicate, alias, or resolve an
 *   identity. Missing, malformed, and same-identity moves refuse without change.
 *
 * Methods are synchronized because several host observations may reach the same
 * coordinator from different threads. The returned lists are snapshots owned by
 * the caller; mutating a returned list never changes this model.
 */
public class RemotePresentationOrder {

    /** The one canonical store: kind-qualified key -> immutable identity, in order. */
    private val canonical = LinkedHashMap<String, RemotePresentationIdentity>()

    /** Number of remembered remote presentation identities. */
    @get:Synchronized
    public val size: Int
        get() = canonical.size

    /** True when this exact identity already occupies a position in the sequence. */
    @Synchronized
    public fun contains(identity: RemotePresentationIdentity): Boolean =
        canonical.containsKey(identity.canonicalKey)

    /**
     * First observation of one identity appends it once.
     *
     * A matching return of an already-present identity changes nothing at all and
     * returns `false`. The caller's immutable identity object is retained; no
     * metadata or runtime binding is copied into this model.
     */
    @Synchronized
    public fun observe(identity: RemotePresentationIdentity): Boolean {
        val key = identity.canonicalKey
        if (canonical.containsKey(key)) return false
        canonical[key] = identity
        return true
    }

    /**
     * Move one present identity immediately before or after another present
     * identity.
     *
     * Movement is kind- and host-independent: any entry may move past any other.
     * A missing identity, a source and target that name the same identity, or
     * anything else that cannot be placed exactly refuses with `false` and leaves
     * the sequence exactly as it was.
     */
    @Synchronized
    public fun move(
        source: RemotePresentationIdentity,
        target: RemotePresentationIdentity,
        position: RemotePresentationMovePosition,
    ): Boolean {
        val sourceKey = source.canonicalKey
        val targetKey = target.canonicalKey
        if (sourceKey == targetKey) return false
        if (!canonical.containsKey(sourceKey) || !canonical.containsKey(targetKey)) return false

        val entries = canonical.entries.map { it.key to it.value }.toMutableList()
        val sourceIndex = entries.indexOfFirst { it.first == sourceKey }
        if (sourceIndex < 0) return false
        val moved = entries.removeAt(sourceIndex)
        val targetIndex = entries.indexOfFirst { it.first == targetKey }
        if (targetIndex < 0) return false
        entries.add(if (position == RemotePresentationMovePosition.BEFORE) targetIndex else targetIndex + 1, moved)

        canonical.clear()
        for ((key, identity) in entries) canonical[key] = identity
        return true
    }

    /**
     * Replace the whole sequence from an ordered identity list (the shape a
     * durable read produces).
     *
     * Validation is total before any mutation. A duplicate identity in the input
     * refuses the whole hydration and leaves the sequence exactly as it was. An
     * empty list is a legitimate empty sequence. Identities are immutable, so
     * adopting them by reference cannot let a caller rewrite the order later.
     */
    @Synchronized
    public fun hydrate(identities: List<RemotePresentationIdentity>): Boolean {
        val rebuilt = LinkedHashMap<String, RemotePresentationIdentity>(identities.size)
        for (identity in identities) {
            val key = identity.canonicalKey
            if (rebuilt.containsKey(key)) return false
            rebuilt[key] = identity
        }
        canonical.clear()
        canonical.putAll(rebuilt)
        return true
    }

    /** Ordered snapshot of every remembered remote presentation identity. */
    @Synchronized
    public fun identities(): List<RemotePresentationIdentity> = canonical.values.toList()
}
