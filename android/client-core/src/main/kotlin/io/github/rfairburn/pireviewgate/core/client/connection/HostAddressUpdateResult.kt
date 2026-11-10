package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint

/** Outcome of [HostConnectionRegistry.updateHostAddress]; no outcome requests a connection. */
public sealed interface HostAddressUpdateResult {
    /**
     * The address was durably saved and old runtime authority retired.
     *
     * [endpoint] is the saved target, retaining the old port. This is a save result,
     * not permission or consent to connect. Even if the registry closed during IO,
     * a completed publication is reported as Saved, never as a failed save. A UI
     * wanting to reconnect must capture fresh state and use normal explicit Connect.
     */
    public data class Saved(public val endpoint: Endpoint) : HostAddressUpdateResult

    /** The expected target matched, but the address was identical. No write or retirement. */
    public data object Unchanged : HostAddressUpdateResult

    /** The host is saved at a different endpoint than the caller captured. No write or retirement. */
    public data object StaleTarget : HostAddressUpdateResult

    /** Not running, unknown/removing host, or settings unavailable. No new address was adopted. */
    public data class Refused(public val reason: HostCommandRefusal) : HostAddressUpdateResult
}
