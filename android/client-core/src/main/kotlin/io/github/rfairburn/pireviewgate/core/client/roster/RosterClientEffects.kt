package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCloseFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCreateFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerRenameFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedDeleteFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedResumeFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedWindowOutcome
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.SavedWindowRefusalReason

/**
 * What one roster client endpoint asks its owner of the future transport, and what
 * it reports back to the caller.
 *
 * The endpoint performs no I/O and starts no timer. It emits typed effects that a
 * future coordinator pumps to one transport and to one scheduler, and it accepts
 * the honest disposition of each write in return. The disposition is what decides
 * between a positively not-submitted refusal and an unobservable outcome: only a
 * write that was provably never invoked can be reported as never submitted.
 */

/** One outbound frame with the identity and proof the adapter must honour. */
public data class RosterClientMessage(
    /** Monotonic within this endpoint, so a disposition can be matched to its effect. */
    public val messageId: Long,
    public val frame: RosterFrame,
    /**
     * Checked by the adapter before it encodes and again immediately before it
     * invokes the transport. A proof that no longer holds means the write is never
     * invoked, and the endpoint then settles the operation as never submitted.
     */
    public val proof: RosterSendProof,
)

/** Which control deadline a token names. */
public enum class RosterDeadlineKind {
    /** Waiting for `hello_ack`. */
    HANDSHAKE,

    /** Waiting for `snapshot_begin` after subscribing. */
    SNAPSHOT_START,

    /** Waiting for the next frame of an in-flight snapshot transfer. */
    TRANSFER_IDLE,

    /** Waiting for `unsubscribed` on an outstanding retirement. */
    RETIREMENT_ACK,

    /** Requester patience for one `close_result`. */
    CLOSE_RESULT,

    /** Requester patience for one `create_result`. */
    CREATE_RESULT,

    /** Requester patience for one `rename_result`. */
    RENAME_RESULT,

    /** Requester patience for one Saved answer or window transfer. */
    SAVED_RESULT,
}

/**
 * One deadline, identified rather than timed.
 *
 * [id] is the subscription id for the subscription-scoped kinds, the request id for
 * the operation kinds, and the channel generation as text for the handshake.
 * [arm] is the endpoint's own generation of that registration: re-arming the same
 * kind and id mints a higher arm and cancels the previous one, so a callback that
 * was already queued by an earlier arm is recognizable as stale and is ignored
 * rather than allowed to expire the replacement deadline.
 */
public data class RosterDeadlineToken(
    public val kind: RosterDeadlineKind,
    public val id: String,
    public val arm: Long,
)

/** One thing this endpoint asks its owner to do. */
public sealed interface RosterClientEffect {
    /** Hand one frame to the transport with its proof. Never claims the peer acted on it. */
    public data class Send(public val message: RosterClientMessage) : RosterClientEffect

    /** Arm one deadline at an absolute local time. */
    public data class ArmDeadline(
        public val token: RosterDeadlineToken,
        public val dueAtMs: Long,
    ) : RosterClientEffect

    /** Drop one armed deadline. A coordinator that ignores this is still safe. */
    public data class CancelDeadline(public val token: RosterDeadlineToken) : RosterClientEffect

    /** End the channel. Emitted only for a protocol failure or an unconfirmed retirement. */
    public data object CloseChannel : RosterClientEffect
}

/**
 * The honest disposition of one write, reported by the adapter that performed it.
 *
 * The endpoint never infers a disposition from a resolved promise: resolution means
 * the bytes were admitted somewhere, nothing more. The adapter obtains the
 * permission to invoke the transport from
 * [RosterClientEndpoint.decideDispatch] for this message id, immediately before the
 * write, and reports [RosterSendDisposition.NotDispatched] with that refusal when
 * the endpoint says the write must not happen.
 */
public sealed interface RosterSendDisposition {
    /** The transport accepted the bytes. This is never proof the peer received them. */
    public data object Completed : RosterSendDisposition

    /** The write was invoked and then failed: acceptance can no longer be excluded. */
    public data object FailedAfterInvoke : RosterSendDisposition

    /** The adapter refused before invoking the transport, so no bytes were ever offered. */
    public data class NotDispatched(public val reason: RosterSendRefusal) : RosterSendDisposition
}

/** Fixed reason an adapter refused before invoking the transport. */
public enum class RosterSendRefusal {
    /** The channel or the endpoint is no longer usable, or this message's request is gone. */
    NOT_READY,

    /** The message's own dynamic proof no longer holds. */
    PROOF_UNAVAILABLE,

    /** Encoding this frame exceeded the lane's bounds. */
    ENCODE_FAILED,

    /** The owner no longer exposes remote delete for the run this request names. */
    POLICY_UNAVAILABLE,
}

/**
 * The endpoint's own last-instant decision on one emitted message.
 *
 * The adapter must obtain it immediately before invoking the transport. Only the
 * endpoint can combine its lifetime, the identity and deadline of the pending
 * request this message belongs to, the currently observed owner run and native
 * tuple, and the caller's UI proof, so a queued effect whose request was superseded,
 * timed out, moved, or stopped cannot reach the transport on the strength of a proof
 * object that still looks well-formed.
 */
public sealed interface RosterDispatchDecision {
    /** The write may be invoked now. Still not a claim the peer will act on it. */
    public data object Allow : RosterDispatchDecision

    /** The write must not be invoked; report it as [RosterSendDisposition.NotDispatched]. */
    public data class Refuse(public val reason: RosterSendRefusal) : RosterDispatchDecision
}

/** Fixed reason a request was positively never submitted, with no correlation id. */
public enum class RosterNotSentReason {
    /** The owner never acknowledged this exchange for this channel. */
    CAPABILITY_UNSUPPORTED,

    /** This endpoint is stopped, detached, failed, or still awaiting its handshake. */
    NOT_READY,

    /** The request could not be represented on this lane, or its proof was absent. */
    INVALID_REQUEST,

    /** The destination this request was built for is no longer the one observed. */
    TARGET_UNAVAILABLE,

    /** This endpoint already has that row, that slot, or that operation outstanding. */
    BUSY,

    /** This channel's outstanding-close table has reached its bound. */
    ROW_LIMIT,

    /** This channel's monotonic attempt scalar is exhausted. */
    LIMIT,

    /** The owner's described delete exposure for this run is unknown or Off. */
    POLICY_UNAVAILABLE,
}

/** Why one subscribe or resync request was refused without touching the channel. */
public enum class RosterSubscriptionRefusal {
    /** Stopped or detached: this endpoint never starts another subscription. */
    STOPPED,

    /** The handshake failed: there is nothing to subscribe to. */
    REFUSED,

    /** One subscription is already live on this channel. */
    ALREADY_SUBSCRIBED,

    /** A retirement is outstanding; the coordinator subscribes after it settles. */
    RETIRING,

    /** The handshake has not been acknowledged yet. */
    NOT_READY,
}

/** One owner answer, exactly as the owner reported it, with nothing added. */
public sealed interface RosterOwnerOutcome {
    public data class Close(public val facts: OwnerCloseFacts) : RosterOwnerOutcome
    public data class Create(public val facts: OwnerCreateFacts) : RosterOwnerOutcome
    public data class Rename(public val facts: OwnerRenameFacts) : RosterOwnerOutcome
    public data class SavedWindow(public val facts: RosterSavedWindowFacts) : RosterOwnerOutcome
    public data class SavedResume(public val facts: OwnerSavedResumeFacts) : RosterOwnerOutcome
    public data class SavedDelete(public val facts: OwnerSavedDeleteFacts) : RosterOwnerOutcome
}

/**
 * One complete Saved window over one immutable owner result.
 *
 * [total] is the FULL result total and may exceed any per-transfer bound; [offset]
 * is the actual position this window starts at, and [entries] is the honest list of
 * what this window actually carries. Nothing here caps, refines, or truncates the
 * owner's catalog.
 */
public sealed interface RosterSavedWindowFacts {
    public data class Complete(
        public val hostRunId: String,
        public val catalogId: String,
        public val resultId: String,
        public val total: Long,
        public val issueCount: Long,
        public val offset: Long,
        public val entries: List<OwnerSavedEntry>,
    ) : RosterSavedWindowFacts

    /** A fixed non-data refusal; a null reason is the owner's narrower statement. */
    public data class Refused(public val reason: SavedWindowRefusalReason? = null) : RosterSavedWindowFacts

    /** The owner has no usable catalog view for this request. */
    public data object Unavailable : RosterSavedWindowFacts

    /** Nothing is established and nothing is replayed. */
    public data object Unknown : RosterSavedWindowFacts
}

/** The three honest answers one submitted operation can end with. */
public sealed interface RosterRequestResult {
    /** The owner's own facts. Never a claim that this side's rows, focus, or selection changed. */
    public data class OwnerResult(public val outcome: RosterOwnerOutcome) : RosterRequestResult

    /** Positive proof no bytes were ever handed to the transport. Never means "the owner did nothing". */
    public data class NotSent(public val reason: RosterNotSentReason) : RosterRequestResult

    /** Unobservable: the write may have been accepted, the reply lost, or the deadline elapsed. */
    public data object Unknown : RosterRequestResult
}

/** Fixed local diagnostics. Never a row, label, key, frame, path, or exception detail. */
public enum class RosterClientDiagnosticCode {
    HELLO_ACCEPTED,
    HELLO_REFUSED,
    SUBSCRIBED,
    UNSUBSCRIBED,
    SNAPSHOT_PUBLISHED,
    SNAPSHOT_REJECTED,
    OWNER_ERROR,
    PROTOCOL_VIOLATION,
    SEND_FAILED,
    CHANNEL_CLOSED,
    CLIENT_STOPPED,
}

/** One observable thing that happened to one operation or to the projection. */
public sealed interface RosterClientEvent {
    /** A request was accepted and is now outstanding with this correlation id. */
    public data class OperationAccepted(
        public val kind: RosterOperationKind,
        public val requestId: String,
        public val hostRunId: String,
    ) : RosterClientEvent

    /** A request was refused before any id existed; nothing was submitted. */
    public data class OperationRefused(
        public val kind: RosterOperationKind,
        public val reason: RosterNotSentReason,
    ) : RosterClientEvent

    /** One operation settled exactly once. Nothing settles twice and nothing is replayed. */
    public data class OperationSettled(
        public val kind: RosterOperationKind,
        public val requestId: String,
        public val hostRunId: String,
        public val result: RosterRequestResult,
    ) : RosterClientEvent

    /** The published projection changed. Rows change only from a complete authoritative snapshot. */
    public data class ProjectionChanged(public val projection: RosterProjection) : RosterClientEvent

    /** Negotiation finished. The capability set is what this channel may ever assume. */
    public data class HandshakeAccepted(public val capabilities: List<String>) : RosterClientEvent

    /** Negotiation ended without an acknowledgement. */
    public data class HandshakeRefused(public val reason: RosterStalenessReason) : RosterClientEvent

    /** A fresh subscription is outstanding. */
    public data class SubscriptionStarted(public val subscriptionId: String) : RosterClientEvent

    /** A subscribe or resync was refused; nothing left this endpoint. */
    public data class SubscriptionRefused(public val reason: RosterSubscriptionRefusal) : RosterClientEvent

    /**
     * A retirement began. [subscriptionId] is `null` when there was nothing to
     * retire. The coordinator owns the next subscription attempt: this endpoint
     * never starts one on its own after a retirement.
     */
    public data class RetirementRequested(public val subscriptionId: String?) : RosterClientEvent

    /** The coordinator's resync joined the retirement already outstanding. */
    public data class RetirementJoined(public val subscriptionId: String) : RosterClientEvent

    /** A subscription ended. `acknowledged` is false when the owner never confirmed it. */
    public data class SubscriptionRetired(
        public val subscriptionId: String,
        public val acknowledged: Boolean,
    ) : RosterClientEvent

    /** The described delete policy changed, including back to `null` (unknown). */
    public data class SavedPolicyChanged(public val policy: RosterSavedPolicy?) : RosterClientEvent

    /**
     * The owner answered `confirmation-required` for one row. This arms the next
     * deliberate confirmed close and nothing else: no dialog, no send, and no
     * automatic retry follows from this endpoint.
     */
    public data class OwnerConfirmationRequired(
        public val hostRunId: String,
        public val rowId: String,
    ) : RosterClientEvent

    /** The channel is gone. Rows are retained as explicitly not current. */
    public data class ChannelClosed(public val reason: RosterStalenessReason) : RosterClientEvent

    /** A fixed local diagnostic. */
    public data class Diagnostic(
        public val code: RosterClientDiagnosticCode,
        public val rowCount: Long? = null,
    ) : RosterClientEvent
}

/** The result of one endpoint step: the new state, the effects to pump, the events to publish. */
public data class RosterClientStep(
    public val state: RosterClientState,
    public val effects: List<RosterClientEffect>,
    public val events: List<RosterClientEvent>,
) {
    public companion object {
        /** A step that changed nothing and asked for nothing. */
        public fun unchanged(state: RosterClientState): RosterClientStep =
            RosterClientStep(state, emptyList(), emptyList())
    }
}

internal fun OwnerSavedWindowOutcome.toClientFacts(): RosterSavedWindowFacts = when (this) {
    is OwnerSavedWindowOutcome.Refused -> RosterSavedWindowFacts.Refused(reason)
    OwnerSavedWindowOutcome.Unavailable -> RosterSavedWindowFacts.Unavailable
    OwnerSavedWindowOutcome.Unknown -> RosterSavedWindowFacts.Unknown
}
