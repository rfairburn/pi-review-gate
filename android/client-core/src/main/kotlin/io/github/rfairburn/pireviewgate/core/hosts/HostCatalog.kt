package io.github.rfairburn.pireviewgate.core.hosts

/**
 * Why one host-catalog mutation was refused.
 *
 * Fixed reasons only: the caller never learns a path, a stored value, or an
 * exception text, and a refusal is never reported as a partial success.
 */
public enum class CatalogFailureReason {
    /** Another saved host already owns this id. */
    DUPLICATE_HOST_ID,

    /** The catalog already holds the maximum number of saved hosts. */
    TOO_MANY_HOSTS,

    /** No saved host carries this id. */
    UNKNOWN_HOST_ID,

    /**
     * A per-host update tried to move the entry to a different [HostId].
     *
     * The id is the association every consumer, pin slot, and remote-pane copy is
     * keyed by: an update that changes it would silently retarget another host's
     * state and produce a catalog no later read can accept.
     */
    INVALID_UPDATE,
}

/** Result of one catalog mutation: either the new catalog, or one fixed reason. */
public sealed interface HostCatalogMutation {
    public data class Ok(public val catalog: HostCatalog) : HostCatalogMutation
    public data class Failed(public val reason: CatalogFailureReason) : HostCatalogMutation
}

/**
 * The complete, immutable set of configured hosts.
 *
 * The client is multi-host by construction: there is no "current host" slot, no
 * single active destination, and no ordering authority. Each entry keeps its own
 * stable [HostId], so a consumer that holds an id keeps addressing the same saved
 * host across a rename, a restart, or the removal of another entry. Removal of one
 * entry never renumbers or retargets the others, and re-adding the same endpoint
 * produces a different id and therefore a different association and pin slot.
 *
 * Instances are safe for concurrent consumers: the list is never mutated in place,
 * so a snapshot handed to a UI frame, a reconnect pass, or a transport consumer
 * cannot be changed underneath it.
 */
public class HostCatalog private constructor(
    /** Saved hosts in stable save order. Never mutated after construction. */
    public val hosts: List<ConfiguredHost>,
) {
    /** Number of saved hosts. */
    public val size: Int get() = hosts.size

    /** True when nothing is saved. */
    public val isEmpty: Boolean get() = hosts.isEmpty()

    /** The saved ids, in save order. */
    public val ids: List<HostId> get() = hosts.map(ConfiguredHost::id)

    /** One saved host by its stable id, or `null` when nothing is saved under it. */
    public fun find(id: HostId): ConfiguredHost? = hosts.firstOrNull { it.id == id }

    /** Every saved host naming exactly this endpoint; usually zero or one entry. */
    public fun findByEndpoint(endpoint: Endpoint): List<ConfiguredHost> =
        hosts.filter { it.endpoint == endpoint }

    /** Save one new host. Duplicate ids and the count bound refuse without changing anything. */
    public fun added(host: ConfiguredHost): HostCatalogMutation = mutate(host, adding = true)

    /** Replace the entry with the same id in place. Unknown ids refuse. */
    public fun replaced(host: ConfiguredHost): HostCatalogMutation = mutate(host, adding = false)

    /** Forget one host association. Other hosts, pins, and identity are untouched. */
    public fun removed(id: HostId): HostCatalogMutation {
        val existing = find(id)
            ?: return HostCatalogMutation.Failed(CatalogFailureReason.UNKNOWN_HOST_ID)
        val next = ArrayList<ConfiguredHost>(hosts.size - 1)
        for (host in hosts) if (host != existing) next.add(host)
        return HostCatalogMutation.Ok(HostCatalog(next))
    }

    /**
     * Apply one per-host fact.
     *
     * Used for rename, explicit Connect/Disconnect suppression, and
     * previously-connected history: the id and endpoint association of every entry
     * is preserved and no other entry changes.
     *
     * A transform that returns a different [HostId] is refused with
     * [CatalogFailureReason.INVALID_UPDATE]: the id is the association, so changing
     * it here would collide with another saved host and publish a catalog that no
     * later read can accept. The resulting catalog is validated before it is handed
     * back, so a refused update changes nothing.
     */
    public fun updated(id: HostId, transform: (ConfiguredHost) -> ConfiguredHost): HostCatalogMutation {
        val existing = find(id)
            ?: return HostCatalogMutation.Failed(CatalogFailureReason.UNKNOWN_HOST_ID)
        val transformed = transform(existing)
        if (transformed.id != existing.id) {
            return HostCatalogMutation.Failed(CatalogFailureReason.INVALID_UPDATE)
        }
        val next = ArrayList<ConfiguredHost>(hosts.size)
        for (host in hosts) next.add(if (host == existing) transformed else host)
        return validated(next)
    }

    private fun mutate(host: ConfiguredHost, adding: Boolean): HostCatalogMutation {
        val existing = find(host.id)
        if (adding && existing != null) return HostCatalogMutation.Failed(CatalogFailureReason.DUPLICATE_HOST_ID)
        if (!adding && existing == null) return HostCatalogMutation.Failed(CatalogFailureReason.UNKNOWN_HOST_ID)
        if (adding && hosts.size >= MAX_HOSTS) return HostCatalogMutation.Failed(CatalogFailureReason.TOO_MANY_HOSTS)
        val next = ArrayList<ConfiguredHost>(if (adding) hosts.size + 1 else hosts.size)
        for (saved in hosts) next.add(if (saved == existing) host else saved)
        if (adding) next.add(host)
        return validated(next)
    }

    /**
     * Re-check the invariant the type guarantees — unique ids within the count bound
     * — before a mutation result is handed to a caller that may persist it.
     */
    private fun validated(next: List<ConfiguredHost>): HostCatalogMutation {
        if (next.size > MAX_HOSTS) return HostCatalogMutation.Failed(CatalogFailureReason.TOO_MANY_HOSTS)
        val seen = HashSet<HostId>(next.size)
        for (entry in next) {
            if (!seen.add(entry.id)) return HostCatalogMutation.Failed(CatalogFailureReason.DUPLICATE_HOST_ID)
        }
        return HostCatalogMutation.Ok(HostCatalog(next))
    }

    override fun equals(other: Any?): Boolean = other is HostCatalog && other.hosts == hosts

    override fun hashCode(): Int = hosts.hashCode()

    override fun toString(): String = "HostCatalog(size=$size)"

    public companion object {
        /** Bound for saved hosts; a document holding more is refused. */
        public const val MAX_HOSTS: Int = 64

        /** The catalog of a client that has never saved a host. */
        public val EMPTY: HostCatalog = HostCatalog(emptyList())

        /**
         * Validated catalog.
         *
         * @throws IllegalArgumentException on a duplicate id or a count above [MAX_HOSTS].
         */
        public fun of(hosts: List<ConfiguredHost>): HostCatalog {
            require(hosts.size <= MAX_HOSTS) { "too many configured hosts" }
            val seen = HashSet<HostId>(hosts.size)
            for (host in hosts) require(seen.add(host.id)) { "duplicate configured host id" }
            return HostCatalog(hosts.toList())
        }
    }
}
