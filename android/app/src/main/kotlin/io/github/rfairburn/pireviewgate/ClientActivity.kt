package io.github.rfairburn.pireviewgate

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import io.github.rfairburn.pireviewgate.client.application.ClientWindow
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermission
import io.github.rfairburn.pireviewgate.permissions.LocalNetworkPermissionRationaleDialog
import io.github.rfairburn.pireviewgate.ui.client.NonTerminalStatusSlot
import io.github.rfairburn.pireviewgate.ui.client.RootUIScreen

/** Exported native client launcher. There is no local owner, worker, gateway or service. */
class ClientActivity : ComponentActivity() {
    private var clientWindow: ClientWindow? = null
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        clientWindow?.permissionResult(granted)
    }
    fun launchLocalNetworkPermission() { permission.launch(LocalNetworkPermission.PERMISSION_NAME) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // The window background and the app's Material palette are fixed light on every route,
        // while enableEdgeToEdge() derives the status contrast from the system night flag: on a
        // phone in dark mode that draws white icons over our light strip. Status contrast only —
        // the helper keeps edge-to-edge geometry, the consumed insets and the navigation bar.
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = true
        val appOwner = application as PiReviewGateApplication
        setContent {
            val controller by appOwner.controller.collectAsState()
            val failed by appOwner.startupFailed.collectAsState()
            val app = controller
            if (app == null) {
                MaterialTheme {
                    Box(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp)) {
                        Text(stringResource(if (failed) R.string.client_startup_refused else R.string.client_startup_loading))
                    }
                }
            } else {
                val window = remember(app, this) { ClientWindow(this, app) }
                DisposableEffect(window) {
                    clientWindow = window
                    window.bind()
                    // The graph may finish starting after Activity.ON_START/ON_RESUME.
                    if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) window.started()
                    if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) window.resumed()
                    onDispose {
                        window.close()
                        if (clientWindow === window) clientWindow = null
                    }
                }
                val state by app.ui.collectAsState()
                val status by app.status.collectAsState()
                val overlayPlacement by appOwner.overlayPlacements.uiState.collectAsState()
                val rationale by window.permissionRationale.collectAsState()
                val capturedFrame = state
                val capturedRoute = capturedFrame.route
                val observedWindowEpoch by window.epochs.collectAsState()
                val capturedEpoch = observedWindowEpoch
                // The terminal route owns the whole app window: it applies its own stable
                // bar/cutout insets and overlays status, so no slot is reserved above it.
                val terminalRoute = capturedRoute is ClientRoute.Terminal
                // Saved presentation preference only: it decides whether the app's
                // diagnostic status and notice surfaces are drawn, and nothing else.
                val debugInputMessaging = capturedFrame.settings.debugInputMessagingEnabled
                Column(Modifier.fillMaxSize().then(if (terminalRoute) Modifier else Modifier.statusBarsPadding())) {
                    // A fixed-height, noninteractive status slot never moves a pending form
                    // when an admission/settlement arrives. No owner fact is inferred. With
                    // debugging off the slot composes nothing, reserved height included.
                    if (!terminalRoute) {
                        NonTerminalStatusSlot(
                            status = status,
                            debugInputMessagingEnabled = debugInputMessaging,
                        )
                    }
                    // Same call site on every route, so RootUIScreen's remembered list
                    // positions survive entering and leaving the terminal.
                    Box(Modifier.weight(1f)) {
                        RootUIScreen(
                            state = state,
                            onIntent = { intent -> window.dispatch(intent, capturedFrame, capturedEpoch) },
                            onTerminalKey = { request -> window.key(request, (capturedRoute as? ClientRoute.Terminal)?.terminal?.target) },
                            onTerminalPaste = { window.paste((capturedRoute as? ClientRoute.Terminal)?.terminal?.target) },
                            terminalContent = { window.Surface() },
                            status = status,
                            debugInputMessagingEnabled = debugInputMessaging,
                            overlayPlacement = overlayPlacement.placement,
                            overlayPlacementWarning = overlayPlacement.warning,
                            overlayPlacementReady = overlayPlacement.ready,
                            onOverlayPlacementCommitted = { placement ->
                                appOwner.overlayPlacements.commit(placement)
                            },
                        )
                    }
                }
                rationale?.let { token ->
                    LocalNetworkPermissionRationaleDialog(window.permissionObservation(), token.endpoint.displayText(),
                        onContinue = { window.continueRationale(token) }, onNotNow = { window.cancelConnect(token.hostId) })
                }
            }
        }
    }
    override fun onStart() { super.onStart(); clientWindow?.started() }
    override fun onResume() { super.onResume(); clientWindow?.resumed() }
    override fun onStop() { clientWindow?.stopped(); super.onStop() }
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        clientWindow?.focusChanged()
    }
    override fun onDestroy() {
        clientWindow?.close()
        clientWindow = null
        super.onDestroy()
    }
}
