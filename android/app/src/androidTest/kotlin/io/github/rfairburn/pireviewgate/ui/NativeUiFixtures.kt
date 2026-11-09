package io.github.rfairburn.pireviewgate.ui

import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import android.view.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.test.platform.app.InstrumentationRegistry
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPlacement
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.input.KeyboardModifiers
import io.github.rfairburn.pireviewgate.core.input.TerminalFunctionKey
import io.github.rfairburn.pireviewgate.core.input.TerminalKey
import io.github.rfairburn.pireviewgate.core.protocol.content.*
import io.github.rfairburn.pireviewgate.core.protocol.roster.*
import io.github.rfairburn.pireviewgate.ui.client.RootUIScreen
import io.github.rfairburn.pireviewgate.ui.terminal.*
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Invented component inputs only. No transport, owner results, identity or storage
 * adapter is installed. Connected/Ready below are explicit fixture facts, not
 * observations about a real host. Screenshots must be described the same way.
 */
internal object NativeUiFixtures {
    const val RUN_A = "11111111-1111-4111-8111-111111111111"
    const val RUN_B = "22222222-2222-4222-8222-222222222222"
    const val FINGERPRINT = "SHA256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    val hostA = HostId.parse("fixture-a")
    val hostB = HostId.parse("fixture-b")

    // The landed enum has no selection/read-specific kinds. Match the existing
    // core contract fixtures' SESSION_CLOSE/SAVED_DELETE token convention; these
    // tests exercise platform presentation, not a future controller's dispatch.
    fun rowProof(host: HostId = hostA, run: String = RUN_A, generation: Long = 1) =
        MutableUiActionProof(UiActionTargetToken(
            screen = UiProofScreen.SESSION_CLOSE, hostId = host, hostRunId = run,
            rowId = "duplicate-row", generation = generation,
        ))

    fun row(host: HostId = hostA, stale: Boolean = false, proof: UiActionProof? = null): SessionUiState {
        val isA = host == hostA
        return SessionUiState(
            hostId = host, hostLabel = if (isA) "Owner A" else "Owner B",
            hostRunId = if (isA) RUN_A else RUN_B, stale = stale, rosterRevision = 7,
            selectProof = proof,
            metadata = RemoteSessionMetadata(
                id = "duplicate-row", label = "Owner label ${if (isA) "A" else "B"}",
                workspace = "/synthetic/workspace/${if (isA) "a" else "b"}",
                lifecycle = RosterLifecycle.ALIVE, hasLiveProcess = true, inputSurface = false,
                rosterSlotId = if (isA) "slot-a" else "slot-b",
                busy = if (isA) false else null, pendingInput = if (isA) false else null,
                activity = listOf("Synthetic activity one", "Synthetic activity two"),
                nativeSession = RemoteNativeSession(
                    "native-${if (isA) "a" else "b"}", 3,
                    if (isA) "Conversation A" else "Conversation B", RemoteNativePersistence.SAVED,
                ),
                backgroundTasks = 2, backgroundShells = 4,
                // Missing is deliberately not zero/idle.
                activeTasks = null, activeShells = null,
            ),
        )
    }

    fun host(id: HostId, label: String, run: String, rows: List<SessionUiState>?, stale: Boolean = false) =
        HostUiState(
            host = ConfiguredHost(id, HostLabel.parse(label), Endpoint("${id.value}.invalid", 8443)),
            connection = if (stale) HostConnectionState.DISCONNECTED else HostConnectionState.CONNECTED,
            roster = rows?.let { RosterSnapshot(
                if (stale) RosterFreshness.STALE else RosterFreshness.CURRENT, run, 7, it,
            ) },
            capabilities = HostCapabilities.fromAcknowledged(listOf(
                RosterWire.CLOSE_CAPABILITY, RosterWire.CREATE_CAPABILITY,
                RosterWire.RENAME_CAPABILITY, RosterWire.SAVED_CAPABILITY,
            ), 1),
            serverFingerprint = FINGERPRINT,
        )

    fun sessions(proofA: UiActionProof? = null, proofB: UiActionProof? = null) = ClientUiState(
        hostStates = listOf(
            host(hostA, "Owner A", RUN_A, listOf(row(proof = proofA))),
            host(hostB, "Owner B", RUN_B, listOf(row(hostB, stale = true, proof = proofB)), stale = true),
            host(HostId.parse("fixture-empty"), "Empty owner", "empty-run", emptyList()),
            host(HostId.parse("fixture-unknown"), "Unobserved owner", "unknown-run", null),
        ),
    )

    fun savedProof(generation: Long, entry: String? = null) = MutableUiActionProof(UiActionTargetToken(
        screen = UiProofScreen.SAVED_DELETE, hostId = hostA, hostRunId = RUN_A,
        catalogId = "catalog-a", resultId = "result-a", requestId = "request-a",
        entryId = entry, generation = generation,
    ))

    fun saved(list: UiActionProof, window: UiActionProof, resume: UiActionProof): ClientUiState {
        val entry = OwnerSavedEntry("entry-a", "native-saved-a", "/synthetic/saved/a.jsonl",
            "Saved conversation A", "/synthetic/workspace/a")
        return sessions().copy(
            route = ClientRoute.Saved(hostA),
            saved = SavedUiState(
                selectedHostId = hostA, status = SavedRequestStatus.Ready, hostRunId = RUN_A,
                catalogId = "catalog-a", resultId = "result-a", requestId = "request-a",
                sequence = 5, total = 2, entries = listOf(entry), transferComplete = true,
                listProof = list, windowProof = window,
                entryProofs = mapOf(SavedEntryKey(RUN_A, "catalog-a", "result-a", "entry-a") to
                    SavedEntryControlProofs(resume = resume)),
            ),
        )
    }

    fun terminal(chooser: Map<SessionRowKey, UiActionProof> = emptyMap()) = TerminalUiState(
        target = TerminalTarget(hostA, RUN_A, "duplicate-row", 1), sessionTitle = "Conversation A",
        hostLabel = "Owner A", hostConnection = HostConnectionState.CONNECTED,
        rosterFreshness = RosterFreshness.CURRENT, chooserProofs = chooser,
    )

    fun binding(sourced: Boolean, selection: Long = 1, cols: Int = 24, rows: Int = 4, revision: Long = 1): TerminalViewBinding {
        val geometry = SessionGeometry(cols, rows, revision)
        val modes = TerminalInputModes(0, false, false, true, MouseTrackingMode.NONE, 0, MouseEncodingMode.DEFAULT)
        return TerminalViewBinding(
            hostId = hostA.value, connectionGeneration = 1, selectionGeneration = selection,
            subscriptionId = "subscription-a", ownerRun = RUN_A, rowId = "duplicate-row",
            publishSequence = revision, geometry = geometry,
            source = if (sourced) NativeIoSource(RUN_A, "duplicate-row", NativeSessionRef("native-a", 3),
                geometry, 1, "synthetic-source-a") else null,
            modes = modes, policyGeneration = 1,
            frame = TerminalFrame(cols, rows, List(rows) { row ->
                val text = listOf("Synthetic fixture only", "Native Canvas viewport", "No connected host", "No network effects")
                    .getOrNull(row).orEmpty()
                "\u001b[0m${text.take(cols).padEnd(cols)}\u001b[0m"
            }, TerminalCursor(0, minOf(3, rows - 1), true)),
        )
    }
}

/** Capture synchronously: checking a later re-armed epoch must not revive this intent. */
internal data class CapturedUiIntent(
    val intent: ClientIntent,
    val proof: UiActionProof?,
    val epoch: Long?,
    val target: UiActionTargetToken? = proof?.target,
    val authorizedAtCapture: Boolean = proof != null && target != null &&
        proof.grantsFor(target) && epoch == proof.epoch,
) {
    // grantsFor brackets its own reads, not our captured epoch. Compare that epoch
    // last so a re-arm during authorization cannot qualify an older queued action.
    val stillAuthorized: Boolean get() = authorizedAtCapture && proof != null && target != null &&
        proof.grantsFor(target) && epoch == proof.epoch
}

internal data class EncodedUiPacket(
    val kind: NativeIoInputKind,
    val bytes: ByteArray,
    val receipt: FrameCommitReceipt,
    val verifiedAtCapture: Boolean,
)

/** UI-only response loop. It records requests, never fabricates successful owner operations. */
internal class NativeUiFixture(initial: ClientUiState) {
    var state by mutableStateOf(initial)
    var binding by mutableStateOf<TerminalViewBinding?>(null)
    var surface: TerminalSurfaceView? = null
    val intents = CopyOnWriteArrayList<CapturedUiIntent>()
    val receipts = CopyOnWriteArrayList<FrameCommitReceipt>()
    val packets = CopyOnWriteArrayList<EncodedUiPacket>()
    val refusals = CopyOnWriteArrayList<InputUnavailableReason>()
    /** The not-sent notice each recorded packet carried, in packet order. */
    val refusalNotices = CopyOnWriteArrayList<TerminalInputRefusal>()
    /** Runs on main right after a packet is recorded, as a caller's intake could. */
    var afterInput: (() -> Unit)? = null
    val viewports = CopyOnWriteArrayList<Pair<Int, Int>>()

    // Overlay placement is hoisted above the route exactly as production hoists it: the
    // screen reads one placement value and a completed gesture replaces that value. The
    // fixture never opens, reads, or writes a placement store, so a committed docking or
    // remembered position lives only as long as the fixture does — no durable test state.
    var overlayPlacement by mutableStateOf(TerminalOverlayPlacement.DEFAULT)
    var overlayPlacementCommits = 0
        private set

    private fun updateTerminal(block: (TerminalUiState) -> TerminalUiState) {
        val route = state.route as? ClientRoute.Terminal ?: return
        val next = block(route.terminal)
        if (next != route.terminal) state = state.copy(route = ClientRoute.Terminal(next))
    }

    fun onIntent(intent: ClientIntent) {
        val proof = when (intent) {
            is ClientIntent.EnterTerminal -> intent.proof
            is ClientIntent.SwitchTerminalTarget -> intent.proof
            is ClientIntent.RequestSavedList -> intent.proof
            is ClientIntent.RequestSavedWindow -> intent.proof
            is ClientIntent.ResumeSavedEntry -> intent.proof
            is ClientIntent.ApproveFirstContactServerKey -> intent.proof
            is ClientIntent.ConfirmSessionClose -> intent.proof
            is ClientIntent.SubmitNewHost -> intent.proof
            is ClientIntent.SaveHostAddressAndReconnect -> intent.proof
            else -> null
        }
        // Freeze before any response/recomposition or asynchronous test work.
        intents.add(CapturedUiIntent(intent, proof, proof?.epoch))
        when (intent) {
            is ClientIntent.UiCoverageChanged -> {
                surface?.setModalSuspended(intent.coverage.suspendsTerminalInput)
                state = state.copy(coverage = intent.coverage)
                updateTerminal { it.withCoverage(intent.coverage).copy(inputReady = surface?.currentInputProof() != null) }
            }
            is ClientIntent.SetTerminalExtraKeysVisible -> updateTerminal { it.copy(extraKeysVisible = intent.visible) }
            is ClientIntent.ToggleTerminalModifier -> updateTerminal {
                val modifiers = it.modifiers.toggled(intent.modifier)
                surface?.setMobileModifiers(modifiers.bits())
                it.copy(modifiers = modifiers)
            }
            is ClientIntent.SetTerminalKeyboardVisible -> {
                if (intent.visible) surface?.openKeyboard()
                else surface?.windowInsetsController?.hide(WindowInsets.Type.ime())
                // Visibility is observed through actual insets by instrumentation,
                // not asserted from this request's boolean.
            }
            else -> Unit
        }
    }

    /**
     * The screen's completed-gesture commit. It publishes the supplied placement exactly as
     * the production holder does, and logs synthetic placement facts only: the count, the
     * docking states, the remembered sizes, and the permille positions. No input, packet,
     * host, session, or clipboard value is ever logged here.
     */
    fun onOverlayPlacementCommitted(placement: TerminalOverlayPlacement) {
        overlayPlacementCommits += 1
        overlayPlacement = placement
        Log.i("NativeUiDiagnostics", "placement-commit n=$overlayPlacementCommits placement=$placement")
    }

    private val listener = object : TerminalSurfaceListener {
        override fun onViewportRequested(cols: Int, rows: Int) {
            viewports.add(cols to rows)
            Log.i("NativeUiDiagnostics", "viewport=$cols x $rows")
            // Synthetic owner response to the REAL measured pane, not a preset
            // grid. No network or proof is fabricated: Canvas/platform commits
            // still have to draw and attest to this newly bound frame.
            binding?.let { old ->
                val next = NativeUiFixtures.binding(old.source != null, old.selectionGeneration,
                    cols, rows, old.geometry.revision + 1)
                binding = next
                surface?.setBinding(next)
            }
            updateTerminal { it.copy(inputReady = false) }
        }
        override fun onFrameCommitted(receipt: FrameCommitReceipt) {
            receipts.add(receipt)
            updateTerminal { it.copy(inputReady = surface?.verifyReceipt(receipt) == true) }
        }
        override fun onInput(kind: NativeIoInputKind, bytes: ByteArray, receipt: FrameCommitReceipt) {
            val verified = surface?.verifyReceipt(receipt) == true
            check(verified) { "Packet attributed to an obsolete receipt" }
            packets.add(EncodedUiPacket(kind, bytes.copyOf(), receipt, verified))
        }
        override fun onInput(kind: NativeIoInputKind, bytes: ByteArray, receipt: FrameCommitReceipt,
            refusal: TerminalInputRefusal) {
            onInput(kind, bytes, receipt)
            refusalNotices.add(refusal)
            afterInput?.invoke()
        }
        override fun onInputUnavailable(reason: InputUnavailableReason) {
            refusals.add(reason)
            Log.i("NativeUiDiagnostics", "refusal=$reason")
        }
    }

    fun logTerminalState(phase: String) {
        val view = surface
        Log.i("NativeUiDiagnostics", "$phase surface=$view size=${view?.width}x${view?.height} " +
            "focused=${view?.hasFocus()} windowFocus=${view?.hasWindowFocus()} shown=${view?.isShown} " +
            "hardware=${view?.isHardwareAccelerated} binding=${view?.currentBinding()} " +
            "receipt=${view?.currentReceipt()} input=${view?.currentInputProof()} refusals=$refusals")
    }

    @Composable
    fun Content() {
        RootUIScreen(
            // The stored preference is the single source of truth for diagnostic notice
            // presentation, exactly as in production. A fixture that expects notices
            // enables the setting on its own state instead of a parallel flag.
            state = state,
            onIntent = ::onIntent,
            debugInputMessagingEnabled = state.settings.debugInputMessagingEnabled,
            onTerminalKey = { request -> surface?.submitKey(request.asRendererKey()) },
            // Never access a device/user clipboard, even in instrumentation.
            onTerminalPaste = { surface?.submitPastedText("fixed synthetic paste") },
            // Wired rather than defaulted: an unwired fixture silently drops every docking
            // toggle into the screen's no-op callback and cannot show a floating panel.
            overlayPlacement = overlayPlacement,
            onOverlayPlacementCommitted = ::onOverlayPlacementCommitted,
            terminalContent = {
                TerminalSurface(binding, Modifier.fillMaxSize(), listener) { view ->
                    surface = view
                    view.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
                        logTerminalState("layout")
                    }
                    view.post {
                        Log.i("NativeUiDiagnostics", "requestFocus=${view.requestFocus()}")
                        logTerminalState("posted-focus")
                    }
                }
            },
        )
    }
}

internal fun TerminalModifiers.bits(): Int =
    (if (ctrl) KeyboardModifiers.CTRL else 0) or (if (alt) KeyboardModifiers.ALT else 0) or
        (if (shift) KeyboardModifiers.SHIFT else 0) or (if (meta) KeyboardModifiers.META else 0)

private fun TerminalKeyRequest.asRendererKey(): TerminalKey {
    val bits = modifiers.bits()
    return when (key) {
        TerminalControlKey.ESCAPE -> TerminalKey(codepoint = 27, modifiers = bits)
        TerminalControlKey.TAB -> TerminalKey(codepoint = 9, modifiers = bits)
        TerminalControlKey.BACKTAB -> TerminalKey(codepoint = 9, modifiers = bits or KeyboardModifiers.SHIFT)
        else -> TerminalKey(functionKey = when (key) {
            TerminalControlKey.ARROW_UP -> TerminalFunctionKey.UP
            TerminalControlKey.ARROW_DOWN -> TerminalFunctionKey.DOWN
            TerminalControlKey.ARROW_LEFT -> TerminalFunctionKey.LEFT
            TerminalControlKey.ARROW_RIGHT -> TerminalFunctionKey.RIGHT
            else -> TerminalFunctionKey.valueOf(key.name)
        }, modifiers = bits)
    }
}

/** Opt-in guest evidence only; pull privately and label it synthetic component UI. */
internal fun captureSyntheticScreen(name: String) {
    if (InstrumentationRegistry.getArguments().getString("uiScreenshots") != "true") return
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val root = File(instrumentation.targetContext.filesDir, "ui-evidence")
    check(root.isDirectory || root.mkdirs())
    val file = File(root, "api${Build.VERSION.SDK_INT}-$name.png")
    val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
    try {
        file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    } finally {
        bitmap.recycle()
    }
    Log.i("NativeUiEvidence", "SYNTHETIC COMPONENT FIXTURE ONLY: ${file.absolutePath}")
}
