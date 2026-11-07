package io.github.rfairburn.pireviewgate.core.hosts

/**
 * The client's complete durable network configuration.
 *
 * It holds every configured host plus the three remembered global preferences. A
 * hosting/listen configuration and owner-side policies are deliberately absent: this
 * client dials out and hosts nothing, so an enabled-listener or owner-policy field
 * would be a setting with no effect.
 *
 * Defaults follow the source preference semantics and are only ever *in-memory*:
 *
 * - [autoReconnect] is off by default.
 * - [viewerRemoteInputEnabled] is on by default; a stored document omits the field
 *   when it is on and writes an explicit `false` when it is off.
 * - [savedFirstReplyTimeoutSeconds] is 60 by default; a stored document omits the
 *   field at that default and writes a positive whole-second value otherwise.
 *
 * A genuinely absent document is not "defaults": the store reports `null` so the
 * caller can show defaults without creating anything. A present-but-invalid
 * document is never treated as defaults either — it fails closed and stays
 * untouched.
 */
public data class NetworkSettings(
    val autoReconnect: Boolean = DEFAULT_AUTO_RECONNECT,
    val viewerRemoteInputEnabled: Boolean = DEFAULT_VIEWER_REMOTE_INPUT_ENABLED,
    val hosts: HostCatalog = HostCatalog.EMPTY,
    val savedFirstReplyTimeoutSeconds: Int = DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_SECONDS,
) {
    init {
        require(isValidSavedFirstReplyTimeoutSeconds(savedFirstReplyTimeoutSeconds)) {
            "saved first-reply timeout is not a positive whole number of seconds"
        }
    }

    public companion object {
        /** Automatic reconnect is remembered, off by default. */
        public const val DEFAULT_AUTO_RECONNECT: Boolean = false

        /** This viewer's remote native input/copy preference is on by default. */
        public const val DEFAULT_VIEWER_REMOTE_INPUT_ENABLED: Boolean = true

        /** Saved list/search first-reply patience, in whole seconds. */
        public const val DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_SECONDS: Int = 60

        /**
         * Largest whole-second value the closed settings document can express.
         *
         * This is not a product ceiling: it is the nine-digit decimal integer width
         * already enforced by the strict JSON number helper. A larger value is
         * refused rather than silently clamped or allowed to become an unreadable
         * document.
         */
        public const val MAX_SAVED_FIRST_REPLY_TIMEOUT_SECONDS: Int = 999_999_999

        /** In-memory defaults for a client that has never saved anything. */
        public val DEFAULTS: NetworkSettings = NetworkSettings()

        /** A whole number of seconds greater than zero and expressible by the document. */
        public fun isValidSavedFirstReplyTimeoutSeconds(seconds: Int): Boolean =
            seconds in 1..MAX_SAVED_FIRST_REPLY_TIMEOUT_SECONDS

        /**
         * Operator text admitted as one Saved first-reply wait.
         *
         * Only plain decimal digits are accepted. Empty text, signs, fractions,
         * exponents, and values outside the document's whole-second range are
         * refused; nothing is trimmed into a different number, clamped, or treated
         * as zero-means-infinite.
         */
        public fun parseSavedFirstReplyTimeoutSeconds(text: String): Int? {
            val trimmed = text.trim()
            if (trimmed.isEmpty() || trimmed.length > 9) return null
            if (!trimmed.all { it in '0'..'9' }) return null
            val seconds = trimmed.toIntOrNull() ?: return null
            return seconds.takeIf(::isValidSavedFirstReplyTimeoutSeconds)
        }

        /** Safe whole-seconds to milliseconds conversion, or `null` when refused. */
        public fun savedFirstReplyTimeoutMillis(seconds: Int): Long? =
            if (isValidSavedFirstReplyTimeoutSeconds(seconds)) seconds.toLong() * 1_000L else null
    }

    /**
     * True when an automatic reconnect attempt for [host] is eligible: the global
     * preference is on, this host connected successfully before, and no explicit
     * Disconnect suppressed it.
     *
     * Only the persisted facts are consulted here. Transport scheduling, terminal
     * state, and app lifecycle stay with their owners; this is not a connection
     * attempt and grants nothing.
     */
    public fun autoReconnectEligible(host: ConfiguredHost): Boolean =
        autoReconnect && host.previouslyConnected && !host.reconnectSuppressed

    /** Saved host by stable id, or `null`. */
    public fun findHost(id: HostId): ConfiguredHost? = hosts.find(id)

    /** One global preference changed; nothing else moves. */
    public fun withAutoReconnect(enabled: Boolean): NetworkSettings = copy(autoReconnect = enabled)

    /** One global preference changed; nothing else moves. */
    public fun withViewerRemoteInputEnabled(enabled: Boolean): NetworkSettings =
        copy(viewerRemoteInputEnabled = enabled)

    /** One global preference changed; nothing else moves. */
    public fun withSavedFirstReplyTimeoutSeconds(seconds: Int): NetworkSettings =
        copy(savedFirstReplyTimeoutSeconds = seconds)

    /** This setting's local deadline in milliseconds. */
    public val savedFirstReplyTimeoutMs: Long
        get() = requireNotNull(savedFirstReplyTimeoutMillis(savedFirstReplyTimeoutSeconds))

    /** Whole-catalog replacement, as used by a save of the edited catalog. */
    public fun withHosts(next: HostCatalog): NetworkSettings = copy(hosts = next)

    /** Save one new host; refuses on duplicate id or the count bound. */
    public fun addingHost(host: ConfiguredHost): SettingsMutation =
        hosts.added(host).asSettings { withHosts(it) }

    /** Replace the entry with the same id; refuses on unknown id. */
    public fun replacingHost(host: ConfiguredHost): SettingsMutation =
        hosts.replaced(host).asSettings { withHosts(it) }

    /** Forget one host association only. Pins and identity are separate lifecycles. */
    public fun removingHost(id: HostId): SettingsMutation =
        hosts.removed(id).asSettings { withHosts(it) }

    /** Apply one per-host fact (rename, suppression, connected history). */
    public fun updatingHost(
        id: HostId,
        transform: (ConfiguredHost) -> ConfiguredHost,
    ): SettingsMutation = hosts.updated(id, transform).asSettings { withHosts(it) }

    private inline fun HostCatalogMutation.asSettings(
        build: NetworkSettings.(HostCatalog) -> NetworkSettings,
    ): SettingsMutation = when (this) {
        is HostCatalogMutation.Ok -> SettingsMutation.Ok(build(catalog))
        is HostCatalogMutation.Failed -> SettingsMutation.Failed(reason)
    }
}

/** Result of one settings mutation: either the new value, or one fixed reason. */
public sealed interface SettingsMutation {
    public data class Ok(public val settings: NetworkSettings) : SettingsMutation
    public data class Failed(public val reason: CatalogFailureReason) : SettingsMutation
}
