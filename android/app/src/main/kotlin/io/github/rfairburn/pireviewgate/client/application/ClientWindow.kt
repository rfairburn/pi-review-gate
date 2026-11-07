package io.github.rfairburn.pireviewgate.client.application

import android.content.ClipData
import android.content.ClipboardManager
import android.view.WindowInsets
import android.view.ViewTreeObserver
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import io.github.rfairburn.pireviewgate.ClientActivity
import io.github.rfairburn.pireviewgate.client.platform.AndroidClientActivityBinding
import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.application.HostCommandSequencer
import io.github.rfairburn.pireviewgate.core.client.application.AcceptedAddressEdit
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.client.content.*
import io.github.rfairburn.pireviewgate.core.client.platform.ClientLifecycleCallbacks
import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.client.runtime.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.input.*
import io.github.rfairburn.pireviewgate.core.permissions.*
import io.github.rfairburn.pireviewgate.core.protocol.content.*
import io.github.rfairburn.pireviewgate.permissions.AndroidLocalNetworkPermissionProbe
import io.github.rfairburn.pireviewgate.permissions.openAppPermissionSettings
import io.github.rfairburn.pireviewgate.ui.terminal.*
import kotlinx.coroutines.flow.*
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** One actual Activity/window. No view/Activity survives close or enters a transport guard. */
class ClientWindow(private val activity: ClientActivity, private val app: ClientApplicationController) : ClientLifecycleCallbacks {
    private val gate = LocalNetworkPermissionGate(AndroidLocalNetworkPermissionProbe(activity))
    private var lifecycleBinding: AndroidClientActivityBinding? = null
    private var connectToken: LocalNetworkRequestToken? = null
    private var requestId: Long? = null
    private var launchedToken: LocalNetworkRequestToken? = null
    private var connectGeneration = 0L
    private val windowEpoch = AtomicLong()
    private val epochPublication = MutableStateFlow(0L)
    val epochs = epochPublication.asStateFlow()
    private var connectEpoch = 0L
    private var editedConnectGeneration: Long? = null
    private var closed = false
    private var needsFreshSurface = false
    private var focusObserver: ViewTreeObserver? = null
    private val focusListener = ViewTreeObserver.OnWindowFocusChangeListener { if (!closed && app.window === this) app.updateCoverage() }
    private val surfaceEpoch = MutableStateFlow(0L)
    private val inputEpoch = AtomicLong()
    private val measuredViewport = AtomicReference<ContentViewportRequest?>()
    private data class OwnedView(val epoch: Long, val view: TerminalSurfaceView)
    private val owned = AtomicReference<OwnedView?>()
    data class RenderFrame(val binding: TerminalViewBinding, val resizeEpoch: Long)
    private val render = MutableStateFlow<RenderFrame?>(null)
    private val rendered = AtomicReference<RenderFrame?>()
    private var covered = true
    private val rationale = MutableStateFlow<LocalNetworkRequestToken?>(null)
    val permissionRationale = rationale.asStateFlow()

    fun bind() {
        app.attachWindow(this)
        lifecycleBinding = app.platform.bindActivity(activity, activity, this)
        focusObserver = activity.window.decorView.viewTreeObserver.also { it.addOnWindowFocusChangeListener(focusListener) }
        activity.window.decorView.setOnApplyWindowInsetsListener { view, insets ->
            if (!closed && app.window === this) app.observedKeyboard(insets.isVisible(WindowInsets.Type.ime()))
            view.onApplyWindowInsets(insets)
        }
    }
    fun started() { if (!closed) { gate.enterForeground(); app.refreshPermission() } }
    fun resumed() {
        if (closed) return
        gate.refresh()
        app.platform.refreshLocalNetworkPermission()
        app.runtime.setAppForeground(app.platform.registry.snapshot.value.foreground)
        if (needsFreshSurface && app.ui.value.route is ClientRoute.Terminal) {
            needsFreshSurface = false
            newSelection() // Measures the real replacement pane; never reuses a startup size.
        }
        app.updateCoverage()
        app.refreshPermission()
    }
    fun stopped() {
        gate.leaveForeground()
        if (app.window === this) app.cancelAddressEdit()
        cancelConnect()
    }
    fun focusChanged() { if (!closed) app.updateCoverage() }

    override fun invalidateTerminalInput() {
        retireTerminal()
        if (app.window !== this) return
        app.runtime.setTerminalInputCoverage(false)
        // Temporary OS/modal focus loss is NOT true application background.
        if (!app.platform.registry.snapshot.value.foreground) {
            app.runtime.setAppForeground(false)
            app.cancelNavigation()
        }
    }
    override fun invalidateWindowProofs() {
        epochPublication.value = windowEpoch.incrementAndGet()
        needsFreshSurface = true
        retireTerminal()
        if (app.window === this) app.retireWindowProofs()
    }
    override fun cancelPendingUserIntent() {
        cancelConnect()
        if (app.window === this) { app.cancelAddressEdit(); app.cancelNavigation() }
    }
    fun retireWindow() {
        invalidateTerminalInput()
        invalidateWindowProofs()
        cancelPendingUserIntent()
    }
    fun close() {
        if (closed) return
        retireWindow()
        closed = true
        lifecycleBinding?.close()
        lifecycleBinding = null
        focusObserver?.takeIf { it.isAlive }?.removeOnWindowFocusChangeListener(focusListener)
        focusObserver = null
        app.detachWindow(this)
        owned.getAndSet(null)?.view?.let { it.listener = null; it.setBinding(null); it.release() }
        render.value = null; rendered.set(null)
        activity.window.decorView.setOnApplyWindowInsetsListener(null)
    }

    fun permissionObservation(): LocalNetworkPermissionObservation = gate.refresh()
    fun catalogChanged(snapshot: ConnectionRegistrySnapshot) {
        val token = connectToken ?: return
        val host = snapshot.hosts.firstOrNull { it.hostId == token.hostId }
        if (host == null || host.endpoint != token.endpoint || !snapshot.foreground ||
            (editedConnectGeneration != null && host.generation != editedConnectGeneration)) cancelConnect()
    }
    fun connect(hostId: HostId) {
        if (closed || app.window !== this || !app.platform.registry.snapshot.value.foreground || !activity.hasWindowFocus()) return
        val host = app.platform.registry.snapshot.value.hosts.firstOrNull { it.hostId == hostId } ?: return
        beginConnect(hostId, host.endpoint)
    }
    /**
     * Only the controller's still-drawn accepted combined gesture can call this.
     * A Material dialog, unlike a host-row tap, owns focus itself; do not pretend
     * the Activity has focus or mint a host-row proof after closing that dialog.
     */
    internal fun connectEditedAddress(target: AcceptedAddressEdit.Reconnect): Boolean {
        val snapshot = app.platform.registry.snapshot.value
        val host = snapshot.hosts.firstOrNull { it.hostId == target.hostId }
        if (closed || app.window !== this || !snapshot.foreground || host == null || host.endpoint != target.endpoint ||
            host.generation != target.connectionGeneration || !target.consume()) return false
        beginConnect(target.hostId, target.endpoint, target.connectionGeneration)
        return true
    }
    private fun beginConnect(hostId: HostId, endpoint: Endpoint, generation: Long? = null) {
        cancelConnect()
        editedConnectGeneration = generation
        val token = LocalNetworkRequestToken(hostId, endpoint, ++connectGeneration)
        connectToken = token
        connectEpoch = windowEpoch.get()
        val observation = gate.refresh()
        if (!app.platform.requiresLocalNetworkGrant(endpoint) || !observation.needsPermission) {
            continueConnect(token)
        } else if (observation.shouldShowRationale) {
            rationale.value = token
            retireTerminal()
            app.runtime.setTerminalInputCoverage(false)
        } else launchPermission(token)
        app.refreshPermission()
    }
    fun continueRationale(token: LocalNetworkRequestToken) {
        if (rationale.value != token || !isConnectCurrent(token)) return
        rationale.value = null
        launchPermission(token)
    }
    private fun launchPermission(token: LocalNetworkRequestToken) {
        if (!isConnectCurrent(token)) return
        if (requestId != null) { app.report("A system permission request is still pending"); cancelConnect(); return }
        when (val start = gate.prepareRequest(token)) {
            is LocalNetworkRequestStart.Accepted -> {
                requestId = start.request.requestId
                launchedToken = start.request.token
                activity.launchLocalNetworkPermission()
            }
            is LocalNetworkRequestStart.Rejected -> {
                if (start.reason == LocalNetworkRequestRejectionReason.PERMISSION_ALREADY_GRANTED ||
                    start.reason == LocalNetworkRequestRejectionReason.PERMISSION_NOT_REQUIRED) continueConnect(token)
                else { cancelConnect(); app.report("Local network permission request not started: ${start.reason.name}") }
            }
        }
    }
    fun permissionResult(granted: Boolean) {
        val id = requestId
        val launched = launchedToken
        requestId = null
        launchedToken = null
        lifecycleBinding?.refreshAfterPermissionResult()
        val result = id?.let { gate.resolve(it, granted, connectToken) }
        when (result) {
            is LocalNetworkRequestResolution.Granted -> {
                // Same accepted gesture, request, endpoint and window only; never a new Connect.
                if (isConnectCurrent(result.token)) continueConnect(result.token)
            }
            is LocalNetworkRequestResolution.Denied -> {
                if (connectToken == result.token) cancelConnect()
                app.report("Local network permission denied; connection not started")
            }
            else -> {
                if (launched != null && connectToken == launched) cancelConnect()
                app.report("Local network permission result is no longer current")
            }
        }
        app.refreshPermission()
    }
    private fun isConnectCurrent(token: LocalNetworkRequestToken): Boolean {
        val host = app.platform.registry.snapshot.value.hosts.firstOrNull { it.hostId == token.hostId }
        return !closed && app.window === this && connectToken == token && connectEpoch == windowEpoch.get() &&
            app.platform.registry.snapshot.value.foreground && host != null && host.endpoint == token.endpoint &&
            (editedConnectGeneration == null || host.generation == editedConnectGeneration)
    }
    private fun continueConnect(token: LocalNetworkRequestToken) {
        if (!isConnectCurrent(token)) return
        val publication = ConnectPublication(token, connectEpoch, editedConnectGeneration)
        connectPublication.set(publication)
        // The shared per-host boundary covers validation AND registry.connect. A newer
        // Disconnect/Remove is reserved synchronously after this ticket and cannot be
        // overtaken by this IO task after it passed validation.
        app.hostCommand(token.hostId, RosterUiProof {
            val host = app.platform.registry.snapshot.value.hosts.firstOrNull { it.hostId == token.hostId }
            connectPublication.get() === publication && windowEpoch.get() == publication.epoch &&
                host != null && host.endpoint == token.endpoint &&
                (publication.generation == null || host.generation == publication.generation) &&
                app.platform.registry.snapshot.value.foreground
        }, { app.platform.registry.connect(token.hostId) }, { dispatch ->
            if (connectToken == token) cancelConnect(token.hostId)
            app.report(when (dispatch) {
                HostCommandSequencer.Dispatch.Retired -> "Connect not started: request changed"
                is HostCommandSequencer.Dispatch.Executed -> when (val result = dispatch.value) {
                    HostCommandResult.Accepted -> "Connect accepted locally"
                    is HostCommandResult.Refused -> "Connect refused: ${result.reason.name}"
                }
            })
        })
    }
    // Connect creates a NEW registry attempt. Ordinary Connect can follow prior FIFO
    // generation changes; an edited-address handoff additionally requires its exact
    // post-save generation until dispatch. Channel guards stay in the registry/runtime.
    private data class ConnectPublication(val token: LocalNetworkRequestToken, val epoch: Long, val generation: Long?)
    private val connectPublication = AtomicReference<ConnectPublication?>()
    fun cancelConnect(hostId: HostId? = null) {
        if (hostId != null && connectToken?.hostId != hostId) return
        connectPublication.set(null)
        connectToken = null
        editedConnectGeneration = null
        gate.retirePending()
        rationale.value = null
    }
    fun openPermissionSettings(host: HostId) {
        if (closed || app.ui.value.hostState(host) == null) return
        cancelConnect()
        openAppPermissionSettings(activity)
    }

    fun newSelection() {
        retireTerminal()
        keyboard(false)
        owned.getAndSet(null)?.view?.let { it.listener = null; it.setBinding(null) }
        render.value = null; rendered.set(null)
        measuredViewport.set(null)
        surfaceEpoch.value++
    }
    fun retireTerminal() {
        inputEpoch.incrementAndGet()
        owned.get()?.view?.let {
            it.invalidateCommittedFrame(InputUnavailableReason.BINDING_RETIRED)
            it.clearMobileModifiers()
        }
    }
    /** The callbacks retain the route/window that installed them, never a later selection. */
    fun dispatch(intent: ClientIntent, frame: ClientUiState, epoch: Long) {
        if (closed || app.window !== this || windowEpoch.get() != epoch) return
        val route = frame.route
        if (intent !is ClientIntent.UiCoverageChanged && frame.dialogs.openKinds != app.ui.value.dialogs.openKinds) return
        val hostTarget = when (intent) {
            is ClientIntent.ConnectHost -> intent.hostId
            is ClientIntent.DisconnectHost -> intent.hostId
            is ClientIntent.RequestLocalNetworkPermissionRetry -> intent.hostId
            is ClientIntent.OpenLocalNetworkPermissionSettings -> intent.hostId
            is ClientIntent.RequestEditHostAddress -> intent.target.hostId
            else -> null
        }
        if (hostTarget != null) {
            val drawn = frame.hostState(hostTarget)?.host ?: return
            val current = app.ui.value.hostState(hostTarget)?.host ?: return
            if (drawn.id != current.id || drawn.endpoint != current.endpoint || drawn.label != current.label) return
        }
        val expected = (route as? ClientRoute.Terminal)?.terminal?.target
        val current = (app.ui.value.route as? ClientRoute.Terminal)?.terminal?.target
        if (expected != current) return
        if (route !is ClientRoute.Terminal && app.ui.value.route != route) return
        app.intent(intent)
    }
    fun freezeIntentLifetime(): RosterUiProof {
        val epoch = windowEpoch.get()
        return RosterUiProof { windowEpoch.get() == epoch && app.platform.registry.snapshot.value.foreground }
    }
    private fun currentTarget(target: io.github.rfairburn.pireviewgate.core.client.ui.TerminalTarget?): Boolean =
        target != null && !closed && app.window === this &&
            (app.ui.value.route as? ClientRoute.Terminal)?.terminal?.target == target &&
            app.runtime.state.value.selection?.selectionGeneration == target.selectionGeneration

    fun coverageChanged(next: Boolean) {
        if (covered != next) inputEpoch.incrementAndGet()
        covered = next
        owned.get()?.view?.setModalSuspended(next)
    }
    fun inputReady(): Boolean {
        val view = owned.get()?.view ?: return false
        val receipt = view.currentInputProof() ?: return false
        return currentProof(view, receipt, inputEpoch.get()).isStillCurrent()
    }

    fun publish(state: ClientRuntimeState) {
        if (closed) return
        val selected = state.selection
        val observation = selected?.observation
        val snapshot = observation?.view
        val next = if (selected == null || observation == null || snapshot == null) null else RenderFrame(
            TerminalViewBinding(selected.target.hostId.value, observation.target.connectionGeneration,
                selected.selectionGeneration, observation.subscriptionId, selected.target.ownerRunId, selected.target.rowId,
                snapshot.meta.sequence, snapshot.meta.geometry, TerminalViewBinding.sourceOf(snapshot.meta.inputSource),
                snapshot.meta.inputModes, observation.inputPolicy.generation, snapshot.frame,
                inputGeneration = observation.inputGeneration, resizeEpoch = observation.resizeEpoch),
            observation.resizeEpoch)
        val previous = render.value
        if (previous != next) {
            // Ordinary output (same semantic input context, newer publish/content) only
            // changes what is displayed: guards captured against the committed proof
            // for this context stay valid. Any semantic context change — including an
            // A -> B -> A return a conflated emission never showed — is a writer boundary.
            if (previous == null || next == null || !previous.binding.sameInputContextAs(next.binding) ||
                previous.resizeEpoch != next.resizeEpoch) inputEpoch.incrementAndGet()
            rendered.set(next)
            render.value = next
        }
        owned.get()?.view?.setUserInputEnabled(state.inputPolicy.enabled &&
            app.platform.registry.snapshot.value.viewerRemoteInputEnabled && !app.policyChangePending.get())
    }

    @Composable
    fun Surface() {
        val observedEpoch by surfaceEpoch.collectAsState()
        val epoch = observedEpoch // Freeze callback ownership in this composition.
        val frame by render.collectAsState()
        key(this, epoch) {
            val listener = remember(this, epoch) { surfaceListener(epoch) }
            TerminalSurface(frame?.binding, Modifier.fillMaxSize(), listener) { view ->
                if (!closed && surfaceEpoch.value == epoch) {
                    owned.set(OwnedView(epoch, view))
                    view.setModalSuspended(covered)
                    view.setUserInputEnabled(app.runtime.state.value.inputPolicy.enabled &&
                        app.platform.registry.snapshot.value.viewerRemoteInputEnabled && !app.policyChangePending.get())
                    view.setOnApplyWindowInsetsListener { v, insets ->
                        if (owns(epoch, view)) app.observedKeyboard(insets.isVisible(WindowInsets.Type.ime()))
                        v.onApplyWindowInsets(insets)
                    }
                }
            }
        }
    }
    private fun owns(epoch: Long, view: TerminalSurfaceView): Boolean = !closed && app.window === this &&
        owned.get()?.let { it.epoch == epoch && it.view === view } == true

    private fun surfaceListener(epoch: Long) = object : TerminalSurfaceListener {
        private fun view(): TerminalSurfaceView? = owned.get()?.takeIf { it.epoch == epoch && !closed && app.window === this@ClientWindow }?.view
        override fun onViewportRequested(cols: Int, rows: Int) {
            val view = view() ?: return
            if (!owns(epoch, view)) return
            inputEpoch.incrementAndGet()
            val viewport = try { ContentViewportRequest(cols, rows) } catch (_: IllegalArgumentException) {
                measuredViewport.set(null); app.report("Terminal pane size is outside protocol bounds"); return
            }
            measuredViewport.set(viewport)
            app.measured(cols, rows)
        }
        override fun onFrameCommitted(receipt: FrameCommitReceipt) {
            val view = view() ?: return
            val frozen = rendered.get() ?: return
            // The view may still be showing an earlier binding of the newest frame's input
            // context, and the receipt may name an earlier publish of it that genuinely drew
            // before newer output arrived. Both are the same context; nothing else is.
            if (view.currentBinding()?.sameInputContextAs(frozen.binding) != true || !matches(receipt, frozen) ||
                !view.verifyReceipt(receipt) || !selected(receipt) || !viewportApplied() || !app.platform.terminalInputEligible ||
                app.policyChangePending.get() || !app.platform.registry.snapshot.value.viewerRemoteInputEnabled || covered) return
            // All geometry comes from THIS actual draw's CELL extent, publish, input
            // generation, and resize epoch; the endpoint rejects anything outside its
            // current context.
            app.runtime.recordWrittenFrame(ContentWrittenFrameProof(receipt.selectionGeneration, receipt.subscriptionId,
                receipt.publishSequence, receipt.geometry, receipt.resizeEpoch, receipt.policyGeneration,
                ContentPaneRect(0, 0, receipt.drawnColumns, receipt.drawnRows), receipt.inputGeneration))
        }
        override fun onInput(kind: NativeIoInputKind, bytes: ByteArray, receipt: FrameCommitReceipt) {
            val view = view() ?: return
            val epochAtIntake = inputEpoch.get()
            val guard = currentProof(view, receipt, epochAtIntake)
            if (!guard.isStillCurrent()) { app.report("Input not sent: current written frame required"); return }
            val source = receipt.source ?: return
            val packet = decodeUtf8(bytes) ?: run { app.report("Input not sent: invalid UTF-8 packet"); return }
            // PasteEncoder already added delimiters using THIS receipt's modes. The endpoint
            // expects its BODY, not another encoded paste. Remove exactly the known wrapper.
            val body = if (kind == NativeIoInputKind.PASTE && receipt.modes.bracketedPaste) {
                val prefix = "\u001b[200~"; val suffix = "\u001b[201~"
                if (!packet.startsWith(prefix) || !packet.endsWith(suffix) || packet.length < prefix.length + suffix.length) {
                    app.report("Paste not sent: invalid renderer packet"); return
                }
                packet.substring(prefix.length, packet.length - suffix.length)
            } else packet
            val request = ContentInputRequest(source, receipt.modes, kind, body)
            app.submitNativeInput(HostId.parse(receipt.hostId), receipt.selectionGeneration, request, guard)
        }
        override fun onInputUnavailable(reason: InputUnavailableReason) {
            if (view() != null) app.report("Terminal input unavailable: ${reason.name}")
        }
        override fun onMobileModifiersChanged(modifiers: Int) {
            if (view() != null) app.observedModifiers(TerminalModifiers(
                modifiers and KeyboardModifiers.CTRL != 0, modifiers and KeyboardModifiers.ALT != 0,
                modifiers and KeyboardModifiers.SHIFT != 0))
        }
    }

    /** Writer checks ONLY native atomic publication + immutable runtime snapshots. */
    private fun currentProof(view: TerminalSurfaceView, receipt: FrameCommitReceipt, epoch: Long): RosterUiProof {
        val owner = owned.get()
        return RosterUiProof {
            inputEpoch.get() == epoch && owned.get() === owner && owner?.view === view &&
                app.platform.terminalInputEligible && !app.policyChangePending.get() &&
                app.platform.registry.snapshot.value.viewerRemoteInputEnabled && viewportApplied() &&
                view.verifyReceipt(receipt) && selected(receipt) &&
                app.runtime.state.value.inputPolicy.let { it.enabled && it.generation == receipt.policyGeneration }
        }
    }
    private fun viewportApplied(): Boolean {
        val measured = measuredViewport.get() ?: return false
        return app.runtime.state.value.content?.requestedViewport == measured
    }
    /**
     * The receipt's input context is the selected stream's CURRENT semantic context:
     * same selection, connection, subscription, monotonic input generation, resize
     * epoch, geometry, frame extents, modes, and exact source, drawn from a publish no
     * newer than the current one. Ordinary output (a newer publish of that context)
     * keeps it; a source, mode, geometry, resize, or A -> B -> A change never does.
     */
    private fun selected(receipt: FrameCommitReceipt): Boolean {
        val selected = app.runtime.state.value.selection ?: return false
        val observation = selected.observation
        val view = observation.view ?: return false
        val meta = view.meta
        return selected.selectionGeneration == receipt.selectionGeneration &&
            selected.target.hostId.value == receipt.hostId && selected.target.ownerRunId == receipt.ownerRun &&
            selected.target.rowId == receipt.rowId && observation.target.connectionGeneration == receipt.connectionGeneration &&
            observation.subscriptionId == receipt.subscriptionId &&
            observation.inputGeneration == receipt.inputGeneration && observation.resizeEpoch == receipt.resizeEpoch &&
            receipt.publishSequence <= meta.sequence &&
            meta.geometry == receipt.geometry && meta.inputModes == receipt.modes &&
            view.frame.cols == receipt.frameCols && view.frame.rows == receipt.frameRows &&
            receipt.source?.let { source -> TerminalViewBinding.sourceOf(meta.inputSource)?.let { nativeIoSourceEquals(source, it) } } == true
    }
    private fun matches(receipt: FrameCommitReceipt, frame: RenderFrame): Boolean =
        receipt.source != null && receipt.inContextOf(frame.binding) && receipt.resizeEpoch == frame.resizeEpoch

    fun deliverCopy(event: ClientRuntimeEvent.TerminalCopyOffered) {
        val view = owned.get()?.view
        val receipt = view?.currentInputProof()
        val epoch = inputEpoch.get()
        val proof = if (view != null && receipt != null) currentProof(view, receipt, epoch) else RosterUiProof { false }
        val claim = app.runtime.claimTerminalCopy(event.selectionGeneration, event.copy.copyId, proof)
        if (claim !is TerminalCopyClaim.Granted) return
        val copy = claim.copy.event
        if (copy is NativeIoCopyEvent.Unavailable) { app.report("Copy unavailable: ${copy.reason.name}"); return }
        copy as NativeIoCopyEvent.Copy
        val bytes = try { Base64.getDecoder().decode(copy.encoded) } catch (_: IllegalArgumentException) { return }
        val text = decodeUtf8(bytes) ?: return
        // One-shot immediate claim/delivery on Main, independently fresh actual view.
        // Copy is NOT input and is intentionally unrelated to last-input/dispatch order.
        val currentView = view ?: return
        if (!proof.isStillCurrent() || !currentView.isShown || !currentView.hasWindowFocus() || !currentView.hasFocus()) return
        val clipboard = activity.getSystemService(ClipboardManager::class.java) ?: run { app.report("Copy unavailable: clipboard service unavailable"); return }
        try {
            clipboard.setPrimaryClip(ClipData.newPlainText("Pi Review Gate", text))
            app.report("Text copied")
        } catch (_: SecurityException) { app.report("Copy unavailable: clipboard access refused") }
    }
    fun paste(target: io.github.rfairburn.pireviewgate.core.client.ui.TerminalTarget?) {
        if (!currentTarget(target)) return
        val view = owned.get()?.view ?: return
        val receipt = view.currentInputProof() ?: return
        if (!currentProof(view, receipt, inputEpoch.get()).isStillCurrent()) return
        // The ONLY clipboard read: an explicit Paste with current authority, on Main.
        val clipboard = activity.getSystemService(ClipboardManager::class.java) ?: run { app.report("Paste unavailable: clipboard service unavailable"); return }
        val clip = try { clipboard.primaryClip } catch (_: SecurityException) {
            app.report("Paste unavailable: clipboard access refused"); return
        } ?: run { app.report("Paste unavailable: clipboard has no text"); return }
        if (clip.itemCount < 1) { app.report("Paste unavailable: clipboard has no text"); return }
        val text = clip.getItemAt(0).text ?: run { app.report("Paste unavailable: clipboard has no text"); return }
        if (!view.verifyReceipt(receipt)) return
        view.submitPastedText(text.toString())
    }
    fun key(request: TerminalKeyRequest, target: io.github.rfairburn.pireviewgate.core.client.ui.TerminalTarget?) {
        if (!currentTarget(target)) return
        val view = owned.get()?.view ?: return
        val receipt = view.currentInputProof() ?: return
        if (!currentProof(view, receipt, inputEpoch.get()).isStillCurrent()) return
        val modifiers = request.modifiers.bits()
        val key = when (request.key) {
            TerminalControlKey.ESCAPE -> TerminalKey(codepoint = 27, modifiers = modifiers)
            TerminalControlKey.TAB -> TerminalKey(codepoint = 9, modifiers = modifiers)
            TerminalControlKey.BACKTAB -> TerminalKey(codepoint = 9, modifiers = modifiers or KeyboardModifiers.SHIFT)
            else -> TerminalKey(functionKey = when (request.key) {
                TerminalControlKey.ARROW_UP -> TerminalFunctionKey.UP
                TerminalControlKey.ARROW_DOWN -> TerminalFunctionKey.DOWN
                TerminalControlKey.ARROW_LEFT -> TerminalFunctionKey.LEFT
                TerminalControlKey.ARROW_RIGHT -> TerminalFunctionKey.RIGHT
                else -> TerminalFunctionKey.valueOf(request.key.name)
            }, modifiers = modifiers)
        }
        view.submitKey(key)
    }
    fun keyboard(visible: Boolean) {
        val view = owned.get()?.view ?: return
        if (visible) view.openKeyboard() else view.windowInsetsController?.hide(WindowInsets.Type.ime())
        // keyboardVisible is updated ONLY by observed WindowInsets, never the tap.
    }
    fun toggleModifier(modifier: TerminalModifier) {
        val view = owned.get()?.view ?: return
        val bits = when (modifier) {
            TerminalModifier.CTRL -> KeyboardModifiers.CTRL
            TerminalModifier.ALT -> KeyboardModifiers.ALT
            TerminalModifier.SHIFT -> KeyboardModifiers.SHIFT
            TerminalModifier.META -> KeyboardModifiers.META
        }
        if (!view.toggleMobileModifier(bits)) app.report("Modifier is not supported by this terminal surface")
    }
    private fun TerminalModifiers.bits(): Int = (if (ctrl) KeyboardModifiers.CTRL else 0) or
        (if (alt) KeyboardModifiers.ALT else 0) or (if (shift) KeyboardModifiers.SHIFT else 0) or (if (meta) KeyboardModifiers.META else 0)
    private fun decodeUtf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: java.nio.charset.CharacterCodingException) { null }
}
