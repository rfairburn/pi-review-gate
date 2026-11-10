package io.github.rfairburn.pireviewgate.core.permissions

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * One explicit user connect intent, used to bind a local-network permission result
 * to the target the user actually asked for.
 *
 * The token combines the saved [hostId], the [endpoint] that would be dialed, and a
 * caller-owned [intentGeneration]. The generation must change whenever the caller
 * starts a new explicit connect intent for the same host and endpoint, or whenever
 * the current target/source changes. A later permission callback for an older
 * generation is therefore distinguishable from the current intent even when the
 * host id and endpoint are unchanged.
 *
 * A token is data, not authority. It grants no permission, starts no connection,
 * and is never derived from a label or a "current host" singleton. The caller owns
 * the lifecycle of the intent and must compare the token returned with a grant
 * against its current explicit target before using it.
 */
public data class LocalNetworkRequestToken(
    public val hostId: HostId,
    public val endpoint: Endpoint,
    public val intentGeneration: Long,
) {
    init {
        require(intentGeneration > 0L) { "intent generation must be positive" }
    }
}
