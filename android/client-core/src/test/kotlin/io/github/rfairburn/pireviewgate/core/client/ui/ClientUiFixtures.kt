package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostCatalog
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteNativePersistence
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteNativeSession
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle

/**
 * Synthetic view fixtures.
 *
 * Every host, endpoint, run, row, workspace, and entry below is invented for these
 * tests. No live owner, real address, or real saved session appears anywhere in this
 * file, and nothing here is ever reachable from production code.
 */
internal object ClientUiFixtures {
    const val RUN_A = "11111111-1111-4111-8111-111111111111"
    const val RUN_B = "22222222-2222-4222-8222-222222222222"

    fun settings(vararg hosts: ConfiguredHost): NetworkSettings =
        NetworkSettings(hosts = HostCatalog.of(hosts.toList()))

    fun host(
        id: String,
        label: String = "host-$id",
        hostAddress: String = "10.0.0.$id",
        port: Int = 8443,
        previouslyConnected: Boolean = true,
        reconnectSuppressed: Boolean = false,
    ): ConfiguredHost = ConfiguredHost(
        id = HostId.parse(id),
        label = HostLabel.parse(label),
        endpoint = Endpoint(hostAddress, port),
        previouslyConnected = previouslyConnected,
        reconnectSuppressed = reconnectSuppressed,
    )

    fun hostState(
        id: String,
        connection: HostConnectionState = HostConnectionState.CONNECTED,
        rows: List<SessionUiState>? = null,
        capabilities: HostCapabilities = HostCapabilities.UNKNOWN,
        savedPolicy: SavedPolicyStatus = SavedPolicyStatus.UNKNOWN,
        serverFingerprint: String? = "aaaa-bbbb-cccc",
    ): HostUiState = HostUiState(
        host = host(id),
        connection = connection,
        roster = rows?.let {
            RosterSnapshot(
                freshness = if (it.firstOrNull()?.stale == true) RosterFreshness.STALE else RosterFreshness.CURRENT,
                hostRunId = RUN_A,
                revision = 7L,
                rows = it,
            )
        },
        capabilities = capabilities,
        savedPolicy = savedPolicy,
        serverFingerprint = serverFingerprint,
    )

    fun row(
        hostId: String,
        rowId: String = "row-1",
        label: String = "display-$rowId",
        lifecycle: RosterLifecycle = RosterLifecycle.ALIVE,
        busy: Boolean? = null,
        pendingInput: Boolean? = null,
        inputSurface: Boolean = false,
        activeTasks: Long? = null,
        activeShells: Long? = null,
        backgroundTasks: Long? = null,
        backgroundShells: Long? = null,
        nativeSession: RemoteNativeSession? = null,
        exitCode: Double? = null,
        error: String? = null,
        rosterSlotId: String? = null,
        stale: Boolean = false,
        revision: Long = 7L,
        workspace: String = "/home/owner/project",
        selectProof: UiActionProof? = null,
    ): SessionUiState = SessionUiState(
        hostId = HostId.parse(hostId),
        hostLabel = "host-$hostId",
        hostRunId = RUN_A,
        stale = stale,
        rosterRevision = revision,
        selectProof = selectProof,
        metadata = RemoteSessionMetadata(
            id = rowId,
            label = label,
            workspace = workspace,
            lifecycle = lifecycle,
            hasLiveProcess = lifecycle == RosterLifecycle.ALIVE,
            inputSurface = inputSurface,
            rosterSlotId = rosterSlotId,
            busy = busy,
            pendingInput = pendingInput,
            activity = listOf("tool: read"),
            nativeSession = nativeSession,
            backgroundTasks = backgroundTasks,
            backgroundShells = backgroundShells,
            activeTasks = activeTasks,
            activeShells = activeShells,
            exitCode = exitCode,
            error = error,
        ),
    )

    fun nativeSession(
        id: String = "native-1",
        epoch: Long = 3L,
        name: String = "Native name",
        persistence: RemoteNativePersistence? = RemoteNativePersistence.SAVED,
    ): RemoteNativeSession = RemoteNativeSession(id, epoch, name, persistence)

    /** A terminal view state addressed at one row. */
    fun terminalState(
        hostId: String = "a",
        rowId: String = "row-1",
        generation: Long = 1L,
        keyboardVisible: Boolean = false,
        extraKeysVisible: Boolean = false,
        quickSwitcherVisible: Boolean = false,
        coverage: UiCoverage = UiCoverage.NONE,
        modifiers: TerminalModifiers = TerminalModifiers.NONE,
        inputReady: Boolean = true,
    ): TerminalUiState = TerminalUiState(
        target = TerminalTarget(HostId.parse(hostId), RUN_A, rowId, generation),
        sessionTitle = "row $rowId",
        hostLabel = "host-$hostId",
        hostConnection = HostConnectionState.CONNECTED,
        rosterFreshness = RosterFreshness.CURRENT,
        coverage = coverage,
        inputReady = inputReady,
        keyboardVisible = keyboardVisible,
        extraKeysVisible = extraKeysVisible,
        modifiers = modifiers,
        quickSwitcherVisible = quickSwitcherVisible,
    )

    /** A proof stand-in: every gate is a plain value the test controls. */
    class FakeProof(
        override val target: UiActionTargetToken,
        var current: Boolean = true,
        var committed: Boolean = true,
        var readable: Boolean = true,
        var drawEpoch: Long = 1L,
    ) : UiActionProof {
        override val epoch: Long get() = drawEpoch
        override val isCurrent: Boolean get() = current
        override val hasCommittedFrame: Boolean get() = committed
        override val criticalIdentityReadable: Boolean get() = readable
    }

    fun token(
        screen: UiProofScreen = UiProofScreen.SESSION_CLOSE,
        hostId: String = "a",
        generation: Long = 1L,
        rowId: String? = "row-1",
    ): UiActionTargetToken = UiActionTargetToken(
        screen = screen,
        hostId = HostId.parse(hostId),
        hostRunId = RUN_A,
        rowId = rowId,
        generation = generation,
    )
}
