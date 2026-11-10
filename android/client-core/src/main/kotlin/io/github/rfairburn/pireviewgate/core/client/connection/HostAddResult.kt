package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.CatalogFailureReason

/** Outcome of saving one new host through [HostConnectionRegistry.addHost]. */
public sealed interface HostAddResult {
    /** The new association was durably saved and is now in the snapshot. No connection was requested. */
    public data object Saved : HostAddResult

    /** The catalog refused the addition. Nothing was written or published. */
    public data class CatalogRefused(public val reason: CatalogFailureReason) : HostAddResult

    /** The registry is not running or settings are unavailable. No new host was published. */
    public data class Refused(public val reason: HostCommandRefusal) : HostAddResult
}
