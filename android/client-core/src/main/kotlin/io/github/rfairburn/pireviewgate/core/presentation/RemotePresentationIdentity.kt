package io.github.rfairburn.pireviewgate.core.presentation

import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * Owner side of one remote presentation identity.
 *
 * [SLOT] is the owner's durable roster slot. [LEGACY_RUNTIME] is the owner-side
 * runtime row identity used when the owner reports no durable slot. They are
 * deliberately distinct: a runtime identity is never treated as, or converted
 * into, a durable slot identity.
 */
public enum class RemotePresentationOwnerKind(public val wireName: String) {
    SLOT("slot"),
    LEGACY_RUNTIME("runtime");

    public companion object {
        /** Exact wire/persisted spelling, or `null` for an unknown kind. */
        public fun fromWireName(value: String): RemotePresentationOwnerKind? =
            entries.firstOrNull { it.wireName == value }
    }
}

/**
 * Presentation identity of one remote session card.
 *
 * This is presentation-order authority only. [hostId] is this client's saved
 * destination handle, and [ownerKind]/[ownerId] identify the card on that owner.
 * It carries no label, workspace, native conversation, status, viewport,
 * transcript, input target, or action target. Selection, connection, input, and
 * actions stay with the runtime row and are never derived from this value.
 *
 * The owner component admission follows the source roster-store bound:
 * non-empty, at most [MAX_OWNER_ID_CHARS] UTF-16 code units, and free of control
 * and line-separator characters. Identity derivation from a currently observed
 * row applies the source remote-roster protocol bounds for a durable slot and
 * for the exact owner run and row that form a legacy runtime identity.
 */
public class RemotePresentationIdentity private constructor(
    public val hostId: HostId,
    public val ownerKind: RemotePresentationOwnerKind,
    public val ownerId: String,
) {
    public companion object {
        /** Bound for one protocol-carried remote row id, in UTF-8 bytes. */
        public const val MAX_LEGACY_ROW_ID_BYTES: Int = 256

        /** Bound for one roster-bridge owner run identifier, in UTF-8 bytes. */
        public const val MAX_LEGACY_RUN_ID_BYTES: Int = 64

        /**
         * Bound for one owner-side identity component, matching the source roster
         * store: an escaped `[owner run, row id]` tuple plus the two JSON quotes,
         * comma, and brackets.
         */
        public const val MAX_OWNER_ID_CHARS: Int =
            2 * (MAX_LEGACY_ROW_ID_BYTES + MAX_LEGACY_RUN_ID_BYTES) + 6

        /** Bound for a protocol-carried durable roster slot id, in Unicode code points. */
        public const val MAX_DURABLE_SLOT_ID_CHARS: Int = 128

        /** Bound for a protocol-carried durable roster slot id, in UTF-8 bytes. */
        public const val MAX_DURABLE_SLOT_ID_BYTES: Int = MAX_DURABLE_SLOT_ID_CHARS * 4

        private val FORBIDDEN: Regex = Regex("[\\u0000-\\u001F\\u007F\\u0080-\\u009F\\u2028\\u2029]")
        private val ROSTER_BRIDGE_IDENTIFIER: Regex = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]*$")

        /** A bounded owner identity component that may be persisted. */
        public fun isValidOwnerId(value: String): Boolean =
            value.isNotEmpty() && value.length <= MAX_OWNER_ID_CHARS && !FORBIDDEN.containsMatchIn(value)

        /** A durable roster slot id as the owner's remote roster boundary reports it. */
        public fun isValidObservedDurableSlotId(value: String): Boolean =
            value.isNotEmpty() &&
                // The source remote-roster bound counts Unicode code points, so a
                // supplementary-Unicode slot id is never refused at half its bound.
                value.codePointCount(0, value.length) <= MAX_DURABLE_SLOT_ID_CHARS &&
                value.toByteArray(Charsets.UTF_8).size <= MAX_DURABLE_SLOT_ID_BYTES &&
                !FORBIDDEN.containsMatchIn(value)

        /** Parsed identity, or `null` when the owner component is outside the bound. */
        public fun parseOrNull(
            hostId: HostId,
            ownerKind: RemotePresentationOwnerKind,
            ownerId: String,
        ): RemotePresentationIdentity? =
            if (isValidOwnerId(ownerId)) RemotePresentationIdentity(hostId, ownerKind, ownerId) else null

        /**
         * One durable owner-side roster slot identity.
         *
         * This is the source precedence rule when the owner negotiated a roster
         * slot: the slot is authoritative. A malformed slot is refused, never
         * replaced with a guessed runtime identity.
         */
        public fun slot(hostId: HostId, durableSlotId: String): RemotePresentationIdentity? =
            if (isValidObservedDurableSlotId(durableSlotId)) {
                RemotePresentationIdentity(hostId, RemotePresentationOwnerKind.SLOT, durableSlotId)
            } else {
                null
            }

        /**
         * One legacy owner-side runtime identity.
         *
         * The owner id is exactly the source JSON tuple `[hostRunId, rowId]`, with a
         * real JSON `null` when the owner reported no run. A row id reused on a new
         * owner run is therefore a different identity, and `null` stays distinct
         * from the string `"null"`. [hostRunId] is `null` for an absent run and a
         * valid roster-bridge identifier otherwise.
         */
        public fun legacyRuntime(
            hostId: HostId,
            hostRunId: String?,
            rowId: String,
        ): RemotePresentationIdentity? {
            if (hostRunId != null && !isValidLegacyRunId(hostRunId)) return null
            if (!isValidLegacyRowId(rowId)) return null
            return parseOrNull(hostId, RemotePresentationOwnerKind.LEGACY_RUNTIME, legacyRuntimeTuple(hostRunId, rowId))
        }

        internal fun isValidLegacyRowId(value: String): Boolean =
            value.isNotEmpty() &&
                value.toByteArray(Charsets.UTF_8).size <= MAX_LEGACY_ROW_ID_BYTES &&
                !FORBIDDEN.containsMatchIn(value)

        internal fun isValidLegacyRunId(value: String): Boolean =
            value.toByteArray(Charsets.UTF_8).size <= MAX_LEGACY_RUN_ID_BYTES &&
                ROSTER_BRIDGE_IDENTIFIER.matches(value)

        internal fun legacyRuntimeTuple(hostRunId: String?, rowId: String): String =
            "[" + (hostRunId?.let(::jsonString) ?: "null") + "," + jsonString(rowId) + "]"
    }

    internal val canonicalKey: String
        get() = "[" + jsonString("remote") + "," + jsonString(hostId.value) + "," +
            jsonString(ownerKind.wireName) + "," + jsonString(ownerId) + "]"

    override fun equals(other: Any?): Boolean = other is RemotePresentationIdentity &&
        hostId == other.hostId &&
        ownerKind == other.ownerKind &&
        ownerId == other.ownerId

    override fun hashCode(): Int {
        var result = hostId.hashCode()
        result = 31 * result + ownerKind.hashCode()
        return 31 * result + ownerId.hashCode()
    }

    override fun toString(): String =
        "RemotePresentationIdentity(hostId=${hostId.value}, ownerKind=${ownerKind.wireName}, ownerId=$ownerId)"
}

/**
 * Derive the presentation identity of one currently observed remote roster row.
 *
 * The source precedence is exact: a reported durable slot wins; a malformed slot
 * refuses the row instead of falling back to a runtime identity. A row without a
 * durable slot uses the legacy `[hostRunId, rowId]` tuple. An empty observed run is
 * the source's "no run" value (`null`), never the string `"null"`. Nothing is
 * guessed from a label, workspace path, or native conversation.
 */
public object RemotePresentationIdentityDerivation {
    public fun forObservedRow(
        hostId: HostId,
        hostRunId: String?,
        rowId: String,
        rosterSlotId: String?,
    ): RemotePresentationIdentity? {
        if (rosterSlotId != null) {
            return RemotePresentationIdentity.slot(hostId, rosterSlotId)
        }
        if (!RemotePresentationIdentity.isValidLegacyRowId(rowId)) return null
        val normalizedRun = when {
            hostRunId.isNullOrEmpty() -> null
            RemotePresentationIdentity.isValidLegacyRunId(hostRunId) -> hostRunId
            else -> return null
        }
        return RemotePresentationIdentity.legacyRuntime(hostId, normalizedRun, rowId)
    }

    public fun forObservedRow(row: RemotePresentationObservedRow): RemotePresentationIdentity? =
        forObservedRow(row.hostId, row.hostRunId, row.rowId, row.rosterSlotId)
}
