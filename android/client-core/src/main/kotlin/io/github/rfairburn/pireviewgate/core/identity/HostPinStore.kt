package io.github.rfairburn.pireviewgate.core.identity

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason

/**
 * One remembered server identity, bound to the stable [HostId] and exact key.
 *
 * [endpoint] is the first-pinned address, retained as provenance for display, not
 * as identity. At a new configured locator the peer must still prove this exact
 * key. Per-attempt endpoint and generation admission remain the caller's duty.
 */
public data class HostPin(
    val hostId: HostId,
    val endpoint: Endpoint,
    val key: PeerKey,
)

/** What the pin store can say about one stable host association. */
public sealed interface PinRead {
    /** No key is remembered for this host: the next handshake may establish one. */
    public data object NoPin : PinRead

    /** This exact key is remembered for this host, independently of its locator. */
    public data class Remembered(public val key: PeerKey) : PinRead

    /**
     * Legacy/custom-store endpoint refusal. Callers must still fail closed.
     *
     * [FileHostPinStore] does not return this: its endpoint is provenance only.
     */
    public data object EndpointMismatch : PinRead

    /** Trust storage refused: the caller must not connect and must not assume anything. */
    public data class Refused(public val reason: StorageFailureReason) : PinRead
}

/** Outcome of recording the key a handshake actually proved. */
public sealed interface PinRecordResult {
    /** No key was remembered for this host, and this key now is. */
    public data object Recorded : PinRecordResult

    /** The proven key already equals the remembered key; nothing changed. */
    public data object Unchanged : PinRecordResult

    /**
     * A different key is already remembered for this host, at any locator.
     *
     * The remembered key is never replaced and the new key is never trusted. The
     * caller must surface this to the operator; only removing the host association
     * clears a pin.
     */
    public data object RejectedChangedKey : PinRecordResult

    /**
     * Legacy/custom-store endpoint refusal. Nothing is written or adopted.
     *
     * [FileHostPinStore] does not return this: continuity is the exact key, not
     * the provenance endpoint.
     */
    public data object EndpointMismatch : PinRecordResult

    /** The record could not be read or published; nothing was changed. */
    public data class Refused(public val reason: StorageFailureReason) : PinRecordResult
}

/** Outcome of forgetting one host's remembered key. */
public sealed interface PinClearResult {
    /** This host's pin is gone. Nothing else was touched. */
    public data object Cleared : PinClearResult

    /** Nothing was stored for this host; there was nothing to forget. */
    public data object NothingStored : PinClearResult

    /** The store refused; the pin may still be present. */
    public data class Refused(public val reason: StorageFailureReason) : PinClearResult
}

/**
 * Remembered server identities, one slot per host association.
 *
 * Pins live here and never in the settings document, so the two lifecycles stay
 * separate: saving a display preference never touches trust, and forgetting a host
 * never disturbs this device's own identity or any other host's pin.
 *
 * The rules are the product's fail-closed trust rules:
 *
 * - A pin is bound to one [HostId] and exact DER SPKI. The recorded [Endpoint]
 *   is first-pinned provenance only. Moving a saved locator does not clear,
 *   replace, or re-record that key. Host slots are never deduplicated by key.
 * - The caller must separately fence each actual endpoint and attempt generation;
 *   looking up a durable identity does not authorize a stale handshake.
 * - A pin is never derived from, or made authoritative by, a saved label or a
 *   connection-history flag.
 * - Recording proves continuity: the same key is [PinRecordResult.Unchanged], a new
 *   host association takes the observed key once, and a different key for a pinned
 *   host is [PinRecordResult.RejectedChangedKey]. A changed key is never adopted by
 *   an explicit Connect, a retry, or a reconnect.
 * - Clearing one host removes only that association's pin. Other hosts, this
 *   device's identity, and any owner-side work are untouched.
 * - Storage failures surface as [StorageFailureReason] and are never reported as
 *   "no pin": an unreadable trust document cannot be downgraded into a first-use
 *   acceptance.
 * - Publications are fenced by the underlying storage: a handle whose view of the
 *   document is stale is refused instead of overwriting newer trust.
 */
public interface HostPinStore : AutoCloseable {
    /**
     * Observe the remembered key for [hostId]. Never writes.
     *
     * [endpoint] is the caller's configured locator, not a durable lookup key.
     * A known host at a changed locator still returns the same remembered key.
     */
    public fun read(hostId: HostId, endpoint: Endpoint): PinRead

    /**
     * Record the exact key the current handshake proved for [hostId] at [endpoint].
     *
     * The caller must prove [endpoint] is the current configured target of the
     * live attempt before recording. For a known host, an equal key is Unchanged
     * and a different key is rejected regardless of endpoint, with no write.
     * Only a first record saves [endpoint] as provenance. Never replaces a key.
     */
    public fun record(hostId: HostId, endpoint: Endpoint, observed: PeerKey): PinRecordResult

    /** Forget one host association's pin only. */
    public fun clear(hostId: HostId): PinClearResult

    /** Fresh display-only projection of every remembered host, in stable order. */
    public fun snapshot(): List<HostPin>

    /** Release this handle. Later operations refuse. */
    override fun close()
}
