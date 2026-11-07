package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEffect
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEndpoint
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEvent
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientMessage
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientPhase
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientState
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientStep
import io.github.rfairburn.pireviewgate.core.client.roster.RosterCloseCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterCreateCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterDeadlineToken
import io.github.rfairburn.pireviewgate.core.client.roster.RosterDispatchDecision
import io.github.rfairburn.pireviewgate.core.client.roster.RosterNotSentReason
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOperationKind
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRenameCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedDeleteCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedListCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedPickerScope
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedResumeCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedSearchCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedWindowCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSendDisposition
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSendRefusal
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSubscriptionRefusal
import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterProtocol
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import io.github.rfairburn.pireviewgate.core.transport.PeerSendReceipt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One host's APP lane: the only consumer of that host's APP channel, the only owner
 * of that host's [RosterClientEndpoint], and the only thing that arms or cancels that
 * endpoint's deadlines.
 *
 * Three cooperating parts, each with exactly one job:
 *
 *  - one reader coroutine consumes the channel's inbound stream exactly once and
 *    forwards whole messages to the driver. It reaches its `receive()` call before
 *    the endpoint is started, so a prompt acknowledgement is consumed rather than
 *    missed, and no second consumer can exist for this channel;
 *  - one driver coroutine is the only place inbound frames, deadline expiries, and
 *    send dispositions enter the endpoint, so one lane's wire order stays the
 *    endpoint's own emission order;
 *  - one writer coroutine owns nothing but the write: it re-runs the endpoint's
 *    last-instant dispatch decision immediately before entering the transport,
 *    encodes, and hands the durable outcome back to the driver. It never decodes,
 *    never publishes, and never decides on its own.
 *
 * Typed operations are handed to the driver, which is the only thing that enters the
 * endpoint and the only thing that publishes what an entry point produced. That is what
 * keeps an endpoint transition and the deadlines it armed in the same order the endpoint
 * applied them: a preempted older call can never mirror away a deadline a newer
 * transition installed. The caller still receives the exact step its own call returned,
 * so it maps its own admission without observing someone else's transition — and the
 * caller's UI-proof epoch is still frozen at the moment of intent, on the calling
 * thread, before anything is queued. The lane never re-authorizes a proof that has since
 * refused, and never manufactures one.
 *
 * What the lane never does: reconnect, retry, replay, heartbeat, buffer an offline
 * request, close the channel it was handed (the registry owns connections), or ask any
 * owner session to stop.
 */
internal class RosterHostLane(
    private val laneScope: CoroutineScope,
    private val binding: HostChannelBinding,
    private val config: ClientRuntimeConfig,
    private val clock: MonotonicClock,
    private val scheduler: DeadlineScheduler,
    private val emit: suspend (ClientRuntimeEvent) -> Unit,
    private val onStateChanged: () -> Unit,
    private val onFinished: () -> Unit,
) {

    private val hostId = binding.hostId
    private val generation = binding.connectionGeneration

    private val endpoint = RosterClientEndpoint(
        hostId = hostId.value,
        generation = generation,
        bounds = config.rosterBounds,
        offeredCapabilities = config.rosterCapabilities,
        clock = { clock.nowNanos() / 1_000_000L },
        idFactory = config.idFactory,
    )

    private val signals = Channel<RosterSignal>(config.laneSignalQueueCapacity)
    private val outbound = Channel<RosterClientMessage>(config.laneOutboundQueueCapacity)

    /**
     * False only once this lane is abandoned. It is deliberately not tied to
     * retirement: a lane that asked to stop must still be able to dispatch its own
     * bounded unsubscribe while the channel it was handed still lives.
     */
    private val live = AtomicBoolean(true)

    private val timers = ConcurrentHashMap<RosterDeadlineToken, DeadlineHandle>()
    private val readerInstalled = CompletableDeferred<Unit>()

    @Volatile
    var phase: HostLanePhase = HostLanePhase.ATTACHED
        private set

    private val writer: Job = laneScope.launch { writerLoop() }
    private val driver: Job = laneScope.launch { driverLoop() }

    /** The endpoint's immutable current state. Cheap, and never a live view. */
    fun state(): RosterClientState = endpoint.state()

    // ------------------------------------------------------------- operations

    suspend fun subscribe(): RosterSubscriptionAdmission {
        val step = request { it.subscribe() }
            ?: return RosterSubscriptionAdmission.NotReached(RuntimeIntake.HOST_DETACHED)
        return subscriptionAdmissionOf(step)
    }

    suspend fun resync(): RosterSubscriptionAdmission {
        val step = request { it.resync() }
            ?: return RosterSubscriptionAdmission.NotReached(RuntimeIntake.HOST_DETACHED)
        return subscriptionAdmissionOf(step)
    }

    suspend fun stopSubscription(): RosterSubscriptionAdmission {
        request { it.stop() }
            ?: return RosterSubscriptionAdmission.NotReached(RuntimeIntake.HOST_DETACHED)
        return RosterSubscriptionAdmission.Stopped
    }

    suspend fun closeSession(command: RosterCloseCommand): RosterOperationAdmission =
        submit(RosterOperationKind.CLOSE) { it.closeSession(command) }

    suspend fun createSession(command: RosterCreateCommand): RosterOperationAdmission =
        submit(RosterOperationKind.CREATE) { it.createSession(command) }

    suspend fun renameSession(command: RosterRenameCommand): RosterOperationAdmission =
        submit(RosterOperationKind.RENAME) { it.renameSession(command) }

    suspend fun savedList(command: RosterSavedListCommand): RosterOperationAdmission =
        submit(RosterOperationKind.SAVED_LIST) { it.savedList(command) }

    suspend fun savedSearch(command: RosterSavedSearchCommand): RosterOperationAdmission =
        submit(RosterOperationKind.SAVED_SEARCH) { it.savedSearch(command) }

    suspend fun savedWindow(command: RosterSavedWindowCommand): RosterOperationAdmission =
        submit(RosterOperationKind.SAVED_WINDOW) { it.savedWindow(command) }

    suspend fun savedResume(command: RosterSavedResumeCommand): RosterOperationAdmission =
        submit(RosterOperationKind.SAVED_RESUME) { it.savedResume(command) }

    suspend fun savedDeletePrepare(command: RosterSavedDeleteCommand): RosterOperationAdmission =
        submit(RosterOperationKind.SAVED_DELETE) { it.savedDeletePrepare(command) }

    /**
     * A confirmed Saved delete carries the caller's own fresh receipt. The lane
     * forwards that object unchanged: it never substitutes a standing proof for a
     * confirmation it was not given.
     */
    suspend fun savedDeleteConfirmed(
        command: RosterSavedDeleteCommand,
        confirmation: RosterUiProof,
    ): RosterOperationAdmission = submit(RosterOperationKind.SAVED_DELETE) {
        it.savedDeleteConfirmed(command, confirmation)
    }

    /**
     * Withdraw the Saved picker's handle ownership. Not an operation, so it reports
     * only whether it reached the endpoint.
     */
    suspend fun dismissSavedPicker(scope: RosterSavedPickerScope? = null): RuntimeIntake? =
        if (request { it.dismissSavedPicker(scope) } != null) null else RuntimeIntake.HOST_DETACHED

    private suspend fun submit(
        kind: RosterOperationKind,
        action: (RosterClientEndpoint) -> RosterClientStep,
    ): RosterOperationAdmission {
        val step = request(action)
            ?: return RosterOperationAdmission.NotReached(kind, RuntimeIntake.HOST_DETACHED)
        return operationAdmissionOf(kind, step)
    }

    /**
     * One endpoint call, applied and published by the driver in request order.
     *
     * The action is a pure synchronous endpoint entry point that runs no caller code, so
     * executing it inside the driver neither blocks the lane nor holds a monitor across
     * anything external. The reply carries the step, which the driver has already applied
     * and published before the caller resumes.
     */
    private suspend fun request(
        action: (RosterClientEndpoint) -> RosterClientStep,
    ): RosterClientStep? {
        if (phase != HostLanePhase.ATTACHED) return null
        val reply = CompletableDeferred<RosterClientStep?>()
        val delivered = try {
            // Delivery is raced against the driver's own completion: a queue the driver
            // will never drain again must not park a caller here forever.
            select<Boolean> {
                driver.onJoin { false }
                signals.onSend(RosterSignal.Request(action, reply)) { channel -> !channel.isClosedForSend }
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (ignored: Throwable) {
            false
        }
        if (!delivered) return null
        // The reply is awaited against the same completion, so a call queued just before
        // the driver broke out — behind a channel-end notice, for instance — finishes with
        // an honest "never reached" instead of hanging on a deferred nobody will complete.
        return select {
            reply.onAwait { it }
            driver.onJoin { null }
        }
    }
    // ------------------------------------------------------------- lifecycle

    /**
     * Retire this lane honestly and within a bound: ask the endpoint to retire its
     * subscription, let its controls drain while the channel it was handed still
     * lives, then cancel only this lane's own jobs. No owner session is ever asked to
     * stop, and no job outlives the call.
     */
    suspend fun shutdown() {
        phase = if (phase == HostLanePhase.ATTACHED) HostLanePhase.RETIRING else phase
        signals.trySend(RosterSignal.Retire)
        try {
            withTimeout(config.retirementGraceMs) { driver.join() }
        } catch (expired: kotlinx.coroutines.TimeoutCancellationException) {
            // The grace expired. Cancelling below is the honest bound; nothing replays.
        }
        live.set(false)
        cancelAllTimers()
        writer.cancel()
        driver.cancel()
        phase = HostLanePhase.DETACHED
    }

    // -------------------------------------------------------------- the loop

    private suspend fun driverLoop() {
        val reader = laneScope.launch { readLoop() }
        try {
            // The single reader has entered its receive call, so nothing the peer can
            // answer to the hello can be missed from here on.
            readerInstalled.await()
            pump(endpoint.start())
            while (true) {
                val received = signals.receiveCatching()
                if (received.isClosed) break
                when (val signal = received.getOrNull() ?: break) {
                    is RosterSignal.Inbound -> pump(endpoint.onFrame(signal.bytes))
                    RosterSignal.ChannelEnd -> {
                        pump(endpoint.onChannelClosed())
                        break
                    }

                    is RosterSignal.Deadline -> pump(endpoint.onDeadline(signal.token))
                    is RosterSignal.Settled ->
                        pump(endpoint.onSendDisposition(signal.messageId, signal.disposition))

                    RosterSignal.Retire -> pump(endpoint.stop())

                    is RosterSignal.Request -> {
                        // Applied and published here, in request order, before the caller
                        // resumes: no caller can ever pump a step out of order.
                        val step = signal.action(endpoint)
                        try {
                            pump(step)
                        } finally {
                            // The endpoint already admitted this operation. A cancellation
                            // that interrupts publication must not also erase that fact.
                            signal.reply.complete(step)
                        }
                    }
                }
                if (endpoint.state().phase == RosterClientPhase.DETACHED) break
            }
        } finally {
            reader.cancel()
            live.set(false)
            cancelAllTimers()
            writer.cancel()
            phase = HostLanePhase.DETACHED
            // The endpoint's own loss settlement is not disposable: an application
            // operation the loss made unobservable has to settle as unknown, and the
            // caller is waiting on exactly that event. Publication is bounded and never
            // dropped, so a full event queue delays this rather than silently erasing it.
            withContext(NonCancellable) {
                try {
                    if (endpoint.state().phase != RosterClientPhase.DETACHED) {
                        endpoint.onChannelClosed().events.forEach { emit(ClientRuntimeEvent.Roster(hostId, generation, it)) }
                    }
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (ignored: Throwable) {
                    // The runtime was disposed while this lane was ending.
                }
            }
            onFinished()
        }
    }

    private suspend fun readLoop() {
        while (true) {
            readerInstalled.complete(Unit)
            val bytes = try {
                binding.channel.receive()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                null
            }
            if (bytes == null) {
                signals.send(RosterSignal.ChannelEnd)
                return
            }
            signals.send(RosterSignal.Inbound(bytes))
        }
    }

    private suspend fun writerLoop() {
        for (message in outbound) dispatch(message)
    }

    /**
     * The actual-dispatch half of the two-guard rule.
     *
     * [RosterClientEndpoint.decideDispatch] is consulted again here — after this lane's
     * own lifetime and the parent's connection fence, and immediately before the
     * transport is entered — so a queued write whose request was superseded, timed out,
     * moved, or stopped cannot reach the transport, and the same decision is then carried
     * into the channel as this message's own [PeerSendGuard]: the real writer evaluates
     * it at admission and again under write ownership immediately before the socket write,
     * so a frame that expired while queued inside the channel is dropped there rather than
     * written. An encode failure and a write positively never invoked settle as never
     * dispatched; everything past the invocation boundary settles unknown, including a
     * cancellation of this coroutine.
     */
    private suspend fun dispatch(message: RosterClientMessage) {
        val messageId = message.messageId
        if (!live.get()) {
            settle(messageId, RosterSendDisposition.NotDispatched(RosterSendRefusal.NOT_READY))
            return
        }
        when (val decision = endpoint.decideDispatch(messageId)) {
            is RosterDispatchDecision.Refuse -> {
                settle(messageId, RosterSendDisposition.NotDispatched(decision.reason))
                return
            }

            RosterDispatchDecision.Allow -> Unit
        }
        val bytes = try {
            RosterProtocol.encode(message.frame, config.rosterBounds)
        } catch (failure: Throwable) {
            settle(messageId, RosterSendDisposition.NotDispatched(RosterSendRefusal.ENCODE_FAILED))
            return
        }
        val guard = CompositeSendGuard(
            listOf(
                binding.connectionGuard,
                LifetimeSendGuard(live),
                RosterMessageFence(endpoint, messageId),
            ),
        )
        val receipt = PeerSendReceipt()
        var failure: Throwable? = null
        try {
            binding.channel.send(bytes, guard, receipt)
        } catch (cancellation: CancellationException) {
            // Cancellation alone proves nothing: the durable receipt decides.
            signals.trySend(RosterSignal.Settled(messageId, dispositionOf(classifySend(receipt, null))))
            throw cancellation
        } catch (error: Throwable) {
            failure = error
        }
        settle(messageId, dispositionOf(classifySend(receipt, failure)))
    }

    private fun dispositionOf(outcome: SendOutcome): RosterSendDisposition = when (outcome) {
        SendOutcome.WRITTEN -> RosterSendDisposition.Completed
        SendOutcome.NEVER_INVOKED -> RosterSendDisposition.NotDispatched(RosterSendRefusal.NOT_READY)
        SendOutcome.UNKNOWN -> RosterSendDisposition.FailedAfterInvoke
    }

    private suspend fun settle(messageId: Long, disposition: RosterSendDisposition) {
        signals.send(RosterSignal.Settled(messageId, disposition))
    }

    // ------------------------------------------------------------- pumping

    /**
     * Apply one step: mirror its timers, queue its writes, publish its events, then
     * publish its state. A disposition reported while doing that produces another step,
     * so pumping is a queue rather than a recursion, and no step is left unpublished.
     */
    private suspend fun pump(step: RosterClientStep) {
        val queue = ArrayDeque<RosterClientStep>()
        queue.add(step)
        while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            for (effect in current.effects) {
                when (effect) {
                    is RosterClientEffect.Send -> admitSend(effect.message, queue)
                    is RosterClientEffect.ArmDeadline -> armDeadline(effect.token, effect.dueAtMs)
                    is RosterClientEffect.CancelDeadline -> cancelDeadline(effect.token)
                    RosterClientEffect.CloseChannel -> emit(
                        ClientRuntimeEvent.RosterChannelRetirementRequested(hostId, generation, PeerAppLane.APP),
                    )
                }
            }
            for (event in current.events) emit(ClientRuntimeEvent.Roster(hostId, generation, event))
            onStateChanged()
        }
    }

    private fun armDeadline(token: RosterDeadlineToken, dueAtMs: Long) {
        timers.compute(token) { _, existing ->
            existing?.cancel()
            scheduler.schedule(dueAtMs * 1_000_000L) { signal(RosterSignal.Deadline(token)) }
        }
    }

    private fun cancelDeadline(token: RosterDeadlineToken) {
        timers.remove(token)?.cancel()
    }

    private fun cancelAllTimers() {
        for (token in timers.keys.toList()) timers.remove(token)?.cancel()
    }

    /**
     * Deliver one armed expiry without ever dropping it.
     *
     * The cheap path posts into the lane's bounded signal queue. When that queue is
     * momentarily full, one short-lived coroutine carries the expiry instead: losing a
     * deadline would leave a pending operation unresolved forever, which is worse than
     * a moment of extra backpressure.
     */
    private fun signal(signal: RosterSignal) {
        if (signals.trySend(signal).isSuccess) return
        laneScope.launch { signals.send(signal) }
    }

    /**
     * The admission half of the two-guard rule: the endpoint decides before the message
     * is ever queued, and a message that cannot be queued is reported as never
     * dispatched rather than buffered without limit.
     */
    private fun admitSend(message: RosterClientMessage, queue: ArrayDeque<RosterClientStep>) {
        when (val decision = endpoint.decideDispatch(message.messageId)) {
            is RosterDispatchDecision.Refuse -> queue.add(
                endpoint.onSendDisposition(
                    message.messageId,
                    RosterSendDisposition.NotDispatched(decision.reason),
                ),
            )

            RosterDispatchDecision.Allow -> {
                if (outbound.trySend(message).isSuccess) return
                queue.add(
                    endpoint.onSendDisposition(
                        message.messageId,
                        RosterSendDisposition.NotDispatched(RosterSendRefusal.NOT_READY),
                    ),
                )
            }
        }
    }
}

/** One inbound signal for a lane's driver, in the order it arrived. */
internal sealed interface RosterSignal {
    data class Inbound(val bytes: ByteArray) : RosterSignal
    data class Deadline(val token: RosterDeadlineToken) : RosterSignal
    data class Settled(val messageId: Long, val disposition: RosterSendDisposition) : RosterSignal

    /**
     * One caller's endpoint call, applied and published by the driver. The action is a
     * pure synchronous endpoint entry point; the reply carries the step, so the caller
     * maps its own admission from the very step the driver applied.
     */
    data class Request(
        val action: (RosterClientEndpoint) -> RosterClientStep,
        val reply: CompletableDeferred<RosterClientStep?>,
    ) : RosterSignal

    data object ChannelEnd : RosterSignal
    data object Retire : RosterSignal
}

private fun operationAdmissionOf(kind: RosterOperationKind, step: RosterClientStep): RosterOperationAdmission {
    for (event in step.events) {
        when (event) {
            is RosterClientEvent.OperationAccepted -> if (event.kind == kind) {
                // Captured from this same step, never from a later observation: the
                // adapter needs the exact sequence and owner facts this acceptance owned,
                // and a settlement in this same step is honestly reported by its absence.
                val pending = step.state.pending.firstOrNull {
                    it.kind == kind && it.requestId == event.requestId
                }
                return RosterOperationAdmission.Accepted(kind, event.requestId, pending)
            }

            is RosterClientEvent.OperationRefused -> if (event.kind == kind) {
                return RosterOperationAdmission.Refused(kind, event.reason)
            }

            else -> Unit
        }
    }
    return RosterOperationAdmission.Refused(kind, RosterNotSentReason.NOT_READY)
}

private fun subscriptionAdmissionOf(step: RosterClientStep): RosterSubscriptionAdmission {
    for (event in step.events) {
        when (event) {
            is RosterClientEvent.SubscriptionStarted -> return RosterSubscriptionAdmission.Started(event.subscriptionId)
            is RosterClientEvent.SubscriptionRefused -> return RosterSubscriptionAdmission.Refused(event.reason)
            is RosterClientEvent.RetirementRequested ->
                return RosterSubscriptionAdmission.RetirementRequested(event.subscriptionId)

            is RosterClientEvent.RetirementJoined ->
                return RosterSubscriptionAdmission.RetirementJoined(event.subscriptionId)

            else -> Unit
        }
    }
    return RosterSubscriptionAdmission.Refused(RosterSubscriptionRefusal.NOT_READY)
}
