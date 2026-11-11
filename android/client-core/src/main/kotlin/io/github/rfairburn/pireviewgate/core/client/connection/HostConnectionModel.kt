package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.AppAppearance
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason

/**
 * What one host's connection currently looks like from this side.
 *
 * The set follows the source coordinator's destination states exactly. It is a
 * report, not a promise: [CONNECTED] is only ever published after an
 * authenticated application channel actually opened, and every other value says
 * what this side is doing or why it stopped.
 */
public enum class HostConnectionPhase {
    /** Nothing has been attempted for this saved host in this session. */
    NEVER,

    /** A TLS connection and application channel open are in flight. */
    CONNECTING,

    /** An explicit pairing is waiting for local or remote approval. */
    PAIRING,

    /** An authenticated application channel is open. */
    CONNECTED,

    /** A bounded automatic retry is scheduled. */
    RETRYING,

    /** No channel, and nothing scheduled. */
    DISCONNECTED,

    /** A terminal authorization, identity, or trust refusal. */
    ERROR,
    ;
}

/**
 * Why one host connection is where it is.
 *
 * Fixed reasons only: no peer text, no endpoint, no key material, and no
 * exception message ever travels through this type, so a value is safe to show
 * an operator and safe to compare in a controller.
 */
public enum class HostConnectionReason {
    /** Nothing notable. */
    NONE,

    /** An application channel open is in flight. */
    CONNECTING,

    /** A pairing is waiting for approval. */
    PAIRING,

    /** A bounded automatic retry is scheduled or running. */
    RECONNECTING,

    /** The finite automatic schedule is exhausted. */
    AUTO_STOPPED,

    /** An open channel ended. */
    CONNECTION_LOST,

    /** The peer refused the pairing. */
    PAIRING_DENIED,

    /** The peer's pairing window expired. */
    PAIRING_EXPIRED,

    /** The peer refused the application channel. */
    NOT_AUTHORIZED,

    /** The remembered key does not match the key the peer proved. */
    PEER_KEY_CHANGED,

    /** The saved association is pinned to another endpoint. */
    PIN_ENDPOINT_MISMATCH,

    /** Local approval was declined, cancelled, or timed out. */
    APPROVAL_DECLINED,

    /** Trust storage refused: nothing is assumed about any key. */
    TRUST_UNAVAILABLE,

    /** This device's peer identity is missing, unsafe, or inconsistent. */
    IDENTITY_UNAVAILABLE,

    /** This device's peer identity has never been initialized. */
    IDENTITY_NOT_INITIALIZED,

    /** Saved configuration could not be read or published. */
    SETTINGS_UNAVAILABLE,

    /** The injected local-network capability refused this dial. */
    LOCAL_NETWORK_UNAVAILABLE,

    /** The saved host id is not in the catalog. */
    UNKNOWN_HOST,

    /** The app left the foreground, which closes every channel. */
    BACKGROUND,
    ;

    /**
     * True when this reason must never be retried in the background. Only an
     * explicit user Connect may try again after one of these.
     */
    public val terminal: Boolean
        get() = when (this) {
            PEER_KEY_CHANGED,
            PIN_ENDPOINT_MISMATCH,
            TRUST_UNAVAILABLE,
            IDENTITY_UNAVAILABLE,
            IDENTITY_NOT_INITIALIZED,
            PAIRING_DENIED,
            PAIRING_EXPIRED,
            APPROVAL_DECLINED,
            NOT_AUTHORIZED,
            -> true
            else -> false
        }
}

/** One host's connection, as an immutable value. */
public data class HostConnectionSnapshot(
    public val hostId: HostId,
    public val endpoint: Endpoint,
    public val label: String,
    public val phase: HostConnectionPhase,
    public val reason: HostConnectionReason,
    /** This destination's admission epoch. Every channel and guard carries it. */
    public val generation: Long,
    /** True only after an authenticated application channel actually opened. */
    public val previouslyConnected: Boolean,
    /** True while an explicit Disconnect suppresses automatic attempts. */
    public val reconnectSuppressed: Boolean,
    /** True when the finite automatic schedule may still try this host. */
    public val autoEligible: Boolean,
    /** Display-only fingerprint of the peer this side verified, when connected. */
    public val peerFingerprint: String?,
)

/** What this device's own peer identity can currently do. */
public sealed interface DeviceIdentityObservation {
    /** A usable identity exists. Only the public fingerprint is reported. */
    public data class Ready(public val fingerprint: String) : DeviceIdentityObservation

    /** Nothing has ever been initialized. Only an explicit Connect may change that. */
    public data object NeverInitialized : DeviceIdentityObservation

    /** Identity storage refused. The client never regenerates a lost identity. */
    public data class Refused(public val reason: DeviceIdentityReason) : DeviceIdentityObservation
}

/** Fixed identity availability reasons for the observation surface. */
public enum class DeviceIdentityReason {
    /** A previous initialization is expected but its key entry is gone. */
    MISSING_INITIALIZED,

    /** Evidence and key entry disagree, or the evidence is unreadable. */
    INCONSISTENT,

    /** The key store itself is unavailable. */
    KEY_STORE_UNAVAILABLE,

    /** The stored entry is not the expected usable identity. */
    UNSAFE_KEY_MATERIAL,

    /** The key exists but cannot sign. */
    KEY_UNUSABLE,
}

/** One durable storage handle's availability, with a fixed reason. */
public data class StorageHandleState(
    public val available: Boolean,
    public val reason: StorageFailureReason? = null,
)

/** What the registry could actually read from durable storage at startup. */
public data class StorageObservation(
    public val settings: StorageHandleState,
    public val trust: StorageHandleState,
)

/**
 * The complete immutable observation of every host connection.
 *
 * A snapshot is a value, so a UI frame, a reconnect pass, or a controller can
 * each hold their own without any of them seeing another's mutation. Hosts
 * appear in saved order, and several entries may name the same endpoint: the
 * client has no "current host" slot and no singleton destination.
 */
public data class ConnectionRegistrySnapshot(
    /** Bumped on every published snapshot. */
    public val generation: Long,
    /** Bumped whenever a preference copy lands, so a controller can invalidate. */
    public val settingsGeneration: Long,
    public val foreground: Boolean,
    public val autoReconnectEnabled: Boolean,
    /**
     * This viewer's remote native input/copy preference.
     *
     * Reported OFF whenever saved configuration is unavailable: an unreadable
     * document is never treated as "on".
     */
    public val viewerRemoteInputEnabled: Boolean,
    public val identity: DeviceIdentityObservation,
    public val storage: StorageObservation,
    public val hosts: List<HostConnectionSnapshot>,
    /** Bounded, latched local key confirmations awaiting a foreground decision. */
    public val pendingConsents: List<HostKeyConsent>,
    /**
     * The last thing the registry could not complete, or `null`.
     *
     * It is deliberately a single fixed value rather than a counter: a failed
     * save, an un-cleared pin, or a removal that did not land must stay visible
     * until the next operation replaces it, so a controller never mistakes "no
     * error thrown" for "the durable state matches what I asked for".
     */
    public val notice: RegistryNotice?,

    /**
     * Saved LIST/SEARCH first-reply patience, in whole seconds.
     *
     * This is a local requester deadline only; it never appears on the wire. Absent
     * saved configuration reports the in-memory default of 60.
     */
    public val savedFirstReplyTimeoutSeconds: Int = NetworkSettings.DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_SECONDS,

    /**
     * Saved whole-app diagnostic status/notice presentation, off by default.
     *
     * Purely presentational: it decides whether the client draws its diagnostic
     * status and notice surfaces, and it grants or revokes nothing. Input, delivery,
     * clipboard, storage, and proof authority never consult it.
     */
    public val debugInputMessagingEnabled: Boolean = NetworkSettings.DEFAULT_DEBUG_INPUT_MESSAGING_ENABLED,

    /**
     * Saved app appearance, light by default.
     *
     * Purely presentational: it selects the Material appearance the app's own
     * screens, dialogs, and controls are painted with. Host-provided terminal colors
     * and the terminal's own defaults never read it, and it grants or revokes no
     * input, delivery, clipboard, storage, trust, or proof authority. Absent saved
     * configuration reports the shipped light default.
     */
    public val appearance: AppAppearance = NetworkSettings.DEFAULT_APPEARANCE,
)
