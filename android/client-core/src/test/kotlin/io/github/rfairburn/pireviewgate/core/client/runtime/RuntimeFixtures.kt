package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpointEvent
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy
import io.github.rfairburn.pireviewgate.core.client.content.ContentPaneRect
import io.github.rfairburn.pireviewgate.core.client.content.ContentSendOutcome
import io.github.rfairburn.pireviewgate.core.client.content.ContentWrittenFrameOutcome
import io.github.rfairburn.pireviewgate.core.client.content.ContentWrittenFrameProof
import io.github.rfairburn.pireviewgate.core.client.content.ackFrame
import io.github.rfairburn.pireviewgate.core.client.content.inlineCopyFrames
import io.github.rfairburn.pireviewgate.core.client.content.subscribedFrame
import io.github.rfairburn.pireviewgate.core.client.content.transferFrames
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientHarness
import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSendProof
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.INPUT_MODES
import io.github.rfairburn.pireviewgate.core.protocol.content.contentSource
import io.github.rfairburn.pireviewgate.core.protocol.content.sampleFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import io.github.rfairburn.pireviewgate.core.protocol.content.SubscribeFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.UnsubscribedFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterProtocol
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel
import io.github.rfairburn.pireviewgate.core.transport.PeerChannelClose
import io.github.rfairburn.pireviewgate.core.transport.PeerDelivery
import io.github.rfairburn.pireviewgate.core.transport.PeerKey
import io.github.rfairburn.pireviewgate.core.transport.PeerSendGuard
import io.github.rfairburn.pireviewgate.core.transport.PeerSendReceipt
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportErrorCode
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.CoroutineContext
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Deterministic in-memory fixtures for the endpoint runtime suites.
 *
 * Everything here is a verification driver, never a production stand-in: a real
 * [PeerByteChannel] implementation is faked only so a test can say exactly what the
 * transport did — admitted, invoked, written, refused before admission, blocked, or
 * lost — and the runtime must settle from that evidence rather than from a convenient
 * assumption. Time is a hand-driven monotonic clock with a scheduler the test fires, so
 * no suite waits on a wall clock and no deadline is simulated by sleeping.
 */

internal const val HOST_A = "host-a"
internal const val HOST_B = "host-b"
internal const val RUN_ID = "run-1"
internal const val OTHER_RUN_ID = "run-2"
internal const val ROW_1 = "row-1"
internal const val ROW_2 = "row-2"

/** Every optional capability this build implements, as the runtime must offer them. */
internal val ALL_ROSTER_CAPABILITIES: List<String> = listOf(
    RosterWire.REQUIRED_CAPABILITY,
    RosterWire.CLOSE_CAPABILITY,
    RosterWire.CREATE_CAPABILITY,
    RosterWire.SAVED_CAPABILITY,
    RosterWire.RENAME_CAPABILITY,
    RosterWire.ROSTER_SLOT_CAPABILITY,
)

/** A well-formed base64 SPKI key id, so a fake channel carries a real identity type. */
private const val FAKE_KEY_ID = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0="

/** One refused-before-admission transport failure: this side never wrote anything. */
internal fun refusedBeforeAdmission(): PeerTransportException =
    PeerTransportException(PeerTransportErrorCode.CHANNEL_NOT_OPEN)

/** A refusal raised by the dispatch-time fence, with the boundary it did or did not cross. */
internal fun refusedAtDispatch(invocationBoundaryCrossed: Boolean): PeerTransportException =
    PeerTransportException(
        PeerTransportErrorCode.CHANNEL_NOT_OPEN,
        invocationBoundaryCrossed = invocationBoundaryCrossed,
    )

/** One failure raised after the accepted-dispatch boundary: the outcome is unknown. */
internal fun failureAfterInvoke(): PeerTransportException =
    PeerTransportException(PeerTransportErrorCode.SEND_FAILED)

/**
 * A [PeerByteChannel] a test fully controls.
 *
 * It reproduces the real channel's evidence discipline rather than its bytes: a frame
 * refused before admission records [PeerDelivery.NOT_SENT] and never claims invocation,
 * an admitted frame crosses the invocation boundary exactly once before the "write", and
 * a blocked send stays blocked until the test releases it — which is how a test can lose
 * the channel while a write is in flight and prove the runtime still refuses to call it
 * never-sent.
 */
internal class FakePeerByteChannel(
    override val lane: PeerAppLane,
    val name: String = "channel",
) : PeerByteChannel {

    /** One recorded write, with the guard facts the transport saw. */
    data class Write(
        val bytes: ByteArray,
        val guardAllowedAtAdmission: Boolean,
        val guardEpochAtAdmission: Long,
        val guardAllowedAtDispatch: Boolean,
    )

    override val peerKey: PeerKey = PeerKey.fromKeyId(FAKE_KEY_ID)
    override val label: String? = name

    val writes: MutableList<Write> = mutableListOf()
    var closeCount: Int = 0
        private set

    private val incoming = Channel<ByteArray>(Channel.UNLIMITED)
    private val closedDeferred = CompletableDeferred<PeerChannelClose>()
    private var blocked: Channel<Unit>? = null
    private var postInvokeBlock: Channel<Unit>? = null
    private var failNext: Throwable? = null
    private var refuseNext: Throwable? = null
    private var invokeAnyway = false

    override val bufferedAmount: Int get() = writes.size

    override val closed: Deferred<PeerChannelClose> get() = closedDeferred

    /** Deliver one inbound message to the runtime's reader. */
    fun push(bytes: ByteArray) {
        check(incoming.trySend(bytes).isSuccess)
    }

    fun push(frame: RosterFrame) = push(RosterProtocol.encode(frame))

    fun push(frame: ContentFrame) = push(ContentProtocol.encode(frame))

    /** The peer ended the channel: the runtime's next receive returns null. */
    fun endIncoming() {
        incoming.close()
    }

    /** The next write is refused at admission, exactly as a dropped stale frame is. */
    fun refuseNextWrite(error: Throwable = refusedBeforeAdmission()) {
        refuseNext = error
    }

    /** The next write is entered and then fails: acceptance can no longer be excluded. */
    fun failNextWrite(error: Throwable = failureAfterInvoke()) {
        failNext = error
    }

    /** Hold every subsequent write until [releaseWrites]. */
    fun blockWrites() {
        blocked = Channel(0)
    }

    /**
     * Hold every subsequent write after the invocation boundary, modelling a frame whose
     * socket handoff has begun and has not returned.
     */
    fun blockAfterInvoke() {
        postInvokeBlock = Channel(0)
    }

    /**
     * The next released write crosses its invocation boundary despite its own fence.
     *
     * A real writer refuses such a frame, and a lane still must not trust it: this models
     * the one case the settlement floor exists for — a transport that entered a write its
     * message guard had already invalidated.
     */
    fun forceInvokeOnRelease() {
        invokeAnyway = true
    }

    fun releaseWrites() {
        blocked?.close()
        blocked = null
        postInvokeBlock?.close()
        postInvokeBlock = null
    }

    /**
     * The real channel's guard discipline, reproduced step for step:
     *
     * 1. Admission captures the guard's epoch first and only then evaluates authorization,
     *    so a fence that moves afterwards cannot bless a newer epoch.
     * 2. The outbound queue wait happens next, still with no invocation boundary.
     * 3. Immediately before accepted dispatch the per-message fence is proved again; a
     *    frame that expired while queued is dropped there — never invoked, never bytes.
     * 4. The invocation boundary is claimed and reported, and the fence is proved once more
     *    afterwards, because the real writer knows the observer callback may itself have
     *    changed the source. A refusal after that point can no longer be recorded as
     *    provably never sent, exactly as [PeerSendReceipt] documents.
     */
    override suspend fun send(bytes: ByteArray, writeGuard: PeerSendGuard, receipt: PeerSendReceipt) {
        val epochAtAdmission = writeGuard.epoch()
        val allowedAtAdmission = writeGuard.allows()
        val refused = refuseNext
        if (refused != null) {
            refuseNext = null
            recordLikeTransport(receipt, PeerDelivery.NOT_SENT)
            throw refused
        }
        if (!allowedAtAdmission) {
            recordLikeTransport(receipt, PeerDelivery.NOT_SENT)
            throw refusedBeforeAdmission()
        }
        blocked?.receiveCatching()
        if (invokeAnyway) {
            invokeAnyway = false
            check(receipt.claimInvoked()) { "invocation boundary crossed twice" }
            receipt.onInvoked?.invoke()
            recordLikeTransport(receipt, PeerDelivery.SUBMITTED_UNKNOWN)
            throw refusedAtDispatch(true)
        }
        val allowedAtDispatch = writeGuard.allows() && writeGuard.epoch() == epochAtAdmission
        if (!allowedAtDispatch) {
            recordLikeTransport(receipt, PeerDelivery.NOT_SENT)
            throw refusedAtDispatch(receipt.wasInvoked)
        }
        check(receipt.claimInvoked()) { "invocation boundary crossed twice" }
        receipt.onInvoked?.invoke()
        postInvokeBlock?.receiveCatching()
        if (!writeGuard.allows()) {
            recordLikeTransport(receipt, PeerDelivery.NOT_SENT)
            throw refusedAtDispatch(true)
        }
        val failure = failNext
        if (failure != null) {
            failNext = null
            recordLikeTransport(receipt, PeerDelivery.SUBMITTED_UNKNOWN)
            throw failure
        }
        recordLikeTransport(receipt, PeerDelivery.WRITTEN)
        writes += Write(bytes, allowedAtAdmission, epochAtAdmission, true)
    }

    /** A not-sent outcome is widened once the invocation boundary was crossed. */
    private fun recordLikeTransport(receipt: PeerSendReceipt, value: PeerDelivery) {
        receipt.record(
            if (value == PeerDelivery.NOT_SENT && receipt.wasInvoked) PeerDelivery.SUBMITTED_UNKNOWN else value,
        )
    }

    override suspend fun receive(): ByteArray? = incoming.receiveCatching().getOrNull()

    override suspend fun close() {
        closeCount += 1
        closedDeferred.complete(PeerChannelClose(1000, "local close"))
    }

    /** Every frame this channel was asked to write, decoded on this lane's protocol. */
    fun rosterFrames(): List<RosterFrame> = writes.map { RosterProtocol.decode(it.bytes) }

    fun contentFrames(): List<ContentFrame> = writes.map { ContentProtocol.decode(it.bytes) }

    fun countFrame(type: String): Int = rosterFrames().count { it.type == type }
}

/**
 * A monotonic clock and deadline scheduler the test drives by hand.
 *
 * Advancing the clock fires due callbacks in due order, which is what lets a suite prove
 * that a re-armed deadline is not expired by the callback its replacement cancelled.
 */
internal class VirtualTime(startNanos: Long = 1_000_000_000L) {

    private class Task(val dueAtNanos: Long, val sequence: Long, val onDue: () -> Unit, val cancelled: AtomicBoolean)

    var nowNanos: Long = startNanos
        private set

    private val tasks = mutableListOf<Task>()
    private var nextSequence = 0L

    val clock: MonotonicClock = MonotonicClock { nowNanos }

    val scheduler: DeadlineScheduler = DeadlineScheduler { dueAtNanos, onDue ->
        val task = Task(dueAtNanos, nextSequence++, onDue, AtomicBoolean(false))
        tasks += task
        DeadlineHandle { task.cancelled.set(true) }
    }

    /** Live arms, oldest first. A retired arm disappears here, which is the assertion. */
    val armed: List<Long>
        get() = tasks.filter { !it.cancelled.get() }.sortedBy { it.dueAtNanos }.map { it.dueAtNanos }

    fun armedCount(): Int = tasks.count { !it.cancelled.get() }

    fun advance(nanos: Long) {
        nowNanos += nanos
        fireDue()
    }

    fun advanceMillis(millis: Long) = advance(millis * 1_000_000L)

    private fun fireDue() {
        while (true) {
            val due = tasks.filter { !it.cancelled.get() && it.dueAtNanos <= nowNanos }.sortedWith(
                compareBy({ it.dueAtNanos }, { it.sequence }),
            ).firstOrNull() ?: return
            tasks.remove(due)
            due.onDue()
        }
    }
}

/** One dynamic proof a test can flip, mirroring what a real native bridge reports. */
internal class ToggleProof(initial: Boolean = true) : RosterUiProof {
    var current: Boolean = initial
    var checks: Int = 0
        private set

    override fun isStillCurrent(): Boolean {
        checks += 1
        return current
    }
}

/** A proof the caller never withdraws. Real suites flip [ToggleProof] instead. */
internal val ALWAYS_TRUE: RosterUiProof = RosterUiProof { true }

/**
 * A dynamic proof that answers true until its [flipOn]th check.
 *
 * It models the window a queued frame actually lives through: the same proof object is
 * consulted by the lane before it queues, by the channel at admission, and by the channel
 * again under write ownership. Choosing which check fails lets a suite prove the last
 * fence — not just the first — is what decides whether bytes exist.
 */
internal class FlipOnCheckProof(private val flipOn: Int) : RosterUiProof {
    var checks: Int = 0
        private set

    override fun isStillCurrent(): Boolean {
        checks += 1
        return checks < flipOn
    }
}
/** The per-message proofs these suites hand to the runtime's exact forwarders. */
internal fun rowProof(
    generation: Long,
    runId: String,
    rowId: String,
    sessionId: String? = null,
    epoch: Long? = null,
    ui: RosterUiProof = ALWAYS_TRUE,
): RosterSendProof.RowAction = RosterSendProof.RowAction(generation, runId, rowId, sessionId, epoch, ui)

internal fun formProof(
    generation: Long,
    runId: String,
    workspace: String,
    ui: RosterUiProof = ALWAYS_TRUE,
): RosterSendProof.Form = RosterSendProof.Form(generation, runId, workspace, ui)

internal fun readProof(
    generation: Long,
    runId: String,
    queryRevision: Long = 1L,
    ui: RosterUiProof = ALWAYS_TRUE,
): RosterSendProof.PickerRead = RosterSendProof.PickerRead(generation, runId, queryRevision = queryRevision, ui = ui)

internal fun entryProof(
    generation: Long,
    runId: String,
    catalogId: String,
    resultId: String,
    entryId: String,
    pickerRevision: Long = 1L,
    ui: RosterUiProof = ALWAYS_TRUE,
): RosterSendProof.PickerEntry =
    RosterSendProof.PickerEntry(generation, runId, catalogId, resultId, entryId, pickerRevision, ui)

/** The default configuration for these suites: small bounds, fast grace, stable ids. */
internal fun runtimeConfig(
    ids: () -> String,
    maxHosts: Int = ClientRuntimeConfig.MAX_HOSTS,
    outboundCapacity: Int = 16,
    signalCapacity: Int = 64,
    rosterCapabilities: List<String> = ClientRuntimeConfig.DEFAULT_ROSTER_CAPABILITIES,
    contentCapabilities: List<String> = ClientRuntimeConfig.DEFAULT_CONTENT_CAPABILITIES,
    initialInputPolicy: ContentInputPolicy = ContentInputPolicy(enabled = false, generation = 0L),
    retirementGraceMs: Long = 250L,
    eventQueueCapacity: Int = 512,
): ClientRuntimeConfig = ClientRuntimeConfig(
    rosterCapabilities = rosterCapabilities,
    contentCapabilities = contentCapabilities,
    initialInputPolicy = initialInputPolicy,
    maxHosts = maxHosts,
    laneSignalQueueCapacity = signalCapacity,
    laneOutboundQueueCapacity = outboundCapacity,
    eventQueueCapacity = eventQueueCapacity,
    retirementGraceMs = retirementGraceMs,
    idFactory = ids,
)

/**
 * Drives one [ClientRuntime] on the calling thread's own event loop.
 *
 * Every runtime coroutine runs on the test dispatcher, so the suite decides exactly when
 * work happens: [settle] hands the loop a bounded number of turns, and [awaitUntil]
 * fails loudly rather than passing a test whose condition never arrived.
 */
internal class RuntimeHarness(
    context: CoroutineContext,
    val time: VirtualTime = VirtualTime(),
    config: ClientRuntimeConfig = runtimeConfig(ids = CountingRuntimeIds()),
    opener: ContentChannelOpener? = null,
) {
    private val scope = CoroutineScope(context + Job())
    val openedContentChannels: MutableList<FakePeerByteChannel> = mutableListOf()
    val events: MutableList<ClientRuntimeEvent> = mutableListOf()
    val hostChannels: MutableMap<String, FakePeerByteChannel> = mutableMapOf()
    val runtime: ClientRuntime
    private var collector: Job? = null

    init {
        val actualOpener = opener ?: ContentChannelOpener { _, _, _ ->
            FakePeerByteChannel(PeerAppLane.CONTENT, "content").also { openedContentChannels += it }
        }
        runtime = ClientRuntime(actualOpener, config, time.clock, context, time.scheduler)
        collector = startCollector()
    }

    private fun startCollector(): Job = scope.launch {
        for (event in runtime.events) events += event
    }

    /**
     * Stop collecting entirely, so the next publication parks its producer.
     *
     * The collector is cancelled rather than gated in place: a collector suspended in
     * `receive` would take the next event by direct handoff, leaving the queue empty and
     * the producer that was meant to park free to run on.
     */
    fun pauseEvents() {
        collector?.cancel()
        collector = null
    }

    /** Collect again, releasing whatever was parked. */
    fun resumeEvents() {
        if (collector == null) collector = startCollector()
    }

    // ------------------------------------------------------------------ pumps

    suspend fun settle(turns: Int = 120) {
        repeat(turns) { yield() }
    }

    suspend fun awaitUntil(description: String, condition: () -> Boolean) {
        repeat(400) {
            if (condition()) return
            yield()
        }
        fail("condition never held: $description")
    }

    suspend fun closeRuntime() {
        runtime.close()
        settle()
    }

    // ------------------------------------------------------------- host lanes

    fun attach(hostId: String, generation: Long = 1L, lane: PeerAppLane = PeerAppLane.APP): Pair<FakePeerByteChannel, HostAttachResult> {
        val channel = FakePeerByteChannel(lane, hostId)
        hostChannels[hostId] = channel
        val result = runtime.attachHost(
            HostChannelBinding(HostId.parse(hostId), channel, generation, PeerSendGuard.NONE),
        )
        return channel to result
    }

    fun attachOn(hostId: String, channel: FakePeerByteChannel, generation: Long = 1L): HostAttachResult =
        runtime.attachHost(HostChannelBinding(HostId.parse(hostId), channel, generation, PeerSendGuard.NONE))

    /** The APP channel this harness attached for [hostId], or `null`. */
    fun hostChannel(hostId: String): FakePeerByteChannel? = hostChannels[hostId]

    /** Every content-model event the runtime published, in order. */
    fun contentEvents(): List<ContentEndpointEvent> =
        events.filterIsInstance<ClientRuntimeEvent.Content>().map { it.event }

    /** Every copy the runtime offered to the clipboard adapter, in order. */
    fun copyOffers(): List<ClientRuntimeEvent.TerminalCopyOffered> =
        events.filterIsInstance<ClientRuntimeEvent.TerminalCopyOffered>()

    /** Deliver the frames of one completed native copy and let the runtime offer it. */
    suspend fun offerCopy(
        channel: FakePeerByteChannel,
        copyId: String,
        sequence: Long,
        source: io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoSource = nativeSource(),
    ) {
        inlineCopyFrames(
            copyId = copyId,
            subscriptionId = subscriptionOf(channel),
            sequence = sequence,
            source = source,
        ).forEach { channel.push(it) }
        settle()
    }

    /** The final outcome of every logical input this runtime was asked to send. */
    fun inputOutcomes(): List<ContentSendOutcome> =
        contentEvents().filterIsInstance<ContentEndpointEvent.InputSettled>().map { it.outcome }

    /**
     * Bring one host up to a live, subscribed CONTENT stream for one row.
     *
     * This is the shared happy path: attach, handshake, subscribe, publish an
     * authoritative roster, measure a viewport, select deliberately, then complete the
     * content handshake and publish one viewport. [publish] is switched off only by suites
     * that need to watch the stream before any pixels exist.
     */
    suspend fun terminalUp(
        hostId: String = HOST_A,
        rowId: String = ROW_1,
        publish: Boolean = true,
        cols: Int = 80,
        rows: Int = 24,
    ): FakePeerByteChannel {
        val existing = hostChannel(hostId)
        val roster = existing ?: attach(hostId).also {
            check(it.second == HostAttachResult.Accepted) { "host attach was refused: ${it.second}" }
        }.first
        subscribed(hostId, roster)
        publishSnapshot(roster, rows = listOf(RosterClientHarness.row(ROW_1), RosterClientHarness.row(ROW_2)))
        check(runtime.setViewport(cols, rows) is ViewportResult.Applied)
        val selected = runtime.selectTerminal(TerminalTarget(HostId.parse(hostId), RUN_ID, rowId), ALWAYS_TRUE)
        check(selected is SelectionResult.Selected) { "selection was refused: $selected" }
        settle()
        val content = lastContentChannel()
        contentUp(content, NATIVE_IO_ACK_CAPS, hostId, RUN_ID, rowId)
        if (publish) publishContent(content, source = nativeSource(rowId), sequence = 1L, runId = RUN_ID, rowId = rowId)
        return content
    }

    fun hostState(hostId: String): HostRuntimeState? = runtime.hostState(HostId.parse(hostId))

    // --------------------------------------------------------- roster driving

    /**
     * Drive one host's handshake and subscription, and return the subscription id this
     * side minted. Writes are reported as accepted unless a test says otherwise.
     */
    suspend fun subscribed(
        hostId: String,
        channel: FakePeerByteChannel,
        capabilities: List<String> = ALL_ROSTER_CAPABILITIES,
    ): String {
        settle()
        ackRoster(channel, capabilities)
        settle()
        runtime.subscribeRoster(HostId.parse(hostId))
        settle()
        return subscriptionIdOf(channel)
    }

    fun ackRoster(channel: FakePeerByteChannel, capabilities: List<String> = ALL_ROSTER_CAPABILITIES) {
        channel.push(RosterFrame.HelloAck(RosterWire.SERVICE, RosterWire.MAJOR, RosterWire.MINOR, capabilities))
    }

    /** Publish one complete authoritative snapshot, in page frames of [pageSize] rows. */
    suspend fun publishSnapshot(
        channel: FakePeerByteChannel,
        rows: List<RemoteSessionMetadata>,
        runId: String = RUN_ID,
        revision: Long = 1L,
        pageSize: Int = 2,
    ) {
        val subscription = subscriptionIdOf(channel)
        val chunks = rows.chunked(pageSize)
        channel.push(
            RosterFrame.SnapshotBegin(
                subscriptionId = subscription,
                transferId = "transfer-$revision",
                hostRunId = runId,
                revision = revision,
                totalRows = rows.size.toLong(),
                pageCount = chunks.size.toLong(),
            ),
        )
        settle()
        chunks.forEachIndexed { index, page ->
            channel.push(
                RosterFrame.SnapshotPage(
                    subscriptionId = subscription,
                    transferId = "transfer-$revision",
                    pageIndex = index.toLong(),
                    rows = page,
                ),
            )
            settle()
        }
        channel.push(
            RosterFrame.SnapshotEnd(
                subscriptionId = subscription,
                transferId = "transfer-$revision",
                revision = revision,
                totalRows = rows.size.toLong(),
            ),
        )
        settle()
    }

    fun subscriptionIdOf(channel: FakePeerByteChannel): String =
        channel.rosterFrames().mapNotNull { (it as? RosterFrame.Subscribe)?.subscriptionId }.last()

    fun rosterFrames(channel: FakePeerByteChannel): List<RosterFrame> = channel.rosterFrames()

    fun lastRequest(channel: FakePeerByteChannel, type: String): RosterFrame =
        channel.rosterFrames().last { it.type == type }

    // -------------------------------------------------------- terminal target

    fun target(hostId: String = HOST_A, runId: String = RUN_ID, rowId: String = ROW_1): TerminalTarget =
        TerminalTarget(HostId.parse(hostId), runId, rowId)

    fun selection(hostId: String = HOST_A): SelectedContent? =
        runtime.state.value.selection?.takeIf { it.target.hostId == HostId.parse(hostId) }

    // -------------------------------------------------------- content driving

    suspend fun contentUp(
        channel: FakePeerByteChannel,
        capabilities: List<String>,
        hostId: String = HOST_A,
        runId: String = RUN_ID,
        rowId: String = ROW_1,
    ) {
        settle()
        channel.push(ackFrame(capabilities))
        settle()
        val subscription = subscriptionOf(channel)
        channel.push(subscribedFrame(subscription, runId, rowId))
        settle()
    }

    fun subscriptionOf(channel: FakePeerByteChannel): String =
        channel.contentFrames().mapNotNull { (it as? SubscribeFrame)?.subscriptionId }.last()

    /** The owner acknowledged this stream's own retirement notice. */
    fun unsubscribed(channel: FakePeerByteChannel) {
        channel.push(UnsubscribedFrame(subscriptionOf(channel)))
    }

    /** The most recently opened CONTENT channel, which this runtime itself opened. */
    fun lastContentChannel(): FakePeerByteChannel = openedContentChannels.last()

    /** Publish one complete viewport onto a content channel, in the protocol's own frames. */
    suspend fun publishContent(
        channel: FakePeerByteChannel,
        source: NativeIoInputSource? = null,
        sequence: Long = 1L,
        runId: String = RUN_ID,
        rowId: String = ROW_1,
        nativeSession: io.github.rfairburn.pireviewgate.core.protocol.content.NativeSessionRef? =
            io.github.rfairburn.pireviewgate.core.protocol.content.NativeSessionRef("native-session-1", 3),
    ) {
        transferFrames(
            frame = sampleFrame(),
            subscriptionId = subscriptionOf(channel),
            transferId = "content-transfer-$sequence",
            hostRunId = runId,
            sessionId = rowId,
            nativeSession = nativeSession,
            sequence = sequence,
            geometry = CONTENT_GEOMETRY,
            inputModes = INPUT_MODES,
            inputSource = source?.let { OptionalNativeIoSource.Stated(it) } ?: OptionalNativeIoSource.Absent,
            chunkBytes = ContentBounds.DEFAULT.maxChunkPayloadBytes,
        ).forEach {
            channel.push(it)
            settle()
        }
    }

    /** Hand the runtime the caller's real commit of the currently published frame. */
    fun commitPublishedFrame(
        selectionGeneration: Long,
        sequence: Long = 1L,
        policyGeneration: Long = runtime.state.value.inputPolicy.generation,
        geometry: SessionGeometry = CONTENT_GEOMETRY,
        inputGeneration: Long? = null,
    ): ContentWrittenFrameOutcome {
        val observation = runtime.currentContentObservation()
            ?: error("no content stream is live to have committed a frame")
        return runtime.recordWrittenFrame(
            ContentWrittenFrameProof(
                selectionGeneration = selectionGeneration,
                subscriptionId = observation.subscriptionId,
                sequence = sequence,
                geometry = geometry,
                resizeEpoch = observation.resizeEpoch,
                policyGeneration = policyGeneration,
                nativeContent = ContentPaneRect(
                    column = 0,
                    row = 0,
                    cols = geometry.cols,
                    rows = geometry.rows,
                ),
                inputGeneration = inputGeneration ?: observation.inputGeneration,
            ),
        )
    }
}

/** The geometry the shared content fixtures' [sampleFrame] actually draws. */
internal val CONTENT_GEOMETRY: SessionGeometry = SessionGeometry(cols = 12, rows = 3, revision = 0)

/** The native IO capability pair a suite acks when it wants remote input. */
internal val NATIVE_IO_ACK_CAPS: List<String> =
    listOf(ContentProtocol.REQUIRED_CAPABILITY, ContentProtocol.NATIVE_IO_CAPABILITY)

/** The host-written source of [CONTENT_GEOMETRY], bound to this suite's run and row. */
internal fun nativeSource(rowId: String = ROW_1): io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoSource =
    contentSource(sessionId = rowId, geometry = CONTENT_GEOMETRY)

/** Deterministic correlation ids, so a suite's request ids never drift. */
internal class CountingRuntimeIds(private val prefix: String = "id") : () -> String {
    private var next = 0

    override fun invoke(): String = "$prefix-${++next}"
}

internal fun assertNoRosterClose(frames: List<RosterFrame>) {
    assertTrue(frames.none { it.type == "close_request" }, "a terminal navigation asked the owner to close a session")
}
