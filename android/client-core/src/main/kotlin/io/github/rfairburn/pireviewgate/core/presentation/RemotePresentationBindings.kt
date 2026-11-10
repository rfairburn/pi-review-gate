package io.github.rfairburn.pireviewgate.core.presentation

import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * One currently observed remote roster row, exactly as the wire facts name it.
 *
 * This is an observation input, not a display row and not a stored row map. It
 * carries the host, the exact owner run, the exact row id, and the owner's durable
 * roster slot when the owner reported one. Labels, workspace paths, native
 * conversations, status, and viewport data are deliberately absent: none of them
 * may produce or change a presentation identity.
 */
public data class RemotePresentationObservedRow(
    public val hostId: HostId,
    public val hostRunId: String?,
    public val rowId: String,
    public val rosterSlotId: String? = null,
)

/**
 * Exact runtime binding of one remote card: host plus the observed owner run and
 * row id.
 *
 * This is the same runtime pair selection, input, and actions keep using. It is
 * used only to revalidate a move intent against currently observed cards; it is
 * never persisted and never becomes presentation order authority.
 */
public class RemotePresentationRuntimeKey private constructor(
    public val hostId: HostId,
    public val hostRunId: String?,
    public val rowId: String,
) {
    public companion object {
        /**
         * Validated runtime key, or `null` when the host run or row id is outside
         * the source protocol bounds.
         *
         * An empty run is normalized to `null`, matching the source's observed-run
         * value. A non-empty run must be a roster-bridge identifier: at most
         * [RemotePresentationIdentity.MAX_LEGACY_RUN_ID_BYTES] UTF-8 bytes of the
         * source identifier character class. A row id is non-empty, at most
         * [RemotePresentationIdentity.MAX_LEGACY_ROW_ID_BYTES] UTF-8 bytes, and free
         * of control and line-separator characters.
         */
        public fun parseOrNull(
            hostId: HostId,
            hostRunId: String?,
            rowId: String,
        ): RemotePresentationRuntimeKey? {
            if (!RemotePresentationIdentity.isValidLegacyRowId(rowId)) return null
            val normalizedRun = when {
                hostRunId.isNullOrEmpty() -> null
                RemotePresentationIdentity.isValidLegacyRunId(hostRunId) -> hostRunId
                else -> return null
            }
            return RemotePresentationRuntimeKey(hostId, normalizedRun, rowId)
        }
    }

    override fun equals(other: Any?): Boolean = other is RemotePresentationRuntimeKey &&
        hostId == other.hostId &&
        hostRunId == other.hostRunId &&
        rowId == other.rowId

    override fun hashCode(): Int {
        var result = hostId.hashCode()
        result = 31 * result + (hostRunId?.hashCode() ?: 0)
        return 31 * result + rowId.hashCode()
    }

    override fun toString(): String =
        "RemotePresentationRuntimeKey(hostId=${hostId.value}, hostRunId=$hostRunId, rowId=$rowId)"
}

/** One unambiguous current binding from a runtime card to a presentation identity. */
public class RemotePresentationBinding internal constructor(
    public val identity: RemotePresentationIdentity,
    public val runtime: RemotePresentationRuntimeKey,
)

/** Resolution of one exact runtime key against the current observation. */
public sealed interface RemotePresentationBindingResolution {
    /** This runtime key names exactly one presentation identity. */
    public class Bound(public val binding: RemotePresentationBinding) : RemotePresentationBindingResolution

    /** No current observed row carries this exact host, run, and row. */
    public data object Unknown : RemotePresentationBindingResolution

    /** More than one observation claims this card or identity: neither is guessed. */
    public data object Ambiguous : RemotePresentationBindingResolution
}

/**
 * Current runtime bindings derived from one complete observation list.
 *
 * Two visible rows of one owner that name the same durable slot are ambiguous:
 * neither is guessed, converted, or used to retarget a move, so that identity has
 * no runtime binding while both cards are present. The same fail-closed rule
 * applies if one exact runtime key is claimed by different identities.
 */
public class RemotePresentationBindings internal constructor(
    private val byIdentity: Map<String, RemotePresentationBinding>,
    private val byRuntime: Map<RemotePresentationRuntimeKey, RemotePresentationBinding>,
    private val ambiguousRuntime: Set<RemotePresentationRuntimeKey>,
) {
    /** Resolve one runtime key to its current identity, or a fixed refusal kind. */
    public fun bindingFor(runtime: RemotePresentationRuntimeKey): RemotePresentationBindingResolution =
        when {
            ambiguousRuntime.contains(runtime) -> RemotePresentationBindingResolution.Ambiguous
            else -> byRuntime[runtime]
                ?.let { RemotePresentationBindingResolution.Bound(it) }
                ?: RemotePresentationBindingResolution.Unknown
        }

    /**
     * The current runtime binding of one remembered identity, or `null` while the
     * identity is absent or ambiguous. No display row is invented here.
     */
    public fun bindingForIdentity(identity: RemotePresentationIdentity): RemotePresentationBinding? =
        byIdentity[identity.canonicalKey]
}

/** Derive unambiguous runtime bindings from current wire observations. */
public object RemotePresentationBindingResolver {
    public fun bind(rows: List<RemotePresentationObservedRow>): RemotePresentationBindings {
        val observed = ArrayList<Pair<RemotePresentationIdentity, RemotePresentationRuntimeKey?>>(rows.size)
        for (row in rows) {
            val identity = RemotePresentationIdentityDerivation.forObservedRow(row) ?: continue
            val runtime = RemotePresentationRuntimeKey.parseOrNull(row.hostId, row.hostRunId, row.rowId)
            observed.add(identity to runtime)
        }

        val identityCounts = HashMap<String, Int>(observed.size)
        for ((identity, _) in observed) {
            identityCounts[identity.canonicalKey] = (identityCounts[identity.canonicalKey] ?: 0) + 1
        }
        val ambiguousIdentities = identityCounts.filterValues { it > 1 }.keys

        val byIdentity = LinkedHashMap<String, RemotePresentationBinding>()
        val byRuntime = LinkedHashMap<RemotePresentationRuntimeKey, RemotePresentationBinding>()
        val ambiguousRuntime = HashSet<RemotePresentationRuntimeKey>()

        for ((identity, runtime) in observed) {
            val identityKey = identity.canonicalKey
            if (identityKey in ambiguousIdentities) {
                if (runtime != null) ambiguousRuntime.add(runtime)
                continue
            }
            if (runtime == null || runtime in ambiguousRuntime) continue

            val existing = byRuntime[runtime]
            if (existing != null) {
                // One exact card cannot carry two identities: refuse both rather
                // than choose one and retarget a later move.
                byRuntime.remove(runtime)
                ambiguousRuntime.add(runtime)
                byIdentity.remove(existing.identity.canonicalKey)
                continue
            }

            val binding = RemotePresentationBinding(identity, runtime)
            byIdentity[identityKey] = binding
            byRuntime[runtime] = binding
        }

        return RemotePresentationBindings(byIdentity, byRuntime, ambiguousRuntime)
    }
}
