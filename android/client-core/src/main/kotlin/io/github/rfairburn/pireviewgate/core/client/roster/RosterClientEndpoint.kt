package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.MAX_SAFE_INTEGER
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCloseFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCreateFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedDeleteFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedResumeFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterAckVerdict
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterBounds
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterMetadataRow
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterProtocol
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWireErrorCode
import io.github.rfairburn.pireviewgate.core.protocol.roster.internal.RosterText
import java.util.Collections
import java.util.IdentityHashMap

/**
 * The one roster client endpoint for one configured host on one channel attempt.
 *
 * It is the portable, transport-independent heart of the phone client's remote
 * sidebar: it turns decoded owner frames into an immutable [RosterClientState]
 * plus typed [RosterClientEffect]s, and it turns caller commands into guarded
 * effects with honest [RosterClientEvent]s. It performs no I/O, starts no timer,
 * reads no wall clock on its own, and touches no Android, storage, or UI type — a
 * future coordinator pumps its effects to one transport and one scheduler and
 * reports each write's honest disposition back.
 *
 * What it owns, and nothing else:
 *
 *  - The channel generation and host handle, so a stale effect from a retired
 *    attempt is recognizable and is never re-armed by a later one.
 *  - The handshake: the viewer's hello offering the required baseline plus every
 *    optional capability this implementation knows (Close by default; Create,
 *    Saved, and Rename only when the caller asked), and the owner's narrowed
 *    acknowledgement, which is the only thing this side may ever assume.
 *  - One subscription at a time, pinned to one owner run, plus its retirement:
 *    frames for a retiring subscription are noise, an unconfirmed retirement ends
 *    the channel instead of being reused, and no subscription is ever started
 *    automatically after a retirement — the coordinator owns the next attempt.
 *  - Atomic authoritative snapshots. Identifiers, page order, row counts,
 *    duplicate row ids, and the UTF-8 byte account are all proved, and a partial
 *    or inconsistent transfer never becomes current.
 *  - Truthful freshness: `empty` (nothing ever completed), `current` (this
 *    subscription's last complete snapshot is authoritative now), and `stale`
 *    (last-observed rows only). A lost channel, a refused request, a run change,
 *    or a stop keeps the rows and marks them not current; it never manufactures an
 *    empty, idle, or zero-count roster.
 *  - Every remote operation the lane carries — Close, Create, Rename, and the full
 *    Saved list/search/window/resume/delete exchange — with one pending slot per
 *    kind, per-channel monotonic attempt numbers that are never rewound or reused,
 *    and results that are only ever the owner's own facts, a positively not-sent
 *    refusal, or `unknown`.
 *
 * What it deliberately never does: reconnect, retry, replay, back off, heartbeat,
 * queue a mutation, optimistically rename or remove a row, create a local row,
 * steal focus, cancel accepted owner work, or claim a device-level proof it was
 * never given. An owner outcome changes nothing here on its own: only a later
 * complete authoritative snapshot changes the rows.
 *
 * Every public entry point is serialized: it takes one lock, returns one
 * [RosterClientStep], and never calls back into the caller.
 */
public class RosterClientEndpoint(
    /** This side's local presentation and action handle. Never sent on the wire. */
    public val hostId: String,
    /** Identifies this channel attempt. A fresh attempt is a fresh endpoint. */
    public val generation: Long,
    private val bounds: RosterBounds = RosterBounds.DEFAULT,
    /**
     * Optional capabilities to offer beyond Close. Offering one grants nothing: it
     * only makes an acknowledgement possible, and the owner narrows it further.
     */
    offeredCapabilities: List<String> = emptyList(),
    /** Deterministic local time source supplied by the coordinator. */
    private val clock: () -> Long,
    /** Correlation id source. Request ids are this side's own and are never reused. */
    private val idFactory: () -> String,
) {

    init {
        require(generation >= 0L) { "roster client generation must not be negative" }
    }

    // ------------------------------------------------------------------ setup

    private val offered: List<String> = buildList {
        add(RosterWire.REQUIRED_CAPABILITY)
        add(RosterWire.CLOSE_CAPABILITY)
        for (capability in offeredCapabilities) if (!contains(capability)) add(capability)
    }

    private var phase: RosterClientPhase = RosterClientPhase.AWAITING_ACK
    private var projection: RosterProjection = RosterProjection.EMPTY
    private var subscriptionId: String? = null
    private var subscriptionRun: String? = null
    private var capabilities: List<String> = emptyList()
    private var transfer: PartialTransfer? = null
    private var lastComplete: LastComplete? = null

    private var retiringId: String? = null
    private var retirementOutstanding = false
    private var retirementFailClosed = false
    private var stopRequested = false
    private var detachAfterRetirement = false
    private var helloSettled = false

    private val pendingCloses = LinkedHashMap<String, PendingClose>()
    private val pendingCloseRows = LinkedHashMap<String, String>()
    private var pendingCreate: PendingCreate? = null
    private var createSequence = 0L
    private var pendingRename: PendingRename? = null
    private var renameSequence = 0L
    private var pendingSaved: PendingSaved? = null
    private var savedSequence = 0L
    private var savedPolicy: RosterSavedPolicy? = null
    private var savedOwnership: RosterSavedOwnership? = null
    private var savedOwnershipLifetime: RosterUiProof? = null

    private fun currentSavedOwnership(): RosterSavedOwnership? {
        if (savedOwnership == null || savedOwnershipLifetime?.let { !proofHolds(it) } == true) {
            savedOwnership = null
            savedOwnershipLifetime = null
        }
        return savedOwnership
    }
    private val armedRows = LinkedHashSet<String>()

    /** A written delete confirmation is spendable once, by identity, and never again. */
    private val consumedConfirmations: MutableSet<RosterUiProof> =
        Collections.newSetFromMap(IdentityHashMap())

    /** Live deadline registrations, keyed by their full token including the arm generation. */
    private val deadlines = LinkedHashMap<RosterDeadlineToken, Long>()
    /** Never reset when a registration is cancelled, completes, or is superseded. */
    private var nextDeadlineArm = 0L
    private val outstandingSends = LinkedHashMap<Long, OutstandingSend>()
    private var nextMessageId = 1L

    private val effects = mutableListOf<RosterClientEffect>()
    private val events = mutableListOf<RosterClientEvent>()

    // ------------------------------------------------------------ public API

    /** The current immutable state. Never a live view of owner state. */
    @Synchronized
    public fun state(): RosterClientState = snapshot()

    /**
     * Send the hello and arm the handshake deadline. Ordering is fixed: the
     * coordinator installs its message handler before calling this, so a prompt
     * acknowledgement cannot be missed. Nothing else is sent until the owner
     * acknowledges.
     */
    @Synchronized
    public fun start(): RosterClientStep {
        if (phase != RosterClientPhase.AWAITING_ACK) return RosterClientStep.unchanged(snapshot())
        armDeadline(RosterDeadlineKind.HANDSHAKE, generation.toString(), bounds.handshakeTimeoutMs)
        send(
            RosterFrame.Hello(RosterWire.SERVICE, RosterWire.MAJOR, RosterWire.MINOR, offered),
            SendPurpose.HELLO,
            null,
            RosterSendProof.Control(generation),
        )
        return step()
    }

    /**
     * Deliver one complete binary channel message. A message that cannot be decoded
     * is a protocol failure, never a partially applied frame.
     */
    @Synchronized
    public fun onFrame(bytes: ByteArray): RosterClientStep {
        if (phase == RosterClientPhase.DETACHED) return RosterClientStep.unchanged(snapshot())
        val frame = try {
            RosterProtocol.decode(bytes, bounds)
        } catch (ignored: Exception) {
            protocolFailure()
            return step()
        }
        return handleFrame(frame)
    }

    /**
     * The transport is gone. Rows are retained as explicitly not current; every
     * outstanding operation settles `unknown`, because a lost channel never answers
     * a request, and nothing is replayed.
     */
    @Synchronized
    public fun onChannelClosed(): RosterClientStep {
        if (phase == RosterClientPhase.DETACHED) return RosterClientStep.unchanged(snapshot())
        diagnostic(RosterClientDiagnosticCode.CHANNEL_CLOSED)
        clearTransferDeadlines()
        clearDeadline(RosterDeadlineKind.HANDSHAKE, generation.toString())
        // Transport loss is the owner's answer for any retirement still outstanding:
        // the barrier settles so every waiting subscribe, resync, or stop settles too.
        settleRetirement()
        settleAllCloses()
        settleAllCreates()
        settleAllRenames()
        settleAllSaved()
        setSavedPolicy(null)
        savedOwnership = null
        transfer = null
        subscriptionId = null
        subscriptionRun = null
        armedRows.clear()
        markNotCurrent(RosterStalenessReason.CHANNEL_CLOSED)
        phase = RosterClientPhase.DETACHED
        detachAfterRetirement = false
        events += RosterClientEvent.ChannelClosed(RosterStalenessReason.CHANNEL_CLOSED)
        rejectHello(RosterStalenessReason.CHANNEL_CLOSED)
        return step()
    }

    /**
     * One armed deadline elapsed. A token this endpoint no longer holds settles
     * nothing: because re-arming mints a higher arm and cancels the previous
     * registration, a callback the coordinator had already queued for an earlier arm
     * arrives with an arm that is no longer registered and is ignored, so it can
     * never expire a healthy replacement deadline.
     */
    @Synchronized
    public fun onDeadline(token: RosterDeadlineToken): RosterClientStep {
        if (deadlines.remove(token) == null) return RosterClientStep.unchanged(snapshot())
        when (token.kind) {
            RosterDeadlineKind.HANDSHAKE -> if (phase == RosterClientPhase.AWAITING_ACK) {
                phase = RosterClientPhase.FAILED
                setProjection(RosterProjectionState.STALE, RosterStalenessReason.HANDSHAKE_TIMEOUT)
                events += RosterClientEvent.HandshakeRefused(RosterStalenessReason.HANDSHAKE_TIMEOUT)
                helloSettled = true
            }

            RosterDeadlineKind.SNAPSHOT_START ->
                if (phase == RosterClientPhase.SUBSCRIBED && transfer == null) {
                    diagnostic(RosterClientDiagnosticCode.SNAPSHOT_REJECTED)
                    abandonSubscription(RosterStalenessReason.TRANSFER_FAILED)
                }

            RosterDeadlineKind.TRANSFER_IDLE ->
                if (phase == RosterClientPhase.SUBSCRIBED && transfer != null) {
                    diagnostic(RosterClientDiagnosticCode.SNAPSHOT_REJECTED)
                    // A stalled partial transfer is discarded whole; staged rows never publish.
                    abandonSubscription(RosterStalenessReason.TRANSFER_FAILED)
                }

            RosterDeadlineKind.RETIREMENT_ACK -> completeRetirement(acknowledged = false)

            // A silent owner is unobservable, not "never happened": the row may
            // already be stopping, the child may already exist, and nothing is
            // re-sent, cancelled, or replayed on the owner's behalf.
            RosterDeadlineKind.CLOSE_RESULT -> settleClose(token.id, RosterRequestResult.Unknown)

            RosterDeadlineKind.CREATE_RESULT -> {
                val pending = pendingCreate
                if (pending != null && pending.requestId == token.id) {
                    settleCreate(pending, RosterRequestResult.Unknown)
                }
            }

            RosterDeadlineKind.RENAME_RESULT -> {
                val pending = pendingRename
                if (pending != null && pending.requestId == token.id) {
                    settleRename(pending, RosterRequestResult.Unknown)
                }
            }

            RosterDeadlineKind.SAVED_RESULT -> {
                val pending = pendingSaved
                if (pending != null && pending.requestId == token.id) {
                    settleSaved(pending, RosterRequestResult.Unknown)
                }
            }
        }
        return step()
    }

    /** Deadlines this endpoint still expects, for a coordinator that lost its timers. */
    @Synchronized
    public fun pendingDeadlines(): List<RosterDeadlineToken> = deadlines.keys.toList()

    /**
     * Report what happened to one emitted write. This is the only honest source of
     * a send outcome: only a write the adapter provably never invoked can settle as
     * not-submitted; a write that was invoked and then failed settles `unknown`; and
     * a write the transport accepted settles nothing at all, because resolution is
     * not receipt and only the owner's answer settles an operation.
     */
    @Synchronized
    public fun onSendDisposition(messageId: Long, disposition: RosterSendDisposition): RosterClientStep {
        val sent = outstandingSends.remove(messageId) ?: return RosterClientStep.unchanged(snapshot())
        if (disposition is RosterSendDisposition.Completed) return RosterClientStep.unchanged(snapshot())
        diagnostic(RosterClientDiagnosticCode.SEND_FAILED)
        val result = when (disposition) {
            // Positive proof this request never reached the transport.
            is RosterSendDisposition.NotDispatched -> RosterRequestResult.NotSent(
                when (disposition.reason) {
                    RosterSendRefusal.PROOF_UNAVAILABLE -> RosterNotSentReason.TARGET_UNAVAILABLE
                    RosterSendRefusal.ENCODE_FAILED -> RosterNotSentReason.INVALID_REQUEST
                    RosterSendRefusal.POLICY_UNAVAILABLE -> RosterNotSentReason.POLICY_UNAVAILABLE
                    RosterSendRefusal.NOT_READY -> RosterNotSentReason.NOT_READY
                },
            )
            // The write was invoked and then rejected: the owner may still have
            // accepted it, so no outcome is established either way.
            RosterSendDisposition.FailedAfterInvoke -> RosterRequestResult.Unknown
            RosterSendDisposition.Completed -> return RosterClientStep.unchanged(snapshot())
        }
        when (sent.purpose) {
            SendPurpose.HELLO -> if (phase == RosterClientPhase.AWAITING_ACK) {
                clearDeadline(RosterDeadlineKind.HANDSHAKE, generation.toString())
                phase = RosterClientPhase.FAILED
                setProjection(RosterProjectionState.STALE, RosterStalenessReason.HANDSHAKE_REFUSED)
                rejectHello(RosterStalenessReason.HANDSHAKE_REFUSED)
            }

            SendPurpose.SUBSCRIBE -> if (subscriptionId == sent.correlationId) {
                abandonSubscription(RosterStalenessReason.TRANSFER_FAILED)
            }

            SendPurpose.UNSUBSCRIBE -> completeRetirement(acknowledged = false)

            // The error notice that already reported an unfixable failure: nothing follows.
            SendPurpose.ERROR_NOTICE -> Unit

            SendPurpose.CLOSE -> settleClose(sent.correlationId ?: return step(), result)

            SendPurpose.CREATE -> {
                val pending = pendingCreate
                if (pending != null && pending.requestId == sent.correlationId) settleCreate(pending, result)
            }

            SendPurpose.RENAME -> {
                val pending = pendingRename
                if (pending != null && pending.requestId == sent.correlationId) settleRename(pending, result)
            }

            SendPurpose.SAVED -> {
                val pending = pendingSaved
                if (pending != null && pending.requestId == sent.correlationId) settleSaved(pending, result)
            }
        }
        return step()
    }

    /**
     * The endpoint's own last-instant decision on one emitted message.
     *
     * The adapter must call this immediately before it invokes the transport, and
     * report [RosterSendDisposition.NotDispatched] with the returned reason when it
     * says [RosterDispatchDecision.Refuse]. This is the only place where all the
     * facts that can invalidate a queued write are visible together: this endpoint's
     * lifetime, whether the request this message belongs to is still the outstanding
     * one, whether its own deadline has passed, whether the run and native tuple the
     * request was built for are still the observed ones, whether the owner still
     * exposes remote delete, and the caller's own UI proof.
     *
     * Refusing here never retracts bytes already handed over, and it never cancels
     * owner work the owner already accepted: it only proves that a write that has
     * not started must not start.
     */
    @Synchronized
    public fun decideDispatch(messageId: Long): RosterDispatchDecision {
        val sent = outstandingSends[messageId]
            ?: return RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY)
        if (stopRequested && !isRetirementControl(sent.purpose) || phase == RosterClientPhase.DETACHED) {
            return RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY)
        }
        if (sent.proof.channelGeneration != generation) {
            return RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY)
        }
        dispatchLifetimeReason(sent)?.let { return RosterDispatchDecision.Refuse(it) }
        val uiProofs = when (val proof = sent.proof) {
            // Control traffic carries no row, form, or picker epoch to re-prove.
            is RosterSendProof.Control -> emptyList()
            is RosterSendProof.RowAction -> listOfNotNull(proof.ui, proof.confirmation)
            is RosterSendProof.Form -> listOf(proof.ui)
            is RosterSendProof.PickerRead -> listOf(proof.ui)
            is RosterSendProof.PickerEntry -> listOfNotNull(proof.ui, proof.confirmation)
        }
        if (uiProofs.any { !proofHolds(it) }) {
            return RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE)
        }
        // A caller proof runs arbitrary code on this thread inside this monitor, and
        // synchronized entry is reentrant: it can stop this endpoint, lose the channel,
        // supersede this request, or revoke a policy before returning true. Nothing a
        // proof just invalidated may be allowed through, so the endpoint's own facts
        // are re-proved after the callbacks, exactly as the source re-checks them.
        if (outstandingSends[messageId] !== sent ||
            stopRequested && !isRetirementControl(sent.purpose) ||
            phase == RosterClientPhase.DETACHED
        ) {
            return RosterDispatchDecision.Refuse(RosterSendRefusal.NOT_READY)
        }
        dispatchLifetimeReason(sent)?.let { return RosterDispatchDecision.Refuse(it) }
        return RosterDispatchDecision.Allow
    }

    /**
     * Retirement and failure notice are the only writes still permitted once stop is
     * requested: `stop()` itself asks for the retirement, and refusing it would make
     * graceful retirement impossible for an adapter that dispatches through this gate.
     * Application operations never are.
     */
    private fun isRetirementControl(purpose: SendPurpose): Boolean =
        purpose == SendPurpose.UNSUBSCRIBE || purpose == SendPurpose.ERROR_NOTICE

    /**
     * Whether this endpoint still wants this message's request to exist at all, and
     * whether its own facts still support sending it. [RosterSendRefusal]
     * PROOF_UNAVAILABLE here covers this side's own row, run, tuple, or policy
     * re-proof having moved; NOT_READY covers a request that already settled or was
     * superseded.
     */
    private fun dispatchLifetimeReason(sent: OutstandingSend): RosterSendRefusal? {
        val id = sent.correlationId
        return when (sent.purpose) {
            // A hello whose acknowledgement already arrived, or whose channel is gone,
            // is never re-offered.
            SendPurpose.HELLO ->
                if (phase == RosterClientPhase.AWAITING_ACK) null else RosterSendRefusal.NOT_READY

            SendPurpose.SUBSCRIBE ->
                if (id != null && subscriptionId == id) null else RosterSendRefusal.NOT_READY

            SendPurpose.UNSUBSCRIBE ->
                if (id != null && retiringId == id) null else RosterSendRefusal.NOT_READY

            // A protocol-failure notice is worth attempting while the channel is up.
            SendPurpose.ERROR_NOTICE -> null

            SendPurpose.CLOSE -> {
                val pending = pendingCloses[id ?: return RosterSendRefusal.NOT_READY]
                    ?: return RosterSendRefusal.NOT_READY
                if (clock() > pending.deadlineAt) return RosterSendRefusal.NOT_READY
                null
            }

            SendPurpose.CREATE -> {
                val pending = pendingCreate ?: return RosterSendRefusal.NOT_READY
                if (pending.requestId != id) return RosterSendRefusal.NOT_READY
                if (clock() > pending.deadlineAt) return RosterSendRefusal.NOT_READY
                null
            }

            SendPurpose.RENAME -> {
                val pending = pendingRename ?: return RosterSendRefusal.NOT_READY
                if (pending.requestId != id) return RosterSendRefusal.NOT_READY
                if (clock() >= pending.deadlineAt) return RosterSendRefusal.NOT_READY
                if (!renameTargetCurrent(
                        pending.hostRunId,
                        pending.rowId,
                        pending.expectedSessionId,
                        pending.expectedSessionEpoch,
                    )
                ) {
                    return RosterSendRefusal.PROOF_UNAVAILABLE
                }
                null
            }

            SendPurpose.SAVED -> savedDispatchReason(id)
        }
    }

    private fun savedDispatchReason(requestId: String?): RosterSendRefusal? {
        val pending = pendingSaved ?: return RosterSendRefusal.NOT_READY
        if (pending.requestId != requestId) return RosterSendRefusal.NOT_READY
        // A dismissed picker invalidates this request's handles even if its effect is
        // still queued: a write the transport never started must not start.
        if (!pending.pickerCurrent) return RosterSendRefusal.PROOF_UNAVAILABLE
        // Checked directly, not only through the timer: a delayed dispatch can never
        // let an expired request reach the transport.
        if (clock() > pending.deadlineAt) return RosterSendRefusal.NOT_READY
        if (!savedRunCurrent(pending.hostRunId)) return RosterSendRefusal.PROOF_UNAVAILABLE
        if (pending.kind.isSavedRead &&
            !ownsReadTarget(
                pending.kind,
                pending.hostRunId,
                pending.catalogId,
                pending.resultId,
                pending.queryRevision,
            )
        ) {
            return RosterSendRefusal.PROOF_UNAVAILABLE
        }
        if (pending.kind == RosterOperationKind.SAVED_DELETE && !deleteExposedFor(pending.hostRunId)) {
            return RosterSendRefusal.POLICY_UNAVAILABLE
        }
        return null
    }

    // --------------------------------------------------------- subscription

    /**
     * Start the one subscription this channel allows.
     *
     * While a retirement is outstanding this refuses rather than queueing: the
     * coordinator owns the next attempt and issues it once
     * [RosterClientEvent.SubscriptionRetired] arrives. This endpoint never starts a
     * subscription on its own.
     */
    @Synchronized
    public fun subscribe(): RosterClientStep {
        refusalReason()?.let {
            events += RosterClientEvent.SubscriptionRefused(it)
            return step()
        }
        if (retirementOutstanding) {
            events += RosterClientEvent.SubscriptionRefused(RosterSubscriptionRefusal.RETIRING)
            return step()
        }
        if (phase == RosterClientPhase.SUBSCRIBED) {
            events += RosterClientEvent.SubscriptionRefused(RosterSubscriptionRefusal.ALREADY_SUBSCRIBED)
            return step()
        }
        if (phase != RosterClientPhase.READY) {
            events += RosterClientEvent.SubscriptionRefused(RosterSubscriptionRefusal.NOT_READY)
            return step()
        }
        startSubscription()
        return step()
    }

    /**
     * Retire the live subscription so a fresh one can be started.
     *
     * Overlapping calls join the one outstanding retirement instead of replacing its
     * acknowledgement or timer. Freshness is recovered by re-subscribing, never by
     * requiring an owner mutation, and the replacement subscription is the
     * coordinator's call, not this endpoint's.
     */
    @Synchronized
    public fun resync(): RosterClientStep {
        refusalReason()?.let {
            events += RosterClientEvent.SubscriptionRefused(it)
            return step()
        }
        if (retirementOutstanding) {
            events += RosterClientEvent.RetirementJoined(retiringId ?: "")
            return step()
        }
        beginRetirement(RetirementKind.GRACEFUL, RosterStalenessReason.STOPPED, announceEmpty = true)
        return step()
    }

    /**
     * Stop this endpoint: retire the subscription, settle every outstanding
     * operation honestly, and detach.
     *
     * Idempotent. Last-observed rows stay visible as explicitly not current —
     * stopping ends metadata delivery and never clears the roster to empty or idle.
     */
    @Synchronized
    public fun stop(): RosterClientStep {
        if (phase == RosterClientPhase.DETACHED && !retirementOutstanding) {
            return RosterClientStep.unchanged(snapshot())
        }
        // Recorded synchronously: nothing can start another subscription after this.
        stopRequested = true
        settleAllCloses()
        settleAllCreates()
        settleAllRenames()
        settleAllSaved()
        setSavedPolicy(null)
        beginRetirement(RetirementKind.GRACEFUL, RosterStalenessReason.STOPPED, announceEmpty = true)
        if (retirementOutstanding) detachAfterRetirement = true else finishStop()
        return step()
    }

    // -------------------------------------------------------------- close

    /**
     * Ask this owner to close exactly one of its rows.
     *
     * Every refusal before the write is emitted is positively not-submitted. A
     * confirmed close — the deliberate second attempt on a busy or unknown row —
     * additionally requires a fresh, specific user receipt naming this exact run and
     * row; without one the request is never submitted. This endpoint never shows a
     * dialog, never sends automatically, and never retries on its own.
     */
    @Synchronized
    public fun closeSession(command: RosterCloseCommand): RosterClientStep {
        controlRefusal()?.let { return refuse(RosterOperationKind.CLOSE, it) }
        if (!snapshot().supportsClose) {
            return refuse(RosterOperationKind.CLOSE, RosterNotSentReason.CAPABILITY_UNSUPPORTED)
        }
        if (!isIdentifier(command.hostRunId) || !isIdentifier(command.rowId)) {
            return refuse(RosterOperationKind.CLOSE, RosterNotSentReason.INVALID_REQUEST)
        }
        val proof = command.proof
        if (proof == null ||
            proof.channelGeneration != generation ||
            proof.hostRunId != command.hostRunId ||
            proof.rowId != command.rowId
        ) {
            return refuse(RosterOperationKind.CLOSE, RosterNotSentReason.INVALID_REQUEST)
        }
        if (!proofHolds(proof.ui)) {
            return refuse(RosterOperationKind.CLOSE, RosterNotSentReason.TARGET_UNAVAILABLE)
        }
        if (command.confirmed) {
            val confirmation = command.confirmation
                ?: return refuse(RosterOperationKind.CLOSE, RosterNotSentReason.INVALID_REQUEST)
            if (!proofHolds(confirmation)) {
                return refuse(RosterOperationKind.CLOSE, RosterNotSentReason.TARGET_UNAVAILABLE)
            }
        }
        // One in-flight close per row, and a bounded table: a duplicate or an
        // overflow is refused here rather than queued behind live work.
        if (pendingCloseRows.containsKey(command.rowId)) {
            return refuse(RosterOperationKind.CLOSE, RosterNotSentReason.BUSY)
        }
        if (pendingCloses.size.toLong() >= bounds.maxSnapshotRows) {
            return refuse(RosterOperationKind.CLOSE, RosterNotSentReason.ROW_LIMIT)
        }
        val requestId = idFactory()
        pendingCloses[requestId] = PendingClose(
            requestId = requestId,
            hostRunId = command.hostRunId,
            rowId = command.rowId,
            deadlineAt = clock() + bounds.closeResultTimeoutMs,
        )
        pendingCloseRows[command.rowId] = requestId
        armDeadline(RosterDeadlineKind.CLOSE_RESULT, requestId, bounds.closeResultTimeoutMs)
        events += RosterClientEvent.OperationAccepted(RosterOperationKind.CLOSE, requestId, command.hostRunId)
        val sent = send(
            RosterFrame.CloseRequest(requestId, command.hostRunId, command.rowId, command.confirmed),
            SendPurpose.CLOSE,
            requestId,
            proof.copy(confirmation = if (command.confirmed) command.confirmation else null),
        )
        if (!sent) settleClose(requestId, RosterRequestResult.NotSent(RosterNotSentReason.NOT_READY))
        return step()
    }

    // ------------------------------------------------------------- create

    /**
     * Ask this owner to create one blank child in one of its runs.
     *
     * Rowless: no row, selection, viewer, or native tuple is needed to ask, and an
     * owner whose roster is empty is a valid target. One create is in flight per
     * channel; a second is refused rather than queued, evicted, or retargeted. The
     * attempt number comes from a monotonic high-water that is advanced before the
     * write and never rewound, so no number is ever sent twice on one channel.
     */
    @Synchronized
    public fun createSession(command: RosterCreateCommand): RosterClientStep {
        controlRefusal()?.let { return refuse(RosterOperationKind.CREATE, it) }
        if (!snapshot().supportsCreate) {
            return refuse(RosterOperationKind.CREATE, RosterNotSentReason.CAPABILITY_UNSUPPORTED)
        }
        if (!isIdentifier(command.hostRunId) || !RosterText.isCreateWorkspace(command.workspace)) {
            return refuse(RosterOperationKind.CREATE, RosterNotSentReason.INVALID_REQUEST)
        }
        val proof = command.proof
        if (proof == null ||
            proof.channelGeneration != generation ||
            proof.hostRunId != command.hostRunId ||
            proof.workspace != command.workspace
        ) {
            return refuse(RosterOperationKind.CREATE, RosterNotSentReason.INVALID_REQUEST)
        }
        if (!proofHolds(proof.ui)) {
            return refuse(RosterOperationKind.CREATE, RosterNotSentReason.TARGET_UNAVAILABLE)
        }
        if (pendingCreate != null) return refuse(RosterOperationKind.CREATE, RosterNotSentReason.BUSY)
        if (createSequence >= MAX_SAFE_INTEGER) return refuse(RosterOperationKind.CREATE, RosterNotSentReason.LIMIT)
        val sequence = createSequence + 1L
        // Advanced now and never rewound: this attempt owns its number even if the
        // write is refused or the request later times out.
        createSequence = sequence
        val requestId = idFactory()
        pendingCreate = PendingCreate(
            requestId = requestId,
            hostRunId = command.hostRunId,
            sequence = sequence,
            deadlineAt = clock() + bounds.createResultTimeoutMs,
        )
        armDeadline(RosterDeadlineKind.CREATE_RESULT, requestId, bounds.createResultTimeoutMs)
        events += RosterClientEvent.OperationAccepted(RosterOperationKind.CREATE, requestId, command.hostRunId)
        val sent = send(
            RosterFrame.CreateRequest(requestId, command.hostRunId, command.workspace, sequence),
            SendPurpose.CREATE,
            requestId,
            proof,
        )
        if (!sent) {
            settleCreate(requireNotNull(pendingCreate), RosterRequestResult.NotSent(RosterNotSentReason.NOT_READY))
        }
        return step()
    }

    // ------------------------------------------------------------- rename

    /**
     * Ask this owner to rename exactly one row, fenced to that row's native
     * conversation tuple.
     *
     * The fence is the point: the request must be built from the tuple this side
     * actually observed for that row, and a result that arrives after the tuple moved
     * — or after the deadline — is `unknown`, never quietly retargeted onto a newer
     * form of the same row. A rename never carries or mirrors a previous name, and
     * the new name becomes visible only through the owner's next complete
     * authoritative snapshot.
     */
    @Synchronized
    public fun renameSession(command: RosterRenameCommand): RosterClientStep {
        controlRefusal()?.let { return refuse(RosterOperationKind.RENAME, it) }
        if (!snapshot().supportsRename) {
            return refuse(RosterOperationKind.RENAME, RosterNotSentReason.CAPABILITY_UNSUPPORTED)
        }
        if (pendingRename != null) return refuse(RosterOperationKind.RENAME, RosterNotSentReason.BUSY)
        if (renameSequence >= MAX_SAFE_INTEGER) return refuse(RosterOperationKind.RENAME, RosterNotSentReason.LIMIT)
        val proof = command.proof
        if (proof == null ||
            proof.channelGeneration != generation ||
            proof.hostRunId != command.hostRunId ||
            proof.rowId != command.rowId ||
            proof.expectedSessionId != command.expectedSessionId ||
            proof.expectedSessionEpoch != command.expectedSessionEpoch
        ) {
            return refuse(RosterOperationKind.RENAME, RosterNotSentReason.INVALID_REQUEST)
        }
        val sequence = renameSequence + 1L
        val requestId = idFactory()
        val frame = RosterFrame.RenameRequest(
            requestId = requestId,
            hostRunId = command.hostRunId,
            rowId = command.rowId,
            expectedSessionId = command.expectedSessionId,
            expectedSessionEpoch = command.expectedSessionEpoch,
            name = command.name,
            sequence = sequence,
        )
        // The wire owns identifier, native-tuple, and name validation; no parallel rules.
        try {
            RosterProtocol.encode(frame, bounds)
        } catch (ignored: Exception) {
            return refuse(RosterOperationKind.RENAME, RosterNotSentReason.INVALID_REQUEST)
        }
        if (!renameTargetCurrent(command.hostRunId, command.rowId, command.expectedSessionId, command.expectedSessionEpoch)) {
            return refuse(RosterOperationKind.RENAME, RosterNotSentReason.TARGET_UNAVAILABLE)
        }
        if (!proofHolds(proof.ui)) {
            return refuse(RosterOperationKind.RENAME, RosterNotSentReason.TARGET_UNAVAILABLE)
        }
        renameSequence = sequence
        pendingRename = PendingRename(
            requestId = requestId,
            hostRunId = command.hostRunId,
            rowId = command.rowId,
            expectedSessionId = command.expectedSessionId,
            expectedSessionEpoch = command.expectedSessionEpoch,
            deadlineAt = clock() + bounds.renameResultTimeoutMs,
        )
        armDeadline(RosterDeadlineKind.RENAME_RESULT, requestId, bounds.renameResultTimeoutMs)
        events += RosterClientEvent.OperationAccepted(RosterOperationKind.RENAME, requestId, command.hostRunId)
        val sent = send(frame, SendPurpose.RENAME, requestId, proof)
        if (!sent) {
            settleRename(requireNotNull(pendingRename), RosterRequestResult.NotSent(RosterNotSentReason.NOT_READY))
        }
        return step()
    }

    // -------------------------------------------------------------- saved

    /** Fresh Saved catalog listing. A newer read supersedes an older read; nothing is queued. */
    @Synchronized
    public fun savedList(command: RosterSavedListCommand): RosterClientStep = submitSaved(
        kind = RosterOperationKind.SAVED_LIST,
        hostRunId = command.hostRunId,
        catalogId = null,
        resultId = null,
        entryId = null,
        query = command.query,
        offset = command.offset,
        count = command.count,
        confirmed = null,
        proof = command.proof,
        confirmation = null,
        resultLifetime = command.resultLifetime,
    )

    /** Search within one exact owner catalog; replaces the owner's result only. */
    @Synchronized
    public fun savedSearch(command: RosterSavedSearchCommand): RosterClientStep = submitSaved(
        kind = RosterOperationKind.SAVED_SEARCH,
        hostRunId = command.hostRunId,
        catalogId = command.catalogId,
        resultId = null,
        entryId = null,
        query = command.query,
        offset = command.offset,
        count = command.count,
        confirmed = null,
        proof = command.proof,
        confirmation = null,
    )

    /** Another bounded window of one exact owner result. Never relists and never remints ids. */
    @Synchronized
    public fun savedWindow(command: RosterSavedWindowCommand): RosterClientStep = submitSaved(
        kind = RosterOperationKind.SAVED_WINDOW,
        hostRunId = command.hostRunId,
        catalogId = command.catalogId,
        resultId = command.resultId,
        entryId = null,
        query = null,
        offset = command.offset,
        count = command.count,
        confirmed = null,
        proof = command.proof,
        confirmation = null,
    )

    /** Resume one entry of one exact owner result. Never superseded by a newer read. */
    @Synchronized
    public fun savedResume(command: RosterSavedResumeCommand): RosterClientStep = submitSaved(
        kind = RosterOperationKind.SAVED_RESUME,
        hostRunId = command.hostRunId,
        catalogId = command.catalogId,
        resultId = command.resultId,
        entryId = command.entryId,
        query = null,
        offset = null,
        count = null,
        confirmed = null,
        proof = command.proof,
        confirmation = null,
    )

    /**
     * Ask the owner to prepare a delete. Removes nothing and answers
     * `confirmation-required`; it is a separate call from the confirmed delete so a
     * removal is never implied by a browse action.
     */
    @Synchronized
    public fun savedDeletePrepare(command: RosterSavedDeleteCommand): RosterClientStep = submitSaved(
        kind = RosterOperationKind.SAVED_DELETE,
        hostRunId = command.hostRunId,
        catalogId = command.catalogId,
        resultId = command.resultId,
        entryId = command.entryId,
        query = null,
        offset = null,
        count = null,
        confirmed = false,
        proof = command.proof,
        confirmation = null,
    )

    /**
     * Confirm and submit one delete of exactly one entry of one frozen picker
     * result.
     *
     * [confirmation] is the user's written confirmation for this exact entry. It is
     * spent once: presenting it again is refused rather than re-armed, and a
     * confirmation that no longer holds is refused as never submitted. The policy
     * description this endpoint holds is presentation only and grants nothing — the
     * owner re-checks its own live policy at admission — so an unknown or Off
     * description keeps delete hidden in the UI while this call, if it is made at
     * all, can only ever be refused or answered by the owner.
     */
    @Synchronized
    public fun savedDeleteConfirmed(command: RosterSavedDeleteCommand, confirmation: RosterUiProof): RosterClientStep {
        if (consumedConfirmations.contains(confirmation)) {
            return refuse(RosterOperationKind.SAVED_DELETE, RosterNotSentReason.INVALID_REQUEST)
        }
        if (!proofHolds(confirmation)) {
            return refuse(RosterOperationKind.SAVED_DELETE, RosterNotSentReason.TARGET_UNAVAILABLE)
        }
        val entryProof = command.proof
        val step = submitSaved(
            kind = RosterOperationKind.SAVED_DELETE,
            hostRunId = command.hostRunId,
            catalogId = command.catalogId,
            resultId = command.resultId,
            entryId = command.entryId,
            query = null,
            offset = null,
            count = null,
            confirmed = true,
            proof = entryProof?.copy(confirmation = confirmation),
            confirmation = confirmation,
        )
        // Spent whether or not it was submitted: a confirmation is one decision, not a token.
        consumedConfirmations.add(confirmation)
        return step
    }

    // -------------------------------------------------------- frame routing

    private fun handleFrame(frame: RosterFrame): RosterClientStep {
        when (frame) {
            is RosterFrame.HelloAck -> onHelloAck(frame)
            is RosterFrame.SnapshotBegin -> onSnapshotBegin(frame)
            is RosterFrame.SnapshotPage -> onSnapshotPage(frame)
            is RosterFrame.SnapshotEnd -> onSnapshotEnd(frame)

            is RosterFrame.Unsubscribed ->
                if (retiringId != null && frame.subscriptionId == retiringId) {
                    completeRetirement(acknowledged = true)
                }

            is RosterFrame.Failure -> onOwnerError(frame.code, frame.subscriptionId)
            is RosterFrame.CloseResult -> onCloseResult(frame)
            is RosterFrame.CreateResult -> onCreateResult(frame)
            is RosterFrame.RenameResult ->
                if (!snapshot().supportsRename) protocolFailure() else onRenameResult(frame)

            is RosterFrame.SavedWindowResult,
            is RosterFrame.SavedWindowBegin,
            is RosterFrame.SavedWindowPage,
            is RosterFrame.SavedWindowFragment,
            is RosterFrame.SavedWindowEnd,
            is RosterFrame.SavedResumeResult,
            is RosterFrame.SavedDeleteResult,
            is RosterFrame.SavedPolicy,
            -> {
                if (!snapshot().supportsSaved) {
                    // Never acknowledged for this channel: outside the negotiated protocol.
                    protocolFailure()
                } else {
                    onSavedFrame(frame)
                }
            }

            // Anything else is a frame this side sends, so the peer is not speaking this protocol.
            else -> protocolFailure()
        }
        return step()
    }

    private fun onHelloAck(frame: RosterFrame.HelloAck) {
        if (phase != RosterClientPhase.AWAITING_ACK) {
            protocolFailure()
            return
        }
        clearDeadline(RosterDeadlineKind.HANDSHAKE, generation.toString())
        when (val verdict = RosterProtocol.reviewHelloAck(frame, offered)) {
            is RosterAckVerdict.Refused -> {
                diagnostic(RosterClientDiagnosticCode.HELLO_REFUSED)
                phase = RosterClientPhase.FAILED
                setProjection(RosterProjectionState.STALE, RosterStalenessReason.HANDSHAKE_REFUSED)
                rejectHello(RosterStalenessReason.HANDSHAKE_REFUSED)
            }

            is RosterAckVerdict.Accepted -> {
                phase = RosterClientPhase.READY
                diagnostic(RosterClientDiagnosticCode.HELLO_ACCEPTED)
                // The acknowledgement's capability set is all this channel may ever
                // assume. Nothing is enabled by it beyond protocol support, and it is
                // never widened here.
                capabilities = verdict.capabilities.toList()
                helloSettled = true
                events += RosterClientEvent.HandshakeAccepted(capabilities)
            }
        }
    }

    // ------------------------------------------------------------- snapshot

    /**
     * Frames for a subscription being retired are retirement noise: the owner may
     * have admitted them before its unsubscribe arrived. They are discarded, never
     * treated as a protocol violation, and never published.
     */
    private fun isRetiringNoise(id: String): Boolean = retiringId != null && id == retiringId

    private fun onSnapshotBegin(frame: RosterFrame.SnapshotBegin) {
        if (isRetiringNoise(frame.subscriptionId)) return
        if (phase != RosterClientPhase.SUBSCRIBED || frame.subscriptionId != subscriptionId) return
        if (transfer != null) {
            protocolFailure()
            return
        }
        val reason = acceptsCandidate(frame.hostRunId, frame.revision)
        if (reason != null) {
            diagnostic(RosterClientDiagnosticCode.SNAPSHOT_REJECTED)
            abandonSubscription(reason)
            return
        }
        subscriptionRun = frame.hostRunId
        transfer = PartialTransfer(
            subscriptionId = frame.subscriptionId,
            transferId = frame.transferId,
            hostRunId = frame.hostRunId,
            revision = frame.revision,
            totalRows = frame.totalRows,
            pageCount = frame.pageCount,
        )
        armDeadline(RosterDeadlineKind.TRANSFER_IDLE, frame.subscriptionId, bounds.transferIdleTimeoutMs)
    }

    private fun onSnapshotPage(frame: RosterFrame.SnapshotPage) {
        if (isRetiringNoise(frame.subscriptionId)) return
        if (phase != RosterClientPhase.SUBSCRIBED || frame.subscriptionId != subscriptionId) return
        val staged = transfer
        if (staged == null ||
            frame.transferId != staged.transferId ||
            frame.pageIndex != staged.pageIndex ||
            frame.pageIndex >= staged.pageCount
        ) {
            // Out-of-order, duplicated, or foreign-transfer pages cannot be applied to
            // an atomic snapshot, so the whole transfer fails instead of landing partially.
            protocolFailure()
            return
        }
        var bytes = staged.bytes
        for (row in frame.rows) {
            if (staged.rows.size.toLong() >= staged.totalRows || !staged.ids.add(row.id)) {
                protocolFailure()
                return
            }
            val rowBytes = rowWireBytes(row)
            if (rowBytes == null || bytes + rowBytes > bounds.maxSnapshotBytes) {
                abandonSubscription(RosterStalenessReason.TRANSFER_FAILED)
                return
            }
            bytes += rowBytes
            staged.rows.add(row)
        }
        // The aggregate byte account carries across pages: each page fitting is not
        // evidence that the whole snapshot fits.
        staged.bytes = bytes
        staged.pageIndex += 1
        armDeadline(RosterDeadlineKind.TRANSFER_IDLE, frame.subscriptionId, bounds.transferIdleTimeoutMs)
    }

    private fun onSnapshotEnd(frame: RosterFrame.SnapshotEnd) {
        if (isRetiringNoise(frame.subscriptionId)) return
        if (phase != RosterClientPhase.SUBSCRIBED || frame.subscriptionId != subscriptionId) return
        val staged = transfer
        if (staged == null || frame.transferId != staged.transferId) {
            protocolFailure()
            return
        }
        if (frame.revision != staged.revision ||
            frame.totalRows != staged.totalRows ||
            staged.pageIndex != staged.pageCount ||
            staged.rows.size.toLong() != staged.totalRows
        ) {
            // An incomplete or inconsistent transfer never becomes current: the staged
            // rows are discarded rather than published as a partial roster.
            diagnostic(RosterClientDiagnosticCode.SNAPSHOT_REJECTED)
            abandonSubscription(RosterStalenessReason.TRANSFER_FAILED)
            return
        }
        val published = staged.subscriptionId
        val rows = staged.rows.toList()
        transfer = null
        clearTransferDeadlines()
        lastComplete = LastComplete(staged.hostRunId, staged.revision, published)
        // A row this owner no longer reports can no longer be armed for a confirmed close.
        val present = rows.mapTo(HashSet()) { it.id }
        armedRows.retainAll(present)
        setProjection(
            state = RosterProjectionState.CURRENT,
            reason = null,
            rows = rows,
            hostRunId = staged.hostRunId,
            revision = staged.revision,
            subscriptionId = published,
        )
        diagnostic(RosterClientDiagnosticCode.SNAPSHOT_PUBLISHED, rows.size.toLong())
    }

    /**
     * Freshness rule for a candidate snapshot, or the reason it is refused.
     *
     * The owner run is pinned for the lifetime of one subscription: another run
     * arriving mid-subscription is refused rather than adopted, because accepting it
     * would let a peer present a stale run as current and step around the regression
     * guard. Only a fresh subscription adopts another run — exactly the boundary an
     * explicit resync creates. Within one run, a later snapshot of the same
     * subscription must be strictly newer, while a snapshot published to a fresh
     * subscription may carry the same revision: freshness is recovered by
     * re-subscribing, never by requiring an owner mutation.
     */
    private fun acceptsCandidate(hostRunId: String, revision: Long): RosterStalenessReason? {
        val pinned = subscriptionRun
        if (pinned != null && hostRunId != pinned) return RosterStalenessReason.RUN_CHANGED
        val last = lastComplete ?: return null
        if (hostRunId != last.hostRunId) return null
        if (subscriptionId != last.subscriptionId) {
            return if (revision >= last.revision) null else RosterStalenessReason.REVISION_REGRESSION
        }
        return if (revision > last.revision) null else RosterStalenessReason.REVISION_REGRESSION
    }

    // ---------------------------------------------------------- owner error

    private fun onOwnerError(code: RosterWireErrorCode, errorSubscriptionId: String?) {
        if (retiringId != null && errorSubscriptionId == retiringId) {
            // The owner answered about the subscription being retired. That is its
            // confirmation, and it must not be dropped for no longer matching a live
            // subscription this side already gave up on.
            diagnostic(RosterClientDiagnosticCode.OWNER_ERROR)
            completeRetirement(acknowledged = true)
            return
        }
        if (errorSubscriptionId != null && errorSubscriptionId != subscriptionId) return
        val reason = wireCodeToReason(code)
        diagnostic(RosterClientDiagnosticCode.OWNER_ERROR)
        if (phase == RosterClientPhase.AWAITING_ACK) {
            clearDeadline(RosterDeadlineKind.HANDSHAKE, generation.toString())
            phase = RosterClientPhase.FAILED
            setProjection(RosterProjectionState.STALE, RosterStalenessReason.HANDSHAKE_REFUSED)
            rejectHello(RosterStalenessReason.HANDSHAKE_REFUSED)
            return
        }
        if (phase == RosterClientPhase.SUBSCRIBED) {
            // The owner ended the subscription on its own side and retired its watch,
            // so no unsubscribe is owed for it and no barrier blocks a later resync.
            abandonSubscription(reason, RetirementKind.OWNER_CONFIRMED)
            return
        }
        if (projection.revision != null) setProjection(RosterProjectionState.STALE, reason)
    }

    // ------------------------------------------------------------ operations

    private fun onCloseResult(frame: RosterFrame.CloseResult) {
        // Matched only by a request id THIS side generated. An unsolicited,
        // duplicated, foreign, or already-timed-out reply resolves nothing, settles
        // nothing else, and never fails the channel.
        val pending = pendingCloses[frame.requestId] ?: return
        settleClose(frame.requestId, RosterRequestResult.OwnerResult(RosterOwnerOutcome.Close(frame.outcome)))
        if (frame.outcome == OwnerCloseFacts.CONFIRMATION_REQUIRED) {
            // Arms the next deliberate confirmed close and does nothing else: no
            // dialog, no send, and no automatic follow-up happens from here.
            armedRows.add(pending.rowId)
            events += RosterClientEvent.OwnerConfirmationRequired(pending.hostRunId, pending.rowId)
        }
    }

    private fun settleClose(requestId: String, result: RosterRequestResult) {
        val pending = pendingCloses.remove(requestId) ?: return
        if (pendingCloseRows[pending.rowId] == requestId) pendingCloseRows.remove(pending.rowId)
        clearDeadline(RosterDeadlineKind.CLOSE_RESULT, requestId)
        events += RosterClientEvent.OperationSettled(
            RosterOperationKind.CLOSE,
            pending.requestId,
            pending.hostRunId,
            result,
        )
    }

    private fun settleAllCloses() {
        for (requestId in pendingCloses.keys.toList()) settleClose(requestId, RosterRequestResult.Unknown)
    }

    private fun onCreateResult(frame: RosterFrame.CreateResult) {
        val pending = pendingCreate ?: return
        if (pending.requestId != frame.requestId) return
        val facts = frame.outcome
        if (facts is OwnerCreateFacts.Started && facts.hostRunId != pending.hostRunId) {
            // The request named one exact run; an answer about another run establishes
            // nothing about this one.
            settleCreate(pending, RosterRequestResult.Unknown)
            return
        }
        settleCreate(pending, RosterRequestResult.OwnerResult(RosterOwnerOutcome.Create(facts)))
    }

    private fun settleCreate(pending: PendingCreate, result: RosterRequestResult) {
        if (pendingCreate !== pending) return
        pendingCreate = null
        clearDeadline(RosterDeadlineKind.CREATE_RESULT, pending.requestId)
        events += RosterClientEvent.OperationSettled(
            RosterOperationKind.CREATE,
            pending.requestId,
            pending.hostRunId,
            result,
        )
    }

    private fun settleAllCreates() {
        pendingCreate?.let { settleCreate(it, RosterRequestResult.Unknown) }
    }

    /**
     * True only while this side's current observation of that row still names the
     * exact native tuple the rename was built for. A missing observation, an absent
     * row, no native conversation, a different id, or a moved epoch is never a match:
     * the request is refused rather than quietly retargeted onto a newer form.
     */
    private fun renameTargetCurrent(
        hostRunId: String,
        rowId: String,
        expectedSessionId: String,
        expectedSessionEpoch: Long,
    ): Boolean {
        if (stopRequested || phase != RosterClientPhase.SUBSCRIBED) return false
        if (projection.state != RosterProjectionState.CURRENT) return false
        if (projection.hostRunId != hostRunId) return false
        val row = projection.rows.firstOrNull { it.id == rowId } ?: return false
        val observed = row.nativeSession ?: return false
        return observed.sessionId == expectedSessionId && observed.epoch == expectedSessionEpoch
    }

    private fun onRenameResult(frame: RosterFrame.RenameResult) {
        val pending = pendingRename ?: return
        if (pending.requestId != frame.requestId) return
        val stillCurrent = clock() < pending.deadlineAt &&
            renameTargetCurrent(
                pending.hostRunId,
                pending.rowId,
                pending.expectedSessionId,
                pending.expectedSessionEpoch,
            )
        val result = if (stillCurrent) {
            RosterRequestResult.OwnerResult(RosterOwnerOutcome.Rename(frame.outcome))
        } else {
            RosterRequestResult.Unknown
        }
        settleRename(pending, result)
    }

    private fun settleRename(pending: PendingRename, result: RosterRequestResult) {
        if (pendingRename !== pending) return
        pendingRename = null
        clearDeadline(RosterDeadlineKind.RENAME_RESULT, pending.requestId)
        events += RosterClientEvent.OperationSettled(
            RosterOperationKind.RENAME,
            pending.requestId,
            pending.hostRunId,
            result,
        )
    }

    private fun settleAllRenames() {
        pendingRename?.let { settleRename(it, RosterRequestResult.Unknown) }
    }

    // ----------------------------------------------------- saved submission

    @Suppress("LongParameterList")
    private fun submitSaved(
        kind: RosterOperationKind,
        hostRunId: String,
        catalogId: String?,
        resultId: String?,
        entryId: String?,
        query: String?,
        offset: Long?,
        count: Long?,
        confirmed: Boolean?,
        proof: RosterSendProof?,
        confirmation: RosterUiProof?,
        resultLifetime: RosterUiProof? = null,
    ): RosterClientStep {
        controlRefusal()?.let { return refuse(kind, it) }
        if (!snapshot().supportsSaved) return refuse(kind, RosterNotSentReason.CAPABILITY_UNSUPPORTED)
        if (!isIdentifier(hostRunId)) return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        savedProofReason(kind, hostRunId, catalogId, resultId, entryId, proof)?.let { return refuse(kind, it) }
        // Offsets are non-negative safe scalars; a window size is 1..max rows per snapshot.
        if (offset != null && (offset < 0L || offset > MAX_SAFE_INTEGER)) {
            return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        }
        if (count != null && (count < 1L || count > bounds.maxSnapshotRows)) {
            return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        }
        if ((offset == null) != (count == null)) return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        if (query != null && !RosterText.isWellFormedUnicode(query)) {
            return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        }
        if (catalogId != null && !isIdentifier(catalogId)) return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        if (resultId != null && !isIdentifier(resultId)) return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        if (entryId != null && !isIdentifier(entryId)) return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        if (kind == RosterOperationKind.SAVED_SEARCH && catalogId == null) {
            return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        }
        if ((kind == RosterOperationKind.SAVED_WINDOW ||
                kind == RosterOperationKind.SAVED_RESUME ||
                kind == RosterOperationKind.SAVED_DELETE) &&
            (catalogId == null || resultId == null)
        ) {
            return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        }
        if ((kind == RosterOperationKind.SAVED_RESUME || kind == RosterOperationKind.SAVED_DELETE) &&
            entryId == null
        ) {
            return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        }
        // The exact owner run this side currently observes. A run is never guessed,
        // substituted, or carried across a subscription boundary.
        if (!savedRunCurrent(hostRunId)) return refuse(kind, RosterNotSentReason.TARGET_UNAVAILABLE)
        // Delete exposure is a described owner fact: unknown or Off keeps delete hidden
        // and blocks admission here, and the same fact is re-checked at dispatch. It is
        // never a grant, and the owner still re-checks its own live policy.
        if (kind == RosterOperationKind.SAVED_DELETE && !deleteExposedFor(hostRunId)) {
            return refuse(kind, RosterNotSentReason.POLICY_UNAVAILABLE)
        }
        // A resume or delete is only admissible against an entry handle this picker
        // actually owns, so an obsolete catalog, result, or picker revision cannot be
        // replayed just because its strings still match the caller's proof.
        if ((kind == RosterOperationKind.SAVED_RESUME || kind == RosterOperationKind.SAVED_DELETE) &&
            !ownsEntry(
                hostRunId = hostRunId,
                catalogId = requireNotNull(catalogId),
                resultId = requireNotNull(resultId),
                entryId = requireNotNull(entryId),
                pickerRevision = (proof as? RosterSendProof.PickerEntry)?.pickerRevision ?: 0L,
            )
        ) {
            return refuse(kind, RosterNotSentReason.TARGET_UNAVAILABLE)
        }
        val existing = pendingSaved
        // A newer read supersedes an older read; a pending resume or delete is never
        // superseded, so anything else colliding is refused without being queued.
        if (existing != null && !(kind.isSavedRead && existing.kind.isSavedRead)) {
            return refuse(kind, RosterNotSentReason.BUSY)
        }
        if (savedSequence >= MAX_SAFE_INTEGER) return refuse(kind, RosterNotSentReason.LIMIT)
        val sequence = savedSequence + 1L
        val requestId = idFactory()
        val frame = buildSavedRequestFrame(
            kind, requestId, hostRunId, catalogId, resultId, entryId, query, offset, count, confirmed, sequence,
        ) ?: return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        // The only size bound on a query is that this one frame fits the lane.
        try {
            RosterProtocol.encode(frame, bounds)
        } catch (ignored: Exception) {
            return refuse(kind, RosterNotSentReason.INVALID_REQUEST)
        }
        // Nothing already outstanding is superseded until this side knows its own request goes out.
        if (existing != null) settleSaved(existing, RosterRequestResult.Unknown)
        // Advanced now and never rewound, whatever happens to this attempt.
        savedSequence = sequence
        pendingSaved = PendingSaved(
            requestId = requestId,
            sequence = sequence,
            kind = kind,
            hostRunId = hostRunId,
            catalogId = catalogId,
            resultId = resultId,
            entryId = entryId,
            offset = offset ?: 0L,
            count = count ?: 0L,
            queryRevision = (proof as? RosterSendProof.PickerRead)?.queryRevision
                ?: (proof as? RosterSendProof.PickerEntry)?.pickerRevision ?: 0L,
            confirmed = confirmed,
            resultLifetime = resultLifetime,
            deadlineAt = clock() + bounds.createResultTimeoutMs,
        )
        // The same patience class as Create for the first answer; never a retry.
        armSavedDeadline(requireNotNull(pendingSaved), bounds.createResultTimeoutMs)
        events += RosterClientEvent.OperationAccepted(kind, requestId, hostRunId)
        val sent = send(frame, SendPurpose.SAVED, requestId, requireNotNull(proof))
        if (!sent) settleSaved(requireNotNull(pendingSaved), RosterRequestResult.NotSent(RosterNotSentReason.NOT_READY))
        return step()
    }

    private fun savedProofReason(
        kind: RosterOperationKind,
        hostRunId: String,
        catalogId: String?,
        resultId: String?,
        entryId: String?,
        proof: RosterSendProof?,
    ): RosterNotSentReason? {
        if (kind.isSavedRead) {
            val read = proof as? RosterSendProof.PickerRead
                ?: return RosterNotSentReason.INVALID_REQUEST
            if (read.channelGeneration != generation || read.hostRunId != hostRunId) {
                return RosterNotSentReason.INVALID_REQUEST
            }
            if (kind == RosterOperationKind.SAVED_SEARCH && read.catalogId != catalogId) {
                return RosterNotSentReason.INVALID_REQUEST
            }
            if (kind == RosterOperationKind.SAVED_WINDOW &&
                (read.catalogId != catalogId || read.resultId != resultId)
            ) {
                return RosterNotSentReason.INVALID_REQUEST
            }
            // A read is admissible only against a handle this picker actually holds.
            // Only a fresh list may establish a catalog without existing ownership.
            if (!ownsReadTarget(kind, hostRunId, catalogId, resultId, read.queryRevision)) {
                return RosterNotSentReason.TARGET_UNAVAILABLE
            }
            return if (proofHolds(read.ui)) null else RosterNotSentReason.TARGET_UNAVAILABLE
        }
        val entry = proof as? RosterSendProof.PickerEntry
            ?: return RosterNotSentReason.INVALID_REQUEST
        if (entry.channelGeneration != generation ||
            entry.hostRunId != hostRunId ||
            entry.catalogId != catalogId ||
            entry.resultId != resultId ||
            entry.entryId != entryId
        ) {
            return RosterNotSentReason.INVALID_REQUEST
        }
        return if (proofHolds(entry.ui)) null else RosterNotSentReason.TARGET_UNAVAILABLE
    }

    @Suppress("LongParameterList")
    private fun buildSavedRequestFrame(
        kind: RosterOperationKind,
        requestId: String,
        hostRunId: String,
        catalogId: String?,
        resultId: String?,
        entryId: String?,
        query: String?,
        offset: Long?,
        count: Long?,
        confirmed: Boolean?,
        sequence: Long,
    ): RosterFrame? = when (kind) {
        RosterOperationKind.SAVED_LIST ->
            RosterFrame.SavedListRequest(requestId, hostRunId, query ?: "", offset ?: 0L, count ?: 0L, sequence)

        RosterOperationKind.SAVED_SEARCH -> RosterFrame.SavedSearchRequest(
            requestId, hostRunId, catalogId ?: return null, query ?: "", offset ?: 0L, count ?: 0L, sequence,
        )

        RosterOperationKind.SAVED_WINDOW -> RosterFrame.SavedWindowRequest(
            requestId, hostRunId, catalogId ?: return null, resultId ?: return null,
            offset ?: 0L, count ?: 0L, sequence,
        )

        RosterOperationKind.SAVED_RESUME -> RosterFrame.SavedResumeRequest(
            requestId, hostRunId, catalogId ?: return null, resultId ?: return null, entryId ?: return null, sequence,
        )

        RosterOperationKind.SAVED_DELETE -> RosterFrame.SavedDeleteRequest(
            requestId, hostRunId, catalogId ?: return null, resultId ?: return null,
            entryId ?: return null, confirmed ?: false, sequence,
        )

        else -> null
    }

    // -------------------------------------------------------- saved inbound

    private fun onSavedFrame(frame: RosterFrame) {
        if (frame is RosterFrame.SavedPolicy) {
            // A description for a run this side does not currently observe is stale
            // and is dropped; it can never become the current description.
            if (!savedRunCurrent(frame.hostRunId)) return
            setSavedPolicy(RosterSavedPolicy(frame.hostRunId, frame.deleteExposed))
            return
        }
        val requestId = when (frame) {
            is RosterFrame.SavedWindowResult -> frame.requestId
            is RosterFrame.SavedWindowBegin -> frame.requestId
            is RosterFrame.SavedWindowPage -> frame.requestId
            is RosterFrame.SavedWindowFragment -> frame.requestId
            is RosterFrame.SavedWindowEnd -> frame.requestId
            is RosterFrame.SavedResumeResult -> frame.requestId
            is RosterFrame.SavedDeleteResult -> frame.requestId
            else -> return
        }
        val pending = savedTarget(requestId) ?: return
        // A dismissed picker ends a read: its reply can neither publish nor re-install
        // ownership. A mutation already handed to the transport keeps its correlated
        // owner outcome, because this side cannot cancel accepted owner work.
        if (pending.kind.isSavedRead && (!pending.pickerCurrent ||
                (pending.resultLifetime != null && !proofHolds(pending.resultLifetime)))) {
            settleSaved(pending, RosterRequestResult.Unknown)
            return
        }
        when (frame) {
            is RosterFrame.SavedWindowResult -> {
                if (!pending.kind.isSavedRead) {
                    savedViolation(pending)
                    return
                }
                // A fixed answer, before or instead of a transfer; nothing staged survives.
                settleSaved(
                    pending,
                    RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedWindow(frame.outcome.toClientFacts())),
                )
            }

            is RosterFrame.SavedWindowBegin -> onSavedWindowBegin(pending, frame)
            is RosterFrame.SavedWindowPage -> onSavedWindowPage(pending, frame)
            is RosterFrame.SavedWindowFragment -> onSavedWindowFragment(pending, frame)
            is RosterFrame.SavedWindowEnd -> onSavedWindowEnd(pending, frame)

            is RosterFrame.SavedResumeResult -> {
                if (pending.kind != RosterOperationKind.SAVED_RESUME) {
                    savedViolation(pending)
                    return
                }
                val facts = frame.outcome
                if (facts is OwnerSavedResumeFacts.Started && facts.hostRunId != pending.hostRunId) {
                    // An answer about another run establishes nothing about this request.
                    settleSaved(pending, RosterRequestResult.Unknown)
                    return
                }
                settleSaved(pending, RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedResume(facts)))
            }

            is RosterFrame.SavedDeleteResult -> {
                if (pending.kind != RosterOperationKind.SAVED_DELETE) {
                    savedViolation(pending)
                    return
                }
                settleSaved(pending, RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedDelete(frame.outcome)))
            }
        }
    }

    /** The pending operation this frame answers, if it is still inside its lifetime. */
    private fun savedTarget(requestId: String): PendingSaved? {
        val pending = pendingSaved ?: return null
        // Unsolicited, foreign, superseded, or already-settled ids resolve nothing.
        if (pending.requestId != requestId) return null
        if (clock() > pending.deadlineAt) {
            // Expired even if its timer has not been dispatched yet.
            settleSaved(pending, RosterRequestResult.Unknown)
            return null
        }
        return pending
    }

    /** Incoherent data for this side's own pending request fails closed. */
    private fun savedViolation(pending: PendingSaved) {
        settleSaved(pending, RosterRequestResult.Unknown)
        protocolFailure()
    }

    private fun onSavedWindowBegin(pending: PendingSaved, frame: RosterFrame.SavedWindowBegin) {
        if (!pending.kind.isSavedRead || pending.window != null) {
            savedViolation(pending)
            return
        }
        if (frame.hostRunId != pending.hostRunId ||
            // A search keeps its catalog; a window keeps its catalog AND result. A list
            // may legitimately name a fresh catalog and result.
            (pending.kind != RosterOperationKind.SAVED_LIST && frame.catalogId != pending.catalogId) ||
            (pending.kind == RosterOperationKind.SAVED_WINDOW && frame.resultId != pending.resultId) ||
            frame.offset != pending.offset ||
            frame.rows > pending.count ||
            // A non-empty remainder must make progress: a response can never present a
            // non-empty result as an empty window.
            (frame.offset < frame.total && frame.rows == 0L)
        ) {
            savedViolation(pending)
            return
        }
        pending.window = PartialWindow(
            hostRunId = frame.hostRunId,
            catalogId = frame.catalogId,
            resultId = frame.resultId,
            total = frame.total,
            issueCount = frame.issueCount,
            offset = frame.offset,
            rows = frame.rows,
            pageCount = frame.pageCount,
        )
        armSavedDeadline(pending, bounds.transferIdleTimeoutMs)
    }

    /**
     * One part of one oversized entry. Parts must arrive consecutively at the next
     * page index, exactly in order, with no page in between; the assembled text is
     * bounded by this side's own window byte budget at every part and must decode to
     * exactly one canonical, valid, not-yet-seen entry. Nothing is published until
     * the whole window completes.
     */
    private fun onSavedWindowFragment(pending: PendingSaved, frame: RosterFrame.SavedWindowFragment) {
        val window = pending.window
        if (window == null || frame.pageIndex != window.pageIndex || frame.pageIndex >= window.pageCount) {
            savedViolation(pending)
            return
        }
        var fragment = window.fragment
        if (fragment == null) {
            if (frame.part != 0L || window.entries.size.toLong() >= window.rows) {
                savedViolation(pending)
                return
            }
            fragment = PartialFragment(frame.parts)
        } else if (frame.parts != fragment.parts || frame.part != fragment.next) {
            savedViolation(pending)
            return
        }
        val bytes = fragment.bytes + RosterSavedWire.fragmentWireBytes(frame.text)
        if (window.bytes + bytes > bounds.maxSnapshotBytes) {
            // Beyond this side's own window budget: nothing staged is ever used.
            settleSaved(pending, RosterRequestResult.Unknown)
            return
        }
        fragment.texts.add(frame.text)
        fragment.bytes = bytes
        fragment.next += 1
        window.fragment = fragment
        window.pageIndex += 1
        if (fragment.next == fragment.parts) {
            window.fragment = null
            val entry = try {
                RosterProtocol.decodeSavedEntryText(fragment.texts.joinToString(""), bounds)
            } catch (ignored: Exception) {
                savedViolation(pending)
                return
            }
            if (!window.ids.add(entry.entryId)) {
                savedViolation(pending)
                return
            }
            window.entries.add(entry)
            window.bytes += fragment.bytes
        }
        armSavedDeadline(pending, bounds.transferIdleTimeoutMs)
    }

    private fun onSavedWindowPage(pending: PendingSaved, frame: RosterFrame.SavedWindowPage) {
        val window = pending.window
        if (window == null ||
            window.fragment != null ||
            frame.pageIndex != window.pageIndex ||
            frame.pageIndex >= window.pageCount ||
            frame.entries.isEmpty()
        ) {
            savedViolation(pending)
            return
        }
        val fresh = HashSet<String>()
        var bytes = window.bytes
        for (entry in frame.entries) {
            if (window.entries.size.toLong() + fresh.size.toLong() >= window.rows ||
                window.ids.contains(entry.entryId) ||
                !fresh.add(entry.entryId)
            ) {
                savedViolation(pending)
                return
            }
            bytes += RosterSavedWire.entryWireBytes(entry)
        }
        if (bytes > bounds.maxSnapshotBytes) {
            // Beyond this side's own aggregate bound: nothing staged is ever used.
            settleSaved(pending, RosterRequestResult.Unknown)
            return
        }
        for (entry in frame.entries) {
            window.entries.add(entry)
            window.ids.add(entry.entryId)
        }
        window.bytes = bytes
        window.pageIndex += 1
        armSavedDeadline(pending, bounds.transferIdleTimeoutMs)
    }

    private fun onSavedWindowEnd(pending: PendingSaved, frame: RosterFrame.SavedWindowEnd) {
        val window = pending.window
        if (window == null ||
            window.fragment != null ||
            frame.rows != window.rows ||
            frame.pageCount != window.pageCount ||
            window.pageIndex != window.pageCount ||
            window.entries.size.toLong() != window.rows
        ) {
            savedViolation(pending)
            return
        }
        val facts = RosterSavedWindowFacts.Complete(
            hostRunId = window.hostRunId,
            catalogId = window.catalogId,
            resultId = window.resultId,
            total = window.total,
            issueCount = window.issueCount,
            offset = window.offset,
            entries = window.entries.toList(),
        )
        retainSavedWindow(pending, facts)
        settleSaved(pending, RosterRequestResult.OwnerResult(RosterOwnerOutcome.SavedWindow(facts)))
    }

    /**
     * Install one completed window into the bounded ownership set.
     *
     * A list names a fresh catalog and result and a search replaces the result, so
     * either one obsoletes every window that belonged to what the picker was showing
     * before. A later window of the same result replaces the record for its own
     * offset, and the oldest retained window is evicted past the bound. A reply that
     * no longer matches what this side currently owns is dropped rather than installed,
     * so a late transfer can never retarget a newer picker.
     */
    private fun retainSavedWindow(pending: PendingSaved, facts: RosterSavedWindowFacts.Complete) {
        val existing = currentSavedOwnership()
        val keep: List<RosterSavedWindowHandle> = if (existing == null ||
            existing.hostRunId != facts.hostRunId ||
            existing.catalogId != facts.catalogId ||
            existing.resultId != facts.resultId ||
            existing.pickerRevision != pending.queryRevision
        ) {
            emptyList()
        } else {
            existing.windows.filter { it.offset != facts.offset }
        }
        val handle = RosterSavedWindowHandle(
            catalogId = facts.catalogId,
            resultId = facts.resultId,
            offset = facts.offset,
            total = facts.total,
            issueCount = facts.issueCount,
            pickerRevision = pending.queryRevision,
            entryIds = facts.entries.map { it.entryId },
        )
        savedOwnership = RosterSavedOwnership(
            hostRunId = facts.hostRunId,
            catalogId = facts.catalogId,
            resultId = facts.resultId,
            pickerRevision = pending.queryRevision,
            windows = (keep + handle).takeLast(RosterSavedOwnership.MAX_RETAINED_SAVED_WINDOWS),
        )
        // Keep the guard until the application consumes the complete reply. A cancel
        // racing the final frame cannot leave actionable ownership behind.
        savedOwnershipLifetime = pending.resultLifetime
    }

    /** True only while one owned, current window of this picker carries this entry handle. */
    private fun ownsEntry(
        hostRunId: String,
        catalogId: String,
        resultId: String,
        entryId: String,
        pickerRevision: Long,
    ): Boolean {
        val ownership = currentSavedOwnership() ?: return false
        if (ownership.hostRunId != hostRunId) return false
        if (ownership.catalogId != catalogId || ownership.resultId != resultId) return false
        return ownership.windows.any {
            it.catalogId == catalogId &&
                it.resultId == resultId &&
                it.pickerRevision == pickerRevision &&
                it.entryIds.contains(entryId)
        }
    }

    /** The described delete exposure for one exact run. Unknown is not exposure. */
    private fun deleteExposedFor(hostRunId: String): Boolean {
        val policy = savedPolicy ?: return false
        return policy.hostRunId == hostRunId && policy.deleteExposed
    }

    /**
     * Drop this endpoint's Saved handle ownership: the picker closed or the host
     * switched.
     *
     * Only unsent intent and local handle references are dropped. An operation that
     * already left this endpoint keeps waiting for its own correlated answer or
     * deadline, because this side can neither cancel accepted owner work nor claim to
     * have cancelled it, and a late reply can no longer install anything: handle
     * admission is closed until a fresh read re-establishes ownership.
     */
    @Synchronized
    public fun dismissSavedPicker(scope: RosterSavedPickerScope? = null): RosterClientStep {
        if (scope != null && scope.generation != generation) return step()
        if (scope == null || savedOwnership === scope.ownership) savedOwnership = null
        // In-flight intent belongs to the picker that issued it too: unsent writes are
        // invalidated and a read still awaiting its first frame can no longer publish.
        pendingSaved?.takeIf { scope == null || it.requestId == scope.pendingRequestId }?.pickerCurrent = false
        return step()
    }

    /**
     * Whether this picker currently holds the catalog and result one read names.
     *
     * A list may always be issued, because listing is how ownership of a catalog is
     * established. A search needs the catalog it narrows, and a window needs the exact
     * result and picker revision currently owned — otherwise a stale handle could
     * replace what a newer picker is showing.
     */
    private fun ownsReadTarget(
        kind: RosterOperationKind,
        hostRunId: String,
        catalogId: String?,
        resultId: String?,
        queryRevision: Long,
    ): Boolean {
        if (kind == RosterOperationKind.SAVED_LIST) return true
        val ownership = currentSavedOwnership() ?: return false
        if (ownership.hostRunId != hostRunId || ownership.catalogId != catalogId) return false
        return when (kind) {
            RosterOperationKind.SAVED_SEARCH -> true
            RosterOperationKind.SAVED_WINDOW ->
                ownership.resultId == resultId && ownership.pickerRevision == queryRevision

            else -> false
        }
    }

    private fun settleSaved(pending: PendingSaved, result: RosterRequestResult) {
        if (pendingSaved !== pending) return
        val deleted = ((result as? RosterRequestResult.OwnerResult)?.outcome as? RosterOwnerOutcome.SavedDelete)
            ?.facts is OwnerSavedDeleteFacts.Deleted
        val owned = currentSavedOwnership()
        // Deleted names no target on the wire. Only this accepted confirmed request
        // can retire its exact old catalog; never infer a target from current selection.
        if (pending.kind == RosterOperationKind.SAVED_DELETE && pending.confirmed == true && deleted && owned != null &&
            owned.hostRunId == pending.hostRunId && owned.catalogId == pending.catalogId &&
            owned.resultId == pending.resultId && owned.pickerRevision == pending.queryRevision &&
            owned.windows.any { pending.entryId in it.entryIds && it.pickerRevision == pending.queryRevision }) {
            savedOwnership = null
        }
        pendingSaved = null
        clearDeadline(RosterDeadlineKind.SAVED_RESULT, pending.requestId)
        pending.window = null
        events += RosterClientEvent.OperationSettled(pending.kind, pending.requestId, pending.hostRunId, result)
    }

    private fun settleAllSaved() {
        pendingSaved?.let { settleSaved(it, RosterRequestResult.Unknown) }
    }

    /**
     * The live subscription ended: its run is no longer observed, so a pending read —
     * which the owner abandons with that subscription — is unknown, and the policy
     * description returns to unknown. A pending resume or delete keeps waiting for
     * its own correlated answer or deadline.
     */
    private fun endSavedObservation() {
        val pending = pendingSaved
        if (pending != null && pending.kind.isSavedRead) settleSaved(pending, RosterRequestResult.Unknown)
        setSavedPolicy(null)
        // Handles belong to the run that minted them; they are not carried across a
        // subscription boundary and are never offline history.
        savedOwnership = null
    }

    private fun setSavedPolicy(policy: RosterSavedPolicy?) {
        val previous = savedPolicy
        if (previous == policy) return
        savedPolicy = policy
        events += RosterClientEvent.SavedPolicyChanged(policy)
    }

    /**
     * True only for the exact owner run this side currently observes: a live
     * subscription whose own complete snapshot — possibly with zero rows — named it.
     */
    private fun savedRunCurrent(hostRunId: String): Boolean {
        val last = lastComplete
        return phase == RosterClientPhase.SUBSCRIBED &&
            subscriptionId != null &&
            subscriptionRun == hostRunId &&
            last != null &&
            last.subscriptionId == subscriptionId &&
            last.hostRunId == hostRunId
    }

    // ------------------------------------------------------------- lifecycle

    private fun refusalReason(): RosterSubscriptionRefusal? = when {
        stopRequested || phase == RosterClientPhase.DETACHED -> RosterSubscriptionRefusal.STOPPED
        phase == RosterClientPhase.FAILED -> RosterSubscriptionRefusal.REFUSED
        else -> null
    }

    /**
     * The single reason this endpoint cannot submit a protected control request now,
     * or null. Before the acknowledgement there is no negotiated capability at all,
     * so nothing may be submitted.
     */
    private fun controlRefusal(): RosterNotSentReason? = when (phase) {
        RosterClientPhase.DETACHED, RosterClientPhase.FAILED, RosterClientPhase.AWAITING_ACK ->
            RosterNotSentReason.NOT_READY

        else -> if (stopRequested) RosterNotSentReason.NOT_READY else null
    }

    private fun startSubscription() {
        val id = idFactory()
        subscriptionId = id
        // A fresh subscription is the only boundary at which another owner run may be
        // adopted; the pin is set by the first accepted snapshot of this subscription.
        subscriptionRun = null
        transfer = null
        phase = RosterClientPhase.SUBSCRIBED
        if (projection.revision == null) {
            setProjection(RosterProjectionState.EMPTY, RosterStalenessReason.SUBSCRIBING, subscriptionId = id)
        }
        armDeadline(RosterDeadlineKind.SNAPSHOT_START, id, bounds.snapshotStartTimeoutMs)
        diagnostic(RosterClientDiagnosticCode.SUBSCRIBED)
        events += RosterClientEvent.SubscriptionStarted(id)
        if (!send(RosterFrame.Subscribe(id), SendPurpose.SUBSCRIBE, id, RosterSendProof.Control(generation))) {
            abandonSubscription(RosterStalenessReason.TRANSFER_FAILED)
        }
    }

    private enum class RetirementKind { GRACEFUL, LOCAL_FAILURE, OWNER_CONFIRMED }

    /**
     * Retire the live subscription: discard any staged transfer, tell the owner which
     * subscription to release, and wait (bounded) for its confirmation.
     *
     * Concurrent callers join the one outstanding retirement rather than replacing its
     * acknowledgement or timer, and the retiring identifier stays remembered until
     * then, so frames the owner had already admitted are discarded as noise instead of
     * failing the channel.
     */
    private fun beginRetirement(kind: RetirementKind, reason: RosterStalenessReason?, announceEmpty: Boolean = true) {
        // Whatever path ends the subscription, its run is no longer observed here.
        endSavedObservation()
        if (retirementOutstanding) return
        val id = subscriptionId
        if (phase != RosterClientPhase.SUBSCRIBED || id == null) {
            transfer = null
            clearTransferDeadlines()
            if (reason != null && phase != RosterClientPhase.DETACHED) markNotCurrent(reason)
            if (announceEmpty) events += RosterClientEvent.RetirementRequested(null)
            return
        }
        subscriptionId = null
        subscriptionRun = null
        transfer = null
        clearTransferDeadlines()
        phase = RosterClientPhase.READY
        // The snapshot of a subscription being retired stops being authoritative the
        // moment the retirement starts, not when its acknowledgement arrives.
        if (reason != null) markNotCurrent(reason)
        armedRows.clear()
        if (kind == RetirementKind.OWNER_CONFIRMED) {
            // The owner ended this subscription itself: nothing to notify and nothing to
            // wait for, so a later explicit resync may start immediately.
            diagnostic(RosterClientDiagnosticCode.UNSUBSCRIBED)
            events += RosterClientEvent.SubscriptionRetired(id, acknowledged = true)
            return
        }
        retiringId = id
        retirementOutstanding = true
        // No retirement is trusted without the owner's confirmation, whichever path
        // started it: an unacknowledged one ends the channel rather than being reused.
        retirementFailClosed = true
        events += RosterClientEvent.RetirementRequested(id)
        armDeadline(RosterDeadlineKind.RETIREMENT_ACK, id, bounds.stopAckTimeoutMs)
        if (!send(RosterFrame.Unsubscribe(id), SendPurpose.UNSUBSCRIBE, id, RosterSendProof.Control(generation))) {
            completeRetirement(acknowledged = false)
        }
    }

    private fun completeRetirement(acknowledged: Boolean) {
        if (!retirementOutstanding) return
        val id = retiringId ?: return
        val failClosed = retirementFailClosed
        retiringId = null
        retirementFailClosed = false
        retirementOutstanding = false
        clearDeadline(RosterDeadlineKind.RETIREMENT_ACK, id)
        if (acknowledged) diagnostic(RosterClientDiagnosticCode.UNSUBSCRIBED)
        events += RosterClientEvent.SubscriptionRetired(id, acknowledged)
        if (phase == RosterClientPhase.READY && subscriptionId == null && !acknowledged) {
            // Without a confirmation this side cannot claim a clean stop: report the
            // loss of certainty rather than a stop the owner never acknowledged, and
            // never an empty roster.
            markNotCurrent(RosterStalenessReason.CHANNEL_CLOSED)
        }
        if (!acknowledged && failClosed) {
            // The owner was never told this subscription is gone, so reusing the channel
            // could collide with a watch it still considers live. End the metadata
            // session rather than resuming, and report transport loss rather than a
            // clean stop this side never saw — including a stop that is still waiting
            // on this acknowledgement, which must not detach around the unconfirmed
            // retirement it asked for.
            if (phase == RosterClientPhase.READY || phase == RosterClientPhase.SUBSCRIBED) {
                phase = RosterClientPhase.DETACHED
            }
            effects += RosterClientEffect.CloseChannel
        }
        if (detachAfterRetirement) {
            detachAfterRetirement = false
            finishStop()
        }
    }

    /**
     * End the live subscription locally, discarding any partial transfer. Metadata
     * only: sessions are never stopped here. A locally forced end still names the
     * subscription to the owner and gates any replacement on that confirmation,
     * because forgetting the identifier would leave the owner's watch running and make
     * the next subscription a second one it would have to refuse.
     */
    private fun abandonSubscription(
        reason: RosterStalenessReason,
        kind: RetirementKind = RetirementKind.LOCAL_FAILURE,
    ) {
        beginRetirement(kind, reason, announceEmpty = false)
        if (phase == RosterClientPhase.SUBSCRIBED) phase = RosterClientPhase.READY
    }

    private fun finishStop() {
        if (phase == RosterClientPhase.DETACHED) return
        clearTransferDeadlines()
        clearDeadline(RosterDeadlineKind.HANDSHAKE, generation.toString())
        settleAllCloses()
        settleAllCreates()
        settleAllRenames()
        settleAllSaved()
        setSavedPolicy(null)
        savedOwnership = null
        // No barrier may outlive the handler: whoever is waiting has to settle.
        settleRetirement()
        outstandingSends.clear()
        phase = RosterClientPhase.DETACHED
        diagnostic(RosterClientDiagnosticCode.CLIENT_STOPPED)
        // Last-observed rows stay visible as explicitly not current. Stopping ends
        // metadata delivery; it never clears the roster to empty or idle.
        if (projection.revision != null) {
            setProjection(RosterProjectionState.STALE, RosterStalenessReason.STOPPED)
        } else {
            setProjection(RosterProjectionState.EMPTY, RosterStalenessReason.STOPPED)
        }
        rejectHello(RosterStalenessReason.STOPPED)
    }

    /** Release any outstanding retirement barrier without implying confirmation. */
    private fun settleRetirement() {
        if (!retirementOutstanding) return
        val id = retiringId
        clearDeadline(RosterDeadlineKind.RETIREMENT_ACK, id ?: "")
        retiringId = null
        retirementFailClosed = false
        retirementOutstanding = false
        if (id != null) events += RosterClientEvent.SubscriptionRetired(id, acknowledged = false)
    }

    private fun protocolFailure() {
        if (phase == RosterClientPhase.DETACHED) return
        diagnostic(RosterClientDiagnosticCode.PROTOCOL_VIOLATION)
        send(
            RosterFrame.Failure(RosterWireErrorCode.BAD_FRAME),
            SendPurpose.ERROR_NOTICE,
            null,
            RosterSendProof.Control(generation),
        )
        abandonSubscription(RosterStalenessReason.PROTOCOL_VIOLATION)
        if (phase == RosterClientPhase.AWAITING_ACK) {
            clearDeadline(RosterDeadlineKind.HANDSHAKE, generation.toString())
            phase = RosterClientPhase.FAILED
            setProjection(RosterProjectionState.STALE, RosterStalenessReason.PROTOCOL_VIOLATION)
            rejectHello(RosterStalenessReason.PROTOCOL_VIOLATION)
        }
        // Closing the channel is what makes an unfixable protocol failure observable
        // even when the error frame above could not be written.
        effects += RosterClientEffect.CloseChannel
    }

    // ---------------------------------------------------------- projection

    /** Keep the last rows and say plainly that they are no longer authoritative. */
    private fun markNotCurrent(reason: RosterStalenessReason) {
        if (projection.revision == null) {
            setProjection(RosterProjectionState.EMPTY, reason, subscriptionId = null)
        } else {
            setProjection(RosterProjectionState.STALE, reason, subscriptionId = null)
        }
    }

    private fun setProjection(
        state: RosterProjectionState,
        reason: RosterStalenessReason?,
        rows: List<RemoteSessionMetadata>? = null,
        hostRunId: String? = null,
        revision: Long? = null,
        subscriptionId: String? = null,
    ) {
        val previous = projection
        val next = RosterProjection(
            state = state,
            rows = rows ?: previous.rows,
            hostRunId = hostRunId ?: previous.hostRunId,
            revision = revision ?: previous.revision,
            subscriptionId = subscriptionId ?: previous.subscriptionId,
            reason = reason,
        )
        if (next == previous) return
        projection = next
        events += RosterClientEvent.ProjectionChanged(next)
    }

    // -------------------------------------------------------- effects plumbing

    private fun send(
        frame: RosterFrame,
        purpose: SendPurpose,
        correlationId: String?,
        proof: RosterSendProof,
    ): Boolean {
        if (phase == RosterClientPhase.DETACHED) return false
        if (outstandingSends.size >= MAX_QUEUED_CLIENT_SENDS) {
            // Control traffic is tiny and sequential by design; a backlog means the
            // channel is not draining, so nothing further is queued.
            diagnostic(RosterClientDiagnosticCode.SEND_FAILED)
            return false
        }
        val messageId = nextMessageId
        nextMessageId += 1
        outstandingSends[messageId] = OutstandingSend(purpose, correlationId, proof)
        effects += RosterClientEffect.Send(RosterClientMessage(messageId, frame, proof))
        return true
    }

    private fun armDeadline(kind: RosterDeadlineKind, id: String, timeoutMs: Long) {
        // One endpoint-lifetime counter: an identity is never reused, so cancelling a
        // registration cannot make a late callback for it look current.
        nextDeadlineArm += 1L
        val arm = nextDeadlineArm
        // Any earlier registration for this same deadline is superseded now, so a
        // callback already in flight for it is recognizable as stale.
        dropDeadlineTokens(kind, id)
        val token = RosterDeadlineToken(kind, id, arm)
        val dueAt = clock() + timeoutMs
        deadlines[token] = dueAt
        effects += RosterClientEffect.ArmDeadline(token, dueAt)
    }

    /**
     * Arm one Saved deadline and keep the pending record's own deadline in step with
     * it, so a window that keeps making progress is never discarded against the
     * patience it was first given.
     */
    private fun armSavedDeadline(pending: PendingSaved, timeoutMs: Long) {
        pending.deadlineAt = clock() + timeoutMs
        armDeadline(RosterDeadlineKind.SAVED_RESULT, pending.requestId, timeoutMs)
    }

    private fun clearDeadline(kind: RosterDeadlineKind, id: String) {
        dropDeadlineTokens(kind, id)
    }

    private fun dropDeadlineTokens(kind: RosterDeadlineKind, id: String): Boolean {
        val stale = deadlines.keys.filter { it.kind == kind && it.id == id }
        for (token in stale) {
            deadlines.remove(token)
            effects += RosterClientEffect.CancelDeadline(token)
        }
        return stale.isNotEmpty()
    }

    private fun clearTransferDeadlines() {
        val stale = deadlines.keys.filter {
            it.kind == RosterDeadlineKind.SNAPSHOT_START || it.kind == RosterDeadlineKind.TRANSFER_IDLE
        }
        for (token in stale) {
            deadlines.remove(token)
            effects += RosterClientEffect.CancelDeadline(token)
        }
    }

    private fun rejectHello(reason: RosterStalenessReason) {
        if (helloSettled) return
        helloSettled = true
        events += RosterClientEvent.HandshakeRefused(reason)
    }

    private fun diagnostic(code: RosterClientDiagnosticCode, rowCount: Long? = null) {
        events += RosterClientEvent.Diagnostic(code, rowCount)
    }

    private fun refuse(kind: RosterOperationKind, reason: RosterNotSentReason): RosterClientStep {
        events += RosterClientEvent.OperationRefused(kind, reason)
        return step()
    }

    private fun proofHolds(proof: RosterUiProof): Boolean = try {
        proof.isStillCurrent()
    } catch (ignored: Exception) {
        // An unavailable fence decision is no decision at all.
        false
    }

    private fun isIdentifier(value: String): Boolean = RosterProtocol.isIdentifier(value, bounds)

    private fun rowWireBytes(row: RemoteSessionMetadata): Long? = try {
        RosterMetadataRow.encode(row).toByteArray(Charsets.UTF_8).size.toLong()
    } catch (ignored: Exception) {
        // A row this side cannot re-encode cannot be counted, so the transfer that
        // carried it is refused rather than published with an unknown byte account.
        null
    }

    private fun step(): RosterClientStep {
        val built = RosterClientStep(snapshot(), effects.toList(), events.toList())
        effects.clear()
        events.clear()
        return built
    }

    private fun snapshot(): RosterClientState {
        val pending = mutableListOf<RosterPendingOperation>()
        for (close in pendingCloses.values) {
            pending += RosterPendingOperation(
                kind = RosterOperationKind.CLOSE,
                requestId = close.requestId,
                hostRunId = close.hostRunId,
                rowId = close.rowId,
                deadlineAtMs = close.deadlineAt,
            )
        }
        pendingCreate?.let {
            pending += RosterPendingOperation(
                kind = RosterOperationKind.CREATE,
                requestId = it.requestId,
                hostRunId = it.hostRunId,
                sequence = it.sequence,
                deadlineAtMs = it.deadlineAt,
            )
        }
        pendingRename?.let {
            pending += RosterPendingOperation(
                kind = RosterOperationKind.RENAME,
                requestId = it.requestId,
                hostRunId = it.hostRunId,
                rowId = it.rowId,
                deadlineAtMs = it.deadlineAt,
            )
        }
        pendingSaved?.let {
            pending += RosterPendingOperation(
                kind = it.kind,
                requestId = it.requestId,
                hostRunId = it.hostRunId,
                sequence = it.sequence,
                catalogId = it.catalogId,
                resultId = it.resultId,
                entryId = it.entryId,
                deadlineAtMs = it.deadlineAt,
                stagedWindowEntries = it.window?.entries?.size?.toLong(),
                savedPickerRevision = it.queryRevision,
                savedDeleteConfirmed = it.confirmed,
            )
        }
        val staged = transfer
        return RosterClientState(
            hostId = hostId,
            generation = generation,
            phase = phase,
            projection = projection,
            subscriptionId = subscriptionId,
            subscriptionRunId = subscriptionRun,
            capabilities = capabilities,
            savedPolicy = savedPolicy,
            savedOwnership = currentSavedOwnership(),
            pending = pending,
            inFlightTransfer = staged?.let {
                RosterInFlightTransfer(
                    subscriptionId = it.subscriptionId,
                    transferId = it.transferId,
                    hostRunId = it.hostRunId,
                    revision = it.revision,
                    totalRows = it.totalRows,
                    pageCount = it.pageCount,
                    rowsReceived = it.rows.size.toLong(),
                    pagesReceived = it.pageIndex,
                )
            },
            retiringSubscriptionId = retiringId,
            stopRequested = stopRequested,
            createSequence = createSequence,
            renameSequence = renameSequence,
            savedSequence = savedSequence,
            armedCloseConfirmationRows = armedRows.toList(),
        )
    }

    // ------------------------------------------------------------- internals

    private enum class SendPurpose { HELLO, SUBSCRIBE, UNSUBSCRIBE, ERROR_NOTICE, CLOSE, CREATE, RENAME, SAVED }

    private class OutstandingSend(
        val purpose: SendPurpose,
        val correlationId: String?,
        val proof: RosterSendProof,
    )

    private class LastComplete(val hostRunId: String, val revision: Long, val subscriptionId: String)

    private class PendingClose(val requestId: String, val hostRunId: String, val rowId: String, val deadlineAt: Long)

    private class PendingCreate(
        val requestId: String,
        val hostRunId: String,
        val sequence: Long,
        val deadlineAt: Long,
    )

    private class PendingRename(
        val requestId: String,
        val hostRunId: String,
        val rowId: String,
        val expectedSessionId: String,
        val expectedSessionEpoch: Long,
        val deadlineAt: Long,
    )

    private class PendingSaved(
        val requestId: String,
        val sequence: Long,
        val kind: RosterOperationKind,
        val hostRunId: String,
        val catalogId: String?,
        val resultId: String?,
        val entryId: String?,
        val offset: Long,
        val count: Long,
        val queryRevision: Long,
        val confirmed: Boolean?,
        val resultLifetime: RosterUiProof?,
        var deadlineAt: Long,
    ) {
        /** Cleared when the picker that issued this request is dismissed. */
        var pickerCurrent: Boolean = true
        var window: PartialWindow? = null
    }

    private class PartialWindow(
        val hostRunId: String,
        val catalogId: String,
        val resultId: String,
        val total: Long,
        val issueCount: Long,
        val offset: Long,
        val rows: Long,
        val pageCount: Long,
    ) {
        val entries: MutableList<OwnerSavedEntry> = mutableListOf()
        val ids: MutableSet<String> = mutableSetOf()
        var pageIndex: Long = 0L
        var bytes: Long = 0L
        var fragment: PartialFragment? = null
    }

    private class PartialFragment(val parts: Long) {
        var next: Long = 0L
        val texts: MutableList<String> = mutableListOf()
        var bytes: Long = 0L
    }

    private class PartialTransfer(
        val subscriptionId: String,
        val transferId: String,
        val hostRunId: String,
        val revision: Long,
        val totalRows: Long,
        val pageCount: Long,
    ) {
        val rows: MutableList<RemoteSessionMetadata> = mutableListOf()
        val ids: MutableSet<String> = mutableSetOf()
        var pageIndex: Long = 0L
        var bytes: Long = 0L
    }

    private companion object {
        /** Queued control sends: hello, subscribe, unsubscribe, close, create, rename, Saved, and errors. */
        const val MAX_QUEUED_CLIENT_SENDS = 4
    }
}

private fun wireCodeToReason(code: RosterWireErrorCode): RosterStalenessReason = when (code) {
    RosterWireErrorCode.UNAVAILABLE -> RosterStalenessReason.SOURCE_UNAVAILABLE
    RosterWireErrorCode.NOT_AUTHORIZED -> RosterStalenessReason.AUTHORIZATION_REFUSED
    RosterWireErrorCode.RUN_CHANGED -> RosterStalenessReason.RUN_CHANGED
    RosterWireErrorCode.BAD_FRAME, RosterWireErrorCode.PROTOCOL_VIOLATION -> RosterStalenessReason.PROTOCOL_VIOLATION
    else -> RosterStalenessReason.TRANSFER_FAILED
}
