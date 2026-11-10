package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkRequestToken
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire

/**
 * What this client currently observes about one host's connection lifecycle.
 *
 * The set is the operator-visible lifecycle, not a transport state machine: the
 * future controller maps its own attempts onto these values. [DISCONNECTED] covers
 * both "never connected" and "an explicit Disconnect was honoured"; the saved
 * [ConfiguredHost.reconnectSuppressed] fact says which.
 */
public enum class HostConnectionState {
    DISCONNECTED,
    CONNECTING,
    PAIRING,
    RETRYING,
    CONNECTED,
    ERROR,
}

/**
 * How current one host's roster view is.
 *
 * Only a host that actually reported a snapshot can be [CURRENT] or [STALE]; a host
 * that never reported one has no [HostUiState.roster] at all, which is a different
 * statement from a snapshot carrying zero rows.
 */
public enum class RosterFreshness {
    /** The last complete snapshot is the one this client is still being fed. */
    CURRENT,

    /** The connection closed or the view aged out: rows are retained but no longer live. */
    STALE,
}

/** Three-valued view of one optional negotiated capability. */
public enum class CapabilityStatus {
    /** Nothing is known yet: no acknowledgement was observed on this connection. */
    UNKNOWN,

    /** This connection's acknowledgement included the capability. */
    SUPPORTED,

    /** This connection's acknowledgement completed and did not include the capability. */
    UNSUPPORTED,
}

/**
 * The owner-negotiated capabilities of one live connection.
 *
 * [negotiated] is true only after this connection's acknowledgement was observed.
 * Until then every per-capability status is [CapabilityStatus.UNKNOWN] and no
 * capability-gated affordance may be offered: an unknown capability is never
 * rendered as support, and never rendered as refusal either.
 *
 * This is a projection of the roster lane's own capability identifiers
 * ([RosterWire]); it adds no capability of its own and grants nothing.
 */
public data class HostCapabilities(
    public val negotiated: Boolean = false,
    public val minor: Long? = null,
    public val close: CapabilityStatus = CapabilityStatus.UNKNOWN,
    public val create: CapabilityStatus = CapabilityStatus.UNKNOWN,
    public val saved: CapabilityStatus = CapabilityStatus.UNKNOWN,
    public val rename: CapabilityStatus = CapabilityStatus.UNKNOWN,
    public val rosterSlot: CapabilityStatus = CapabilityStatus.UNKNOWN,
) {
    /** Support for one identifier, or [CapabilityStatus.UNKNOWN] before negotiation. */
    public fun statusOf(capability: String): CapabilityStatus = when (capability) {
        RosterWire.CLOSE_CAPABILITY -> close
        RosterWire.CREATE_CAPABILITY -> create
        RosterWire.SAVED_CAPABILITY -> saved
        RosterWire.RENAME_CAPABILITY -> rename
        RosterWire.ROSTER_SLOT_CAPABILITY -> rosterSlot
        else -> CapabilityStatus.UNKNOWN
    }

    /** True only when this connection positively acknowledged [capability]. */
    public fun supports(capability: String): Boolean = statusOf(capability) == CapabilityStatus.SUPPORTED

    public companion object {
        /** Nothing is known yet. Every gated affordance stays closed. */
        public val UNKNOWN: HostCapabilities = HostCapabilities()

        /**
         * Project one completed acknowledgement.
         *
         * Identifiers this implementation does not know are ignored, exactly as the
         * lane ignores them; every known optional capability is then reported as
         * SUPPORTED or UNSUPPORTED because the acknowledgement is complete.
         */
        public fun fromAcknowledged(capabilities: List<String>, minor: Long): HostCapabilities =
            HostCapabilities(
                negotiated = true,
                minor = minor,
                close = status(capabilities, RosterWire.CLOSE_CAPABILITY),
                create = status(capabilities, RosterWire.CREATE_CAPABILITY),
                saved = status(capabilities, RosterWire.SAVED_CAPABILITY),
                rename = status(capabilities, RosterWire.RENAME_CAPABILITY),
                rosterSlot = status(capabilities, RosterWire.ROSTER_SLOT_CAPABILITY),
            )

        private fun status(capabilities: List<String>, capability: String): CapabilityStatus =
            if (capability in capabilities) CapabilityStatus.SUPPORTED else CapabilityStatus.UNSUPPORTED
    }
}

/**
 * What this client knows about one owner's Saved delete exposure.
 *
 * [UNKNOWN] is the honest starting point and the safe one: delete affordances stay
 * hidden until the owner positively exposes them, and they stay hidden when the
 * owner says it does not expose them.
 */
public enum class SavedPolicyStatus {
    UNKNOWN,
    OFF,
    EXPOSED,
}

/**
 * One host's complete view state.
 *
 * [host] is the saved association itself — the same [ConfiguredHost] the durable
 * catalog holds, so label, endpoint, connection history, and reconnect suppression
 * are never copied into a second mutable store.
 *
 * [roster] is `null` while this host has never produced a complete snapshot. That
 * is deliberately distinct from a snapshot whose [RosterSnapshot.rows] is empty,
 * which is the owner positively reporting zero sessions.
 *
 * [serverFingerprint] is display-only proof text for the identity this client
 * remembers for this host at its saved endpoint. `null` means unknown; it is never
 * a placeholder, and it never carries key material or a secret.
 *
 * [noticeText] is bounded, controller-supplied display text for the current
 * connection condition. It is never raw peer text, a path, or an exception message.
 *
 * [pendingConnectToken] is the explicit-connect-intent token the controller issues
 * when the platform's local-network permission applies. The UI echoes it back inside
 * [ClientIntent.ConnectHost] on the operator's own Connect tap and never mints one:
 * the caller owns the generation, and the permission is never requested on
 * composition or resume.
 */
public data class HostUiState(
    public val host: ConfiguredHost,
    public val connection: HostConnectionState = HostConnectionState.DISCONNECTED,
    public val roster: RosterSnapshot? = null,
    public val capabilities: HostCapabilities = HostCapabilities.UNKNOWN,
    public val savedPolicy: SavedPolicyStatus = SavedPolicyStatus.UNKNOWN,
    public val serverFingerprint: String? = null,
    public val noticeText: String? = null,
    public val pendingConnectToken: LocalNetworkRequestToken? = null,
) {
    /** Rows this host currently contributes to the unified list; none when unknown. */
    public val rows: List<SessionUiState> get() = roster?.rows ?: emptyList()

    /** True when the owner positively reported a roster, even a zero-row one. */
    public val hasRosterObservation: Boolean get() = roster != null

    /** True when rows exist but are no longer live. Never inferred from absence. */
    public val isStale: Boolean get() = roster?.freshness == RosterFreshness.STALE

    /** Delete exposure for this owner's Saved list: only a positive exposure opens it. */
    public val savedDeleteExposed: Boolean get() = savedPolicy == SavedPolicyStatus.EXPOSED

    /**
     * True only when this owner can take a create now: the connection is live *and*
     * create was positively acknowledged. An unacknowledged or unknown capability is
     * never eligible, and eligibility is never inferred from history.
     */
    public val canCreateSession: Boolean
        get() = connection == HostConnectionState.CONNECTED &&
            capabilities.supports(RosterWire.CREATE_CAPABILITY)

    /** True only when this owner can serve a Saved listing now, by the same rule. */
    public val canBrowseSaved: Boolean
        get() = connection == HostConnectionState.CONNECTED &&
            capabilities.supports(RosterWire.SAVED_CAPABILITY)
}

/**
 * One host's roster view: whose run it is, how current it is, and its rows.
 *
 * [revision] and [hostRunId] come from the owner's own snapshot and are what a
 * frozen action target is stamped with, so a confirmation always names the snapshot
 * it was drawn from instead of whatever arrived afterwards.
 */
public data class RosterSnapshot(
    public val freshness: RosterFreshness,
    public val hostRunId: String,
    public val revision: Long,
    public val rows: List<SessionUiState>,
) {
    /** Zero is meaningful here: this snapshot exists and carries no rows. */
    public val rowCount: Int get() = rows.size
}
