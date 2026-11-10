package io.github.rfairburn.pireviewgate.acceptance

import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.content.ContentViewStatus
import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.runtime.*
import io.github.rfairburn.pireviewgate.core.hosts.*
import io.github.rfairburn.pireviewgate.core.identity.PinRecordResult
import io.github.rfairburn.pireviewgate.core.presentation.*
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.selects.select
import kotlinx.serialization.json.*

/** Explicit isolated graph. No AndroidClientPlatform, default stores, or app graph. */
class AcceptanceGraph(
    private val resources: NonceResources,
    private val manifest: AcceptanceManifest,
    private val activity: FixtureActivity,
    private val status: (String, String) -> Unit,
) {
    private data class Failure(val code: AcceptanceDiagnosticCode, val error: Throwable)
    private val failure = CompletableDeferred<Failure>()
    @Volatile private var checkpoint = AcceptanceCheckpoint.GRAPH_CREATED
    @Volatile private var channelClosureProven = false
    private fun fail(code: AcceptanceDiagnosticCode, error: Throwable) {
        failure.complete(Failure(code, error))
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default +
        CoroutineExceptionHandler { _, error -> fail(AcceptanceDiagnosticCode.COROUTINE_ERROR, error) })
    private val closing = AtomicBoolean(false)
    private val settings = AndroidClientStorage.settingsStore(resources.scopedContext)
    private val pins = AndroidClientStorage.pinStore(resources.scopedContext)
    private val identity = resources.identity
    private val recording = RecordingTransport {
        fail(AcceptanceDiagnosticCode.UNEXPECTED_FIRST_CONTACT, IllegalStateException("fixture rejects first contact"))
    }
    private val registry = HostConnectionRegistry(
        settings, pins, identity,
        promptValidator = CommittedPromptValidator { false }, // No first-contact UI exists here.
        transportFactory = recording,
        networkAccess = NetworkAccessAdmission { activity.hasNetworkGrant() },
    )
    private fun connected(host: HostId, generation: Long): Boolean =
        registry.snapshot.value.hosts.any {
            it.hostId == host && it.generation == generation && it.phase == HostConnectionPhase.CONNECTED
        }

    private val runtime = ClientRuntime(ContentChannelOpener { host, generation, guard ->
        check(guard.allows() && connected(host, generation))
        val opened = registry.openContentChannel(host) as? HostContentChannelResult.Opened
            ?: error("fixture content open refused")
        val handoff = opened.channel
        if (!guard.allows() || handoff.hostId != host || handoff.generation != generation ||
            !connected(host, generation)) {
            handoff.channel.close()
            error("fixture stale content handoff")
        }
        handoff.channel // Original channel retains registry association/send guards.
    })

    private sealed interface Handoff {
        data class Available(val value: HostAppChannel) : Handoff
        data class Lost(val value: HostChannelLost) : Handoff
    }
    private val handoffs = Channel<Handoff>(256)
    private val listener = object : HostConnectionListener {
        override fun onAppChannelAvailable(channel: HostAppChannel) {
            if (!handoffs.trySend(Handoff.Available(channel)).isSuccess) {
                fail(AcceptanceDiagnosticCode.HANDOFF_OVERFLOW, IllegalStateException("fixture handoff overflow"))
            }
        }
        override fun onChannelLost(lost: HostChannelLost) {
            if (!handoffs.trySend(Handoff.Lost(lost)).isSuccess && !closing.get()) {
                fail(AcceptanceDiagnosticCode.HANDOFF_OVERFLOW, IllegalStateException("fixture loss overflow"))
            }
        }
    }

    init { resources.graphStarted() }

    private fun startConsumers() {
        registry.addListener(listener)
        scope.launch {
            for (event in handoffs) when (event) {
                is Handoff.Available -> {
                    val h = event.value
                    if (closing.get() || !connected(h.hostId, h.generation)) continue
                    checkAdmission(runtime.attachHost(HostChannelBinding(h.hostId, h.channel, h.generation)) ==
                        HostAttachResult.Accepted, AcceptanceDiagnosticCode.APP_ATTACH_REFUSED)
                }
                is Handoff.Lost -> {
                    val h = event.value
                    if (!closing.get() && runtime.hostState(h.hostId)?.connectionGeneration == h.generation) {
                        fail(AcceptanceDiagnosticCode.APP_LOST, IllegalStateException("fixture APP lane lost"))
                        runtime.detachHost(h.hostId)
                    }
                }
            }
        }
        // The sole runtime event consumer. Never suspend it on command admission.
        scope.launch {
            for (event in runtime.events) when (event) {
                is ClientRuntimeEvent.Roster -> {
                    if (event.event is RosterClientEvent.HandshakeAccepted &&
                        connected(event.hostId, event.connectionGeneration) && !closing.get()) {
                        scope.launch {
                            checkAdmission(runtime.subscribeRoster(event.hostId) is RosterSubscriptionAdmission.Started,
                                AcceptanceDiagnosticCode.ROSTER_SUBSCRIBE_REFUSED)
                        }
                    }
                }
                is ClientRuntimeEvent.RosterChannelRetirementRequested -> {
                    if (!closing.get()) fail(AcceptanceDiagnosticCode.ROSTER_RETIREMENT,
                        IllegalStateException("fixture APP retirement requested"))
                }
                is ClientRuntimeEvent.ContentOpenFailed -> {
                    if (!closing.get()) fail(AcceptanceDiagnosticCode.CONTENT_OPEN_FAILED,
                        IllegalStateException("fixture content open failed"))
                }
                else -> Unit // No input/copy, committed-frame, or remote action receipts fabricated.
            }
        }
    }

    suspend fun run() {
        status("provisioning", "starting")
        checkpoint = AcceptanceCheckpoint.PROVISIONING
        check(resources.nonce == manifest.nonce)
        check(identity.current().key == manifest.clientKey) { "fixture client key mismatch" }
        // Run is single-use for this nonce; never reset, repair, or adopt a prior run.
        check(settings.read() == null && pins.snapshot().isEmpty()) { "fixture run already provisioned" }
        for (host in manifest.hosts) {
            check(registryStartNotDialing())
            check(pins.record(host.hostId, host.endpoint, host.key) == PinRecordResult.Recorded)
            check(canonicalPublicKey(host.key.keyId).fingerprint == host.key.fingerprint)
        }
        startConsumers()
        registry.start() // Default Auto is off; setup still performs no networking.
        for (host in manifest.hosts) {
            check(registry.addHost(host.hostId, HostLabel.parse(FIXTURE_LABEL), host.endpoint) == HostAddResult.Saved)
        }
        check(recording.attempts == 0)
        status("provisioning", "passed")
        status("permission", "starting")
        checkpoint = AcceptanceCheckpoint.PERMISSION_WAIT
        val permission = withTimeout(90_000) { activity.connect.await() }
        checkpoint = AcceptanceCheckpoint.PERMISSION_GRANT
        check(activity.hasNetworkGrant())
        status("permission_${permission.status}_${if (permission.requestedNow) "requested" else "existing"}", "passed")
        status("rosters64_revision2", "starting")
        checkpoint = AcceptanceCheckpoint.MEASUREMENT_WAIT
        val measured = withTimeout(15_000) { activity.measurement.await() }
        checkpoint = AcceptanceCheckpoint.GRID_ASSERTION
        check(measured.first >= 80 && measured.second >= 25) { "fixture pane too small" }
        checkpoint = AcceptanceCheckpoint.VIEWPORT_ADMISSION
        check(runtime.setViewport(measured.first, measured.second) is ViewportResult.Applied)
        checkpoint = AcceptanceCheckpoint.CONNECT_ADMISSION
        for (host in manifest.hosts) check(registry.connect(host.hostId) == HostCommandResult.Accepted)
        checkpoint = AcceptanceCheckpoint.REGISTRY_WAIT
        awaitState(registry.snapshot, 45_000) { s ->
            check(s.pendingConsents.isEmpty()) { "fixture refuses first-contact prompts" }
            s.hosts.size == 64 && s.hosts.all { it.phase == HostConnectionPhase.CONNECTED }
        }
        checkpoint = AcceptanceCheckpoint.ROSTER_REVISION2_WAIT
        val revisionTwo = awaitRosters(2)
        checkpoint = AcceptanceCheckpoint.ATTACHED64_ASSERTION
        check(revisionTwo.attachedHosts.size == 64)
        checkpoint = AcceptanceCheckpoint.MATRIX_REVISION2_ASSERTION
        assertMatrix(revisionTwo)
        status("rosters64_revision2", "passed")
        status("presentation_order", "starting")
        checkpoint = AcceptanceCheckpoint.PRESENTATION_ORDER
        checkOrder(revisionTwo)
        status("presentation_order", "passed")
        status("content64_and_APP_continuity", "starting")
        for (host in manifest.hosts) {
            checkpoint = AcceptanceCheckpoint.CONTENT_SELECTION
            val target = TerminalTarget(host.hostId, host.hostRunId, "shared-live")
            val proof = withContext(Dispatchers.Main) { activity.select(target) }
            val selected = runtime.selectTerminal(target, proof) as? SelectionResult.Selected
                ?: error("fixture terminal selection refused")
            checkpoint = AcceptanceCheckpoint.CONTENT_WAIT
            val current = awaitState(runtime.state, 20_000) { state ->
                val s = state.selection ?: return@awaitState false
                val o = s.observation
                val view = o.view ?: return@awaitState false
                s.selectionGeneration == selected.selectionGeneration && s.target == target &&
                    o.status == ContentViewStatus.CURRENT && o.target.hostId == host.hostId &&
                    o.target.ownerRunId == host.hostRunId && o.target.rowId == "shared-live" &&
                    view.meta.hostRunId == host.hostRunId && view.meta.rowId == "shared-live" &&
                    view.meta.subscriptionId == o.subscriptionId &&
                    view.frame.cols >= 80 && view.frame.rows >= 25 &&
                    view.frame.lines.any { it.contains("stable:${manifest.nonce}:${host.hostId.value}") }
            }
            checkpoint = AcceptanceCheckpoint.CONTENT_ASSERTION
            check(current.content?.writtenReceipt == null)
            check(current.attachedHosts.size == 64)
            assertMatrix(current)
        }
        checkpoint = AcceptanceCheckpoint.CONTINUITY_ASSERTION
        withContext(Dispatchers.Main) { activity.clearSelection() }
        check(runtime.leaveTerminal() is TerminalLeaveResult.Left)
        checkpoint = AcceptanceCheckpoint.ROSTER_REVISION3_WAIT
        val revisionThree = awaitRosters(3)
        checkpoint = AcceptanceCheckpoint.MATRIX_REVISION3_ASSERTION
        assertMatrix(revisionThree)
        checkpoint = AcceptanceCheckpoint.CONTINUITY_ASSERTION
        check(revisionThree.attachedHosts.size == 64 && revisionThree.selection == null)
        check(registry.snapshot.value.hosts.count { it.phase == HostConnectionPhase.CONNECTED } == 64)
        status("content64_and_APP_continuity", "passed")
        status("capacity65_no_transport", "starting")
        checkpoint = AcceptanceCheckpoint.CAPACITY_ASSERTION
        val extra = generateSequence { HostId.parse(UUID.randomUUID().toString()) }
            .first { candidate -> manifest.hosts.none { it.hostId == candidate } }
        val attempts = recording.attempts
        check(registry.addHost(extra, HostLabel.parse(FIXTURE_LABEL), manifest.hosts.first().endpoint) ==
            HostAddResult.CatalogRefused(CatalogFailureReason.TOO_MANY_HOSTS))
        check(registry.connect(extra) == HostCommandResult.Refused(HostCommandRefusal.UNKNOWN_HOST))
        check(recording.attempts == attempts)
        if (failure.isCompleted) throw failure.await().error
        status("capacity65_no_transport", "passed")
    }

    // Keep the original check failure internally; label only these known admission checks.
    private fun checkAdmission(accepted: Boolean, code: AcceptanceDiagnosticCode) {
        try { check(accepted) } catch (error: Throwable) {
            fail(code, error)
            throw error
        }
    }

    /** Failure-only sampling: never call the runtime's mutable/reentrant hostState getter here. */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun diagnosticEvidence(): AcceptanceDiagnosticEvidence {
        val connections = registry.snapshot.value
        val state = runtime.state.value
        val current = state.hosts.filter { it.roster.projection.state == RosterProjectionState.CURRENT }
        return AcceptanceDiagnosticEvidence(
            firstFailureCode = if (failure.isCompleted) failure.getCompleted().code else null,
            checkpoint = checkpoint,
            channelClosureProven = channelClosureProven,
            counts = AcceptanceDiagnosticCounts(
                registryConfigured = connections.hosts.size,
                registryNever = connections.hosts.count { it.phase == HostConnectionPhase.NEVER },
                registryConnecting = connections.hosts.count { it.phase == HostConnectionPhase.CONNECTING },
                registryPairing = connections.hosts.count { it.phase == HostConnectionPhase.PAIRING },
                registryConnected = connections.hosts.count { it.phase == HostConnectionPhase.CONNECTED },
                registryRetrying = connections.hosts.count { it.phase == HostConnectionPhase.RETRYING },
                registryDisconnected = connections.hosts.count { it.phase == HostConnectionPhase.DISCONNECTED },
                registryError = connections.hosts.count { it.phase == HostConnectionPhase.ERROR },
                runtimeAttached = state.attachedHosts.size,
                rosterCurrent = current.size,
                rosterCurrentRevision2 = current.count { it.roster.projection.revision == 2L },
                rosterCurrentRevision3 = current.count { it.roster.projection.revision == 3L },
                rosterEmpty = state.hosts.count { it.roster.projection.state == RosterProjectionState.EMPTY },
                rosterStale = state.hosts.count { it.roster.projection.state == RosterProjectionState.STALE },
                rosterAwaitingAck = state.hosts.count { it.roster.phase == RosterClientPhase.AWAITING_ACK },
                rosterFailed = state.hosts.count { it.roster.phase == RosterClientPhase.FAILED },
                rosterHandshakeTimeout = state.hosts.count {
                    it.roster.projection.reason == RosterStalenessReason.HANDSHAKE_TIMEOUT
                },
                transportAttempts = recording.attempts,
            ),
        )
    }

    private fun registryStartNotDialing(): Boolean = recording.attempts == 0

    private suspend fun awaitRosters(revision: Long): ClientRuntimeState = awaitState(runtime.state, 45_000) { s ->
        s.attachedHosts.size == 64 && manifest.hosts.all { host ->
            s.hosts.singleOrNull { it.hostId == host.hostId }?.roster?.projection?.let {
                it.state == RosterProjectionState.CURRENT && it.hostRunId == host.hostRunId && it.revision == revision
            } == true
        }
    }

    private fun assertMatrix(state: ClientRuntimeState) {
        manifest.hosts.forEachIndexed { i, h ->
            val p = state.hosts.single { it.hostId == h.hostId }.roster.projection
            check(p.state == RosterProjectionState.CURRENT && p.hostRunId == h.hostRunId)
            MetadataMatrix.assertReceived(i, h, p.rows)
        }
    }

    private fun checkOrder(state: ClientRuntimeState) {
        // Feed RECEIVED rows, not expected fixtures, to the actual coordinator/store.
        val observed = manifest.hosts.flatMap { h ->
            val p = state.hosts.single { it.hostId == h.hostId }.roster.projection
            p.rows.map { RemotePresentationObservedRow(h.hostId, p.hostRunId, it.id, it.rosterSlotId) }
        }
        val settingsBefore = settings.read()
        val pinsBefore = pins.snapshot()
        val runtimeBefore = runtime.state.value
        val coordinator = RemotePresentationOrderCoordinator(
            store = AndroidClientStorage.presentationOrderStore(resources.scopedContext),
        )
        val identities: List<RemotePresentationIdentity>
        val ordered: List<RemotePresentationRuntimeKey>
        coordinator.use {
            check(it.observe(observed).save == RemotePresentationOrderWriteResult.Published)
            val original = it.visibleOrder(observed)
            check(original.size == 128 && original.toSet().size == 128)
            val moved = it.reorder(observed, original.last(), original.first(), RemotePresentationMovePosition.BEFORE)
            check(moved is RemotePresentationMoveResult.Moved && moved.save == RemotePresentationOrderWriteResult.Published)
            ordered = it.visibleOrder(observed)
            check(ordered == listOf(original.last()) + original.dropLast(1))
            identities = it.identities()
        }
        RemotePresentationOrderCoordinator(
            store = AndroidClientStorage.presentationOrderStore(resources.scopedContext),
        ).use {
            check(it.identities() == identities && it.visibleOrder(observed) == ordered)
        }
        val document = RemotePresentationOrderStorage.storage(File(resources.root, "peer-client")).read()
            as? DocumentRead.Present ?: error("fixture order not persisted")
        val root = Json.parseToJsonElement(document.bytes.decodeToString()).closedObject("version", "entries")
        check(root["version"] == JsonPrimitive(1))
        val entries = root["entries"] as JsonArray
        check(entries.size == 128)
        for (entry in entries) {
            val e = entry.closedObject("hostId", "owner")
            e.getValue("owner").closedObject("kind", "id")
        }
        check(RemotePresentationOrderDocumentCodec.decode(document.bytes) is RemotePresentationOrderDecodeResult.Valid)
        check(settings.read() == settingsBefore && pins.snapshot() == pinsBefore)
        check(runtime.state.value == runtimeBefore) { "presentation reorder altered runtime" }
    }

    private suspend fun <T> awaitState(flow: StateFlow<T>, timeout: Long, predicate: (T) -> Boolean): T =
        withTimeout(timeout) {
            coroutineScope {
                val waiting = async { flow.first(predicate) }
                try {
                    select {
                        failure.onAwait { throw it.error }
                        waiting.onAwait { it }
                    }
                } finally { waiting.cancel() }
            }
        }

    /** Failure/uncertain close prevents deletion; the caller must preserve the nonce. */
    suspend fun closeAndAwait() = withContext(NonCancellable) {
        withTimeout(120_000) {
            closing.set(true)
            try { runtime.close() } finally {
                recording.sealAndDispose()
                registry.close()
            }
            recording.awaitClosed()
            registry.removeListener(listener)
            handoffs.close()
            scope.cancel()
            scope.coroutineContext[Job]!!.join()
            settings.close()
            pins.close()
            identity.close()
            resources.graphClosed()
            channelClosureProven = true // Diagnostic-only milestone, never cleanup authority.
            if (failure.isCompleted) throw failure.await().error
        }
    }
}
