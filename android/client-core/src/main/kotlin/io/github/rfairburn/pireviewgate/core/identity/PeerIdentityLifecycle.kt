package io.github.rfairburn.pireviewgate.core.identity

import io.github.rfairburn.pireviewgate.core.hosts.ExclusiveLock
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason

/** What the platform key store holds under one alias. */
public sealed interface MaterialObservation {
    /** No entry exists under this alias. */
    public data object Absent : MaterialObservation

    /** A usable entry exists, with its canonical identity. */
    public class Present(public val handle: PeerIdentityHandle) : MaterialObservation

    /** An entry exists but is not the expected usable identity. */
    public class Unusable(public val reason: IdentityFailureReason) : MaterialObservation
}

/**
 * The platform seam that touches key material.
 *
 * Keeping generation and observation behind this seam means the initialization policy
 * — evidence, presence, refusal, serialization — is ordinary code that is testable off
 * device, and the platform adapter does one thing only: talk to its key store.
 */
public interface PeerIdentityMaterialSeam {
    /** Observe the alias. Never creates anything. */
    public fun observe(alias: String): MaterialObservation

    /**
     * Generate the key entry at [alias].
     *
     * The caller serializes this call and only reaches it when no identity exists.
     *
     * @throws IdentityException when the platform refuses.
     */
    public fun generate(alias: String, label: HostLabel)
}

/**
 * The client's peer identity lifecycle, independent of any platform.
 *
 * Presence is decided from two independent facts, never from one:
 *
 * | evidence | key entry | meaning |
 * |---|---|---|
 * | absent | absent | [PeerIdentityStatus.NeverInitialized] — a fresh device; [initialize] may generate |
 * | present | absent | [IdentityFailureReason.MISSING_INITIALIZED] — a lost entry; never regenerated |
 * | present | present, same key | [PeerIdentityStatus.Ready] |
 * | present | present, other key | [IdentityFailureReason.INCONSISTENT_EVIDENCE] — never adopted |
 * | absent | present | [IdentityFailureReason.INCONSISTENT_EVIDENCE] — a key with no recorded initialization |
 * | refused | — | refused; the state is unknown, so nothing is generated |
 *
 * [initialize] runs the whole check — evidence read, entry observation, generation, and
 * exclusive evidence publication — inside one [ExclusiveLock]. Two callers, two
 * adapters, or two processes naming the same alias therefore cannot both generate: the
 * second sees the first one's evidence and refuses with
 * [IdentityFailureReason.ALREADY_INITIALIZED].
 *
 * [status] and [current] observe only, and they observe without creating: neither a
 * key, a certificate, a file, a directory, nor a lock file appears because someone
 * asked whether an identity exists. Only [initialize] may write, and it does so under
 * the exclusive lock.
 */
public class PeerIdentityLifecycle(
    private val alias: String,
    private val material: PeerIdentityMaterialSeam,
    private val evidence: PeerIdentityEvidenceStore,
    private val lock: ExclusiveLock,
) : PeerIdentityStore {

    override fun status(): PeerIdentityStatus = lock.withObservation { decide() }

    override fun current(): PeerIdentityHandle = lock.withObservation {
        when (val present = decide()) {
            is PeerIdentityStatus.Ready -> when (val observation = material.observe(alias)) {
                is MaterialObservation.Present -> observation.handle
                is MaterialObservation.Unusable -> throw IdentityException(observation.reason)
                MaterialObservation.Absent -> throw IdentityException(IdentityFailureReason.MISSING_INITIALIZED)
            }
            is PeerIdentityStatus.Refused -> throw IdentityException(present.reason)
            PeerIdentityStatus.NeverInitialized ->
                throw IdentityException(IdentityFailureReason.MISSING_INITIALIZED)
        }
    }

    override fun initialize(label: HostLabel): PeerIdentityHandle {
        if (!HostLabel.isValid(label.value)) {
            throw IdentityException(IdentityFailureReason.LABEL_INVALID)
        }
        return lock.withLock {
            when (val present = decide()) {
                is PeerIdentityStatus.Ready -> throw IdentityException(IdentityFailureReason.ALREADY_INITIALIZED)
                is PeerIdentityStatus.Refused -> throw IdentityException(present.reason)
                PeerIdentityStatus.NeverInitialized -> Unit
            }
            material.generate(alias, label)
            val handle = when (val observation = material.observe(alias)) {
                is MaterialObservation.Present -> observation.handle
                is MaterialObservation.Unusable -> throw IdentityException(observation.reason)
                MaterialObservation.Absent -> throw IdentityException(IdentityFailureReason.KEY_UNUSABLE)
            }
            when (val published = evidence.publishExclusive(PeerIdentityEvidence(handle.key))) {
                EvidencePublishResult.Published -> handle
                // The entry exists but this client cannot prove it initialized it. The
                // identity is reported unusable rather than trusted or replaced: a
                // second key would silently break every host that pinned the first.
                is EvidencePublishResult.Refused ->
                    throw IdentityException(IdentityFailureReason.INCONSISTENT_EVIDENCE)
            }
        }
    }

    override fun close() {
        // Nothing to release: the platform entry outlives this handle by design.
    }

    /** Decide presence from evidence plus entry. Never creates anything. */
    private fun decide(): PeerIdentityStatus {
        val evidenceRead = evidence.read()
        if (evidenceRead is EvidenceRead.Refused) return PeerIdentityStatus.Refused(asIdentityReason(evidenceRead.reason))

        val observation = material.observe(alias)
        if (observation is MaterialObservation.Unusable) return PeerIdentityStatus.Refused(observation.reason)

        val entryAbsent = observation is MaterialObservation.Absent
        return when {
            evidenceRead is EvidenceRead.Absent && entryAbsent -> PeerIdentityStatus.NeverInitialized
            evidenceRead is EvidenceRead.Absent ->
                PeerIdentityStatus.Refused(IdentityFailureReason.INCONSISTENT_EVIDENCE)
            entryAbsent -> PeerIdentityStatus.Refused(IdentityFailureReason.MISSING_INITIALIZED)
            else -> {
                val actual = (observation as MaterialObservation.Present).handle.key
                val recorded = (evidenceRead as EvidenceRead.Present).evidence.key
                if (actual == recorded) PeerIdentityStatus.Ready
                else PeerIdentityStatus.Refused(IdentityFailureReason.INCONSISTENT_EVIDENCE)
            }
        }
    }

    private fun asIdentityReason(reason: StorageFailureReason): IdentityFailureReason = when (reason) {
        StorageFailureReason.MISSING_INITIALIZED -> IdentityFailureReason.MISSING_INITIALIZED
        StorageFailureReason.MALFORMED,
        StorageFailureReason.UNSUPPORTED_VERSION,
        StorageFailureReason.UNSAFE_OBJECT,
        -> IdentityFailureReason.INCONSISTENT_EVIDENCE
        StorageFailureReason.UNREADABLE,
        StorageFailureReason.CHANGED,
        StorageFailureReason.WRITE_FAILED,
        StorageFailureReason.UNAVAILABLE,
        -> IdentityFailureReason.KEY_STORE_UNAVAILABLE
    }
}
