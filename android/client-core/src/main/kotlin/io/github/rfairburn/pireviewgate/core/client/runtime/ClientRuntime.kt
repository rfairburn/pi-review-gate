package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointConfig
import io.github.rfairburn.pireviewgate.core.client.content.ContentCopyReceipt
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointEvent
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointObservation
import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointTarget
import io.github.rfairburn.pireviewgate.core.client.content.ContentIdSupplier
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputAdmission
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputRequest
import io.github.rfairburn.pireviewgate.core.client.content.ContentNativeInputTarget
import io.github.rfairburn.pireviewgate.core.client.content.ContentNativeIoOptions
import io.github.rfairburn.pireviewgate.core.client.content.ContentNotSentReason
import io.github.rfairburn.pireviewgate.core.client.content.ContentViewportRequest
import io.github.rfairburn.pireviewgate.core.client.content.ContentWrittenFrameOutcome
import io.github.rfairburn.pireviewgate.core.client.content.ContentWrittenFrameProof
import io.github.rfairburn.pireviewgate.core.client.content.ContentWrittenFrameRejectReason
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEvent
import io.github.rfairburn.pireviewgate.core.client.roster.RosterCloseCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterCreateCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOperationKind
import io.github.rfairburn.pireviewgate.core.client.roster.RosterProjection
import io.github.rfairburn.pireviewgate.core.client.roster.RosterProjectionState
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRenameCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedDeleteCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedListCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedPickerScope
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedResumeCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedSearchCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedWindowCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.content.nativeIoSourceEquals
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext
import kotlin.coroutines.ContinuationInterceptor
import kotlin.coroutines.CoroutineContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * The portable endpoint runtime: per-host APP lanes plus the one currently wanted
 * CONTENT stream, wired to transport channels the parent owns.
 *
 * It is the layer between the landed models and the Android app bridge, and it owns
 * exactly three things.
 *
 * **Consumption.** Every host APP channel is consumed by exactly one reader coroutine,
 * and every content channel by exactly one reader coroutine, on many hosts at once up
 * to [ClientRuntimeConfig.MAX_HOSTS]. Lanes never mix: an APP channel never reaches a
 * content endpoint, and a content channel never reaches a roster endpoint.
 *
 * **Dispatch discipline.** Every outbound frame passes the model's own admission
 * decision when it is queued and its guard again immediately before the transport is
 * entered, composed with the parent's connection fence and — for input pages only — the
 * caller's own dynamic proof. A write is called never-sent only when the durable
 * [io.github.rfairburn.pireviewgate.core.transport.PeerSendReceipt] proves nothing was
 * invoked, and a local write success is never reported as remote success.
 *
 * **Selection truth.** One deliberate terminal target at a time, addressed only by the
 * exact host, owner run, and owner row of a current roster snapshot, with a real caller
 * proof. Switching, leaving, host loss, a policy change, or a coverage change closes
 * input admission synchronously on the calling thread before anything asynchronous
 * starts, while the outgoing stream is still allowed to retire its own controls within
 * a bound. Other hosts' APP lanes keep running, and no path here asks an owner session
 * to stop.
 *
 * What stays the parent's: connection establishment, pairing, trust, reconnection,
 * storage, Compose, and turning a real native commit into a written-frame proof. This
 * runtime never fabricates a channel, a host, a proof, a frame, or a viewport.
 *
 * Commands take effect synchronously at intake — the model is entered on the calling
 * thread, so a proof is consulted at the moment of intent, before anything is queued —
 * and only their event publication suspends. Events go through one bounded channel and
 * are never dropped: a producer waits rather than discarding a settlement.
 */
class ClientRuntime(
    private val contentOpener: ContentChannelOpener,
    private val config: ClientRuntimeConfig = ClientRuntimeConfig(),
    private val clock: MonotonicClock = MonotonicClock.SYSTEM,
    context: CoroutineContext = Dispatchers.Default,
    deadlineScheduler: DeadlineScheduler? = null,
) {

    private val dispatcher = context[ContinuationInterceptor] ?: Dispatchers.Default
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val scheduler: DeadlineScheduler = deadlineScheduler ?: CoroutineDeadlineScheduler(scope, clock)
    private val eventChannel = Channel<ClientRuntimeEvent>(config.eventQueueCapacity)

    /** The runtime's event stream. Exactly one collector may consume it. */
    val events: ReceiveChannel<ClientRuntimeEvent> = eventChannel

    private val hosts = ConcurrentHashMap<HostId, HostEntry>()
    private val lastGeneration = ConcurrentHashMap<HostId, Long>()
    private val selection = AtomicReference<ActiveSelection?>()
    private val selectionCounter = AtomicLong(0L)
    private val viewport = MutableStateFlow<ContentViewportRequest?>(null)
    private val visibility = AtomicReference(VisibilitySnapshot(appForeground = true, terminalInputCovered = true))
    private val remembered = AtomicReference<TerminalTarget?>()
    private val storedRestoreProof = AtomicReference<RosterUiProof?>()
    private val restoreArmed = AtomicBoolean(false)
    /** The target a deliberate restoration request names, or `null` when none exists. */
    private val armedFor = AtomicReference<TerminalTarget?>()
    private val policy = AtomicReference(config.initialInputPolicy)
    private val closed = AtomicBoolean(false)

    private val stateFlow = MutableStateFlow(snapshot())

    /** The complete immutable runtime state, republished on every change. */
    val state: StateFlow<ClientRuntimeState> = stateFlow

    // ----------------------------------------------------------- host lanes

    /**
     * Install the one consumer of one host's APP channel.
     *
     * The lane is refused — with nothing written and the channel untouched — for a
     * non-APP channel, a host that already has a live lane, a generation that does not
     * follow this host's last attempt, or a full host ceiling.
     */
    // The whole admission is one transaction: a concurrent map only makes each access
    // safe, not the decision. Two callers could otherwise both see no existing lane and
    // free capacity, each construct a running consumer, and then overwrite one another —
    // double-consuming one APP channel and leaving the displaced lane outside teardown
    // ownership, or taking the host ceiling past its stated bound. This method never
    // suspends, so holding the runtime monitor here cannot strand a coroutine.
    @Synchronized
    fun attachHost(binding: HostChannelBinding): HostAttachResult {
        if (closed.get()) return refusedAttach(binding, HostAttachRefusal.CLOSED)
        if (binding.channel.lane != PeerAppLane.APP) return refusedAttach(binding, HostAttachRefusal.WRONG_LANE)
        val existing = hosts[binding.hostId]
        if (existing != null && existing.lane.phase != HostLanePhase.DETACHED) {
            return refusedAttach(binding, HostAttachRefusal.ALREADY_ATTACHED)
        }
        val previous = lastGeneration[binding.hostId]
        if (previous != null && binding.connectionGeneration <= previous) {
            return refusedAttach(binding, HostAttachRefusal.STALE_GENERATION)
        }
        if (hosts.values.count { it.lane.phase == HostLanePhase.ATTACHED } >= config.maxHosts) {
            return refusedAttach(binding, HostAttachRefusal.HOST_LIMIT)
        }
        lastGeneration[binding.hostId] = binding.connectionGeneration
        hosts[binding.hostId] = HostEntry(binding)
        publishState()
        scope.launch {
            emit(ClientRuntimeEvent.HostAttached(binding.hostId, binding.connectionGeneration))
        }
        return HostAttachResult.Accepted
    }

    /**
     * Retire one host lane within a bound and forget nothing that was observed.
     *
     * The lane's subscription retires and its controls drain while the channel it was
     * handed still lives; then its jobs are cancelled and never resurrected. The channel
     * itself stays the registry's to close, and no owner session is touched.
     */
    suspend fun detachHost(hostId: HostId, reason: HostDetachReason = HostDetachReason.PARENT_DETACHED): Boolean {
        val entry = hosts[hostId] ?: return false
        // The parent is ending this host, so nothing of it may linger: the selected
        // stream is ended now, and this call does not return while its writes, timers,
        // or unsettled inputs still exist.
        val current = selection.get()
        if (current != null && current.target.hostId == hostId && selection.compareAndSet(current, null)) {
            retireBlocking(current, force = true)
            publishState()
            emit(ClientRuntimeEvent.SelectionChanged(null))
        }
        entry.lane.shutdown()
        entry.scope.cancel()
        publishState()
        reportDetached(entry, reason)
        return true
    }

    /** The current state of one host lane, or `null` when this runtime never had it. */
    fun hostState(hostId: HostId): HostRuntimeState? = hosts[hostId]?.let {
        HostRuntimeState(it.hostId, it.binding.connectionGeneration, it.lane.phase, it.lane.state())
    }

    // ---------------------------------------------------- roster operations

    suspend fun subscribeRoster(hostId: HostId): RosterSubscriptionAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterSubscriptionAdmission.NotReached(intakeReason(hostId))
        return lane.subscribe()
    }

    /**
     * Retire the live subscription so a fresh one can start.
     *
     * The replacement subscription stays the caller's decision: this runtime never
     * re-subscribes on its own, and no blind retry or heartbeat exists anywhere here.
     */
    suspend fun resyncRoster(hostId: HostId): RosterSubscriptionAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterSubscriptionAdmission.NotReached(intakeReason(hostId))
        return lane.resync()
    }

    suspend fun stopRoster(hostId: HostId): RosterSubscriptionAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterSubscriptionAdmission.NotReached(intakeReason(hostId))
        return lane.stopSubscription()
    }

    suspend fun closeSession(hostId: HostId, command: RosterCloseCommand): RosterOperationAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterOperationAdmission.NotReached(RosterOperationKind.CLOSE, intakeReason(hostId))
        return lane.closeSession(command)
    }

    suspend fun createSession(hostId: HostId, command: RosterCreateCommand): RosterOperationAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterOperationAdmission.NotReached(RosterOperationKind.CREATE, intakeReason(hostId))
        return lane.createSession(command)
    }

    suspend fun renameSession(hostId: HostId, command: RosterRenameCommand): RosterOperationAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterOperationAdmission.NotReached(RosterOperationKind.RENAME, intakeReason(hostId))
        return lane.renameSession(command)
    }

    suspend fun savedList(hostId: HostId, command: RosterSavedListCommand): RosterOperationAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterOperationAdmission.NotReached(RosterOperationKind.SAVED_LIST, intakeReason(hostId))
        return lane.savedList(command)
    }

    suspend fun savedSearch(hostId: HostId, command: RosterSavedSearchCommand): RosterOperationAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterOperationAdmission.NotReached(RosterOperationKind.SAVED_SEARCH, intakeReason(hostId))
        return lane.savedSearch(command)
    }

    suspend fun savedWindow(hostId: HostId, command: RosterSavedWindowCommand): RosterOperationAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterOperationAdmission.NotReached(RosterOperationKind.SAVED_WINDOW, intakeReason(hostId))
        return lane.savedWindow(command)
    }

    suspend fun savedResume(hostId: HostId, command: RosterSavedResumeCommand): RosterOperationAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterOperationAdmission.NotReached(RosterOperationKind.SAVED_RESUME, intakeReason(hostId))
        return lane.savedResume(command)
    }

    suspend fun savedDeletePrepare(hostId: HostId, command: RosterSavedDeleteCommand): RosterOperationAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterOperationAdmission.NotReached(RosterOperationKind.SAVED_DELETE, intakeReason(hostId))
        return lane.savedDeletePrepare(command)
    }

    /**
     * A confirmed Saved delete, carrying the caller's fresh written confirmation.
     *
     * The confirmation object is forwarded unchanged, and the endpoint spends it once by
     * identity: nothing here re-arms or replays it.
     */
    suspend fun savedDeleteConfirmed(
        hostId: HostId,
        command: RosterSavedDeleteCommand,
        confirmation: RosterUiProof,
    ): RosterOperationAdmission {
        val lane = liveRosterLane(hostId)
            ?: return RosterOperationAdmission.NotReached(RosterOperationKind.SAVED_DELETE, intakeReason(hostId))
        return lane.savedDeleteConfirmed(command, confirmation)
    }

    /** Withdraw the Saved picker's handle ownership. Null means the endpoint processed it. */
    suspend fun dismissSavedPicker(hostId: HostId,
        scope: RosterSavedPickerScope? = null): RuntimeIntake? {
        val lane = liveRosterLane(hostId) ?: return intakeReason(hostId)
        return lane.dismissSavedPicker(scope)
    }

    private fun liveRosterLane(hostId: HostId): RosterHostLane? {
        if (closed.get()) return null
        val entry = hosts[hostId] ?: return null
        if (entry.lane.phase != HostLanePhase.ATTACHED) return null
        return entry.lane
    }

    private fun intakeReason(hostId: HostId): RuntimeIntake = when {
        closed.get() -> RuntimeIntake.CLOSED
        hosts[hostId] == null -> RuntimeIntake.HOST_NOT_ATTACHED
        else -> RuntimeIntake.HOST_DETACHED
    }

    // ------------------------------------------------------------ selection

    /**
     * Select one terminal target deliberately.
     *
     * Admission is exact and synchronous: the host must have a live lane, its roster
     * must be a current authoritative snapshot, and that snapshot must carry this exact
     * owner run and owner row. Nothing is matched by label, caption, workspace, or name,
     * and the caller's own dynamic proof must hold right now.
     *
     * Any previous selection's input admission closes on this calling thread before any
     * coroutine runs, so a keystroke cannot slip into the stream being replaced. The old
     * endpoint is then left to retire its own stream within its bound while every other
     * host's APP lane continues, and the new stream is a fresh endpoint that cannot
     * inherit the old one's pixels, receipt, or input lifetime.
     */
    fun selectTerminal(target: TerminalTarget, proof: RosterUiProof): SelectionResult {
        if (closed.get()) return SelectionResult.Refused(SelectionRefusal.CLOSED)
        val entry = hosts[target.hostId] ?: return SelectionResult.Refused(SelectionRefusal.HOST_NOT_ATTACHED)
        if (entry.lane.phase != HostLanePhase.ATTACHED) return SelectionResult.Refused(SelectionRefusal.HOST_DETACHED)
        val projection = entry.lane.state().projection
        if (projection.state != RosterProjectionState.CURRENT) {
            return SelectionResult.Refused(SelectionRefusal.ROSTER_NOT_CURRENT)
        }
        if (!projectionCarries(projection, target)) {
            return SelectionResult.Refused(SelectionRefusal.ROW_NOT_IN_CURRENT_ROSTER)
        }
        if (viewport.value == null) return SelectionResult.Refused(SelectionRefusal.NO_VIEWPORT)
        val current = selection.get()
        if (current != null && current.target == target) {
            return SelectionResult.Refused(SelectionRefusal.ALREADY_SELECTED)
        }
        if (!proof.isStillCurrent()) return SelectionResult.Refused(SelectionRefusal.PROOF_UNAVAILABLE)
        return beginSelection(target, entry)
    }

    /**
     * Withdraw the current stream.
     *
     * This is a navigation act, never a remote close: the owner's session is untouched,
     * and the remembered target survives for honest display. It does not stay armed for
     * automatic restoration — that takes a deliberate act of its own.
     */
    fun leaveTerminal(): TerminalLeaveResult {
        val current = selection.get() ?: return TerminalLeaveResult.NoSelection
        if (!selection.compareAndSet(current, null)) return TerminalLeaveResult.NoSelection
        current.withdrawNow()
        restoreArmed.set(false)
        storedRestoreProof.set(null)
        armedFor.set(null)
        publishState()
        scope.launch { emit(ClientRuntimeEvent.SelectionChanged(null)) }
        return TerminalLeaveResult.Left(current.target)
    }

    /**
     * Record that this exact target is the one the user deliberately wants back.
     *
     * Restoration then happens only when a fresh positive roster for that host carries
     * the same owner run and row, no other stream is live, the app is foreground with
     * the terminal uncovered, a real viewport measurement exists, and the caller's own
     * stored proof still answers true. A different run is never adopted, and no other
     * row is ever chosen.
     */
    fun rememberTerminalTarget(target: TerminalTarget, restoreProof: RosterUiProof): RememberTerminalResult {
        if (closed.get()) return RememberTerminalResult.Refused(SelectionRefusal.CLOSED)
        val entry = hosts[target.hostId]
            ?: return RememberTerminalResult.Refused(SelectionRefusal.HOST_NOT_ATTACHED)
        if (entry.lane.phase != HostLanePhase.ATTACHED) {
            return RememberTerminalResult.Refused(SelectionRefusal.HOST_DETACHED)
        }
        val projection = entry.lane.state().projection
        if (projection.state != RosterProjectionState.CURRENT) {
            return RememberTerminalResult.Refused(SelectionRefusal.ROSTER_NOT_CURRENT)
        }
        if (!projectionCarries(projection, target)) {
            return RememberTerminalResult.Refused(SelectionRefusal.ROW_NOT_IN_CURRENT_ROSTER)
        }
        remembered.set(target)
        armedFor.set(target)
        storedRestoreProof.set(restoreProof)
        restoreArmed.set(true)
        publishState()
        return RememberTerminalResult.Remembered(target)
    }

    // ----------------------------------------------------- viewport and view

    /**
     * Record the viewport the native layer actually measured.
     *
     * There is no default size anywhere in this runtime: until a real measurement
     * arrives, selection is refused with [SelectionRefusal.NO_VIEWPORT] and an in-flight
     * open waits for one. Once a stream is live, a new measurement becomes a resize
     * against the endpoint's own resize epoch, and the owner's reported geometry stays
     * authoritative for what is actually on screen.
     */
    fun setViewport(cols: Int, rows: Int): ViewportResult {
        if (closed.get()) return ViewportResult.Rejected(ViewportRefusal.CLOSED)
        val next = try {
            ContentViewportRequest(cols, rows)
        } catch (ignored: IllegalArgumentException) {
            return ViewportResult.Rejected(ViewportRefusal.INVALID_DIMENSIONS)
        }
        viewport.value = next
        publishState()
        selection.get()?.lane?.let { lane -> scope.launch { lane.resize(next.cols, next.rows) } }
        return ViewportResult.Applied(next.cols, next.rows)
    }

    /**
     * Report the application's own foreground state.
     *
     * Losing it closes input admission synchronously and retires the selected stream
     * within its bound, while every host APP lane keeps running and no owner session is
     * asked to stop. Regaining it never reopens a stream by itself.
     */
    fun setAppForeground(appForeground: Boolean) {
        visibility.updateAndGet { it.copy(appForeground = appForeground) }
        if (!appForeground) {
            selection.get()?.let { current ->
                if (selection.compareAndSet(current, null)) {
                    current.withdrawNow()
                    scope.launch { emit(ClientRuntimeEvent.SelectionChanged(null)) }
                }
            }
        }
        publishState()
    }

    /**
     * Report whether the terminal pane itself is visible, focused, and uncovered.
     *
     * A modal or chooser retires input and copy proofs and requires a fresh real commit
     * to return. It retires nothing else: display continues, and the content channel's
     * hello, subscribe, resize, unsubscribe, and protocol-refusal traffic remain
     * dispatchable, so a stream can still end cleanly behind a dialog.
     */
    fun setTerminalInputCoverage(covered: Boolean) {
        visibility.updateAndGet { it.copy(terminalInputCovered = covered) }
        if (!covered) selection.get()?.gate?.demandFreshCommit()
        publishState()
    }

    /**
     * Replace the live remote input and copy preference.
     *
     * Only the content lane sees this: roster traffic, other hosts, metadata, and
     * subscription controls are untouched. Every effective change must arrive with a
     * higher generation, and the next input needs a fresh commit under the new one.
     */
    suspend fun updateInputPolicy(next: ContentInputPolicy) {
        if (closed.get()) return
        policy.set(next)
        selection.get()?.lane?.updateInputPolicy(next)
        publishState()
    }

    /** Register the caller's commit of one exact published frame. Never invents one. */
    fun recordWrittenFrame(proof: ContentWrittenFrameProof): ContentWrittenFrameOutcome {
        val lane = selection.get()?.lane
            ?: return ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.STOPPED)
        val outcome = lane.recordWrittenFrame(proof)
        // A registration is exactly the fact `terminalInputAdmissionOpen` turns on, so
        // the published state must reflect it the moment the caller is told.
        publishState()
        return outcome
    }

    /**
     * Submit one logical native input against the selected stream.
     *
     * The caller's dynamic proof is consulted first and can only refuse: this runtime
     * adds its own fences (this selection still live, app foreground, terminal covered,
     * no fresh commit outstanding) and never turns a refused proof into a permission.
     */
    suspend fun submitInput(request: ContentInputRequest, proof: RosterUiProof): ContentInputAdmission {
        val lane = selection.get()?.lane ?: return ContentInputAdmission.Refused(ContentNotSentReason.STOPPED)
        return lane.submitInput(request, proof)
    }

    /** The selected stream's observation, or `null` when nothing is live. */
    fun currentContentObservation(): ContentEndpointObservation? = selection.get()?.lane?.observation()

    /** The exact native input target of the selected stream, or `null`. Descriptive only. */
    fun nativeInputTarget(): ContentNativeInputTarget? = selection.get()?.lane?.nativeInputTarget()

    /**
     * How many logical inputs still have write tracking outstanding on the live stream.
     *
     * Read-only and internal, for suites that must prove tracking does not accumulate.
     */
    internal fun trackedInputFlights(): Int = selection.get()?.lane?.trackedInputFlights() ?: 0

    // -------------------------------------------------------------- disposal

    /** Retire every lane and close the event stream. Idempotent, and bounded per lane. */
    suspend fun close() {
        // Setting the closed flag and capturing what has to be torn down happen under the
        // same monitor as host admission. Otherwise an attachment can pass its closed check,
        // install its entry after this snapshot was taken, and report Accepted for a live
        // APP consumer that no teardown owns — a host lane runs on its own SupervisorJob, so
        // cancelling the runtime scope afterwards does not stop it. Either disposal is seen
        // first and the attachment is refused, or the install is seen first and is retired.
        // Setting the closed flag and capturing what has to be torn down happen under the
        // same monitor as host admission. Otherwise an attachment can pass its closed check,
        // install its entry after this snapshot was taken, and report Accepted for a live
        // APP consumer that no teardown owns — a host lane runs on its own SupervisorJob, so
        // cancelling the runtime scope afterwards does not stop it. Either disposal is seen
        // first and the attachment is refused, or the install is seen first and is retired.
        val entries = synchronized(this) {
            if (!closed.compareAndSet(false, true)) return
            hosts.values.toList()
        }
        selection.getAndSet(null)?.let { current -> retireBlocking(current, force = true) }
        coroutineScope {
            entries.forEach { entry ->
                launch {
                    entry.lane.shutdown()
                    entry.contentLaneScope?.cancel()
                    entry.scope.cancel()
                }
            }
        }
        publishState()
        eventChannel.close()
        withContext(NonCancellable) { scope.coroutineContext[Job]?.cancel() }
    }

    /**
     * Retire a selection and wait for it, so a runtime or host that is ending leaves no
     * lane, no armed deadline, and no accepted input without a terminal outcome.
     */
    private suspend fun retireBlocking(current: ActiveSelection, force: Boolean) {
        val retiring = current.takeRetirement() ?: return
        if (force) retiring.finalize() else {
            retiring.stop()
            retiring.awaitDriver()
        }
    }

    // ------------------------------------------------------------- internals

    private fun refusedAttach(binding: HostChannelBinding, reason: HostAttachRefusal): HostAttachResult {
        scope.launch {
            emit(ClientRuntimeEvent.HostAttachRefused(binding.hostId, binding.connectionGeneration, reason))
        }
        return HostAttachResult.Refused(reason)
    }

    private fun projectionCarries(projection: RosterProjection, target: TerminalTarget): Boolean =
        projection.hostRunId == target.ownerRunId && projection.rows.any { it.id == target.rowId }

    private fun beginSelection(target: TerminalTarget, entry: HostEntry): SelectionResult {
        val generation = selectionCounter.incrementAndGet()
        val next = ActiveSelection(generation, target, entry.binding.connectionGeneration, ContentSelectionGate(generation))
        // One atomic exchange: every replacement owns withdrawal of exactly the selection
        // it displaced. Two concurrent replacements — a native selection and a
        // roster-driven restoration — can therefore never both displace the same previous
        // selection and leave the loser installed, live, and admitting input with nobody
        // left to withdraw it. The displaced selection's input gate closes on this calling
        // thread, before the replacement is published or opened.
        selection.getAndSet(next)?.withdrawNow()
        remembered.set(target)
        // Selecting is not itself a restoration request. A deliberate remember stays
        // armed only while it names this same target; choosing another target cancels it.
        if (armedFor.get() != null && armedFor.get() != target) {
            restoreArmed.set(false)
            storedRestoreProof.set(null)
            armedFor.set(null)
        }
        publishState()
        scope.launch { emit(ClientRuntimeEvent.SelectionChanged(next.snapshot())) }
        scope.launch { openContent(next, entry) }
        return SelectionResult.Selected(generation, target)
    }

    private suspend fun openContent(selection: ActiveSelection, entry: HostEntry) {
        val measured = awaitViewportOrAbort(selection)
        if (measured == null) {
            reportOpenFailure(selection, if (closed.get()) ContentOpenFailure.RUNTIME_CLOSED else ContentOpenFailure.SUPERSEDED)
            return
        }
        val channel = try {
            contentOpener.open(entry.hostId, entry.binding.connectionGeneration, entry.binding.connectionGuard)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            reportOpenFailure(selection, ContentOpenFailure.CHANNEL_OPEN_FAILED)
            return
        }
        // A late completion is only ever a late completion: if this selection is no
        // longer the live one, or its host attempt changed, the channel is closed and
        // nothing is ever subscribed on it.
        if (closed.get()) {
            closeQuietly(channel)
            reportOpenFailure(selection, ContentOpenFailure.RUNTIME_CLOSED)
            return
        }
        if (selection.superseded.isCompleted || this.selection.get() !== selection) {
            closeQuietly(channel)
            reportOpenFailure(selection, ContentOpenFailure.SUPERSEDED)
            return
        }
        val hostNow = hosts[entry.hostId]
        if (hostNow !== entry || hostNow.lane.phase != HostLanePhase.ATTACHED) {
            closeQuietly(channel)
            reportOpenFailure(selection, ContentOpenFailure.HOST_LOST)
            return
        }
        val laneScope = CoroutineScope(SupervisorJob() + dispatcher)
        val lane = SelectedContentLane(
            laneScope = laneScope,
            hostId = entry.hostId,
            channel = channel,
            connectionGuard = entry.binding.connectionGuard,
            endpointConfig = ContentEndpointConfig(
                target = ContentEndpointTarget(
                    hostId = entry.hostId,
                    connectionGeneration = entry.binding.connectionGeneration,
                    selectionGeneration = selection.generation,
                    ownerRunId = selection.target.ownerRunId,
                    rowId = selection.target.rowId,
                ),
                viewport = measured,
                nativeIo = config.contentCapabilities.ifEmpty { null }?.let { ContentNativeIoOptions(it) },
                bounds = config.contentBounds,
                deadlines = config.contentDeadlines,
                inputPolicy = policy.get(),
                ids = ContentIdSupplier { config.idFactory() },
            ),
            selectionGeneration = selection.generation,
            gate = selection.gate,
            visibility = visibility,
            config = config,
            clock = clock,
            scheduler = scheduler,
            emit = ::emitContent,
            onStateChanged = ::publishState,
        )
        if (!selection.installLane(lane)) {
            // This selection was withdrawn while the channel was opening. Nothing starts:
            // no reader, no subscription, no control lane the navigation already replaced.
            closeQuietly(channel)
            reportOpenFailure(
                selection,
                if (closed.get()) ContentOpenFailure.RUNTIME_CLOSED else ContentOpenFailure.SUPERSEDED,
            )
            return
        }
        entry.contentLaneScope = laneScope
        publishState()
        emit(ClientRuntimeEvent.SelectionChanged(selection.snapshot()))
        lane.awaitDriver()
        laneScope.cancel()
        if (this.selection.get() === selection) {
            this.selection.compareAndSet(selection, null)
            entry.contentLaneScope = null
            publishState()
            emit(ClientRuntimeEvent.SelectionChanged(null))
        }
    }

    /**
     * Wait for a real measurement without pretending one exists.
     *
     * The wait ends the moment the selection is superseded or the runtime closes, so a
     * stale selection can never be resurrected by a viewport that arrived late.
     */
    private suspend fun awaitViewportOrAbort(selection: ActiveSelection): ContentViewportRequest? = supervisorScope {
        if (selection.superseded.isCompleted) return@supervisorScope null
        val ready = async { viewport.first { value -> value != null } }
        val aborted = async { selection.superseded.await() }
        val winner = select {
            ready.onAwait { measured -> measured }
            aborted.onAwait { null }
        }
        ready.cancel()
        aborted.cancel()
        winner
    }

    private suspend fun reportOpenFailure(selection: ActiveSelection, reason: ContentOpenFailure) {
        if (this.selection.get() === selection) {
            this.selection.compareAndSet(selection, null)
            publishState()
        }
        emit(ClientRuntimeEvent.ContentOpenFailed(selection.generation, selection.target.hostId, reason))
    }

    private fun closeQuietly(channel: PeerByteChannel) {
        scope.launch {
            try {
                channel.close()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (ignored: Throwable) {
                // The parent owns the end of this channel; nothing is replayed.
            }
        }
    }

    /**
     * Withdraw the live selection for one finished host attempt.
     *
     * Fenced twice over: the entry must still be the one this runtime holds for that host,
     * and the selection must belong to that attempt's connection generation. A delayed
     * callback from a generation-1 lane therefore cannot force-cancel a stream that
     * generation 2 attached and selected after it.
     */
    private fun withdrawSelectionForHost(entry: HostEntry, force: Boolean = false) {
        if (hosts[entry.hostId] !== entry) return
        withdrawSelectionMatching(entry.hostId, entry.binding.connectionGeneration, force)
    }

    /** Withdrawal by host alone, for the parent's own explicit end of that host. */
    private fun withdrawSelectionForHost(hostId: HostId, force: Boolean = false) =
        withdrawSelectionMatching(hostId, null, force)

    private fun withdrawSelectionMatching(hostId: HostId, connectionGeneration: Long?, force: Boolean) {
        val current = selection.get() ?: return
        if (current.target.hostId != hostId) return
        if (connectionGeneration != null && current.connectionGeneration != connectionGeneration) return
        if (!selection.compareAndSet(current, null)) return
        current.withdrawNow(force)
        publishState()
        scope.launch { emit(ClientRuntimeEvent.SelectionChanged(null)) }
    }

    private suspend fun emitRoster(event: ClientRuntimeEvent) {
        emit(event)
        val wrapper = event as? ClientRuntimeEvent.Roster ?: return
        val changed = wrapper.event as? RosterClientEvent.ProjectionChanged ?: return
        maybeRestore(wrapper.hostId, wrapper.connectionGeneration, changed.projection)
    }

    private suspend fun emitContent(event: ClientRuntimeEvent) {
        val content = (event as? ClientRuntimeEvent.Content) ?: run {
            emit(event)
            return
        }
        val delivered = content.event as? ContentEndpointEvent.CopyDelivered ?: run {
            emit(event)
            return
        }
        // A completed copy is offered only to the viewer still actually looking at its
        // source. Nothing is buffered for a later foreground, and nothing replays.
        val reason = copySuppression(content.selectionGeneration)
        if (reason != null) {
            emit(
                ClientRuntimeEvent.TerminalCopySuppressed(
                    content.selectionGeneration,
                    content.hostId,
                    delivered.copy.copyId,
                    reason,
                ),
            )
            return
        }
        // Only one copy per selection stays claimable. A replaced copy is over: it is
        // suppressed permanently rather than queued behind the newer one.
        val displaced = selection.get()?.offerCopy(delivered.copy)
        if (displaced != null && displaced.copyId != delivered.copy.copyId) {
            emit(
                ClientRuntimeEvent.TerminalCopySuppressed(
                    content.selectionGeneration,
                    content.hostId,
                    displaced.copyId,
                    CopySuppressionReason.COPY_SUPERSEDED,
                ),
            )
        }
        emit(
            ClientRuntimeEvent.TerminalCopyOffered(
                content.selectionGeneration,
                content.hostId,
                delivered.copy,
                policy.get().generation,
            ),
        )
    }

    /**
     * Claim one offered copy immediately before the native clipboard write.
     *
     * The attempt itself spends the offer: every claim, successful or not, retires this
     * copy permanently, so a copy can never be retried into a clipboard after the thing
     * that made it undeliverable. What is then re-checked is the whole lifetime the copy
     * was offered under — this selection still being the live one, its stream still the
     * one that produced the copy, the policy generation still the offered one and still
     * enabled, the published source still the source the copy came from, the input
     * generation still the offered one, no coverage or preference change since the offer,
     * and the caller's own current-view proof still answering true. An A → B → A source
     * return is not the original source: the offered generation and epoch both moved.
     */
    fun claimTerminalCopy(selectionGeneration: Long, copyId: String, viewProof: RosterUiProof): TerminalCopyClaim {
        val current = selection.get()
            ?: return TerminalCopyClaim.Suppressed(copyId, CopySuppressionReason.SELECTION_WITHDRAWN)
        if (current.generation != selectionGeneration) {
            return TerminalCopyClaim.Suppressed(copyId, CopySuppressionReason.SELECTION_WITHDRAWN)
        }
        // Every attempt spends the offer, including one whose proof then fails.
        val offered = current.takeCopyForClaim(copyId)
            ?: return TerminalCopyClaim.Suppressed(copyId, CopySuppressionReason.COPY_SUPERSEDED)
        suppressionFor(current, offered)?.let {
            return TerminalCopyClaim.Suppressed(copyId, it)
        }
        if (!viewProof.isStillCurrent()) {
            return TerminalCopyClaim.Suppressed(copyId, CopySuppressionReason.PROOF_UNAVAILABLE)
        }
        // The proof call runs caller code, so the lifetime is proved again after it.
        suppressionFor(current, offered)?.let {
            return TerminalCopyClaim.Suppressed(copyId, it)
        }
        return TerminalCopyClaim.Granted(offered.copy)
    }

    /** Why this offered copy may not be delivered right now, or `null` when it may. */
    private fun suppressionFor(current: ActiveSelection, offered: OfferedCopy): CopySuppressionReason? {
        copySuppression(current.generation)?.let { return it }
        val lane = current.lane
            ?: return CopySuppressionReason.SELECTION_WITHDRAWN
        if (selection.get() !== current || !current.gate.inputOpenForSelection) {
            return CopySuppressionReason.SELECTION_WITHDRAWN
        }
        if (current.gate.proofEpoch != offered.proofEpoch || current.gate.requiresFreshCommit) {
            return CopySuppressionReason.FRESH_COMMIT_REQUIRED
        }
        val observed = lane.observation()
        if (policy.get().generation != offered.policyGeneration ||
            observed.inputPolicy.generation != offered.policyGeneration ||
            !observed.inputPolicy.enabled ||
            observed.inputGeneration != offered.inputGeneration ||
            observed.subscriptionId != offered.copy.subscriptionId
        ) {
            return CopySuppressionReason.COPY_SUPERSEDED
        }
        val target = lane.nativeInputTarget()
            ?: return CopySuppressionReason.COPY_SUPERSEDED
        if (target.subscriptionId != offered.copy.subscriptionId ||
            !nativeIoSourceEquals(target.source, offered.copy.source)
        ) {
            return CopySuppressionReason.COPY_SUPERSEDED
        }
        return null
    }

    private fun copySuppression(selectionGeneration: Long): CopySuppressionReason? {
        if (closed.get()) return CopySuppressionReason.RUNTIME_CLOSED
        val current = selection.get() ?: return CopySuppressionReason.SELECTION_WITHDRAWN
        if (current.generation != selectionGeneration) return CopySuppressionReason.SELECTION_WITHDRAWN
        if (!policy.get().enabled) return CopySuppressionReason.POLICY_DISABLED
        val seen = visibility.get()
        if (!seen.appForeground) return CopySuppressionReason.APP_NOT_FOREGROUND
        if (!seen.terminalInputCovered) return CopySuppressionReason.TERMINAL_NOT_COVERED
        return null
    }

    /**
     * Restore a deliberately remembered target, and only on its own terms.
     *
     * A fresh authoritative snapshot is the only trigger; the same owner run and the
     * same owner row must be in it; the caller's stored proof must still answer true; and
     * no other stream may be live. A run change is never adopted and no substitute row is
     * ever chosen.
     */
    private fun maybeRestore(hostId: HostId, connectionGeneration: Long, projection: RosterProjection) {
        if (closed.get() || !restoreArmed.get()) return
        if (selection.get() != null) return
        if (!visibility.get().allowsTerminalInput) return
        if (viewport.value == null) return
        val target = remembered.get() ?: return
        if (armedFor.get() != target) return
        if (target.hostId != hostId) return
        if (projection.state != RosterProjectionState.CURRENT) return
        if (projection.hostRunId != target.ownerRunId) return
        if (!projection.rows.any { it.id == target.rowId }) return
        val proof = storedRestoreProof.get() ?: return
        if (!proof.isStillCurrent()) return
        val entry = hosts[hostId] ?: return
        // A roster event from a generation this runtime no longer holds can neither
        // restore a stream nor clear anything a replacement generation already owns.
        if (entry.binding.connectionGeneration != connectionGeneration) return
        if (entry.lane.phase != HostLanePhase.ATTACHED) return
        beginSelection(target, entry)
    }

    private fun onHostFinished(entry: HostEntry) {
        scope.launch {
            // This callback belongs to one finished lane. If the parent already replaced
            // this host with a newer attempt, or the live selection belongs to that newer
            // attempt, nothing here may touch it.
            withdrawSelectionForHost(entry, force = true)
            entry.scope.cancel()
            publishState()
            reportDetached(entry, HostDetachReason.CHANNEL_CLOSED)
        }
    }

    private fun reportDetached(entry: HostEntry, reason: HostDetachReason) {
        if (!entry.detachedReported.compareAndSet(false, true)) return
        scope.launch {
            emit(ClientRuntimeEvent.HostDetached(entry.hostId, entry.binding.connectionGeneration, reason))
        }
    }

    private fun publishState() {
        stateFlow.value = snapshot()
    }

    private fun snapshot(): ClientRuntimeState {
        val current = selection.get()
        val seen = visibility.get()
        return ClientRuntimeState(
            hosts = hosts.values.map { entry ->
                HostRuntimeState(entry.hostId, entry.binding.connectionGeneration, entry.lane.phase, entry.lane.state())
            },
            selection = current?.snapshot(),
            pendingSelection = if (current?.lane == null) current?.target else null,
            rememberedTarget = remembered.get(),
            restoreArmed = restoreArmed.get(),
            visibility = seen,
            viewport = viewport.value,
            inputPolicy = policy.get(),
            terminalInputAdmissionOpen = current != null &&
                current.lane != null &&
                current.gate.inputOpenForSelection &&
                seen.allowsTerminalInput &&
                !current.gate.requiresFreshCommit,
            closed = closed.get(),
        )
    }

    /** One host's lane and the scope that owns its jobs. */
    private inner class HostEntry(val binding: HostChannelBinding) {
        val hostId: HostId = binding.hostId
        val scope: CoroutineScope = CoroutineScope(SupervisorJob() + dispatcher)
        val detachedReported = AtomicBoolean(false)

        @Volatile
        var contentLaneScope: CoroutineScope? = null

        val lane: RosterHostLane = RosterHostLane(
            laneScope = scope,
            binding = binding,
            config = config,
            clock = clock,
            scheduler = scheduler,
            emit = ::emitRoster,
            onStateChanged = ::publishState,
            onFinished = { onHostFinished(this) },
        )
    }

    /**
     * One copy this runtime offered, bound to the exact lifetime it was offered under.
     *
     * These are the facts a later claim must still find unchanged. A policy change, a
     * coverage loss and return, or an A → B → A source return moves at least one of them,
     * so the original copy cannot be delivered again under a view that is merely similar.
     */
    private data class OfferedCopy(
        val copy: ContentCopyReceipt,
        val policyGeneration: Long,
        val inputGeneration: Long,
        val proofEpoch: Long,
    )

    /** One deliberate selection, its gate, and the lane that may still be opening. */
    private inner class ActiveSelection(
        val generation: Long,
        val target: TerminalTarget,
        val connectionGeneration: Long,
        val gate: ContentSelectionGate,
    ) {
        val superseded = CompletableDeferred<Unit>()

        /** Serializes lane installation against withdrawal. Never held across a suspension. */
        private val lifecycle = Any()

        @Volatile
        var lane: SelectedContentLane? = null
            private set

        @Volatile
        var withdrawn: Boolean = false
            private set

        /** The one copy this selection may still claim, with the lifetime it was offered under. */
        private val offered = AtomicReference<OfferedCopy?>()

        /**
         * Take ownership of a lane that finished opening.
         *
         * Installation and withdrawal are one coordinated transition: if this selection
         * was already withdrawn, the caller must discard the lane, so a superseded
         * selection can never install a reader, a subscription, or a live control lane
         * after the navigation that replaced it.
         */
        fun installLane(candidate: SelectedContentLane): Boolean = synchronized(lifecycle) {
            if (withdrawn) false
            else {
                lane = candidate
                // The driver is started here, inside the same critical section that makes
                // this lane obtainable by a withdrawal. [SelectedContentLane.start] does not
                // suspend, so no withdrawal can ever take this lane while it has none: a
                // retirement asked for during a later blocked publication always reaches a
                // live driver instead of being discarded before startup.
                candidate.start()
                true
            }
        }

        /**
         * Close this selection's input admission now and hand back the lane to retire.
         *
         * The gate dies on this calling thread, before any coroutine runs. The endpoint is
         * then left to retire its own stream while its channel lives, which is what keeps
         * a replaced stream from being abandoned; a forced retirement ends that lane now.
         */
        fun takeRetirement(): SelectedContentLane? = synchronized(lifecycle) {
            withdrawn = true
            gate.withdrawInput()
            superseded.complete(Unit)
            offered.set(null)
            lane
        }

        fun withdrawNow(force: Boolean = false) {
            val retiring = takeRetirement() ?: return
            if (force) {
                scope.launch(start = CoroutineStart.UNDISPATCHED) { retiring.finalize() }
            } else {
                scope.launch { retiring.stop(); retiring.awaitDriver() }
            }
        }

        /**
         * Record the one copy this selection may claim, bound to the lifetime it existed
         * under. Returns the copy it displaced.
         *
         * A withdrawn selection is offered nothing, and a copy naming another selection is
         * refused: an offer is never attached to a stream that did not produce it.
         */
        fun offerCopy(copy: ContentCopyReceipt): ContentCopyReceipt? = synchronized(lifecycle) {
            if (withdrawn || copy.selectionGeneration != generation) return@synchronized null
            val observed = lane?.observation() ?: return@synchronized null
            offered.getAndSet(
                OfferedCopy(copy, observed.inputPolicy.generation, observed.inputGeneration, gate.proofEpoch),
            )?.copy
        }

        /**
         * Consume the claimable copy with this id.
         *
         * Exactly one caller can win this, and every attempt spends the offer — a granted
         * copy can never be delivered twice, and a refused one is never claimable again.
         */
        fun takeCopyForClaim(copyId: String): OfferedCopy? {
            while (true) {
                val current = offered.get() ?: return null
                if (current.copy.copyId != copyId) return null
                if (offered.compareAndSet(current, null)) return current
            }
        }

        fun snapshot(): SelectedContent? = lane?.let { SelectedContent(generation, target, it.observation()) }
    }

    private suspend fun emit(event: ClientRuntimeEvent) {
        if (eventChannel.isClosedForSend) return
        try {
            eventChannel.send(event)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (ignored: IllegalStateException) {
            // The runtime was disposed while this event was in flight.
        }
    }
}
