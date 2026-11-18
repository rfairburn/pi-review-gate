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
     * Optional capability for the owner's native lane: the advertised native
     * launch-target catalog on `snapshot_end`, the typed backend identity on rows
     * the owner reports, and the rowless native create exchange. It states only
     * that the owner really holds both a native create provider and an explicit
     * catalog; protocol support only, never authority or an available target.
     */
    const val NATIVE_CAPABILITY: String = "roster-native-v1"

    /**
     * Optional capability for the owner's SEPARATE native host-caption lane. An
     * owner may advertise native targets while never accepting a remote caption,
     * so this is negotiated independently and never inferred from
     * [NATIVE_CAPABILITY] or from the Pi rename capability.
     */
    const val NATIVE_NAME_CAPABILITY: String = "roster-native-name-v1"

    /**
     * Optional capability DESCRIBING how the owner's [NATIVE_CAPABILITY] catalog is
     * produced (#493). It depends on that lane: an acknowledgement carrying it without
     * [NATIVE_CAPABILITY] is a protocol violation.
     *
     * Acknowledged, each `snapshot_end` catalog is the owner's fresh read-only launch
     * probe at publication, so its targets are the ones observed launchable then.
     * Unacknowledged (absent or a legacy owner), the catalog is configuration-only and
     * its availability is UNKNOWN: never assumed launchable and never assumed
     * unavailable. It adds no frame, field, target, or kind state, and it grants
     * nothing: the owner still re-reads and re-proves its own live catalog before
     * every native create.
     */
    const val NATIVE_AVAILABILITY_CAPABILITY: String = "roster-native-availability-v1"

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
        NATIVE_CAPABILITY,
        NATIVE_NAME_CAPABILITY,
        NATIVE_AVAILABILITY_CAPABILITY,
    )

    /**
     * True when [capabilities] respect every optional-capability dependency: the
     * native availability description exists only beside the native lane it
     * describes.
     */
    fun dependenciesHold(capabilities: Collection<String>): Boolean =
        !capabilities.contains(NATIVE_AVAILABILITY_CAPABILITY) || capabilities.contains(NATIVE_CAPABILITY)

    /** One metadata subscription per channel; not configurable. */
    const val MAX_SUBSCRIPTIONS_PER_CHANNEL: Int = 1

    /** One snapshot transfer in flight per channel; not configurable. */
    const val MAX_IN_FLIGHT_TRANSFERS: Int = 1

    /** One newest-wins pending snapshot per channel; not configurable. */
    const val MAX_PENDING_SNAPSHOTS: Int = 1
}

/** Largest value a JSON number can carry exactly, mirroring the source's safe-integer limit. */
const val MAX_SAFE_INTEGER: Long = 9_007_199_254_740_991L
