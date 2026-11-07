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
import io.github.rfairburn.pireviewgate.client.application.ClientWindow
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermission
import io.github.rfairburn.pireviewgate.permissions.LocalNetworkPermissionRationaleDialog
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
                val rationale by window.permissionRationale.collectAsState()
                val capturedFrame = state
                val capturedRoute = capturedFrame.route
                val observedWindowEpoch by window.epochs.collectAsState()
                val capturedEpoch = observedWindowEpoch
                Column(Modifier.fillMaxSize().statusBarsPadding()) {
                    // A fixed-height, noninteractive status slot never moves a pending form or
                    // terminal pane when an admission/settlement arrives. No owner fact is inferred.
                    Box(Modifier.fillMaxWidth().height(40.dp).padding(horizontal = 8.dp)) {
                        Text(status ?: "", maxLines = 2, style = MaterialTheme.typography.bodySmall)
                    }
                    Box(Modifier.weight(1f)) {
                        RootUIScreen(
                            state = state,
                            onIntent = { intent -> window.dispatch(intent, capturedFrame, capturedEpoch) },
                            onTerminalKey = { request -> window.key(request, (capturedRoute as? ClientRoute.Terminal)?.terminal?.target) },
                            onTerminalPaste = { window.paste((capturedRoute as? ClientRoute.Terminal)?.terminal?.target) },
                            terminalContent = { window.Surface() },
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
