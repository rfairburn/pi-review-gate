package io.github.rfairburn.pireviewgate.client.application

import android.content.Context
import io.github.rfairburn.pireviewgate.client.platform.AndroidClientPlatform
import io.github.rfairburn.pireviewgate.core.client.application.*
import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.content.*
import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.runtime.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.client.runtime.TerminalTarget as RuntimeTarget
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalTarget as UiTerminalTarget
import io.github.rfairburn.pireviewgate.core.hosts.*
import io.github.rfairburn.pireviewgate.core.input.InputSettlementBook
import io.github.rfairburn.pireviewgate.core.input.OrderedInputAdmission
import io.github.rfairburn.pireviewgate.core.presentation.*
import io.github.rfairburn.pireviewgate.core.protocol.roster.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicBoolean

/** Production composition. All presentation mutations are confined to Main. */
class ClientApplicationController private constructor(
    val platform: AndroidClientPlatform,
    private val order: RemotePresentationOrderCoordinator,
    private val prompt: AtomicReference<PromptStanding?>,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val registry get() = platform.registry
    val runtime = ClientRuntime(ContentChannelOpener { host, generation, _ ->
        val before = registry.snapshot.value.hosts.firstOrNull { it.hostId == host }
        check(before != null && before.generation == generation && before.phase == HostConnectionPhase.CONNECTED)
        val opened = registry.openContentChannel(host) as? HostContentChannelResult.Opened
            ?: error("content channel unavailable")
        val channel = opened.channel
        val now = registry.snapshot.value.hosts.firstOrNull { it.hostId == host }
        if (channel.hostId != host || channel.generation != generation ||
            now == null || now.generation != generation || now.phase != HostConnectionPhase.CONNECTED) {
            channel.channel.close()
            error("content channel superseded")
        }
        // The ORIGINAL channel retains the registry's internal association/send guard.
        channel.channel
    }).also {
        it.setAppForeground(false)
        it.setTerminalInputCoverage(false)
    }
    private val projection = ClientProjection()
    private val state = MutableStateFlow(ClientUiState())
    val ui = state.asStateFlow()
    private val notice = MutableStateFlow<String?>(null)
    val status = notice.asStateFlow()
    val navigation = AcceptedNavigation()
    private val establishedWanted = AtomicReference<AcceptedNavigation.Wanted?>()
    private val terminalRouteActive = AtomicBoolean(false)
    private val measuredWindow = AtomicBoolean(false)
    private var terminalTitle = ""
    private var terminalHostLabel = ""
    private var displayedContent: Pair<HostId, Long>? = null
    private var route: ClientRoute = ClientRoute.Sessions
    private var dialogs = ClientDialogs.NONE
    private var saved = SavedUiState.EMPTY
    private var savedEpoch = 0L
    private var savedDeleteScope: SavedResultTarget? = null
    private var savedDeletion: AcceptedSavedDeletion? = null
    private fun cancelSavedDeletion() { savedDeletion?.cancel(); savedDeletion = null }
    // Only the owner-returned row of an accepted create may be activated here, once.
    private var createdActivation: AcceptedCreateActivation? = null
    // The exact in-flight create form. A newer explicit intent retires its delayed
    // navigation but keeps this receipt so the exact form can still close on Started.
    private var submittedCreate: AcceptedCreateActivation? = null
    private fun cancelSubmittedCreate(activation: AcceptedCreateActivation) {
        activation.cancel()
        if (submittedCreate === activation) submittedCreate = null
    }
    private fun cancelCreatedActivation() {
        createdActivation?.cancel(); createdActivation = null
    }
    private fun supersedeSubmittedCreate() {
        // Retire delayed navigation, but keep the exact submitted receipt so an actual
        // owner `started` can still close its form and prevent a duplicate create.
        submittedCreate?.supersede()
    }
    private var savedConnectionGeneration: Long? = null
    // Status-only pending feedback for the exact admitted user LIST/SEARCH; never a proof.
    private val savedFeedback = SavedReadFeedback()
    // The one post-delete refresh whose synchronously raised pending display it owns.
    private val savedRefreshFeedback = SavedRefreshFeedback()
    private var savedResultGeneration: Long? = null // Channel of the adopted result's sequence.
    private val savedReadSettlements = SavedReadSettlementFence() // Every projected read, data or not.
    private fun savedView() = SavedReadFeedback.View(saved.selectedHostId, saved.hostRunId, saved.query,
        savedEpoch, saved.selectedHostId?.let { generation(it) }, route is ClientRoute.Saved)
    private var coverage = UiCoverage.NONE
    private var chooser = false
    private var keyboard = false
    private var extraKeys = false
    private var modifiers = TerminalModifiers.NONE
    private var proofGeneration = 0L
    private val proofs = LinkedHashMap<Any, MutableUiActionProof>()
    private val channels = mutableMapOf<HostId, HostAppChannel>()
    private val hostLocks = mutableMapOf<HostId, Mutex>()
    private val connectionCommands = HostCommandSequencer()
    private val orderLock = Mutex()
    private val preferenceLock = Mutex()
    private var orderRevision = 0L
    private var policyGeneration = 0L
    private var policyEnabled: Boolean? = null
    val policyChangePending = AtomicBoolean(false)
    private var policyRequest = 0L
    private val events = Channel<RegistryEvent>(Channel.UNLIMITED)
    private val operations = OperationCorrelation<OperationContext>()
    private val busyForms = mutableSetOf<UiActionProof>()
    private val addressEdit = AcceptedAddressEdit()
    fun cancelAddressEdit() { addressEdit.cancel() }
    private data class InputScope(val host: HostId, val selection: Long)
    private data class InputKey(val host: HostId, val selection: Long, val id: String, val ordinal: Long)
    private class NativeInput(val request: ContentInputRequest, val proof: RosterUiProof)
    /** At most 64 native inputs admitting or awaiting settlement; each keeps its not-sent notice. */
    private val nativeInputs = InputSettlementBook<InputScope, InputKey, ContentSendOutcome, () -> Unit>(64) {
        InputScope(it.host, it.selection)
    }
    /** One consumer, so native inputs reach admission in the order the surface handed them off. */
    private val nativeAdmission = OrderedInputAdmission<NativeInput, ContentInputAdmission>(scope, Dispatchers.Default) {
        runtime.submitInput(it.request, it.proof)
    }
    var window: ClientWindow? = null
        private set

    private sealed interface RegistryEvent {
        data class Available(val value: HostAppChannel) : RegistryEvent
        data class Lost(val value: HostChannelLost) : RegistryEvent
    }
    private val listener = object : HostConnectionListener {
        override fun onAppChannelAvailable(channel: HostAppChannel) { events.trySend(RegistryEvent.Available(channel)) }
        override fun onChannelLost(lost: HostChannelLost) { events.trySend(RegistryEvent.Lost(lost)) }
        // CONTENT is handed directly to the opener, never consumed by this listener.
    }

    fun start() {
        registry.addListener(listener)
        // Exactly one registry-event consumer. Each host's handoffs serialize independently.
        scope.launch {
            for (event in events) {
                val host = when (event) {
                    is RegistryEvent.Available -> event.value.hostId
                    is RegistryEvent.Lost -> event.value.hostId
                }
                val lock = hostLocks.getOrPut(host) { Mutex() }
                scope.launch {
                    lock.withLock {
                        when (event) {
                            is RegistryEvent.Available -> {
                                val channel = event.value
                                val fact = registry.snapshot.value.hosts.firstOrNull { it.hostId == host }
                                if (fact == null || fact.generation != channel.generation || fact.phase != HostConnectionPhase.CONNECTED) return@withLock
                                val previous = channels[host]
                                if (previous === channel || (previous != null && previous.generation >= channel.generation)) return@withLock
                                if (previous != null) runtime.detachHost(host)
                                // Recheck after suspending detach: no late handoff adopts a retired attempt.
                                val latest = registry.snapshot.value.hosts.firstOrNull { it.hostId == host }
                                if (latest == null || latest.generation != channel.generation || latest.phase != HostConnectionPhase.CONNECTED) return@withLock
                                channels[host] = channel
                                val attached = runtime.attachHost(HostChannelBinding(host, channel.channel, channel.generation))
                                if (attached is HostAttachResult.Refused) {
                                    channels.remove(host)
                                    withContext(Dispatchers.IO) { channel.channel.close() }
                                }
                            }
                            is RegistryEvent.Lost -> {
                                val lost = event.value
                                if (channels[host]?.generation == lost.generation) {
                                    channels.remove(host)
                                    runtime.detachHost(host)
                                }
                            }
                        }
                    }
                }
            }
        }
        // Never await command admission in this consumer: endpoint publication precedes replies.
        scope.launch { for (event in runtime.events) consume(event) }
        scope.launch {
            registry.snapshot.collect { snapshot ->
                runtime.setAppForeground(snapshot.foreground)
                if (!snapshot.foreground) cancelNavigation()
                addressEdit.observe(snapshot)
                window?.catalogChanged(snapshot)
                if (policyEnabled != snapshot.viewerRemoteInputEnabled) {
                    policyEnabled = snapshot.viewerRemoteInputEnabled
                    window?.retireTerminal()
                    val next = ContentInputPolicy(snapshot.viewerRemoteInputEnabled, ++policyGeneration)
                    scope.launch { runtime.updateInputPolicy(next) }
                }
                refresh()
            }
        }
        scope.launch { runtime.state.collect { refresh() } }
        refresh()
    }

    private fun consume(event: ClientRuntimeEvent) {
        when (event) {
            is ClientRuntimeEvent.Roster -> {
                when (val rosterEvent = event.event) {
                    is RosterClientEvent.HandshakeAccepted -> {
                        if (channels[event.hostId]?.generation == event.connectionGeneration &&
                            runtime.hostState(event.hostId)?.connectionGeneration == event.connectionGeneration) {
                            scope.launch { runtime.subscribeRoster(event.hostId) }
                        }
                    }
                    is RosterClientEvent.OperationSettled -> {
                        operations.settle(OperationKey(event.hostId, event.connectionGeneration, rosterEvent.kind, rosterEvent.requestId), rosterEvent)
                            ?.let { finish(it.first, it.second) }
                    }
                    else -> Unit // Other roster facts are projected from runtime.state, unchanged.
                }
            }
            is ClientRuntimeEvent.RosterChannelRetirementRequested -> {
                val channel = channels[event.hostId]?.takeIf { it.generation == event.connectionGeneration }
                if (channel != null) scope.launch(Dispatchers.IO) { channel.channel.close() }
            }
            is ClientRuntimeEvent.TerminalCopyOffered -> window?.deliverCopy(event)
            is ClientRuntimeEvent.Content -> {
                val settled = event.event as? ContentEndpointEvent.InputSettled
                if (settled != null) settleInput(InputKey(event.hostId, event.selectionGeneration, settled.inputId, settled.ordinal), settled.outcome)
                else if (displayedContent == (event.hostId to event.selectionGeneration)) {
                    when (val content = event.event) {
                        is ContentEndpointEvent.ViewCleared -> report("Terminal unavailable: ${content.reason.name}")
                        is ContentEndpointEvent.Retired -> report("Terminal unavailable: ${content.reason.name}")
                        else -> Unit // The complete frame and negotiation facts are projected, not fabricated.
                    }
                }
            }
            is ClientRuntimeEvent.ContentOpenFailed -> if (displayedContent == (event.hostId to event.selectionGeneration)) {
                report("Terminal unavailable: ${event.reason.name}")
            }
            is ClientRuntimeEvent.HostAttachRefused -> report("Host channel not attached: ${event.reason.name}")
            else -> Unit // Selection/lane/policy state is rendered from the published state flow.
        }
        refresh()
    }

    fun attachWindow(next: ClientWindow) {
        window?.retireWindow()
        window = next
        refresh()
    }
    fun detachWindow(previous: ClientWindow) {
        if (window !== previous) return
        previous.retireWindow()
        window = null
    }

    private fun proof(key: Any, screen: UiProofScreen, host: HostId,
                      run: String? = null, row: String? = null, catalog: String? = null,
                      result: String? = null, entry: String? = null, request: String? = null): MutableUiActionProof {
        val existing = proofs[key]
        if (existing?.isCurrent == true) return existing
        return MutableUiActionProof(UiActionTargetToken(screen, host, run, row, catalog, result, entry, request, ++proofGeneration))
            .also { proofs[key] = it }
    }
    private val localFormHost = HostId.generate() // Only a proof namespace, never saved or dialed.

    private fun retireCoveredDialogProofs() {
        val standing = listOf(
            ClientDialogKind.ADD_HOST to dialogs.addHost?.proof,
            ClientDialogKind.EDIT_HOST_ADDRESS to dialogs.editHostAddress?.proof,
            ClientDialogKind.REMOVE_HOST to dialogs.removeHost?.proof,
            ClientDialogKind.FIRST_CONTACT_CONSENT to dialogs.firstContactConsent?.proof,
            ClientDialogKind.CREATE_SESSION to dialogs.createSession?.proof,
            ClientDialogKind.RENAME_SESSION to dialogs.renameSession?.proof,
            ClientDialogKind.CLOSE_SESSION to dialogs.closeSession?.proof,
            ClientDialogKind.SAVED_DELETE to dialogs.savedDelete?.proof,
        )
        standing.forEach { (kind, proof) ->
            if (dialogs.isCovered(kind)) (proof as? MutableUiActionProof)?.invalidate(UiProofInvalidationReason.COVERAGE_CHANGE)
        }
    }

    private fun refresh() {
        savedDeletion?.let {
            it.observe(saved, savedEpoch, dialogs.savedDelete?.proof,
                dialogs.openKinds.any { kind -> kind != ClientDialogKind.SAVED_DELETE })
            it.isStillCurrent() // Latch observed window/owner loss even if those facts later return.
        }
        val registryState = registry.snapshot.value
        var runtimeState = runtime.state.value
        runtimeState.selection?.let { displayedContent = it.target.hostId to it.selectionGeneration }
        var hosts = projection.hosts(registryState, runtimeState)
        hosts = hosts.map { host ->
            val roster = host.roster
            if (roster == null) host else host.copy(roster = roster.copy(rows = roster.rows.map { row ->
                val generation = registryState.hosts.first { it.hostId == row.hostId }.generation
                row.copy(selectProof = if (row.stale || route !is ClientRoute.Sessions || dialogs.hasModal || coverage != UiCoverage.NONE) null else proof(
                    listOf("row", generation, SessionActionTarget.of(row)), UiProofScreen.SESSION_CLOSE,
                    row.hostId, row.hostRunId, row.rowId,
                ))
            }))
        }
        // The form's semantic key includes only its explicitly selected owner identity
        // and draft, not unrelated hosts' connection chatter. Keep choices truthful,
        // while retaining the exact committed pending form through writer dispatch.
        dialogs.createSession?.let { form ->
            if (form.proof !in busyForms) {
                val owners = hosts.map { OwnerChoice(it.host.id, it.host.label.value, it.host.endpoint.displayText(), it.connection, it.canCreateSession) }
                val selected = owners.firstOrNull { it.hostId == form.selectedHostId }
                val nextProof = selected?.let {
                    proof(listOf("create-binding", it.hostId, generation(it.hostId), currentRun(it.hostId),
                        it.label, it.endpointDisplayText, form.workspaceDraft), UiProofScreen.SESSION_CREATE,
                        it.hostId, currentRun(it.hostId))
                } ?: form.proof
                if (nextProof !== form.proof) (form.proof as? MutableUiActionProof)?.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
                if (form.owners != owners || nextProof !== form.proof) dialogs = dialogs.copy(createSession = form.copy(owners = owners, proof = nextProof))
            }
        }
        val consent = registryState.pendingConsents.firstOrNull()
        val shown = prompt.get()
        if (shown?.consent != consent || (shown != null && !shown.proof.isCurrent &&
                !dialogs.isCovered(ClientDialogKind.FIRST_CONTACT_CONSENT))) {
            (dialogs.firstContactConsent?.proof as? MutableUiActionProof)?.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
            prompt.set(null)
            dialogs = dialogs.copy(firstContactConsent = consent?.let {
                val p = proof(listOf("consent", it), UiProofScreen.HOST_FIRST_CONTACT_CONSENT, it.hostId)
                prompt.set(PromptStanding(it, p))
                FirstContactConsentDialog(it.hostId, it.label, it.endpoint.displayText(), it.fingerprint,
                    // Registry monotonic clock uses nanoTime, Android dialog uses elapsedRealtime.
                    android.os.SystemClock.elapsedRealtime() + ((it.expiresAtMonoMs - System.nanoTime() / 1_000_000L).coerceAtLeast(0L)), p)
            })
        }
        retireCoveredDialogProofs()
        renewDialogProofs()
        observeCloseDialog(registryState)
        observeSubmittedCreate(hosts, registryState)
        observeCreatedActivation(hosts, registryState)
        // Created activation may have withdrawn an old selection synchronously; the
        // terminal-route build and window publication below must see that state.
        runtimeState = runtime.state.value
        val savedHost = saved.selectedHostId?.let { id -> hosts.firstOrNull { it.host.id == id } }
        val savedRun = savedHost?.roster?.takeIf { it.freshness == RosterFreshness.CURRENT }?.hostRunId
        val savedGeneration = saved.selectedHostId?.let { generation(it) }
        if (savedConnectionGeneration != savedGeneration) {
            retireSavedProofs()
            savedConnectionGeneration = savedGeneration
            if (saved.resultId != null) saved = saved.copy(status = SavedRequestStatus.Unknown)
        }
        if (savedRun != null && saved.hostRunId != savedRun) {
            retireSavedProofs()
            savedEpoch++
            saved = SavedUiState(selectedHostId = saved.selectedHostId, hostRunId = savedRun, query = saved.query)
        }
        saved = savedFeedback.observe(savedView(), saved)
        // The post-delete LIST is not tracked by that helper; a canceled continuation
        // retires only its own pending display, never a replacement read's Requesting.
        saved = savedRefreshFeedback.observe(saved, trackedRead = savedFeedback.pending != null)
        if (savedHost != null && savedRun == saved.hostRunId && route is ClientRoute.Saved) {
            val generation = registryState.hosts.firstOrNull { it.hostId == savedHost.host.id }?.generation
            val result = SavedResultTarget.of(saved)
            val ownership = runtime.hostState(savedHost.host.id)?.roster?.savedOwnership
            val resultOwned = ownership != null && ownership.hostRunId == saved.hostRunId &&
                ownership.catalogId == saved.catalogId && ownership.resultId == saved.resultId
            val controlsVisible = !dialogs.hasModal && coverage == UiCoverage.NONE
            val baseKey = listOf("saved-list", generation, saved.selectedHostId, saved.hostRunId, saved.query,
                saved.catalogId, saved.requestId, saved.sequence)
            saved = saved.copy(
                listProof = saved.hostRunId?.takeIf { controlsVisible }?.let { proof(baseKey, UiProofScreen.SESSION_CREATE, savedHost.host.id, it) },
                windowProof = result?.takeIf { resultOwned && controlsVisible }?.let { proof(listOf("saved-window", generation, it), UiProofScreen.SAVED_DELETE,
                    it.hostId, it.hostRunId, catalog = it.catalogId, result = it.resultId, request = it.requestId) },
                entryProofs = saved.entries.filter { entry -> controlsVisible && resultOwned && ownership?.windows?.any { entry.entryId in it.entryIds } == true }.mapNotNull { entry ->
                    val target = SavedEntryTarget.of(saved, entry) ?: return@mapNotNull null
                    SavedEntryKey.of(target) to SavedEntryControlProofs(
                        proof(listOf("resume", generation, result, target), UiProofScreen.SAVED_DELETE, target.hostId, target.hostRunId,
                            catalog = target.catalogId, result = target.resultId, entry = target.entryId),
                        proof(listOf("prepare", generation, result, target), UiProofScreen.SAVED_DELETE, target.hostId, target.hostRunId,
                            catalog = target.catalogId, result = target.resultId, entry = target.entryId),
                    )
                }.toMap(),
            )
        }
        val wanted = navigation.wanted()
        if (wanted != null && !wantedFactsHold(wanted)) cancelNavigation()
        // These are native facts/atomics; terminal eligibility is distinct from a
        // consent dialog's independently committed proof.
        updateCoverage()
        val terminalRoute = route is ClientRoute.Terminal
        if (terminalRoute) {
            val previous = (route as ClientRoute.Terminal).terminal
            val target = navigation.wanted()?.target ?: runtimeState.selection?.target ?: RuntimeTarget(
                previous.target.hostId, previous.target.hostRunId, previous.target.rowId)
            if (target != null) {
                val host = hosts.firstOrNull { it.host.id == target.hostId }
                route = ClientRoute.Terminal(TerminalUiState(
                    UiTerminalTarget(target.hostId, target.ownerRunId, target.rowId,
                        runtimeState.selection?.selectionGeneration ?: navigation.wanted()?.epoch ?: previous.target.selectionGeneration),
                    host?.rows?.firstOrNull { it.hostRunId == target.ownerRunId && it.rowId == target.rowId }?.displayTitle ?: terminalTitle,
                    host?.host?.label?.value ?: terminalHostLabel, host?.connection ?: HostConnectionState.DISCONNECTED,
                    host?.roster?.freshness, coverage, runtimeState.terminalInputAdmissionOpen && window?.inputReady() == true,
                    keyboard, extraKeys, modifiers, chooser,
                    if (chooser) hosts.flatMap { it.rows }.filter { !it.stale }.associate { row ->
                        SessionRowKey.of(row) to proof(listOf("chooser", SessionActionTarget.of(row),
                            registryState.hosts.first { it.hostId == row.hostId }.generation), UiProofScreen.SESSION_CLOSE,
                            row.hostId, row.hostRunId, row.rowId)
                    } else emptyMap(),
                ))
            }
        }
        val failure = registryState.storage.settings.reason ?: registryState.storage.trust.reason
        val nextUi = ClientUiState(
            route, NetworkSettings(
                autoReconnect = registryState.autoReconnectEnabled,
                viewerRemoteInputEnabled = registryState.viewerRemoteInputEnabled,
                hosts = HostCatalog.of(hosts.map { it.host }),
                savedFirstReplyTimeoutSeconds = registryState.savedFirstReplyTimeoutSeconds,
                debugInputMessagingEnabled = registryState.debugInputMessagingEnabled,
                appearance = registryState.appearance,
            ), hosts, state.value.rowOrder, saved, dialogs,
            when (val identity = registryState.identity) {
                is DeviceIdentityObservation.Ready -> ClientIdentityState.Ready(identity.fingerprint)
                DeviceIdentityObservation.NeverInitialized -> ClientIdentityState.NotInitialized
                is DeviceIdentityObservation.Refused -> ClientIdentityState.Refused(when (identity.reason) {
                    DeviceIdentityReason.MISSING_INITIALIZED -> StorageFailureReason.MISSING_INITIALIZED
                    DeviceIdentityReason.INCONSISTENT -> StorageFailureReason.MALFORMED
                    DeviceIdentityReason.UNSAFE_KEY_MATERIAL -> StorageFailureReason.UNSAFE_OBJECT
                    DeviceIdentityReason.KEY_STORE_UNAVAILABLE, DeviceIdentityReason.KEY_UNUSABLE -> StorageFailureReason.UNAVAILABLE
                })
            },
            if (failure == null) ClientStorageState.Healthy else ClientStorageState.Refused(failure),
            window?.permissionObservation(), coverage,
        )
        retireUnusedProofs(nextUi)
        state.value = nextUi
        window?.publish(runtimeState)
        val rows = hosts.presentationRows()
        if (rows != lastOrderRows) {
            lastOrderRows = rows
            val revision = ++orderRevision
            scope.launch {
                val keys = withContext(Dispatchers.IO) { orderLock.withLock {
                    val observed = order.observe(rows)
                    if (observed.save is RemotePresentationOrderWriteResult.Refused) withContext(Dispatchers.Main) { report("Local ordering could not be saved") }
                    order.visibleOrder(rows).mapNotNull { key -> key.hostRunId?.let { SessionRowKey(key.hostId, it, key.rowId) } }
                } }
                if (revision == orderRevision) state.value = state.value.copy(rowOrder = keys)
            }
        }
        // Drop only retired proof objects; live controls own their layout/commit epochs.
        proofs.entries.removeAll { !it.value.isCurrent && it.value !in busyForms }
    }
    private var lastOrderRows: List<RemotePresentationObservedRow> = emptyList()

    private fun retireUnusedProofs(next: ClientUiState) {
        val used = mutableSetOf<UiActionProof>()
        if (next.route is ClientRoute.Sessions && !next.dialogs.hasModal && next.coverage == UiCoverage.NONE) {
            next.hostStates.flatMap { it.rows }.mapNotNullTo(used) { it.selectProof }
        }
        (next.route as? ClientRoute.Terminal)?.terminal?.chooserProofs?.values?.let { used.addAll(it) }
        used.addAll(listOfNotNull(next.dialogs.addHost?.proof, next.dialogs.editHostAddress?.proof, next.dialogs.removeHost?.proof,
            next.dialogs.firstContactConsent?.proof, next.dialogs.createSession?.proof,
            next.dialogs.renameSession?.proof, next.dialogs.closeSession?.proof, next.dialogs.savedDelete?.proof))
        if (next.route is ClientRoute.Saved && !next.dialogs.hasModal && next.coverage == UiCoverage.NONE) {
            used.addAll(listOfNotNull(next.saved.listProof, next.saved.windowProof))
            next.saved.entryProofs.values.forEach { used.addAll(listOfNotNull(it.resume, it.deletePrepare)) }
        }
        proofs.values.forEach { if (it !in used) it.invalidate(UiProofInvalidationReason.TARGET_CHANGE) }
    }

    private fun retireSavedProofs() {
        val values = listOfNotNull(saved.listProof, saved.windowProof, dialogs.savedDelete?.proof) +
            saved.entryProofs.values.flatMap { listOfNotNull(it.resume, it.deletePrepare) }
        values.forEach { (it as? MutableUiActionProof)?.invalidate(UiProofInvalidationReason.TARGET_CHANGE) }
    }

    private fun renewDialogProofs() {
        fun renew(old: UiActionProof, kind: ClientDialogKind): UiActionProof {
            if (old.isCurrent || old in busyForms || dialogs.isCovered(kind)) return old
            val token = old.target
            return proof(listOf("renew", token, ++proofGeneration), token.screen, token.hostId,
                token.hostRunId, token.rowId, token.catalogId, token.resultId, token.entryId, token.requestId)
        }
        dialogs = dialogs.copy(
            addHost = dialogs.addHost?.let { it.copy(proof = renew(it.proof, ClientDialogKind.ADD_HOST)) },
            editHostAddress = dialogs.editHostAddress?.let { it.copy(proof = renew(it.proof, ClientDialogKind.EDIT_HOST_ADDRESS)) },
            removeHost = dialogs.removeHost?.let { it.copy(proof = renew(it.proof, ClientDialogKind.REMOVE_HOST)) },
            createSession = dialogs.createSession?.let { it.copy(proof = renew(it.proof, ClientDialogKind.CREATE_SESSION)) },
            renameSession = dialogs.renameSession?.let { it.copy(proof = renew(it.proof, ClientDialogKind.RENAME_SESSION)) },
            closeSession = dialogs.closeSession?.let { it.copy(proof = renew(it.proof, ClientDialogKind.CLOSE_SESSION)) },
            savedDelete = dialogs.savedDelete?.let { it.copy(proof = renew(it.proof, ClientDialogKind.SAVED_DELETE)) },
        )
    }

    private fun wantedFactsHold(wanted: AcceptedNavigation.Wanted): Boolean {
        if (!navigation.isCurrent(wanted) || !registry.snapshot.value.foreground) return false
        val host = runtime.hostState(wanted.target.hostId) ?: return false
        val roster = host.roster.projection
        return host.connectionGeneration == wanted.connectionGeneration && host.lane == HostLanePhase.ATTACHED &&
            roster.state == RosterProjectionState.CURRENT && roster.hostRunId == wanted.target.ownerRunId &&
            roster.rows.any { it.id == wanted.target.rowId }
    }

    fun measured(cols: Int, rows: Int) {
        if (route !is ClientRoute.Terminal) return
        if (runtime.setViewport(cols, rows) !is ViewportResult.Applied) return
        measuredWindow.set(true)
        val wanted = navigation.wanted()
        if (wanted != null) {
            if (!wantedFactsHold(wanted)) { cancelNavigation(); return }
            if (runtime.state.value.selection?.target == wanted.target) return
            when (val result = runtime.selectTerminal(wanted.target, RosterUiProof { wantedFactsHold(wanted) })) {
                is SelectionResult.Selected -> {
                    displayedContent = wanted.target.hostId to result.selectionGeneration
                    establishedWanted.set(wanted)
                    runtime.rememberTerminalTarget(wanted.target, establishedProof(wanted))
                }
                is SelectionResult.Refused -> report("Terminal not opened: ${result.reason.name}")
            }
        } else {
            // Only a formerly ESTABLISHED deliberate target may return. Pending first-open
            // navigation was cancelled on background/window retirement and never reaches here.
            val established = establishedWanted.get() ?: return
            if (runtime.state.value.selection != null) return
            val proof = establishedProof(established)
            if (proof.isStillCurrent()) {
                val result = runtime.selectTerminal(established.target, proof)
                if (result is SelectionResult.Selected) {
                    displayedContent = established.target.hostId to result.selectionGeneration
                    runtime.rememberTerminalTarget(established.target, proof)
                }
            }
        }
    }

    private fun establishedProof(wanted: AcceptedNavigation.Wanted) = RosterUiProof {
        val connection = registry.snapshot.value.hosts.firstOrNull { it.hostId == wanted.target.hostId }
        val host = runtime.hostState(wanted.target.hostId)
        val roster = host?.roster?.projection
        establishedWanted.get() === wanted && terminalRouteActive.get() && measuredWindow.get() &&
            registry.snapshot.value.foreground && runtime.state.value.visibility.terminalInputCovered &&
            connection != null && connection.phase == HostConnectionPhase.CONNECTED && connection.previouslyConnected && !connection.reconnectSuppressed &&
            host != null && host.connectionGeneration == connection.generation && host.lane == HostLanePhase.ATTACHED &&
            roster != null && roster.state == RosterProjectionState.CURRENT && roster.hostRunId == wanted.target.ownerRunId &&
            roster.rows.any { it.id == wanted.target.rowId }
    }

    fun cancelNavigation() {
        navigation.cancel()
        cancelCreatedActivation()
        supersedeSubmittedCreate()
    }
    /**
     * Focus/pause loss retires only the accepted created-row continuation, never the
     * in-flight form or a form's own normal closure. A later resume never revives it.
     */
    fun terminalLifecycleLost() {
        createdActivation?.let { it.focusLost(); createdActivation = null }
    }
    fun retireWindowProofs() {
        cancelSavedDeletion()
        cancelAddressEdit()
        cancelCreatedActivation()
        supersedeSubmittedCreate()
        measuredWindow.set(false)
        proofs.values.forEach { it.invalidate(UiProofInvalidationReason.LIFECYCLE_CHANGE) }
        prompt.set(null)
        cancelNavigation()
        runtime.setTerminalInputCoverage(false)
        if (!registry.snapshot.value.foreground) runtime.setAppForeground(false)
    }
    fun updateCoverage() {
        val eligible = route is ClientRoute.Terminal && !coverage.suspendsTerminalInput && !dialogs.hasModal &&
            !chooser && !policyChangePending.get() && platform.terminalInputEligible
        runtime.setTerminalInputCoverage(eligible)
        window?.coverageChanged(!eligible)
    }
    fun observedKeyboard(visible: Boolean) { if (keyboard != visible) { keyboard = visible; refresh() } }
    fun observedModifiers(next: TerminalModifiers) { if (modifiers != next) { modifiers = next; refresh() } }
    fun report(message: String) { notice.value = message }

    /**
     * App-owned so Activity recreation cannot lose an accepted input's settlement.
     *
     * Admission is queued here, in call order, before anything suspends: the backspace and
     * text of one IME correction reach the lane in the order they were typed. Only admission
     * is ordered; nothing waits for a send to settle. [notSent] runs on Main when this input
     * is known not to have been submitted, or its outcome is unknown, so its origin can stop
     * relying on it. It is never a retry.
     */
    fun submitNativeInput(host: HostId, selection: Long, request: ContentInputRequest, proof: RosterUiProof,
        notSent: () -> Unit = {}) {
        val inputScope = InputScope(host, selection)
        if (!nativeInputs.reserve(inputScope)) { report("Input not sent: busy"); notSent(); return }
        val admitting = nativeAdmission.submit(NativeInput(request, proof))
        scope.launch {
            try {
                when (val admission = admitting.await()) {
                    is ContentInputAdmission.Refused -> { report("Input not sent: ${admission.reason.name}"); notSent() }
                    is ContentInputAdmission.Accepted -> {
                        val key = InputKey(host, selection, admission.inputId, admission.ordinal)
                        nativeInputs.admitted(key, notSent)?.let { early -> reportInputOutcome(early, notSent) }
                    }
                }
            } finally {
                nativeInputs.release(inputScope)
            }
        }
    }
    private fun settleInput(key: InputKey, outcome: ContentSendOutcome) {
        nativeInputs.settle(key, outcome)?.let { notSent -> reportInputOutcome(outcome, notSent) }
    }
    private fun reportInputOutcome(outcome: ContentSendOutcome, notSent: () -> Unit) {
        report(when (outcome) {
            ContentSendOutcome.Submitted -> "Input submitted locally"
            ContentSendOutcome.Unknown -> "Input outcome unknown; not retried"
            is ContentSendOutcome.NotSent -> "Input not sent: ${outcome.reason.name}"
        })
        if (outcome != ContentSendOutcome.Submitted) notSent()
    }
    fun refreshPermission() { refresh() }

    private fun currentRow(target: SessionActionTarget): SessionUiState? = state.value.sessions.firstOrNull {
        !it.stale && SessionActionTarget.of(it) == target
    }
    // Close-only: stable owner identity and current/non-stale/capability facts, not a
    // display-context freeze. Other actions keep the exact currentRow match above.
    // The runtime check makes CURRENT/non-stale/generation source facts authoritative,
    // even if the last published UI frame is one refresh behind.
    private fun closeRow(target: SessionActionTarget): SessionUiState? {
        val row = CloseRowFence.row(state.value.hostState(target.hostId), target) ?: return null
        val runtimeHost = runtime.hostState(target.hostId) ?: return null
        val projection = runtimeHost.roster.projection
        if (runtimeHost.lane != HostLanePhase.ATTACHED ||
            runtimeHost.connectionGeneration != generation(target.hostId) ||
            projection.state != RosterProjectionState.CURRENT ||
            projection.hostRunId != target.hostRunId ||
            projection.rows.none { it.id == target.rowId }) return null
        return row
    }

    /**
     * Rename-only row admission: the stable owner triple plus the frozen native
     * conversation tuple admit the row.
     *
     * The exact [currentRow] match also compares the row's roster revision and drawn
     * title. A rename form stays open while the operator types, and the owner republishes
     * its roster meanwhile, so that comparison dropped a deliberate Rename without any
     * notice. The native tuple is the fence this action really has, and it stays exact.
     */
    private fun renameRow(target: RenameTarget): SessionUiState? =
        RenameRowFence.row(state.value.hostState(target.base.hostId), target)

    /**
     * Retire an open close form when its original connection attempt is gone.
     *
     * The same stable host/run/row may reappear after reconnect, but that is a new
     * channel attempt and old committed consent must not follow it. Ordinary title or
     * revision drift on the same attempt is deliberately not a retirement reason.
     */
    private fun observeCloseDialog(registryState: ConnectionRegistrySnapshot) {
        val form = dialogs.closeSession ?: return
        val host = registryState.hosts.firstOrNull { it.hostId == form.target.hostId }
        val runtimeHost = runtime.hostState(form.target.hostId)
        if (!CloseConnectionFence.survives(form, host?.generation, host?.phase == HostConnectionPhase.CONNECTED,
                runtimeHost?.connectionGeneration, runtimeHost?.lane == HostLanePhase.ATTACHED)) {
            (form.proof as? MutableUiActionProof)?.invalidate(UiProofInvalidationReason.DISMISSED)
            dialogs = dialogs.copy(closeSession = null)
            report("Close confirmation retired: connection changed")
        }
    }

    /**
     * A submitted create survives harmless roster refreshes, but never a background,
     * disconnect, or owner generation/run change. Cancellation is permanent.
     */
    private fun observeSubmittedCreate(hosts: List<HostUiState>, registryState: ConnectionRegistrySnapshot) {
        val activation = submittedCreate ?: return
        val host = hosts.firstOrNull { it.host.id == activation.hostId }
        val connectionGeneration = registryState.hosts.firstOrNull { it.hostId == activation.hostId }?.generation
        val currentRun = host?.roster?.takeIf { it.freshness == RosterFreshness.CURRENT }?.hostRunId
        if (!registryState.foreground || host == null || host.connection != HostConnectionState.CONNECTED ||
            connectionGeneration != activation.connectionGeneration ||
            (currentRun != null && currentRun != activation.hostRunId)) {
            activation.supersede()
        }
    }

    /**
     * Advance one owner-confirmed create without inventing a row or stealing a later
     * destination choice.
     *
     * The activation survives only harmless roster/metadata refreshes. Any replacement
     * dialog, explicit route change, foreground loss, host generation/run change, or
     * disconnect cancels it permanently. The exact returned row is taken only from a
     * CURRENT, non-stale projection of the matching host.
     */
    private fun observeCreatedActivation(hosts: List<HostUiState>, registryState: ConnectionRegistrySnapshot) {
        val activation = createdActivation ?: return
        val host = hosts.firstOrNull { it.host.id == activation.hostId }
        val connectionGeneration = registryState.hosts.firstOrNull { it.hostId == activation.hostId }?.generation
        val projectedRun = host?.roster?.hostRunId
        if (!registryState.foreground || dialogs.hasModal || createdActivationCovered() ||
            route != activation.originRoute || connectionGeneration != activation.connectionGeneration ||
            host == null || host.connection != HostConnectionState.CONNECTED ||
            !host.capabilities.supports(RosterWire.CREATE_CAPABILITY) ||
            (projectedRun != null && projectedRun != activation.hostRunId)) {
            cancelCreatedActivation()
            return
        }
        // A temporary non-current roster is not a run change: wait for the owner's
        // own CURRENT snapshot rather than inventing a row or an activation timeout.
        if (host.roster?.freshness != RosterFreshness.CURRENT) return
        val returned = activation.returnedRow ?: return
        if (returned.hostRunId != activation.hostRunId) {
            cancelCreatedActivation()
            return
        }
        val row = host.rows.firstOrNull {
            it.hostRunId == returned.hostRunId && it.rowId == returned.rowId && !it.stale
        } ?: return // The owner has not published this row yet; no local row is invented.
        activateCreatedRow(activation, row, host)
    }

    /**
     * The UI's own modal coverage can be one report behind the controller closing this
     * form. With no dialog left, that stale `MODAL_DIALOG` is not a newer cover; a real
     * sheet, menu, or dialog still blocks.
     */
    private fun createdActivationCovered(): Boolean =
        coverage != UiCoverage.NONE && !(coverage == UiCoverage.MODAL_DIALOG && !dialogs.hasModal)

    private fun activateCreatedRow(activation: AcceptedCreateActivation, row: SessionUiState, host: HostUiState) {
        if (createdActivation !== activation) {
            activation.cancel()
            return
        }
        if (dialogs.hasModal || createdActivationCovered() || route != activation.originRoute) {
            cancelCreatedActivation()
            return
        }
        val owner = window ?: run { cancelCreatedActivation(); return }
        val generation = generation(activation.hostId) ?: run { cancelCreatedActivation(); return }
        val target = RuntimeTarget(row.hostId, row.hostRunId, row.rowId)
        val wanted = navigation.acceptReturnedRow(target, generation, activation)
        if (wanted == null) {
            cancelCreatedActivation()
            return
        }
        createdActivation = null
        // The existing measured-viewport selection flow owns CONTENT. This only
        // admits navigation to the row the owner actually returned.
        displayedContent = null
        establishedWanted.set(null)
        measuredWindow.set(false)
        terminalRouteActive.set(true)
        owner.retireTerminal()
        runtime.leaveTerminal()
        terminalTitle = row.displayTitle
        terminalHostLabel = row.hostLabel
        chooser = false; coverage = UiCoverage.NONE; extraKeys = false; modifiers = TerminalModifiers.NONE
        route = ClientRoute.Terminal(TerminalUiState(
            UiTerminalTarget(row.hostId, row.hostRunId, row.rowId, wanted.epoch),
            terminalTitle, terminalHostLabel, host.connection))
        owner.newSelection()
        report("Terminal opening")
    }
    private fun generation(host: HostId): Long? = registry.snapshot.value.hosts.firstOrNull { it.hostId == host }?.generation
    private fun currentRun(host: HostId): String? = runtime.hostState(host)?.roster?.projection?.takeIf {
        it.state == RosterProjectionState.CURRENT
    }?.hostRunId

    /** Synchronous native intake. Immutable target/draft AND proof epoch freeze here. */
    fun intent(intent: ClientIntent) {
        // Any newer explicit user action supersedes a delayed created-row activation.
        // Coverage reports are layout facts emitted by the screen itself, not intent.
        // A repeated submit of the same drawn form is resolved below so it cannot
        // cancel the one create already in flight.
        if (intent !is ClientIntent.UiCoverageChanged && intent !is ClientIntent.SubmitSessionCreate) {
            cancelCreatedActivation()
            supersedeSubmittedCreate()
        }
        // A newer deliberate request supersedes a pending combined gesture immediately,
        // before any later FIFO command/IO can complete. Unrelated metadata is not intent.
        when (intent) {
            is ClientIntent.ConnectHost, is ClientIntent.DisconnectHost,
            is ClientIntent.RequestLocalNetworkPermissionRetry, is ClientIntent.OpenLocalNetworkPermissionSettings,
            is ClientIntent.RequestEditHostAddress, is ClientIntent.SaveHostAddressAndReconnect,
            is ClientIntent.RequestRemoveHost, is ClientIntent.RemoveHost,
            is ClientIntent.ShowDestination, is ClientIntent.LeaveTerminal, is ClientIntent.ShowSaved,
            is ClientIntent.RequestAddHost, is ClientIntent.RequestSessionCreate -> cancelAddressEdit()
            is ClientIntent.DismissDialog -> if (intent.kind == ClientDialogKind.EDIT_HOST_ADDRESS) cancelAddressEdit()
            else -> Unit
        }
        when (intent) {
            is ClientIntent.EnterTerminal -> enter(intent.target, intent.proof, false)
            is ClientIntent.SwitchTerminalTarget -> enter(intent.target, intent.proof, true)
            is ClientIntent.LeaveTerminal -> leave(ClientRoute.Sessions)
            is ClientIntent.ShowDestination -> leave(when (intent.destination) {
                NavigationDestination.SESSIONS -> ClientRoute.Sessions
                NavigationDestination.HOSTS -> ClientRoute.Hosts
                NavigationDestination.SETTINGS -> ClientRoute.Settings
            })
            ClientIntent.ShowQuickSwitcher -> {
                if (runtime.state.value.selection == null) cancelNavigation()
                chooser = true; window?.retireTerminal(); updateCoverage()
            }
            ClientIntent.DismissQuickSwitcher -> { chooser = false; updateCoverage() }
            is ClientIntent.UiCoverageChanged -> { coverage = intent.coverage; updateCoverage() }
            is ClientIntent.ConnectHost -> window?.connect(intent.hostId)
            is ClientIntent.DisconnectHost -> {
                val target = state.value.hostState(intent.hostId)?.host ?: return
                window?.cancelConnect(intent.hostId); cancelTarget(intent.hostId)
                hostCommand(intent.hostId, RosterUiProof {
                    registry.snapshot.value.hosts.any { it.hostId == target.id && it.endpoint == target.endpoint }
                }, { registry.disconnect(intent.hostId) }, { result ->
                    report(when (result) {
                        is HostCommandSequencer.Dispatch.Executed -> commandText("Disconnect", result.value)
                        HostCommandSequencer.Dispatch.Retired -> "Disconnect not applied: target changed"
                    })
                })
            }
            ClientIntent.RequestAddHost -> dialogs = dialogs.copy(addHost = AddHostDialog(proof = proof(
                listOf("add", ++proofGeneration), UiProofScreen.HOST_ADD_FORM, localFormHost)))
            is ClientIntent.SubmitNewHost -> {
                val form = dialogs.addHost ?: return
                if (form.proof !== intent.proof || form.labelDraft != intent.label || form.hostDraft != intent.host || form.portDraft != intent.port) return
                val frozen = FrozenAction.capture(intent.proof) ?: return
                val label = HostLabel.parseOrNull(intent.label) ?: return
                val port = Endpoint.parsePortOrNull(intent.port) ?: return
                val endpoint = Endpoint.parseOrNull(intent.host, port) ?: return
                localForm(intent.proof) {
                    if (!frozen.isStillCurrent()) return@localForm "Host was not saved: form changed"
                    when (val result = registry.addHost(HostId.generate(), label, endpoint)) {
                        is HostAddResult.Saved -> "Host saved"
                        is HostAddResult.CatalogRefused -> "Host was not saved: ${result.reason.name}"
                        is HostAddResult.Refused -> "Host was not saved: ${result.reason.name}"
                    }
                }
            }
            is ClientIntent.RequestEditHostAddress -> {
                val host = state.value.hostState(intent.target.hostId)?.host ?: return
                if (host.endpoint != intent.target.expectedOldEndpoint || route !is ClientRoute.Hosts) return
                window?.cancelConnect()
                dialogs = dialogs.copy(editHostAddress = EditHostAddressDialog(intent.target, host.label.value,
                    proof = proof(listOf("edit-address", intent.target, ++proofGeneration),
                        UiProofScreen.HOST_EDIT_ADDRESS, host.id)))
            }
            is ClientIntent.SaveHostAddressAndReconnect -> saveAddressAndReconnect(intent)
            is ClientIntent.RequestRemoveHost -> {
                val host = state.value.hostState(intent.target.hostId) ?: return
                if (host.host.label.value != intent.target.label || host.host.endpoint.displayText() != intent.target.endpointDisplayText) return
                dialogs = dialogs.copy(removeHost = RemoveHostDialog(intent.target.hostId, intent.target.label,
                    intent.target.endpointDisplayText, proof(listOf("remove", intent.target, ++proofGeneration), UiProofScreen.HOST_REMOVE, intent.target.hostId)))
            }
            is ClientIntent.RemoveHost -> {
                val form = dialogs.removeHost ?: return
                if (form.proof !== intent.proof || RemoveHostTarget(form.hostId, form.label, form.endpointDisplayText) != intent.target) return
                val frozen = FrozenAction.capture(intent.proof) ?: return
                window?.cancelConnect(intent.target.hostId)
                cancelTarget(intent.target.hostId)
                if (!busyForms.add(intent.proof)) return
                val target = intent.target
                hostCommand(target.hostId, RosterUiProof {
                    frozen.isStillCurrent() && registry.snapshot.value.hosts.any {
                        it.hostId == target.hostId && it.label == target.label && it.endpoint.displayText() == target.endpointDisplayText
                    }
                }, { registry.remove(target.hostId) }, { result ->
                    report(when (result) {
                        is HostCommandSequencer.Dispatch.Executed -> commandText("Remove host", result.value)
                        HostCommandSequencer.Dispatch.Retired -> "Host was not removed: confirmation or target changed"
                    })
                }, finished = { busyForms.remove(intent.proof) })
            }
            is ClientIntent.RequestLocalNetworkPermissionRetry -> window?.connect(intent.hostId)
            is ClientIntent.OpenLocalNetworkPermissionSettings -> window?.openPermissionSettings(intent.hostId)
            is ClientIntent.ApproveFirstContactServerKey -> consent(intent.target, intent.proof, HostKeyConsentChoice.APPROVE)
            is ClientIntent.DeclineFirstContactServerKey -> consent(intent.target, dialogs.firstContactConsent?.proof, HostKeyConsentChoice.DENY)
            is ClientIntent.DismissDialog -> {
                if (intent.kind == ClientDialogKind.SAVED_DELETE) cancelSavedDeletion()
                if (intent.kind == ClientDialogKind.FIRST_CONTACT_CONSENT) {
                    dialogs.firstContactConsent?.let { consent(FirstContactConsentTarget(it.hostId, it.latchedLabel,
                        it.endpointDisplayText, it.serverFingerprint), it.proof, HostKeyConsentChoice.DENY) }
                }
                if (intent.kind != ClientDialogKind.FIRST_CONTACT_CONSENT) dialogs = dialogs.dismissing(intent.kind)
            }
            is ClientIntent.UpdateDraft -> draft(intent.draft)
            ClientIntent.RequestSessionCreate -> dialogs = dialogs.copy(createSession = CreateSessionDialog(
                state.value.hostStates.map { OwnerChoice(it.host.id, it.host.label.value, it.host.endpoint.displayText(), it.connection, it.canCreateSession) },
                proof = proof(listOf("create", ++proofGeneration), UiProofScreen.SESSION_CREATE, localFormHost)))
            is ClientIntent.SelectCreateOwner -> dialogs.createSession?.let { form ->
                if (form.proof in busyForms) return
                (form.proof as? MutableUiActionProof)?.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
                dialogs = dialogs.copy(createSession = form.copy(selectedHostId = intent.hostId,
                    proof = proof(listOf("create", intent.hostId, form.workspaceDraft, ++proofGeneration), UiProofScreen.SESSION_CREATE,
                        intent.hostId, currentRun(intent.hostId))))
            }
            is ClientIntent.SubmitSessionCreate -> {
                val form = dialogs.createSession ?: return
                if (form.proof !== intent.proof || form.selectedHostId != intent.hostId || form.workspaceDraft != intent.workspace) return
                val run = currentRun(intent.hostId) ?: run { report("Create not submitted: owner roster is not current"); return }
                val gen = generation(intent.hostId) ?: return
                if (intent.proof.target.hostRunId != run) return
                val frozen = FrozenAction.capture(intent.proof) ?: return
                val inFlight = submittedCreate
                if (inFlight != null && inFlight.formProof === form.proof && inFlight.hostId == intent.hostId &&
                    inFlight.hostRunId == run && inFlight.workspace == intent.workspace) {
                    // Same deliberate submit is already in flight; keep its one receipt.
                    report("Operation not submitted: busy")
                    return
                }
                // A different submit is a newer explicit intent than any earlier one.
                cancelCreatedActivation()
                inFlight?.let { cancelSubmittedCreate(it) }
                // Preserve the actual committed form receipt and the route it was opened
                // from. Only the exact owner-returned row may later be activated, even
                // when the form was opened from Hosts rather than Sessions.
                val activation = AcceptedCreateActivation.capture(intent.hostId, gen, run, intent.workspace,
                    form, frozen, route) ?: return
                submittedCreate = activation
                operation(OperationContext(intent.hostId, gen, intent.proof, created = activation)) {
                    runtime.createSession(intent.hostId, RosterCreateCommand(run, intent.workspace,
                        RosterSendProof.Form(gen, run, intent.workspace, frozen)))
                }
            }
            is ClientIntent.RequestSessionClose -> {
                // Re-freeze the same stable row from the current projection: an ordinary
                // title or revision refresh while the close menu was drawn must not make
                // that owner row unclosable.
                val row = closeRow(intent.target) ?: return
                val closeGeneration = generation(row.hostId) ?: return
                val target = SessionActionTarget.of(row)
                dialogs = dialogs.copy(closeSession = CloseSessionDialog(target,
                    proof(listOf("close", closeGeneration, target, ++proofGeneration), UiProofScreen.SESSION_CLOSE,
                        target.hostId, target.hostRunId, target.rowId),
                    connectionGeneration = closeGeneration))
            }
            is ClientIntent.ConfirmSessionClose -> {
                val form = dialogs.closeSession ?: return
                if (form.target != intent.target || form.proof !== intent.proof) return
                val row = closeRow(form.target) ?: return
                val gen = generation(form.target.hostId) ?: return
                if (!CloseConnectionFence.admits(form, gen)) {
                    report("Close not submitted: connection changed")
                    return
                }
                val secondStage = form.confirmationRequestId != null
                if (secondStage) {
                    // The second stage is bound to the exact owner arm produced by this
                    // form's request. Never optimistically resend confirmed=true.
                    val armed = runtime.hostState(form.target.hostId)?.roster?.armedCloseConfirmationRows
                        ?.contains(row.rowId) == true
                    if (form.confirmationRequestId != form.proof.target.requestId || !armed) {
                        report("Close not submitted: host confirmation is no longer current")
                        return
                    }
                }
                val frozen = FrozenAction.capture(intent.proof) ?: return
                val target = form.target
                operation(OperationContext(target.hostId, gen, intent.proof)) {
                    runtime.closeSession(target.hostId, RosterCloseCommand(target.hostRunId, target.rowId, secondStage,
                        RosterSendProof.RowAction(gen, target.hostRunId, target.rowId, ui = frozen,
                            confirmation = if (secondStage) frozen else null),
                        if (secondStage) frozen else null))
                }
            }
            is ClientIntent.RequestSessionRename -> {
                if (renameRow(intent.target) == null) return
                dialogs = dialogs.copy(renameSession = RenameSessionDialog(intent.target, intent.target.currentName,
                    proof(listOf("rename", intent.target, ++proofGeneration), UiProofScreen.SESSION_RENAME,
                        intent.target.base.hostId, intent.target.base.hostRunId, intent.target.base.rowId)))
            }
            is ClientIntent.SubmitSessionRename -> {
                val form = dialogs.renameSession ?: return
                if (form.target != intent.target || form.nameDraft != intent.name || form.proof !== intent.proof) return
                val hostId = intent.target.base.hostId
                val gen = generation(hostId) ?: return
                // The submission re-admits the drawn form against the owner facts held now,
                // captures this click's committed receipt, and builds the one command.
                val submission = RenameSubmission.begin(state.value.hostState(hostId), gen, form, intent.proof) ?: return
                operation(OperationContext(hostId, gen, intent.proof, rename = submission)) {
                    runtime.renameSession(hostId, submission.command)
                }
            }
            is ClientIntent.MoveSessionRow -> move(intent)
            is ClientIntent.ShowSaved -> showSaved(intent.hostId)
            is ClientIntent.SelectSavedOwner -> showSaved(intent.hostId)
            is ClientIntent.RequestSavedList -> savedList(intent)
            is ClientIntent.RequestSavedWindow -> savedWindow(intent)
            is ClientIntent.ResumeSavedEntry -> savedEntry(intent.target, intent.proof, false, false)
            is ClientIntent.PrepareSavedDelete -> savedEntry(intent.target, intent.proof, true, false)
            is ClientIntent.ConfirmSavedDelete -> savedEntry(intent.target, intent.proof, true, true)
            is ClientIntent.SetAutoReconnectEnabled -> {
                val lifetime = window?.freezeIntentLifetime() ?: return
                scope.launch {
                    val result = preferenceLock.withLock { withContext(Dispatchers.IO) {
                        if (lifetime.isStillCurrent()) registry.setAutoReconnect(intent.enabled) else null
                    } }
                    report(result?.let { commandText("Auto preference", it) } ?: "Auto preference not saved: intent no longer current")
                }
            }
            is ClientIntent.SetViewerRemoteInputEnabled -> {
                val lifetime = window?.freezeIntentLifetime() ?: return
                policyChangePending.set(true)
                val request = ++policyRequest
                window?.retireTerminal()
                runtime.setTerminalInputCoverage(false)
                scope.launch {
                    val result = preferenceLock.withLock { withContext(Dispatchers.IO) {
                        if (lifetime.isStillCurrent()) registry.setViewerRemoteInputEnabled(intent.enabled) else null
                    } }
                    if (request == policyRequest) {
                        // Reenable is only a veto removal; the native surface must draw again.
                        policyChangePending.set(false)
                        window?.retireTerminal()
                        updateCoverage()
                        refresh()
                    }
                    report(result?.let { commandText("Input preference", it) } ?: "Input preference not saved: intent no longer current")
                }
            }
            is ClientIntent.SetSavedFirstReplyTimeoutSeconds -> {
                if (!NetworkSettings.isValidSavedFirstReplyTimeoutSeconds(intent.seconds)) {
                    report("Saved timeout not saved: enter a positive whole number of seconds")
                    return
                }
                val lifetime = window?.freezeIntentLifetime() ?: return
                scope.launch {
                    val result = preferenceLock.withLock { withContext(Dispatchers.IO) {
                        if (lifetime.isStillCurrent()) registry.setSavedFirstReplyTimeoutSeconds(intent.seconds) else null
                    } }
                    report(result?.let { commandText("Saved timeout", it) } ?: "Saved timeout not saved: intent no longer current")
                }
            }
            is ClientIntent.SetDebugInputMessagingEnabled -> {
                // A display preference only. Unlike the input preference, nothing here
                // retires a terminal, marks a policy change pending, disables input, or
                // reconnects anything: only the durable preference and its projection move.
                val lifetime = window?.freezeIntentLifetime() ?: return
                scope.launch {
                    val result = preferenceLock.withLock { withContext(Dispatchers.IO) {
                        if (lifetime.isStillCurrent()) registry.setDebugInputMessagingEnabled(intent.enabled) else null
                    } }
                    report(result?.let { commandText("Debug messaging", it) } ?: "Debug messaging not saved: intent no longer current")
                }
            }
            is ClientIntent.SetAppearance -> {
                // A display preference only, like diagnostic messaging: nothing here
                // retires a terminal, marks a policy change pending, disables input,
                // reconnects anything, or touches a host-provided color. Only the
                // durable preference and its projection move.
                val lifetime = window?.freezeIntentLifetime() ?: return
                scope.launch {
                    val result = preferenceLock.withLock { withContext(Dispatchers.IO) {
                        if (lifetime.isStillCurrent()) registry.setAppearance(intent.appearance) else null
                    } }
                    report(result?.let { commandText("Appearance", it) } ?: "Appearance not saved: intent no longer current")
                }
            }
            is ClientIntent.SetTerminalKeyboardVisible -> window?.keyboard(intent.visible)
            is ClientIntent.SetTerminalExtraKeysVisible -> { window?.retireTerminal(); extraKeys = intent.visible }
            is ClientIntent.ToggleTerminalModifier -> window?.toggleModifier(intent.modifier)
        }
        retireCoveredDialogProofs()
        updateCoverage()
        refresh()
    }

    private fun saveAddressAndReconnect(intent: ClientIntent.SaveHostAddressAndReconnect) {
        val form = dialogs.editHostAddress ?: return
        if (route !is ClientRoute.Hosts || dialogs.isCovered(ClientDialogKind.EDIT_HOST_ADDRESS) || form.proof in busyForms) return
        val owner = window ?: return
        val lifetime = owner.freezeIntentLifetime()
        if (form.target != intent.target || form.proof !== intent.proof || form.addressDraft != intent.address) return
        val host = registry.snapshot.value.hosts.firstOrNull { it.hostId == intent.target.hostId }
            ?: run { report("Address not saved: host no longer saved"); return }
        if (host.endpoint != intent.target.expectedOldEndpoint) {
            report("Address not saved: saved endpoint changed"); return
        }
        val request = addressEdit.accept(form, intent, host) ?: return
        owner.cancelConnect()
        busyForms.add(form.proof)
        // Reserve on Main. No mutable form is read by the IO task; the registry
        // rechecks the frozen old endpoint under its settings transaction too.
        hostCommand(request.target.hostId, RosterUiProof {
            lifetime.isStillCurrent() && addressEdit.canSave(request, registry.snapshot.value)
        }, { registry.updateHostAddress(request.target.hostId, request.target.expectedOldEndpoint, request.address) }, { dispatch ->
            when (dispatch) {
                HostCommandSequencer.Dispatch.Retired -> report("Address not saved: form or target changed")
                is HostCommandSequencer.Dispatch.Executed -> {
                    val result = dispatch.value
                    // Still the original committed form and window. Only now may its
                    // accepted gesture become a NEW exact-target permission request.
                    val reconnect = if (window === owner && lifetime.isStillCurrent() &&
                        dialogs.editHostAddress?.proof === form.proof &&
                        !dialogs.isCovered(ClientDialogKind.EDIT_HOST_ADDRESS)) {
                        addressEdit.takeReconnect(request, result, registry.snapshot.value)
                    } else null
                    val started = reconnect?.let { owner.connectEditedAddress(it) } == true
                    if (started) dialogs = dialogs.copy(editHostAddress = null)
                    report(when (result) {
                        is HostAddressUpdateResult.Saved -> if (started) "Address saved; reconnect requested" else "Address saved; reconnect cancelled"
                        HostAddressUpdateResult.Unchanged -> if (started) "Address unchanged; reconnect requested" else "Address unchanged; reconnect cancelled"
                        HostAddressUpdateResult.StaleTarget -> "Address not saved: saved endpoint changed"
                        is HostAddressUpdateResult.Refused -> "Address not saved: ${result.reason.name}"
                    })
                }
            }
        }, finished = { addressEdit.cancel(request); busyForms.remove(form.proof) })
    }

    private fun enter(target: SessionActionTarget, proof: UiActionProof, fromChooser: Boolean) {
        if (dialogs.hasModal || (!fromChooser && route !is ClientRoute.Sessions)) return
        val row = currentRow(target) ?: return
        val expected = if (fromChooser) (route as? ClientRoute.Terminal)?.terminal?.chooserProofs?.get(SessionRowKey.of(row)) else row.selectProof
        if (expected !== proof) return
        val frozen = FrozenAction.capture(proof) ?: return
        val gen = generation(target.hostId) ?: return
        val wanted = navigation.accept(RuntimeTarget(target.hostId, target.hostRunId, target.rowId), gen, frozen) ?: return
        // Admission happens BEFORE the source row/chooser leaves composition.
        displayedContent = null
        establishedWanted.set(null)
        measuredWindow.set(false)
        terminalRouteActive.set(true)
        window?.retireTerminal()
        runtime.leaveTerminal()
        terminalTitle = target.drawnTitle
        terminalHostLabel = row.hostLabel
        chooser = false; coverage = UiCoverage.NONE; extraKeys = false; modifiers = TerminalModifiers.NONE
        route = ClientRoute.Terminal(TerminalUiState(UiTerminalTarget(target.hostId, target.hostRunId, target.rowId, wanted.epoch),
            terminalTitle, terminalHostLabel, state.value.hostState(target.hostId)!!.connection))
        window?.newSelection()
        report("Terminal opening")
        // The real surface is rendered with binding=null until its actual pane measures.
    }

    private fun leave(next: ClientRoute) {
        displayedContent = null
        terminalRouteActive.set(false)
        measuredWindow.set(false)
        establishedWanted.set(null)
        window?.cancelConnect()
        window?.retireTerminal()
        window?.keyboard(false)
        cancelNavigation()
        runtime.leaveTerminal()
        cancelSavedDeletion()
        savedEpoch++
        dismissCurrentSavedPicker()
        route = next
        chooser = false; extraKeys = false; modifiers = TerminalModifiers.NONE
        proofs.values.forEach { it.invalidate(UiProofInvalidationReason.DISMISSED) }
        dialogs = ClientDialogs.NONE
        prompt.set(null)
    }
    private fun cancelTarget(host: HostId) {
        if (saved.selectedHostId == host) cancelSavedDeletion()
        if (createdActivation?.hostId == host) cancelCreatedActivation()
        submittedCreate?.takeIf { it.hostId == host }?.supersede()
        if (establishedWanted.get()?.target?.hostId == host) establishedWanted.set(null)
        if (navigation.wanted()?.target?.hostId == host) cancelNavigation()
        if (runtime.state.value.selection?.target?.hostId == host) { window?.retireTerminal(); runtime.leaveTerminal() }
    }

    private fun draft(draft: ClientDraft) {
        when (draft) {
            is ClientDraft.HostForm -> dialogs.addHost?.let { form ->
                if (form.proof in busyForms) return
                dialogs = dialogs.copy(addHost = AddHostDialog(draft.label, draft.host, draft.port,
                    proof(listOf("add-draft", draft, ++proofGeneration), UiProofScreen.HOST_ADD_FORM, localFormHost)))
            }
            is ClientDraft.HostAddressForm -> dialogs.editHostAddress?.let { form ->
                if (form.target != draft.target || form.proof !== draft.proof || form.proof in busyForms) return
                cancelAddressEdit()
                dialogs = dialogs.copy(editHostAddress = form.copy(addressDraft = draft.value,
                    proof = proof(listOf("edit-address-draft", draft, ++proofGeneration),
                        UiProofScreen.HOST_EDIT_ADDRESS, form.target.hostId)))
            }
            is ClientDraft.Workspace -> dialogs.createSession?.let { form ->
                if (form.proof in busyForms) return
                dialogs = dialogs.copy(createSession = form.copy(workspaceDraft = draft.value,
                    proof = proof(listOf("create-draft", form.selectedHostId, draft, ++proofGeneration), UiProofScreen.SESSION_CREATE,
                        form.selectedHostId ?: localFormHost, form.selectedHostId?.let { currentRun(it) })))
            }
            is ClientDraft.Rename -> dialogs.renameSession?.let { form ->
                if (form.target != draft.target || form.proof in busyForms) return
                dialogs = dialogs.copy(renameSession = form.copy(nameDraft = draft.value,
                    proof = proof(listOf("rename-draft", draft, ++proofGeneration), UiProofScreen.SESSION_RENAME,
                        draft.target.base.hostId, draft.target.base.hostRunId, draft.target.base.rowId)))
            }
            is ClientDraft.SavedSearch -> {
                cancelSavedDeletion()
                savedEpoch++
                (saved.listProof as? MutableUiActionProof)?.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
                saved = saved.copy(query = draft.value, listProof = null)
            }
        }
    }

    private fun consent(target: FirstContactConsentTarget, proof: UiActionProof?, choice: HostKeyConsentChoice) {
        val standing = prompt.get() ?: return
        val consent = standing.consent
        if (proof !== standing.proof || target != FirstContactConsentTarget(consent.hostId, consent.label,
                consent.endpoint.displayText(), consent.fingerprint)) return
        val frozen = FrozenAction.capture(proof ?: return) ?: run {
            report("Server key decision not applied: a fresh readable dialog is required"); return
        }
        if (!standing.decision.compareAndSet(null, frozen)) return
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                if (!frozen.isStillCurrent()) return@withContext null
                registry.decideKeyConsent(choice, HostKeyConsentProof(consent.consentId, consent.hostId, consent.generation, consent.foregroundEpoch))
            }
            standing.decision.compareAndSet(frozen, null)
            report(when (result) {
                is HostKeyConsentResolution.Applied -> "Server key decision applied"
                is HostKeyConsentResolution.Stale -> "Server key decision not applied: ${result.reason.name}"
                null -> "Server key decision not applied: dialog changed"
            })
        }
    }

    private fun dismissCurrentSavedPicker() {
        val host = saved.selectedHostId ?: return
        val state = runtime.hostState(host) ?: return
        val scope = RosterSavedPickerScope(state.connectionGeneration, state.roster.savedOwnership,
            state.roster.pending.firstOrNull { it.kind.isSaved }?.requestId)
        this.scope.launch { runtime.dismissSavedPicker(host, scope) }
    }

    private fun showSaved(host: HostId) {
        if (state.value.hostState(host) == null) return
        leave(ClientRoute.Saved(host))
        savedConnectionGeneration = generation(host)
        saved = SavedUiState(selectedHostId = host, hostRunId = currentRun(host))
    }
    private fun savedFirstReplyTimeoutMs(): Long? = NetworkSettings.savedFirstReplyTimeoutMillis(
        registry.snapshot.value.savedFirstReplyTimeoutSeconds,
    )
    private fun savedList(intent: ClientIntent.RequestSavedList) {
        if (saved.selectedHostId != intent.target.hostId || saved.hostRunId != intent.target.hostRunId ||
            saved.query != intent.query || saved.listProof !== intent.proof || currentRun(intent.target.hostId) != intent.target.hostRunId) return
        val frozen = FrozenAction.capture(intent.proof) ?: return
        val gen = generation(intent.target.hostId) ?: return
        cancelSavedDeletion()
        val owned = runtime.hostState(intent.target.hostId)?.roster?.savedOwnership
        val catalog = saved.catalogId?.takeIf { owned != null && owned.hostRunId == intent.target.hostRunId && owned.catalogId == it }
        val pickerRevision = intent.proof.target.generation
        val firstReplyTimeoutMs = savedFirstReplyTimeoutMs() ?: run {
            report("Saved read not submitted: timeout unavailable")
            return
        }
        val p = RosterSendProof.PickerRead(gen, intent.target.hostRunId, catalogId = catalog, queryRevision = pickerRevision, ui = frozen)
        operation(OperationContext(intent.target.hostId, gen, intent.proof, savedQuery = intent.query,
            savedIntake = savedView())) {
            if (catalog == null) runtime.savedList(intent.target.hostId,
                RosterSavedListCommand(intent.target.hostRunId, intent.query, 0, 50, p,
                    firstReplyTimeoutMs = firstReplyTimeoutMs))
            else runtime.savedSearch(intent.target.hostId,
                RosterSavedSearchCommand(intent.target.hostRunId, catalog, intent.query, 0, 50, p,
                    firstReplyTimeoutMs = firstReplyTimeoutMs))
        }
    }
    private fun savedWindow(intent: ClientIntent.RequestSavedWindow) {
        if (SavedResultTarget.of(saved) != intent.target || saved.windowProof !== intent.proof) return
        val frozen = FrozenAction.capture(intent.proof) ?: return
        val gen = generation(intent.target.hostId) ?: return
        val ownership = runtime.hostState(intent.target.hostId)?.roster?.savedOwnership ?: return
        cancelSavedDeletion()
        val target = intent.target
        operation(OperationContext(target.hostId, gen, intent.proof, savedQuery = saved.query)) {
            runtime.savedWindow(target.hostId, RosterSavedWindowCommand(target.hostRunId, target.catalogId, target.resultId,
                intent.offset, intent.count, RosterSendProof.PickerRead(gen, target.hostRunId, target.catalogId,
                    target.resultId, ownership.pickerRevision, frozen)))
        }
    }
    private fun savedEntry(target: SavedEntryTarget, proof: UiActionProof, delete: Boolean, confirmed: Boolean) {
        val current = saved.entries.firstOrNull { SavedEntryTarget.of(saved, it) == target } ?: return
        if (confirmed && SavedResultTarget.of(saved) != savedDeleteScope) return
        val expected = if (confirmed) dialogs.savedDelete?.takeIf { it.target == target }?.proof else
            saved.proofsFor(SavedEntryKey.of(target)).let { if (delete) it.deletePrepare else it.resume }
        if (expected !== proof || current.entryId != target.entryId || proof in busyForms) return
        val frozen = FrozenAction.capture(proof) ?: return
        val gen = generation(target.hostId) ?: return
        val ownership = runtime.hostState(target.hostId)?.roster?.savedOwnership ?: return
        val p = RosterSendProof.PickerEntry(gen, target.hostRunId, target.catalogId, target.resultId,
            target.entryId, ownership.pickerRevision, frozen, if (confirmed) frozen else null)
        cancelSavedDeletion()
        val result = SavedResultTarget.of(saved) ?: return
        val deletion = if (delete && confirmed) {
            val lifetime = window?.freezeIntentLifetime() ?: return
            AcceptedSavedDeletion.capture(target, result, savedEpoch, saved.query, p, proof, frozen,
                AcceptedSavedDeletion.ownerLifetime(target, gen, lifetime, registry.snapshot, runtime.state)) ?: return
        } else null
        savedDeletion = deletion
        operation(OperationContext(target.hostId, gen, proof, entry = target, savedResult = result, deletion = deletion)) {
            if (!delete) runtime.savedResume(target.hostId,
                RosterSavedResumeCommand(target.hostRunId, target.catalogId, target.resultId, target.entryId, p))
            else {
                val command = RosterSavedDeleteCommand(target.hostRunId, target.catalogId, target.resultId, target.entryId, p)
                if (confirmed) runtime.savedDeleteConfirmed(target.hostId, command, frozen) else runtime.savedDeletePrepare(target.hostId, command)
            }
        }
    }

    private data class OperationContext(val host: HostId, val generation: Long, val proof: UiActionProof?,
        val savedQuery: String? = null, val entry: SavedEntryTarget? = null, val sequence: Long? = null,
        val pickerEpoch: Long? = null, val savedResult: SavedResultTarget? = null,
        val deletion: AcceptedSavedDeletion? = null, val savedReadLifetime: AcceptedSavedDeletion? = null,
        val savedIntake: SavedReadFeedback.View? = null, val created: AcceptedCreateActivation? = null,
        val rename: RenameSubmission? = null)

    private fun operation(context: OperationContext, command: suspend () -> RosterOperationAdmission) {
        if (context.proof in busyForms || busyForms.size >= 64) {
            context.created?.let { cancelSubmittedCreate(it) }
            context.savedReadLifetime?.cancel()
            report("Operation not submitted: busy")
            return
        }
        val captured = context.copy(pickerEpoch = if (context.savedQuery != null || context.entry != null) savedEpoch else null)
        context.proof?.let { busyForms.add(it) }
        operations.begin(context.host, context.generation)
        // No pending UI re-key or relayout here: actual committed owner proof survives dispatch.
        scope.launch {
            try {
                when (val admission = withContext(Dispatchers.Default) { command() }) {
                    is RosterOperationAdmission.Accepted -> {
                        captured.deletion?.admitted(admission.pending)
                        captured.created?.admitted(admission.pending)
                        val accepted = captured.copy(sequence = admission.pending?.sequence)
                        val key = OperationKey(context.host, context.generation, admission.kind, admission.requestId)
                        val settled = operations.accept(key, accepted)
                        // Status only: the committed Search proof and every drawn control keep
                        // their identity and placement (the base status keeps their presentation).
                        if (admission.kind.isSavedRead) {
                            saved = savedFeedback.accepted(key, admission.pending?.sequence, captured.savedIntake,
                                settled != null, savedView(), saved)
                        }
                        // Do not hide/re-key the load-more or entry control before its
                        // queued writer has consumed the actual committed proof. The fixed
                        // application status slot reports pending without moving that control.
                        if (settled == null) report("${admission.kind.name}: pending owner outcome")
                        settled?.let { finish(it.first, it.second) }
                    }
                    is RosterOperationAdmission.Refused -> {
                        captured.deletion?.cancel(); captured.savedReadLifetime?.cancel()
                        captured.created?.let { cancelSubmittedCreate(it) }
                        busyForms.remove(context.proof)
                        report("Operation not submitted: ${admission.reason.name}")
                    }
                    is RosterOperationAdmission.NotReached -> {
                        captured.deletion?.cancel(); captured.savedReadLifetime?.cancel()
                        captured.created?.let { cancelSubmittedCreate(it) }
                        busyForms.remove(context.proof)
                        report("Operation not submitted: ${admission.reason.name}")
                    }
                }
            } finally {
                operations.end(context.host, context.generation)
                refresh()
            }
        }
    }
    private fun finish(context: OperationContext, event: RosterClientEvent.OperationSettled) {
        if (!event.kind.isSavedRead) return finishSettled(context, event, true)
        val key = OperationKey(context.host, context.generation, event.kind, event.requestId)
        saved = savedFeedback.observe(savedView(), saved)
        try {
            finishSettled(context, event, savedFeedback.projects(key))
        } finally {
            // A canceled continuation is retired by refresh(); only its exact live
            // settlement ends this display ownership here.
            context.savedReadLifetime?.takeIf { it.isStillCurrent() }?.let { savedRefreshFeedback.settled(it) }
            saved = savedFeedback.settled(key, savedView(), saved)
        }
    }
    private fun finishSettled(context: OperationContext, event: RosterClientEvent.OperationSettled, projectRead: Boolean) {
        busyForms.remove(context.proof)
        if (generation(context.host) != context.generation) {
            context.created?.let { cancelSubmittedCreate(it) }
            if (event.kind == RosterOperationKind.SAVED_DELETE) report(resultText(event))
            return
        }
        // A rename result acts only on the exact form/request that submitted it, and only
        // the owner's positive `renamed` closes that form. The displayed name still comes
        // only from the owner's next complete authoritative snapshot.
        context.rename?.let { dialogs = it.closeIfConfirmed(dialogs, event.hostRunId, event.result) }
        if (context.created != null) {
            finishCreated(context, event)
            return
        }
        if (context.savedReadLifetime?.isStillCurrent() == false) { report(resultText(event)); return }
        if (context.pickerEpoch != null && (context.pickerEpoch != savedEpoch || route !is ClientRoute.Saved)) {
            report(resultText(event))
            return
        }
        // A delayed older read cannot replace a newer result already adopted on this channel.
        if (event.kind.isSavedRead && saved.selectedHostId == context.host &&
            SavedReadFeedback.olderThanAdopted(context.sequence, context.generation, saved, savedResultGeneration)) {
            report(resultText(event))
            return
        }
        // Nor a newer read's non-data answer, which leaves the displayed sequence unchanged.
        if (event.kind.isSavedRead && projectRead && saved.selectedHostId == context.host &&
            !savedReadSettlements.projects(
                OperationKey(context.host, context.generation, event.kind, event.requestId), context.sequence)) {
            report(resultText(event))
            return
        }
        val owner = (event.result as? RosterRequestResult.OwnerResult)?.outcome
        if (owner !is RosterOwnerOutcome.SavedDelete || owner.facts !is OwnerSavedDeleteFacts.Deleted) {
            context.deletion?.cancel()
        }
        if (!projectRead) {
            // An older read superseded by the displayed pending read writes nothing here.
        } else if (owner is RosterOwnerOutcome.SavedWindow && saved.selectedHostId == context.host &&
            saved.query == context.savedQuery && saved.hostRunId == event.hostRunId) {
            when (val facts = owner.facts) {
                is RosterSavedWindowFacts.Complete -> {
                    // A complete transfer is published only from the exact correlated request.
                    // Null pending is legal for same-step non-data settlement; a complete transfer
                    // cannot be synthesized without the accepted sequence.
                    val sequence = context.sequence
                    if (sequence != null && (context.savedReadLifetime == null || context.savedReadLifetime.adoptResult())) {
                        if (savedDeletion === context.savedReadLifetime) savedDeletion = null
                        savedResultGeneration = context.generation
                        saved = saved.copy(status = SavedRequestStatus.Ready, hostRunId = facts.hostRunId,
                            catalogId = facts.catalogId, resultId = facts.resultId, requestId = event.requestId, sequence = sequence,
                            total = facts.total, issueCount = facts.issueCount, offset = facts.offset, entries = facts.entries,
                            transferComplete = true, windowProof = null, entryProofs = emptyMap())
                    } else saved = saved.copy(status = SavedRequestStatus.Unknown)
                }
                is RosterSavedWindowFacts.Refused -> saved = saved.copy(status = SavedRequestStatus.Refused(facts.reason))
                RosterSavedWindowFacts.Unavailable -> saved = saved.copy(status = SavedRequestStatus.Unavailable)
                RosterSavedWindowFacts.Unknown -> saved = saved.copy(status = SavedRequestStatus.Unknown)
            }
        } else if (event.kind.isSavedRead && saved.selectedHostId == context.host) {
            saved = saved.copy(status = when (event.result) {
                is RosterRequestResult.NotSent -> SavedRequestStatus.Refused()
                else -> SavedRequestStatus.Unknown
            })
        }
        if (owner is RosterOwnerOutcome.SavedDelete && context.entry != null && saved.selectedHostId == context.host &&
            SavedResultTarget.of(saved) == context.savedResult &&
            saved.entries.any { SavedEntryTarget.of(saved, it) == context.entry }) {
            val target = context.entry
            if (owner.facts is OwnerSavedDeleteFacts.Deleted) {
                val continuation = context.deletion
                val refresh = if (continuation == null) {
                    null
                } else {
                    val timeout = savedFirstReplyTimeoutMs()
                    if (timeout == null) {
                        continuation.cancel()
                        report("Saved read not submitted: timeout unavailable")
                        null
                    } else {
                        continuation.refresh(
                            event, saved, savedEpoch, dialogs.savedDelete?.proof,
                            firstReplyTimeoutMs = timeout,
                        )
                    }
                }
                // Completion may close only its own dialog, even if the read was canceled.
                // Never dismiss a replacement or infer a result from this deletion.
                if (continuation != null && dialogs.savedDelete?.proof === context.proof) {
                    retireSavedProofs()
                    dialogs = dialogs.copy(savedDelete = null)
                    savedDeleteScope = null
                }
                if (refresh != null && continuation != null) {
                    val command = refresh.command
                    savedRefreshFeedback.shown(continuation)
                    saved = refresh.display
                    // This continuation owns its synchronously raised display; it is
                    // not presented as a picker-intake read by SavedReadFeedback.
                    operation(OperationContext(context.host, context.generation, null,
                        savedQuery = command.query, savedReadLifetime = continuation)) {
                        runtime.savedList(context.host, command)
                    }
                }
            } else {
                saved = saved.copy(deletePreparation = SavedDeletePreparation(target, when (val facts = owner.facts) {
                    OwnerSavedDeleteFacts.ConfirmationRequired -> SavedDeletePreparationStatus.ConfirmationRequired
                    is OwnerSavedDeleteFacts.Refused -> SavedDeletePreparationStatus.Refused(facts.reason)
                    else -> SavedDeletePreparationStatus.Unknown
                }))
                if (owner.facts == OwnerSavedDeleteFacts.ConfirmationRequired) {
                    savedDeleteScope = context.savedResult
                    dialogs = dialogs.copy(savedDelete = SavedDeleteDialog(target,
                        proof(listOf("delete-confirm", context.savedResult, target, event.requestId), UiProofScreen.SAVED_DELETE,
                            target.hostId, target.hostRunId, catalog = target.catalogId, result = target.resultId, entry = target.entryId)))
                }
            }
        }
        // Close results act only on the exact form/request that produced them.
        if (owner is RosterOwnerOutcome.Close) {
            val form = CloseResultFence.matching(dialogs.closeSession, context.proof, context.host, event.hostRunId)
            if (form != null && CloseConnectionFence.admits(form, context.generation)) {
                when (owner.facts) {
                    OwnerCloseFacts.CONFIRMATION_REQUIRED -> {
                        // A real owner answer opens a distinct second in-app stage with a
                        // fresh committed receipt. It never auto-sends confirmed=true and
                        // keeps the form's original connection attempt.
                        dialogs = dialogs.copy(closeSession = form.copy(
                            proof = proof(listOf("close-confirm", form.target, event.requestId),
                                UiProofScreen.SESSION_CLOSE, form.target.hostId, form.target.hostRunId,
                                form.target.rowId, request = event.requestId),
                            confirmationRequestId = event.requestId,
                        ))
                    }
                    OwnerCloseFacts.REMOVED -> {
                        // Only this form closes. The row itself disappears only from the
                        // owner's next complete roster snapshot; nothing is deleted locally.
                        dialogs = dialogs.copy(closeSession = null)
                    }
                    else -> Unit // Retained/non-success outcomes keep their truthful form and notice.
                }
            }
        }
        report(resultText(event))
    }

    private fun finishCreated(context: OperationContext, event: RosterClientEvent.OperationSettled) {
        val activation = context.created ?: return
        if (submittedCreate !== activation) {
            // A newer explicit intent already retired this submit; it may have changed
            // the form or destination. Nothing is closed, activated, or retargeted.
            activation.cancel()
            report(resultText(event))
            return
        }
        val returned = activation.started(event, dialogs.createSession)
        if (returned == null) {
            // Refusal, uncertainty, a superseded form, or a retired receipt leaves the
            // form and every row untouched. No other outcome starts navigation.
            submittedCreate = null
            activation.cancel()
            report(resultText(event))
            return
        }
        // Close exactly the form that was submitted, then wait for the owner's own
        // CURRENT row. No row, target, or navigation is invented before it arrives.
        submittedCreate = null
        cancelCreatedActivation()
        dialogs = dialogs.copy(createSession = null)
        if (!activation.mayActivate) {
            // The owner did create the row, so the submitted form is done; the exact
            // committed receipt is no longer current, so no delayed navigation is owed.
            activation.cancel()
            report(resultText(event))
            return
        }
        createdActivation = activation
        report(resultText(event))
    }

    private fun resultText(event: RosterClientEvent.OperationSettled): String {
        val detail = when (val result = event.result) {
            RosterRequestResult.Unknown -> "outcome unknown; not retried"
            is RosterRequestResult.NotSent -> "not submitted: ${result.reason.name}"
            is RosterRequestResult.OwnerResult -> when (val outcome = result.outcome) {
                is RosterOwnerOutcome.Close -> outcome.facts.wireName
                is RosterOwnerOutcome.Rename -> outcome.facts.wireName
                is RosterOwnerOutcome.Create -> when (outcome.facts) {
                    is OwnerCreateFacts.Started -> "owner reports started"
                    OwnerCreateFacts.Unconfirmed -> "unconfirmed"
                    OwnerCreateFacts.Refused -> "refused"
                    OwnerCreateFacts.Unknown -> "outcome unknown"
                }
                is RosterOwnerOutcome.SavedResume -> when (outcome.facts) {
                    is OwnerSavedResumeFacts.Started -> "owner reports started"
                    is OwnerSavedResumeFacts.Refused -> "refused"
                    OwnerSavedResumeFacts.Unconfirmed -> "unconfirmed"
                    OwnerSavedResumeFacts.Unknown -> "outcome unknown"
                }
                is RosterOwnerOutcome.SavedDelete -> when (outcome.facts) {
                    OwnerSavedDeleteFacts.ConfirmationRequired -> "confirmation required; nothing removed"
                    is OwnerSavedDeleteFacts.Deleted -> "owner reports deleted"
                    is OwnerSavedDeleteFacts.Refused -> "refused"
                    OwnerSavedDeleteFacts.Unconfirmed -> "unconfirmed"
                    OwnerSavedDeleteFacts.Unknown -> "outcome unknown"
                }
                is RosterOwnerOutcome.SavedWindow -> when (outcome.facts) {
                    is RosterSavedWindowFacts.Complete -> "owner result received"
                    is RosterSavedWindowFacts.Refused -> "refused"
                    RosterSavedWindowFacts.Unavailable -> "unavailable"
                    RosterSavedWindowFacts.Unknown -> "outcome unknown"
                }
            }
        }
        return "${event.kind.name}: $detail"
    }
    private fun localForm(proof: UiActionProof, command: () -> String) {
        if (!busyForms.add(proof)) return
        scope.launch {
            try { report(withContext(Dispatchers.IO) { command() }) }
            finally { busyForms.remove(proof); refresh() }
        }
    }
    /** Reserve order on Main at gesture intake, then check authority and dispatch on IO. */
    fun <T> hostCommand(
        host: HostId,
        proof: RosterUiProof,
        command: () -> T,
        completed: (HostCommandSequencer.Dispatch<T>) -> Unit,
        finished: () -> Unit = {},
    ) {
        val ticket = connectionCommands.enqueue(host)
        // App-owned: Activity disposal vetoes its proof, never abandons a FIFO ticket.
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) { ticket.dispatch(proof) { command() } }
                completed(result)
            } finally {
                finished()
                refresh()
            }
        }
    }
    private fun commandText(label: String, result: HostCommandResult): String = when (result) {
        HostCommandResult.Accepted -> "$label accepted locally"
        is HostCommandResult.Refused -> "$label refused: ${result.reason.name}"
    }
    private fun move(intent: ClientIntent.MoveSessionRow) {
        val rows = state.value.hostStates.presentationRows()
        val bindings = RemotePresentationBindingResolver.bind(rows)
        val source = bindings.bindingForIdentity(intent.identity)?.runtime ?: return
        val target = bindings.bindingForIdentity(intent.relativeTo)?.runtime ?: return
        val lifetime = window?.freezeIntentLifetime() ?: return
        scope.launch {
            val result = withContext(Dispatchers.IO) { orderLock.withLock {
                if (lifetime.isStillCurrent()) order.reorder(state.value.hostStates.presentationRows(), source, target, intent.position)
                else null
            } }
            when (result) {
                null -> report("Local order unchanged: intent no longer current")
                is RemotePresentationMoveResult.Refused -> report("Local order unchanged: ${result.reason.name}")
                is RemotePresentationMoveResult.Moved -> {
                    if (result.save is RemotePresentationOrderWriteResult.Refused) report("Local order could not be saved")
                    val currentRows = state.value.hostStates.presentationRows()
                    val keys = withContext(Dispatchers.IO) { orderLock.withLock {
                        order.visibleOrder(currentRows).mapNotNull { key ->
                            key.hostRunId?.let { SessionRowKey(key.hostId, it, key.rowId) }
                        }
                    } }
                    state.value = state.value.copy(rowOrder = keys)
                }
            }
        }
    }

    class PromptStanding(val consent: HostKeyConsent, val proof: UiActionProof) {
        val decision = AtomicReference<FrozenAction?>()
    }
    companion object {
        suspend fun create(context: Context): ClientApplicationController {
            val prompt = AtomicReference<PromptStanding?>()
            val platform = AndroidClientPlatform.create(context, CommittedPromptValidator { consent ->
                val standing = prompt.get()
                standing != null && standing.consent == consent && standing.decision.get()?.isStillCurrent() == true
            })
            try {
                return ClientApplicationController(platform, RemotePresentationOrderCoordinator(store = platform.presentationOrderStore), prompt)
            } catch (failure: Exception) {
                withContext(Dispatchers.Main.immediate) { platform.close() }
                throw failure
            }
        }
    }
}
