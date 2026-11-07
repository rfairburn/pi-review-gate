package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteNativePersistence
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteNativeSession
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterBounds
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterProtocol
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire

/**
 * Deterministic off-device harness for [RosterClientEndpoint].
 *
 * It owns the two things the endpoint deliberately does not: a clock the test
 * advances by hand, and the pump that turns effects into recorded sends and armed
 * deadlines. Nothing here pretends to be a transport — a recorded send is a frame
 * the endpoint asked for, and the test reports the disposition back explicitly, so
 * a test can distinguish "never dispatched" from "invoked and failed" from
 * "accepted", exactly as the future adapter will have to.
 */
internal class RosterClientHarness(
    val bounds: RosterBounds = RosterBounds.DEFAULT,
    val generation: Long = 7L,
    offeredCapabilities: List<String> = listOf(
        RosterWire.CLOSE_CAPABILITY,
        RosterWire.CREATE_CAPABILITY,
        RosterWire.SAVED_CAPABILITY,
        RosterWire.RENAME_CAPABILITY,
        RosterWire.ROSTER_SLOT_CAPABILITY,
    ),
    hostId: String = "host-1",
) {

    var now: Long = 1_000_000L
    private var counter = 0
    private fun nextId(): String = "id-${++counter}"

    val endpoint = RosterClientEndpoint(
        hostId = hostId,
        generation = generation,
        bounds = bounds,
        offeredCapabilities = offeredCapabilities,
        clock = { now },
        idFactory = { nextId() },
    )

    val sends: MutableList<RosterClientMessage> = mutableListOf()
    val armed: MutableMap<RosterDeadlineToken, Long> = LinkedHashMap()
    val events: MutableList<RosterClientEvent> = mutableListOf()
    var closeChannelCount: Int = 0

    fun advance(ms: Long) {
        now += ms
    }

    fun push(step: RosterClientStep): RosterClientStep {
        events += step.events
        for (effect in step.effects) {
            when (effect) {
                is RosterClientEffect.Send -> sends += effect.message
                is RosterClientEffect.ArmDeadline -> armed[effect.token] = effect.dueAtMs
                is RosterClientEffect.CancelDeadline -> armed.remove(effect.token)
                is RosterClientEffect.CloseChannel -> closeChannelCount += 1
            }
        }
        return step
    }

    /**
     * Report a healthy draining channel: every emitted write was accepted. A test
     * that needs the other dispositions calls [report] for a specific write instead.
     */
    fun drain() {
        for (message in sends.toList()) {
            push(endpoint.onSendDisposition(message.messageId, RosterSendDisposition.Completed))
        }
    }

    fun start(): RosterClientStep = push(endpoint.start())

    fun deliver(frame: RosterFrame): RosterClientStep =
        push(endpoint.onFrame(RosterProtocol.encode(frame, bounds)))

    /** Raw bytes, so a test can deliver something this side could never have built. */
    fun deliverRaw(bytes: ByteArray): RosterClientStep = push(endpoint.onFrame(bytes))

    fun acknowledgeHandshake(capabilities: List<String> = listOf(RosterWire.REQUIRED_CAPABILITY, RosterWire.CLOSE_CAPABILITY)) {
        deliver(RosterFrame.HelloAck(RosterWire.SERVICE, RosterWire.MAJOR, RosterWire.MINOR, capabilities))
    }

    fun fireDeadline(kind: RosterDeadlineKind): RosterClientStep {
        val token = armed.keys.firstOrNull { it.kind == kind } ?: error("no armed $kind deadline")
        armed.remove(token)
        return push(endpoint.onDeadline(token))
    }

    /**
     * Deliver one exact token callback, exactly as a coordinator that had it queued
     * before a re-arm would: the token is not consulted against [armed] first.
     */
    fun fireToken(token: RosterDeadlineToken): RosterClientStep = push(endpoint.onDeadline(token))

    fun report(messageIndex: Int, disposition: RosterSendDisposition): RosterClientStep =
        push(endpoint.onSendDisposition(sends[messageIndex].messageId, disposition))

    fun reportLast(disposition: RosterSendDisposition): RosterClientStep =
        push(endpoint.onSendDisposition(sends.last().messageId, disposition))

    /** The subscription id this side minted in its outgoing subscribe frame. */
    fun subscriptionId(): String = sends.mapNotNull { (it.frame as? RosterFrame.Subscribe)?.subscriptionId }.last()

    fun frames(): List<RosterFrame> = sends.map { it.frame }

    fun countOfType(type: String): Int = sends.count { it.frame.type == type }

    /** Handshake plus one subscription, stopping before any snapshot arrives. */
    fun subscribed(runId: String = RUN_ID): String {
        start()
        acknowledgeHandshake(ALL_CAPABILITIES)
        push(endpoint.subscribe())
        return subscriptionId()
    }

    /** One complete, coherent two-row snapshot published to the live subscription. */
    fun publishSnapshot(
        runId: String = RUN_ID,
        revision: Long = 1L,
        rows: List<RemoteSessionMetadata> = listOf(row("row-1"), row("row-2")),
        subscription: String = subscriptionId(),
    ) {
        val pages = rows.chunked(2).ifEmpty { listOf(emptyList()) }
        deliver(
            RosterFrame.SnapshotBegin(
                subscriptionId = subscription,
                transferId = "transfer-$revision",
                hostRunId = runId,
                revision = revision,
                totalRows = rows.size.toLong(),
                pageCount = pages.size.toLong(),
            ),
        )
        pages.forEachIndexed { index, page ->
            deliver(
                RosterFrame.SnapshotPage(
                    subscriptionId = subscription,
                    transferId = "transfer-$revision",
                    pageIndex = index.toLong(),
                    rows = page,
                ),
            )
        }
        deliver(
            RosterFrame.SnapshotEnd(
                subscriptionId = subscription,
                transferId = "transfer-$revision",
                revision = revision,
                totalRows = rows.size.toLong(),
            ),
        )
    }

    fun proof(ui: RosterUiProof = TRUE_PROOF): RosterSendProof.Control = RosterSendProof.Control(generation)

    /** Describe the owner's delete exposure for one run. */
    fun exposeDelete(runId: String = RUN_ID, exposed: Boolean = true) {
        deliver(RosterFrame.SavedPolicy(runId, exposed))
    }

    /**
     * Complete one Saved window through this endpoint so its entry handles become
     * genuinely owned, rather than asserting against handles the picker never fetched.
     */
    fun ownSavedWindow(
        runId: String = RUN_ID,
        catalogId: String = CATALOG_ID,
        resultId: String = RESULT_ID,
        entries: List<io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry> =
            (0 until 3).map { entry(it) },
        offset: Long = 0L,
        total: Long = entries.size.toLong(),
        queryRevision: Long = 1L,
    ) {
        push(
            endpoint.savedList(
                RosterSavedListCommand(
                    runId,
                    "",
                    offset,
                    entries.size.coerceAtLeast(1).toLong(),
                    readProof(generation, runId, queryRevision = queryRevision),
                ),
            ),
        )
        drain()
        val requestId = lastRequestOf("saved")
        val pageCount = 1L
        deliver(
            RosterFrame.SavedWindowBegin(
                requestId, runId, catalogId, resultId,
                total = total, issueCount = 0L, offset = offset, rows = entries.size.toLong(), pageCount = pageCount,
            ),
        )
        deliver(RosterFrame.SavedWindowPage(requestId, 0L, entries))
        deliver(RosterFrame.SavedWindowEnd(requestId, rows = entries.size.toLong(), pageCount = pageCount))
    }

    /** What the endpoint itself says about dispatching one emitted message right now. */
    fun decide(messageIndex: Int): RosterDispatchDecision = endpoint.decideDispatch(sends[messageIndex].messageId)

    /** The patience this endpoint currently states for its one pending Saved operation. */
    fun pendingSavedDeadline(): Long = endpoint.state().pending.single { it.kind.isSaved }.deadlineAtMs

    companion object {
        const val RUN_ID = "run-0001"
        const val CATALOG_ID = "catalog-1"
        const val RESULT_ID = "result-1"

        val ALL_CAPABILITIES: List<String> = listOf(
            RosterWire.REQUIRED_CAPABILITY,
            RosterWire.CLOSE_CAPABILITY,
            RosterWire.CREATE_CAPABILITY,
            RosterWire.SAVED_CAPABILITY,
            RosterWire.RENAME_CAPABILITY,
            RosterWire.ROSTER_SLOT_CAPABILITY,
        )

        val TRUE_PROOF: RosterUiProof = RosterUiProof { true }
        val FALSE_PROOF: RosterUiProof = RosterUiProof { false }
        val THROWING_PROOF: RosterUiProof = RosterUiProof { error("fence unavailable") }

        fun row(id: String, epoch: Long = 2L, name: String = "Conversation $id"): RemoteSessionMetadata =
            RemoteSessionMetadata(
                id = id,
                label = "Label $id",
                workspace = "/srv/owner/$id",
                lifecycle = io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle.ALIVE,
                hasLiveProcess = true,
                inputSurface = false,
                nativeSession = RemoteNativeSession(
                    sessionId = "session-$id",
                    epoch = epoch,
                    name = name,
                    persistence = RemoteNativePersistence.SAVED,
                ),
            )

        fun entry(index: Int): io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry =
            io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry(
                entryId = "entry-$index",
                sessionId = "saved-session-$index",
                file = "/srv/owner/saved/$index.jsonl",
                caption = "Saved $index",
                cwd = "/srv/owner/saved",
            )

        fun rowProof(generation: Long, runId: String, rowId: String, ui: RosterUiProof = TRUE_PROOF) =
            RosterSendProof.RowAction(generation, runId, rowId, ui = ui)

        fun formProof(generation: Long, runId: String, workspace: String, ui: RosterUiProof = TRUE_PROOF) =
            RosterSendProof.Form(generation, runId, workspace, ui)

        fun readProof(
            generation: Long,
            runId: String,
            catalogId: String? = null,
            resultId: String? = null,
            queryRevision: Long = 1L,
            ui: RosterUiProof = TRUE_PROOF,
        ) = RosterSendProof.PickerRead(generation, runId, catalogId, resultId, queryRevision = queryRevision, ui = ui)

        fun entryProof(
            generation: Long,
            runId: String,
            catalogId: String,
            resultId: String,
            entryId: String,
            pickerRevision: Long = 1L,
            ui: RosterUiProof = TRUE_PROOF,
        ) = RosterSendProof.PickerEntry(generation, runId, catalogId, resultId, entryId, pickerRevision = pickerRevision, ui = ui)
    }
}

/** Every settled operation event in order, as (kind, requestId, result). */
internal fun RosterClientHarness.settled(): List<Triple<RosterOperationKind, String, RosterRequestResult>> =
    events.filterIsInstance<RosterClientEvent.OperationSettled>()
        .map { Triple(it.kind, it.requestId, it.result) }

internal fun RosterClientHarness.refusals(): List<Pair<RosterOperationKind, RosterNotSentReason>> =
    events.filterIsInstance<RosterClientEvent.OperationRefused>().map { it.kind to it.reason }

internal fun RosterClientHarness.projectionEvents(): List<RosterProjection> =
    events.filterIsInstance<RosterClientEvent.ProjectionChanged>().map { it.projection }

internal fun RosterClientHarness.lastRequestOf(type: String): String = when (type) {
    "close_request" -> sends.mapNotNull { (it.frame as? RosterFrame.CloseRequest)?.requestId }.last()
    "create_request" -> sends.mapNotNull { (it.frame as? RosterFrame.CreateRequest)?.requestId }.last()
    "rename_request" -> sends.mapNotNull { (it.frame as? RosterFrame.RenameRequest)?.requestId }.last()
    else -> sends.mapNotNull {
        when (it.frame) {
            is RosterFrame.SavedListRequest -> it.frame.requestId
            is RosterFrame.SavedSearchRequest -> it.frame.requestId
            is RosterFrame.SavedWindowRequest -> it.frame.requestId
            is RosterFrame.SavedResumeRequest -> it.frame.requestId
            is RosterFrame.SavedDeleteRequest -> it.frame.requestId
            else -> null
        }
    }.last()
}
