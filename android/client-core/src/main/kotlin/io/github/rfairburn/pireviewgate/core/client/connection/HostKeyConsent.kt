package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * One bounded, latched local confirmation of a peer key this side proved but has
 * never remembered.
 *
 * The record is created only inside an explicit user Connect, only after a
 * complete TLS handshake proved a valid key, and only before any request byte.
 * It carries everything an operator needs to compare out of band — the exact
 * canonical key id, its display fingerprint, the endpoint it came from, and the
 * saved label — plus the two facts that make a late answer detectable: the
 * destination [generation] it belongs to and [expiresAtMonoMs], the monotonic
 * deadline after which no answer is admissible.
 *
 * It is bounded and latched: at most one confirmation per host exists at a time,
 * it appears in every snapshot until it is decided, expired, or retired, and it
 * never appears for an automatic or foreground-resume attempt. Nothing prompts
 * without a user having asked for this connection.
 */
public data class HostKeyConsent(
    public val consentId: Long,
    public val hostId: HostId,
    /** The saved label, or the peer certificate's bounded label as a fallback. */
    public val label: String,
    public val endpoint: Endpoint,
    /** Exact canonical identity: base64 of the SPKI DER proved on this handshake. */
    public val keyId: String,
    /** Display-only digest of the same key material. */
    public val fingerprint: String,
    /** This destination's admission epoch when the prompt was latched. */
    public val generation: Long,
    /** The foreground epoch the prompt belongs to. */
    public val foregroundEpoch: Long,
    /** Monotonic deadline. A decision after it is refused, never queued. */
    public val expiresAtMonoMs: Long,
)

/**
 * The cheap, thread-safe proof that a decision came from the foreground UI that
 * actually committed this exact prompt.
 *
 * A UI captures [foregroundEpoch] and [generation] from the snapshot it rendered
 * — it never derives them from a callback — and hands the tuple back with its
 * answer. Checking it costs one comparison of four values and performs no IO,
 * so it is safe to call from any thread at any moment, including after the app
 * backgrounded, the host was removed, or the attempt was superseded.
 *
 * The tuple alone cannot tell a prompt a person is looking at from one a stale,
 * dismissed, or never-rendered frame happened to copy. That is what
 * [CommittedPromptValidator] is for, and both answers pass through it.
 */
public data class HostKeyConsentProof(
    public val consentId: Long,
    public val hostId: HostId,
    public val generation: Long,
    public val foregroundEpoch: Long,
)

/**
 * The registry's question to the foreground UI: is this the prompt you have
 * actually committed to the screen right now?
 *
 * The registry can prove a decision matches a latched record; only the UI knows
 * whether that record is what a person is being asked. Without this seam, a
 * callback from a dismissed or replaced screen stays admissible for the whole
 * foreground epoch, and a snapshot nobody rendered yields an equally valid proof
 * — which is not consent.
 *
 * Implementations read the UI adapter's own atomic committed-prompt state: the
 * value it sets when a frame presenting this [HostKeyConsent] is committed, and
 * clears when that frame is replaced, dismissed, or recycled. They must be cheap,
 * thread-safe, non-blocking, and free of IO.
 *
 * There is no default implementation on purpose. An adapter that has not wired
 * committed-frame state gets refusals, not approvals: a confirmation nobody can
 * show is never answered.
 */
public fun interface CommittedPromptValidator {
    /** True only when [consent] is the prompt the current committed UI presents. */
    public fun isCommitted(consent: HostKeyConsent): Boolean
}

/** The operator's answer to one latched confirmation. */
public enum class HostKeyConsentChoice {
    /** Trust this exact key for this host association. */
    APPROVE,

    /** Refuse this exact key. */
    DENY,
    ;
}

/** Why a decision was not admissible. */
public enum class HostKeyConsentStaleReason {
    /** No such confirmation exists: unknown, already decided, or already retired. */
    UNKNOWN_CONSENT,

    /** The proof does not describe this confirmation. */
    PROOF_MISMATCH,

    /** The app is not in the foreground, so no UI decision is live. */
    NOT_IN_FOREGROUND,

    /** A different foreground UI epoch is current. */
    FOREGROUND_EPOCH_CHANGED,

    /** The attempt this prompt belonged to is no longer in flight. */
    ATTEMPT_SUPERSEDED,

    /** The saved host is gone or now names another endpoint. */
    TARGET_NOT_CURRENT,

    /** The confirmation window elapsed. */
    EXPIRED,

    /** A key is now remembered for this host, so there is nothing to confirm. */
    PIN_STATE_CHANGED,

    /**
     * The committed foreground UI no longer presents this prompt, so neither
     * answer counts as a decision a person made about it.
     */
    UI_NOT_COMMITTED,
    ;
}

/** Outcome of delivering one key-confirmation decision. */
public sealed interface HostKeyConsentResolution {
    /** The decision reached the in-flight pairing. */
    public data class Applied(public val choice: HostKeyConsentChoice) : HostKeyConsentResolution

    /** The decision was refused. Nothing connected and nothing retried. */
    public data class Stale(public val reason: HostKeyConsentStaleReason) : HostKeyConsentResolution
}

/** Outcome of one registry command. */
public sealed interface HostCommandResult {
    /** The command was accepted and its effect is in the published snapshot. */
    public data object Accepted : HostCommandResult

    /** The command was refused, with one fixed reason. */
    public data class Refused(public val reason: HostCommandRefusal) : HostCommandResult
}

/** Fixed command refusals. */
public enum class HostCommandRefusal {
    /** The id is not a saved host. */
    UNKNOWN_HOST,

    /** The registry has not started, or has closed. */
    NOT_RUNNING,

    /** An explicit attempt for this host is already in flight. */
    ATTEMPT_IN_FLIGHT,

    /** This host has no open connection right now. */
    NOT_CONNECTED,

    /** Saved configuration refused the publication. */
    SETTINGS_UNAVAILABLE,

    /** Trust storage refused. */
    TRUST_UNAVAILABLE,
    ;
}

/** Outcome of opening one content-lane channel on a connected host. */
public sealed interface HostContentChannelResult {
    /** The channel opened on the host's own transport. */
    public data class Opened(public val channel: HostContentChannel) : HostContentChannelResult

    /** The channel was refused with one fixed reason. */
    public data class Refused(
        public val reason: HostCommandRefusal,
        public val connection: HostConnectionReason = HostConnectionReason.NONE,
    ) : HostContentChannelResult
}
