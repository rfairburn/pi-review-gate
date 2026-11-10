package io.github.rfairburn.pireviewgate.core.hosts

import java.util.UUID

/**
 * Opaque local handle for one configured host (mirrors the source `PeerDestination.id`
 * and the trust store's remembered-key target id).
 *
 * A [HostId] is data only. It is never an identity, never an endpoint, never a
 * path component, and never a map key with language-level authority: it is held
 * in ordinary collections, so a value such as `__proto__` is just a string here.
 * The same id is the association key between a saved host, its remembered server
 * key, and its per-host connection state, so it is stable across restarts and is
 * never re-derived from a label or endpoint.
 *
 * Bounds follow the source `MAX_PEER_DESTINATION_ID_CHARS` /
 * `MAX_REMEMBERED_TARGET_ID_CHARS`: non-empty, at most [MAX_ID_CHARS] characters,
 * no control characters.
 */
@JvmInline
public value class HostId private constructor(public val value: String) {

    public companion object {
        /** Bound for one opaque local host id. */
        public const val MAX_ID_CHARS: Int = 128

        private val FORBIDDEN: Regex = Regex("[\\u0000-\\u001F\\u007F\\u0080-\\u009F\\u2028\\u2029]")

        /** Structural admission for one candidate local host id. */
        public fun isValid(value: String): Boolean =
            value.isNotEmpty() && value.length <= MAX_ID_CHARS && !FORBIDDEN.containsMatchIn(value)

        /** Parsed id, or `null` when [value] is not a well-formed local id. */
        public fun parseOrNull(value: String): HostId? = if (isValid(value)) HostId(value) else null

        /**
         * Parsed id.
         *
         * @throws IllegalArgumentException when [value] is not a well-formed local id.
         */
        public fun parse(value: String): HostId =
            parseOrNull(value) ?: throw IllegalArgumentException("host id is invalid")

        /**
         * Fresh locally generated id for one newly saved host. Generation is local
         * only: it creates no key material, file, directory, or connection.
         */
        public fun generate(): HostId = HostId(UUID.randomUUID().toString())
    }
}
