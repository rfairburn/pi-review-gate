package io.github.rfairburn.pireviewgate.core.hosts

/**
 * One saved host in the client's own configuration.
 *
 * [id] is the stable association and [endpoint] is its configured locator:
 * the remembered server key, the per-host terminal/input state, and the copy of the
 * remote pane all attach to [id], never to [label] and never to a "current host"
 * singleton. Several [ConfiguredHost] values may name the same [endpoint]; each
 * keeps its own id, its own pin, and its own state.
 *
 * The two booleans carry the exact source semantics:
 *
 * - [previouslyConnected] is true only after an authenticated connection to this
 *   host actually opened. It is the automatic-reconnect eligibility fact, and it is
 *   real state even when the save that recorded it failed.
 * - [reconnectSuppressed] is an explicit Disconnect intent, remembered across
 *   restarts until an explicit Connect clears it. It suppresses automatic attempts
 *   only: association, trust, and history survive it.
 *
 * [id] selects an association, not cryptographic proof. A saved endpoint, label,
 * or history flag never authorizes a connection and never derives a key.
 */
public data class ConfiguredHost(
    val id: HostId,
    val label: HostLabel,
    val endpoint: Endpoint,
    val previouslyConnected: Boolean = false,
    val reconnectSuppressed: Boolean = false,
) {
    /** Rename only: id, endpoint, and both lifecycle facts are preserved. */
    public fun withLabel(next: HostLabel): ConfiguredHost = copy(label = next)

    /**
     * Re-point this saved association at another endpoint.
     *
     * The id, label, and lifecycle facts survive. The exact remembered DER SPKI
     * stays bound to this id; its stored endpoint remains first-pinned provenance.
     * A fresh handshake at the new locator must prove that key before request
     * bytes; a changed key refuses rather than replaces. This value copy alone
     * neither saves nor connects nor retires old runtime authority.
     */
    public fun withEndpoint(next: Endpoint): ConfiguredHost = copy(endpoint = next)

    /** Remembered explicit Disconnect (`true`) or explicit Connect (`false`). */
    public fun withReconnectSuppressed(suppressed: Boolean): ConfiguredHost =
        copy(reconnectSuppressed = suppressed)

    /** Recorded after an authenticated connection actually opened. */
    public fun withPreviouslyConnected(connected: Boolean): ConfiguredHost =
        copy(previouslyConnected = connected)
}
