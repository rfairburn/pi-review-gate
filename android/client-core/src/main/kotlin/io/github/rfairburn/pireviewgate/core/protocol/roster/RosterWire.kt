package io.github.rfairburn.pireviewgate.core.protocol.roster

/**
 * Service identity, version pair, capability identifiers, and the fixed
 * non-configurable ceilings of the roster metadata lane.
 *
 * This lane has its own service name and major/minor pair, deliberately
 * separate from the local child protocol. A different service name, a different
 * major version, or a missing required baseline capability is refused outright;
 * a minor version grants no capability and enables no behavior on its own.
 */
object RosterWire {
    /** Service identity of the metadata channel. */
    const val SERVICE: String = "pi-peer-roster-v1"

    /** Incompatible-change version. A mismatch is refused, never adapted. */
    const val MAJOR: Long = 1

    /** Additive-change version. Grants no capability and enables no behavior. */
    const val MINOR: Long = 0

    /** Every viewer must offer this; a hello without it is refused. */
    const val REQUIRED_CAPABILITY: String = "roster-v1"

    /** Optional capability for the owner Close exchange: protocol support only, never authority. */
    const val CLOSE_CAPABILITY: String = "roster-close-v1"

    /** Optional capability for the rowless owner-create exchange: protocol support only, never authority. */
    const val CREATE_CAPABILITY: String = "roster-create-v1"

    /** Optional capability for the Saved catalog exchange: protocol support only, never delete permission. */
    const val SAVED_CAPABILITY: String = "roster-saved-v1"

    /** Optional capability for the owner rename exchange: protocol support only, never a name store. */
    const val RENAME_CAPABILITY: String = "roster-rename-v1"

    /**
     * Optional capability for the owner's durable roster-slot presentation
     * metadata. It says only that rows on this channel may carry the optional
     * bounded `rosterSlotId` field, and that a row without a slot honestly omits
     * it. It grants nothing: the owner run plus the row's own id stay the only
     * selection, input, and action identity.
     */
    const val ROSTER_SLOT_CAPABILITY: String = "roster-slot-v1"

    /**
     * Optional capabilities this implementation knows. An identifier offered by a
     * peer is recorded only when it appears here and is otherwise ignored; an
     * acknowledgement additionally narrows to what the owner can really honour.
     */
    val KNOWN_OPTIONAL_CAPABILITIES: List<String> = listOf(
        CLOSE_CAPABILITY,
        CREATE_CAPABILITY,
        SAVED_CAPABILITY,
        RENAME_CAPABILITY,
        ROSTER_SLOT_CAPABILITY,
    )

    /** One metadata subscription per channel; not configurable. */
    const val MAX_SUBSCRIPTIONS_PER_CHANNEL: Int = 1

    /** One snapshot transfer in flight per channel; not configurable. */
    const val MAX_IN_FLIGHT_TRANSFERS: Int = 1

    /** One newest-wins pending snapshot per channel; not configurable. */
    const val MAX_PENDING_SNAPSHOTS: Int = 1
}

/** Largest value a JSON number can carry exactly, mirroring the source's safe-integer limit. */
const val MAX_SAFE_INTEGER: Long = 9_007_199_254_740_991L
