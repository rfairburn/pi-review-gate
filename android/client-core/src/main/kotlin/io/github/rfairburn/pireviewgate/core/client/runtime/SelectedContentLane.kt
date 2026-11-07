package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.content.ContentDeadline
import io.github.rfairburn.pireviewgate.core.client.content.ContentDeadlineKind
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpoint
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointConfig
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointEvent
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointObservation
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointPhase
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointStep
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputAdmission
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputRequest
import io.github.rfairburn.pireviewgate.core.client.content.ContentNativeInputTarget
import io.github.rfairburn.pireviewgate.core.client.content.ContentNotSentReason
import io.github.rfairburn.pireviewgate.core.client.content.ContentSendEffect
import io.github.rfairburn.pireviewgate.core.client.content.ContentSendGuard
import io.github.rfairburn.pireviewgate.core.client.content.ContentSendOutcome
import io.github.rfairburn.pireviewgate.core.client.content.ContentSendPhase
import io.github.rfairburn.pireviewgate.core.client.content.ContentWrittenFrameOutcome
import io.github.rfairburn.pireviewgate.core.client.content.ContentWrittenFrameProof
import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel
import io.github.rfairburn.pireviewgate.core.transport.PeerSendGuard
import io.github.rfairburn.pireviewgate.core.transport.PeerSendReceipt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * The per-selection authority over native input and copy.
 *
 * It is deliberately narrow and atomic: the runtime flips it synchronously on the
 * calling thread the moment a selection is switched, withdrawn, or covered, so input
 * admission dies before any asynchronous teardown starts, while the content endpoint's
 * own per-message guards stay free to retire the stream honestly. Nothing here is a
 * proof: it can only refuse, never authorize.
 */
internal class ContentSelectionGate(val selectionGeneration: Long) {

    private val inputOpen = AtomicBoolean(true)

    /**
     * Bumped by anything that ends the lifetime a copy or input proof was captured under.
     *
     * A copy offered before a withdrawal, a coverage loss, or a preference change carries
     * the epoch it was offered under, and a claim under any other epoch is refused even if
     * the view looks identical afterwards.
     */
    private val proofCounter = AtomicLong(0L)

    val proofEpoch: Long get() = proofCounter.get()

    /**
     * True until this selection commits a frame the caller actually drew.
     *
     * It is set again whenever terminal coverage is lost, so a preference or coverage
     * return needs a fresh real commit rather than reviving a receipt drawn before the
     * interruption — even if the pixels are byte-identical.
     */
    @Volatile
    var requiresFreshCommit: Boolean = true
        private set

    fun withdrawInput() {
        proofCounter.incrementAndGet()
        inputOpen.set(false)
    }

    val inputOpenForSelection: Boolean get() = inputOpen.get()

    fun demandFreshCommit() {
        proofCounter.incrementAndGet()
        requiresFreshCommit = true
    }

    fun noteFreshCommit() {
        requiresFreshCommit = false
    }
}

/**
 * The runtime of the ONE currently wanted CONTENT stream.
 *
 * One reader coroutine consumes the channel it was given exactly once; one driver
 * coroutine is the only thing that enters the endpoint *and* the only thing that
 * publishes what an entry point produced; one writer coroutine owns nothing but the
 * write. Nothing else calls the endpoint, and nothing else emits.
 *
 * That single-owner rule is what makes the ordering guarantees hold. A caller that
 * resizes, changes the input preference, submits input, or asks to stop hands the
 * request to the driver and waits, so an endpoint transition and the deadlines it armed
 * are mirrored in the same order the endpoint applied them: a preempted older call can
 * never mirror away a deadline a newer transition installed and strand a stream in
 * STOPPING.
 *
 * The endpoint's per-message [ContentSendGuard] is consumed when the effect is queued
 * and again immediately before the transport is entered, and each guard is honoured for
 * its own lifetime only: an ended input never invalidates a hello, subscribe, resize,
 * unsubscribe, or protocol refusal, which is what lets a withdrawn selection still
 * retire its own stream within a bound.
 *
 * Input and copy carry the additional fences the endpoint cannot observe — this
 * selection still being the live one, the app being foreground, the terminal pane being
 * uncovered, and a frame the caller actually committed existing under the current
 * fences. They are composed with the caller's own dynamic proof at admission and again
 * at dispatch, and they are never applied to control traffic.
 *
 * A new selection is a new lane with a new endpoint: it never inherits the previous
 * stream's published frame, written receipt, resize epoch, or input lifetime.
 */
internal class SelectedContentLane(
    private val laneScope: CoroutineScope,
    private val hostId: HostId,
    private val channel: PeerByteChannel,
    private val connectionGuard: PeerSendGuard,
    endpointConfig: ContentEndpointConfig,
    private val selectionGeneration: Long,
    private val gate: ContentSelectionGate,
    private val visibility: java.util.concurrent.atomic.AtomicReference<VisibilitySnapshot>,
    private val config: ClientRuntimeConfig,
    private val clock: MonotonicClock,
    private val scheduler: DeadlineScheduler,
    private val emit: suspend (ClientRuntimeEvent) -> Unit,
    private val onStateChanged: () -> Unit,
) {

    private val endpoint = ContentEndpoint(endpointConfig)
    private val signals = Channel<ContentSignal>(config.laneSignalQueueCapacity)
    private val outbound = Channel<ContentOutbound>(config.laneOutboundQueueCapacity)

    /** False once this lane is abandoned; retirement controls ignore nothing else. */
    private val live = AtomicBoolean(true)

    private val timers = ConcurrentHashMap<ContentDeadlineKind, ArmedDeadline>()

    /** effectId → the durable receipt of that write, so loss can be settled truthfully. */
    private val outstanding = ConcurrentHashMap<Long, OutstandingWrite>()

    /** inputId → the writes of one logical input that may still cross invocation. */
    private val flights = ConcurrentHashMap<String, InputFlight>()

    private val readerInstalled = CompletableDeferred<Unit>()
    private val reconciled = AtomicBoolean(false)

    @Volatile
    private var writer: Job? = null

    @Volatile
    private var driver: Job? = null

    /** True only while [finalize] is reconciling on its own thread. */
    @Volatile
    private var reconciling = false

    /** True once [finalize] owns the closing of this lane's channel. */
    @Volatile
    private var closing = false

    @Volatile
    var phase: ContentLanePhase = ContentLanePhase.LIVE
        private set

    /**
     * Start consuming. The caller installs this lane's ownership first, so a lane that
     * was already superseded never opens a subscription or leaves a reader behind.
     */
    fun start() {
        if (writer != null || driver != null) return
        writer = laneScope.launch { writerLoop() }
        driver = laneScope.launch { driverLoop() }
    }

    fun observation(): ContentEndpointObservation = endpoint.observe()

    /**
     * How many logical inputs still have write tracking outstanding.
     *
     * Read-only and internal: it exists so a suite can prove tracking does not accumulate
     * for the life of the lane after an operation settles with pages still queued.
     */
    fun trackedInputFlights(): Int = flights.size

    fun nativeInputTarget(): ContentNativeInputTarget? = endpoint.readNativeInputTarget()

    /** Await this lane's driver, for the caller that owns its scope cleanup. */
    suspend fun awaitDriver() {
        driver?.join()
    }

    // ------------------------------------------------------------- operations

    /**
     * Register the caller's commit of one exact published frame.
     *
     * The outcome is the endpoint's own, unchanged. A registration is the only thing
     * that can clear the fresh-commit requirement, and this lane never records a commit
     * it was not given.
     *
     * This is the one entry point taken on the calling thread: it produces no step, so
     * it arms nothing, cancels nothing, and cannot settle an outstanding input — there
     * is no ordering for it to disturb and no evidence it could consume.
     */
    fun recordWrittenFrame(proof: ContentWrittenFrameProof): ContentWrittenFrameOutcome {
        val outcome = endpoint.recordWrittenFrame(proof)
        if (outcome is ContentWrittenFrameOutcome.Registered) gate.noteFreshCommit()
        return outcome
    }

    /**
     * Admit one logical native input against this endpoint's current publication.
     *
     * The authorization is composed on the driver, in request order: the caller's own
     * dynamic proof is consulted first, and anything less than a true answer from it —
     * or a closed gate, a backgrounded app, a covered terminal, or a pending fresh
     * commit — admits nothing. This lane never turns a refused proof into a permission.
     *
     * Every page of the admitted operation is queued as one unit, so a paste's pages can
     * never interleave another input's pages, and a queue that cannot take the whole
     * operation reports every page as never invoked rather than starting half an input.
     */
    suspend fun submitInput(request: ContentInputRequest, proof: RosterUiProof): ContentInputAdmission {
        if (phase != ContentLanePhase.LIVE) return ContentInputAdmission.Refused(ContentNotSentReason.STOPPED)
        val owner = driver ?: return ContentInputAdmission.Refused(ContentNotSentReason.STOPPED)
        val reply = CompletableDeferred<ContentInputAdmission>()
        if (!deliver(ContentSignal.Submit(request, proof, reply))) {
            return ContentInputAdmission.Refused(ContentNotSentReason.STOPPED)
        }
        // Raced against the driver's completion: a request that reaches a driver about to
        // break out — behind a channel-end notice, say — finishes instead of parking here.
        return select {
            reply.onAwait { it }
            owner.onJoin { ContentInputAdmission.Refused(ContentNotSentReason.STOPPED) }
        }
    }

    suspend fun resize(cols: Int, rows: Int) {
        if (phase != ContentLanePhase.LIVE) return
        request { endpoint.resize(cols, rows, clock.nowNanos()) }
    }

    suspend fun updateInputPolicy(next: ContentInputPolicy) {
        if (phase != ContentLanePhase.LIVE) return
        // A preference change is a writer boundary: the next input needs a fresh commit.
        gate.demandFreshCommit()
        request { endpoint.updateInputPolicy(next) }
    }

    /** Synchronous input admission death for this selection, before any async teardown. */
    fun withdrawInput() {
        gate.withdrawInput()
    }

    /** Ask this stream to retire within its own bound. Never an owner session stop. */
    suspend fun stop() {
        if (phase != ContentLanePhase.LIVE) return
        request { endpoint.stop(clock.nowNanos()) }
    }

    /**
     * End this lane now, within a bound, and abandon nothing it accepted.
     *
     * The fence goes first, so no further write can be entered. Then the lane's own jobs
     * are cancelled and joined, and this thread performs the reconciliation the driver can
     * no longer perform: every crossed invocation boundary becomes model evidence, the
     * model is told the stream is gone, and whatever the model could not settle truthfully
     * on its own gets a terminal outcome from the durable receipts. Only then is the
     * channel this runtime opened closed.
     *
     * Publication is suspending and the event queue is bounded, so a caller that stopped
     * collecting can hold this open: settlements are never dropped to avoid waiting.
     */
    suspend fun finalize() {
        if (!reconciled.compareAndSet(false, true)) return
        live.set(false)
        phase = ContentLanePhase.CLOSED
        closing = true
        cancelAllTimers()
        signals.close()
        writer?.cancel()
        val ending = driver
        ending?.cancel()
        withContext(NonCancellable) {
            ending?.join()
            reconciling = true
            try {
                reconcile()
            } finally {
                reconciling = false
                try {
                    channel.close()
                } catch (ignored: Throwable) {
                    // Already ending.
                }
                // Nothing of a finalized lane survives: its own scope is ended with it.
                laneScope.cancel()
            }
        }
    }

    /**
     * One endpoint call, applied and published by the driver in request order.
     *
     * The action runs inside the driver, so it never races another transition; the reply
     * hands the caller the step it produced so the caller can read its own admission.
     */
    private suspend fun request(action: () -> ContentEndpointStep): ContentEndpointStep? {
        val owner = driver ?: return null
        val reply = CompletableDeferred<ContentEndpointStep>()
        if (!deliver(ContentSignal.Call(action, reply))) return null
        return select {
            reply.onAwait { it }
            owner.onJoin { null }
        }
    }

    /** True when the driver took this request. A closed queue means the lane is ending. */
    private suspend fun deliver(request: ContentSignal): Boolean = try {
        val owner = driver
        if (owner == null) {
            false
        } else {
            // A queue the driver will never drain again is refused, not waited on.
            select {
                owner.onJoin { false }
                signals.onSend(request) { channel -> !channel.isClosedForSend }
            }
        }
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (ignored: Throwable) {
        false
    }

    // -------------------------------------------------------------- the loop

    private suspend fun driverLoop() {
        val reader = laneScope.launch { readLoop() }
        try {
            readerInstalled.await()
            pump(endpoint.start(clock.nowNanos()))
            while (true) {
                val received = signals.receiveCatching()
                if (received.isClosed) break
                // Before this signal can change the model, make every crossed invocation
                // boundary visible to it. An inbound frame, a deadline, a stop, or a
                // preference change can all settle an outstanding input, and the endpoint
                // can only settle an invoked input as unknown — but only if it was told.
                for (step in flushInvokedEvidence()) pump(step)
                val incoming = received.getOrNull() ?: break
                val replies = listOfNotNull(
                    (incoming as? ContentSignal.Call)?.reply,
                    (incoming as? ContentSignal.Submit)?.reply,
                )
                try {
                    when (incoming) {
                        is ContentSignal.Inbound -> pump(endpoint.onBytes(incoming.bytes, clock.nowNanos()))
                        ContentSignal.ChannelEnd -> {
                            pump(endpoint.onChannelLost(clock.nowNanos()))
                            break
                        }

                        is ContentSignal.Deadline -> pump(endpoint.onDeadline(incoming.kind, clock.nowNanos()))
                        ContentSignal.WritesDrained -> Unit
                        is ContentSignal.Step -> pump(incoming.step)
                        is ContentSignal.Phase -> {
                            outstanding.remove(incoming.effectId)
                            pump(endpoint.reportSend(incoming.effectId, incoming.phase, clock.nowNanos()))
                        }

                        is ContentSignal.Call -> {
                            // The step is applied and published before the caller resumes,
                            // so a caller acting on its own admission cannot overtake the
                            // deadlines that admission armed.
                            val step = incoming.action()
                            try {
                                pump(step)
                            } finally {
                                // The transition already happened. Interrupted publication
                                // must not report it as never attempted.
                                incoming.reply.complete(step)
                            }
                        }

                        is ContentSignal.Submit -> {
                            val admission = endpoint.submitInput(
                                incoming.request,
                                gateAllowsInput() && incoming.proof.isStillCurrent(),
                                clock.nowNanos(),
                            )
                            try {
                                if (admission is ContentInputAdmission.Accepted) {
                                    // The flight exists before any page does, so a settlement
                                    // that races the writer still finds the operation it
                                    // belongs to.
                                    flights.computeIfAbsent(admission.inputId) { InputFlight() }
                                    val pages = admission.effects.map { ContentOutbound.Item(it, incoming.proof) }
                                    if (!outbound.trySend(ContentOutbound(pages)).isSuccess) {
                                        // Nothing was invoked, so DROPPED is truthful for
                                        // every page.
                                        pages.forEach {
                                            signal(ContentSignal.Phase(it.effect.effectId, ContentSendPhase.DROPPED))
                                        }
                                    }
                                }
                            } finally {
                                incoming.reply.complete(admission)
                            }
                        }
                    }
                    // A write that finished while this turn ran may have made a held
                    // settlement honest. Releasing here keeps publication in driver order.
                    drainHeldSettlements()
                } catch (cancellation: CancellationException) {
                    replies.forEach { it.completeExceptionally(cancellation) }
                    throw cancellation
                }
                if (endpoint.observe().phase == ContentEndpointPhase.RETIRED) break
            }
        } finally {
            reader.cancel()
            live.set(false)
            cancelAllTimers()
            writer?.cancel()
            phase = ContentLanePhase.CLOSED
            // Ordinary termination reconciles too. The channel this runtime opened is
            // ending for any reason — a peer close, a retirement, a cancellation — and an
            // input this lane accepted must not be abandoned mid-settlement because nobody
            // happened to call `finalize`. The writer is joined first so its durable
            // evidence is stable before the last settlements are chosen.
            withContext(NonCancellable) {
                writer?.join()
                if (!closing) {
                    reconciling = true
                    try {
                        reconcile()
                    } finally {
                        reconciling = false
                        // This runtime opened the channel, so this runtime ends it, within
                        // the transport's own bound, even when the lane was cancelled.
                        try {
                            channel.close()
                        } catch (ignored: Throwable) {
                            // Already ending.
                        }
                    }
                }
            }
        }
    }

    private suspend fun readLoop() {
        while (true) {
            readerInstalled.complete(Unit)
            val bytes = try {
                channel.receive()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                null
            }
            if (bytes == null) {
                signals.send(ContentSignal.ChannelEnd)
                return
            }
            signals.send(ContentSignal.Inbound(bytes))
        }
    }

    private suspend fun writerLoop() {
        for (batch in outbound) {
            // One logical operation's pages are written back to back, and no other
            // input's pages can enter between them.
            for (item in batch.items) dispatch(item)
        }
    }

    private suspend fun dispatch(item: ContentOutbound.Item) {
        val guard = item.effect.guard
        val flight = (guard as? ContentSendGuard.Input)?.let { input ->
            // Admission already registered this flight. Its absence means the operation
            // settled: a settled record is never recreated, or the rejected phases of the
            // pages still queued behind it would leave a tracking record with no terminal
            // event left to remove it.
            flights[input.inputId]
        }
        flight?.inFlight?.incrementAndGet()
        try {
            dispatchTracked(item, flight)
        } finally {
            // Released on every exit, and the driver is given a turn to normalize anything
            // this page's evidence just made honest.
            flight?.leave()
            signal(ContentSignal.WritesDrained)
        }
    }

    private suspend fun dispatchTracked(item: ContentOutbound.Item, flight: InputFlight?) {
        val effect = item.effect
        val effectId = effect.effectId
        val guard = effect.guard
        if (!live.get()) {
            signal(ContentSignal.Phase(effectId, ContentSendPhase.DROPPED))
            return
        }
        // The endpoint's own per-message guard, consumed again at dispatch: each guard
        // speaks only for its own lifetime, so control traffic is never collateral.
        if (!endpoint.isSendGuardCurrent(guard)) {
            signal(ContentSignal.Phase(effectId, ContentSendPhase.DROPPED))
            return
        }
        // The additional fences apply to input pages only.
        if (guard is ContentSendGuard.Input && !gateAllowsInput()) {
            signal(ContentSignal.Phase(effectId, ContentSendPhase.DROPPED))
            return
        }
        // The caller's proof is re-run on the exact object admitted for this operation.
        if (item.proof != null && !item.proof.isStillCurrent()) {
            signal(ContentSignal.Phase(effectId, ContentSendPhase.DROPPED))
            return
        }
        val bytes = try {
            ContentProtocol.encode(effect.frame, config.contentBounds)
        } catch (failure: Throwable) {
            signal(ContentSignal.Phase(effectId, ContentSendPhase.DROPPED))
            return
        }
        // The endpoint's own per-message guard, plus the input-only fences, travel into the
        // channel as this message's guard: the real writer re-evaluates them at admission
        // and again under write ownership immediately before the socket write, so a page
        // whose selection, app state, pane coverage, fresh-commit demand, or caller proof
        // expired while it was queued never becomes bytes. Control effects carry only
        // their own guard, so retiring input never invalidates them.
        val inputOnly = if (guard is ContentSendGuard.Input) {
            val proof = item.proof
            ({ gateAllowsInput() && (proof == null || proof.isStillCurrent()) })
        } else {
            null
        }
        val composite = CompositeSendGuard(
            listOf(
                connectionGuard,
                LifetimeSendGuard(live),
                ContentMessageFence(endpoint, guard, inputOnly),
            ),
        )
        val receipt = PeerSendReceipt(
            onInvoked = {
                // Cheap, non-blocking, and on the transport's writer thread. This is the
                // evidence boundary: the durable receipt records the crossing, this lane's
                // flight records it, and the model is told right here, so a transition on
                // another thread cannot settle this input as never sent afterwards.
                flight?.invoked = true
                reportInvoked(effectId)
            },
        )
        outstanding.putIfAbsent(effectId, OutstandingWrite(receipt, flight))
        var failure: Throwable? = null
        try {
            channel.send(bytes, composite, receipt)
        } catch (cancellation: CancellationException) {
            settleWrite(effectId, receipt, null)
            throw cancellation
        } catch (error: Throwable) {
            failure = error
        }
        settleWrite(effectId, receipt, failure)
    }

    /** Report INVOKED first whenever evidence says the write was entered, then the end. */
    private fun settleWrite(effectId: Long, receipt: PeerSendReceipt, failure: Throwable?) {
        val tracked = outstanding[effectId]
        val outcome = classifySend(receipt, failure)
        // Any outcome that cannot exclude a write marks this input's flight invoked: the
        // durable receipt first, then the classification that covers a transport which
        // reported nothing usable.
        if (receipt.wasInvoked || outcome == SendOutcome.UNKNOWN || outcome == SendOutcome.WRITTEN) {
            tracked?.flight?.markInvoked()
        }
        when (outcome) {
            SendOutcome.WRITTEN -> {
                signal(ContentSignal.Phase(effectId, ContentSendPhase.INVOKED))
                signal(ContentSignal.Phase(effectId, ContentSendPhase.COMPLETED))
            }

            SendOutcome.NEVER_INVOKED -> signal(ContentSignal.Phase(effectId, ContentSendPhase.DROPPED))
            SendOutcome.UNKNOWN -> {
                signal(ContentSignal.Phase(effectId, ContentSendPhase.INVOKED))
                signal(ContentSignal.Phase(effectId, ContentSendPhase.FAILED))
            }
        }
    }

    /**
     * Put one invocation boundary into the model, on the thread that crossed it.
     *
     * `reportSend` is a short synchronized record that runs no caller code and touches no
     * socket, so this neither blocks the transport nor holds a lock across anything
     * external. The step it returns is handed to the driver, which stays the only
     * publisher; reporting INVOKED arms and cancels no deadline, so publishing it later
     * cannot disturb a deadline a newer transition installed.
     */
    private fun reportInvoked(effectId: Long) {
        val tracked = outstanding[effectId] ?: return
        if (!tracked.invokedReported.compareAndSet(false, true)) return
        val step = endpoint.reportSend(effectId, ContentSendPhase.INVOKED, clock.nowNanos())
        if (step.effects.isNotEmpty() || step.events.isNotEmpty() || step.deadlines.isNotEmpty()) {
            signal(ContentSignal.Step(step))
        }
    }

    /**
     * Make every crossed invocation boundary visible before a settling transition.
     *
     * Without this, a write the transport had already entered but not yet returned could
     * be settled as positively never sent when the channel disappears or a preference
     * changes, which is exactly the claim the durable receipt exists to prevent. The
     * inline callback normally gets there first; this is the backstop for a callback that
     * raced the lane's own bookkeeping.
     */
    private fun flushInvokedEvidence(): List<ContentEndpointStep> {
        if (outstanding.isEmpty()) return emptyList()
        val now = clock.nowNanos()
        val steps = mutableListOf<ContentEndpointStep>()
        for (effectId in outstanding.keys.toList()) {
            val tracked = outstanding[effectId] ?: continue
            if (!tracked.receipt.wasInvoked) continue
            tracked.flight?.markInvoked()
            if (!tracked.invokedReported.compareAndSet(false, true)) continue
            val step = endpoint.reportSend(effectId, ContentSendPhase.INVOKED, now)
            if (step.effects.isNotEmpty() || step.events.isNotEmpty() || step.deadlines.isNotEmpty()) steps += step
        }
        return steps
    }

    /**
     * Settle what the model could not settle itself, then release everything held back.
     *
     * Runs only on the finalizing thread, after the driver has stopped, so this thread is
     * the lane's only publisher. Nothing is left pending: an input the model settled as
     * never sent while one of its writes was still in flight is republished with the
     * outcome the durable receipts actually support.
     */
    private suspend fun reconcile() {
        for (step in flushInvokedEvidence()) publish(step)
        publish(endpoint.onChannelLost(clock.nowNanos()))
        for (inputId in flights.keys.toList()) {
            val flight = flights.remove(inputId) ?: continue
            val held = flight.held ?: continue
            emit(if (flight.invoked) correctedToUnknown(held) else held)
        }
    }

    /**
     * Publish one step's events without holding a settlement back.
     *
     * During finalization nothing else will ever release a held event, so holding one
     * would discard it in all but name.
     */
    private suspend fun publish(step: ContentEndpointStep) {
        for (event in step.events) emitEvent(event)
        onStateChanged()
    }

    // ------------------------------------------------------------- pumping

    private suspend fun pump(step: ContentEndpointStep) {
        val queue = ArrayDeque<ContentEndpointStep>()
        queue.add(step)
        while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            // Mirrored from the endpoint's *current* complete set, never from the snapshot
            // this step carried. An evidence report taken earlier and published later must
            // never overwrite the timers a newer transition installed.
            mirrorDeadlines(endpoint.nextDeadline())
            for (effect in current.effects) admitSend(effect, queue)
            for (event in current.events) emitEvent(event)
            onStateChanged()
        }
    }

    /**
     * Publish one endpoint event, normalizing every terminal input settlement first.
     *
     * A `NotSent` is only honest when no write of that input can still cross an invocation
     * boundary and no retained evidence says one already did. While a page is inside the
     * transport the settlement is held; once the flight is quiet it is published as the
     * durable evidence supports — unknown as soon as any page was invoked, and never sent
     * only when none was. A settled flight is then removed, so tracking does not accumulate
     * one record per input for the life of the lane.
     */
    private suspend fun emitEvent(event: ContentEndpointEvent) {
        val wrapped = ClientRuntimeEvent.Content(selectionGeneration, hostId, event)
        if (event !is ContentEndpointEvent.InputSettled) {
            emit(wrapped)
            return
        }
        val flight = flights[event.inputId]
        if (event.outcome is ContentSendOutcome.NotSent && flight != null) {
            if (!reconciling && flight.inFlight.get() > 0) {
                flight.held = wrapped
                return
            }
            flights.remove(event.inputId, flight)
            emit(if (flight.invoked) correctedToUnknown(wrapped) else wrapped)
            return
        }
        if (flight != null) flights.remove(event.inputId, flight)
        emit(wrapped)
    }

    /** Replace a held never-sent with the outcome the durable evidence supports. */
    private fun correctedToUnknown(held: ClientRuntimeEvent): ClientRuntimeEvent {
        val event = (held as ClientRuntimeEvent.Content).event as ContentEndpointEvent.InputSettled
        return ClientRuntimeEvent.Content(
            selectionGeneration,
            hostId,
            ContentEndpointEvent.InputSettled(event.inputId, event.ordinal, ContentSendOutcome.Unknown),
        )
    }

    /** Publish whatever held settlements have become honest, in driver order. */
    private suspend fun drainHeldSettlements() {
        if (flights.isEmpty()) return
        for (inputId in flights.keys.toList()) {
            val flight = flights[inputId] ?: continue
            if (flight.inFlight.get() > 0) continue
            val held = flight.held ?: continue
            flights.remove(inputId)
            emit(if (flight.invoked) correctedToUnknown(held) else held)
        }
    }

    /**
     * Queue one effect, honouring its guard at the moment of queueing.
     *
     * A stale guard is reported as DROPPED — never invoked — because silence would pin
     * the endpoint's superseded resize slot or input page until a later step. An effect
     * that can no longer be written at all is reported the same way rather than queued to
     * a writer that will never run. Control effects are queued one at a time; input pages
     * are only ever queued as a batch.
     */
    private fun admitSend(effect: ContentSendEffect, queue: ArrayDeque<ContentEndpointStep>) {
        val guard = effect.guard
        if (guard is ContentSendGuard.Input) flights.computeIfAbsent(guard.inputId) { InputFlight() }
        if (!live.get() || !endpoint.isSendGuardCurrent(guard)) {
            queue.add(endpoint.reportSend(effect.effectId, ContentSendPhase.DROPPED, clock.nowNanos()))
            return
        }
        if (outbound.trySend(ContentOutbound(listOf(ContentOutbound.Item(effect, null)))).isSuccess) return
        queue.add(endpoint.reportSend(effect.effectId, ContentSendPhase.DROPPED, clock.nowNanos()))
    }

    private fun mirrorDeadlines(deadlines: List<ContentDeadline>) {
        val wanted = HashMap<ContentDeadlineKind, Long>()
        for (deadline in deadlines) wanted[deadline.kind] = deadline.dueAtNanos
        for (kind in timers.keys.toList()) {
            if (!wanted.containsKey(kind)) timers.remove(kind)?.handle?.cancel()
        }
        for ((kind, due) in wanted) {
            timers.compute(kind) { _, existing ->
                if (existing != null && existing.dueAtNanos == due) return@compute existing
                existing?.handle?.cancel()
                ArmedDeadline(due, scheduler.schedule(due) { signal(ContentSignal.Deadline(kind)) })
            }
        }
    }

    private fun cancelAllTimers() {
        for (kind in timers.keys.toList()) timers.remove(kind)?.handle?.cancel()
    }

    private fun signal(signal: ContentSignal) {
        if (signals.trySend(signal).isSuccess) return
        laneScope.launch {
            try {
                signals.send(signal)
            } catch (cancellation: CancellationException) {
                // The lane is ending. `finalize` reconciles from the durable receipts.
            }
        }
    }

    /** The composed, non-authorizing input gate for this selection. */
    private fun gateAllowsInput(): Boolean =
        gate.inputOpenForSelection && visibility.get().allowsTerminalInput && !gate.requiresFreshCommit
}

/** Where one content lane stands. */
internal enum class ContentLanePhase { LIVE, CLOSED }

/** One inbound signal for a content lane's driver, in the order it arrived. */
internal sealed interface ContentSignal {
    data class Inbound(val bytes: ByteArray) : ContentSignal
    data class Deadline(val kind: ContentDeadlineKind) : ContentSignal
    data class Phase(val effectId: Long, val phase: ContentSendPhase) : ContentSignal

    /** A step a transport-thread evidence report produced, to be published by the driver. */
    data class Step(val step: ContentEndpointStep) : ContentSignal

    /**
     * One caller's endpoint call, applied and published by the driver before the caller
     * resumes. The action is a pure synchronous endpoint entry point.
     */
    data class Call(
        val action: () -> ContentEndpointStep,
        val reply: CompletableDeferred<ContentEndpointStep>,
    ) : ContentSignal

    /** One logical native input, admitted by the driver so its pages stay contiguous. */
    data class Submit(
        val request: ContentInputRequest,
        val proof: RosterUiProof,
        val reply: CompletableDeferred<ContentInputAdmission>,
    ) : ContentSignal

    data object ChannelEnd : ContentSignal

    /** The writer released a reservation; the driver re-checks held settlements. */
    data object WritesDrained : ContentSignal
}

/**
 * One outbound unit.
 *
 * A control effect travels alone; one admitted logical input travels as its complete
 * page run, so the writer's loop can never interleave another input's pages between
 * them and can never start half an operation.
 */
internal data class ContentOutbound(val items: List<Item>) {
    data class Item(val effect: ContentSendEffect, val proof: RosterUiProof?)
}

/** One write whose durable receipt may still owe the endpoint an INVOKED report. */
private class OutstandingWrite(val receipt: PeerSendReceipt, val flight: InputFlight?) {
    val invokedReported = AtomicBoolean(false)
}

/**
 * One logical input's writes that may still cross an invocation boundary.
 *
 * While the count is above zero, a "definitely not sent" settlement for this input is not
 * yet an honest claim: a page may be between the guard check under write ownership and the
 * invocation boundary. The count and the invoked flag come from the durable receipt, so
 * the held settlement can be resolved to the truth — never sent only when no page was ever
 * invoked, unknown as soon as one was.
 */
private class InputFlight {
    val inFlight = AtomicInteger(0)

    @Volatile
    var invoked: Boolean = false

    @Volatile
    var held: ClientRuntimeEvent.Content? = null

    fun markInvoked() {
        invoked = true
    }

    fun leave() {
        inFlight.decrementAndGet()
    }
}

private class ArmedDeadline(val dueAtNanos: Long, val handle: DeadlineHandle)
