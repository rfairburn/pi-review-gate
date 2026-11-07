package io.github.rfairburn.pireviewgate.permissions

import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermission
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionGate
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionObservation
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkRequestRejectionReason
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkRequestResolution
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkRequestStart
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkRequestToken

/**
 * Compose adapter for the local-network permission prompt.
 *
 * The caller supplies the current explicit connect intent token. Pass `null` when
 * no explicit LAN connection intent exists; [request] then rejects without showing
 * a system prompt. This adapter never requests permission on composition, resume,
 * or any other lifecycle event: only an explicit foreground user action may call
 * [request].
 *
 * The native prompt is launched through
 * `ActivityResultContracts.RequestPermission`. Every result is resolved by the
 * shared [LocalNetworkPermissionGate] against the request id captured at launch,
 * the active foreground UI epoch, and `currentIntent`. A result after background,
 * navigation, source change, or host removal is delivered as
 * [LocalNetworkRequestResolution.Stale] and must not start a connection, retry, or
 * replay an action.
 */
@Stable
public class LocalNetworkPermissionLauncher internal constructor(
    private val gate: LocalNetworkPermissionGate,
    private val launchSystemPrompt: (String) -> Unit,
    private val openSettings: () -> Unit,
) {
    /** Latest platform read; refreshed on lifecycle foreground events. */
    public var observation: LocalNetworkPermissionObservation by mutableStateOf(gate.refresh())
        private set

    /** True while one native system prompt is still waiting for its result. */
    public var isSystemPromptInFlight: Boolean by mutableStateOf(false)
        private set

    private var currentIntent: LocalNetworkRequestToken? = null
    private var launchedRequestId: Long? = null
    internal var onResolution: ((LocalNetworkRequestResolution) -> Unit)? = null

    /**
     * Start the permission prompt for the current explicit intent, if it is needed
     * and no prompt is already in flight.
     *
     * This method must only be called from an explicit user action while the caller
     * is in the foreground. It launches the native system prompt after the gate
     * accepts and tracks the request.
     */
    public fun request(): LocalNetworkRequestStart {
        if (launchedRequestId != null) {
            return LocalNetworkRequestStart.Rejected(
                LocalNetworkRequestRejectionReason.REQUEST_ALREADY_PENDING,
            )
        }
        val start = gate.prepareRequest(currentIntent)
        if (start is LocalNetworkRequestStart.Accepted) {
            launchedRequestId = start.request.requestId
            isSystemPromptInFlight = true
            launchSystemPrompt(LocalNetworkPermission.PERMISSION_NAME)
        }
        observation = gate.refresh()
        return start
    }

    /** Re-read the platform grant without requesting permission or prompting. */
    public fun refresh() {
        observation = gate.refresh()
    }

    /**
     * Retire a pending prompt on navigation or a source change. A later result is
     * stale and starts nothing.
     */
    public fun retirePendingRequest() {
        gate.retirePending()
        observation = gate.refresh()
    }

    /**
     * Open this app's system settings page. This is only a user-action handler; the
     * permission flow never opens Settings automatically.
     */
    public fun openAppSettings() {
        openSettings()
    }

    internal fun updateCurrentIntent(next: LocalNetworkRequestToken?) {
        if (next == currentIntent) return
        currentIntent = next
        gate.retirePending()
        observation = gate.refresh()
    }

    internal fun onLifecycleStart() {
        observation = if (gate.isInForegroundUi) {
            gate.refresh()
        } else {
            gate.enterForeground()
        }
    }

    internal fun onLifecycleResume() {
        observation = gate.refresh()
    }

    internal fun onLifecycleStop() {
        gate.leaveForeground()
        observation = gate.refresh()
    }

    internal fun onSystemPermissionResult(granted: Boolean) {
        val requestId = launchedRequestId
        launchedRequestId = null
        isSystemPromptInFlight = false
        if (requestId == null) {
            observation = gate.refresh()
            return
        }

        val resolution = gate.resolve(requestId, granted, currentIntent)
        observation = gate.refresh()
        onResolution?.invoke(resolution)
    }

    internal fun dispose() {
        gate.leaveForeground()
    }
}

/**
 * Remember the Compose local-network permission adapter for the current Activity.
 *
 * @param currentIntent the explicit connect intent the UI is currently presenting,
 * or `null` when there is none. A token change retires any pending prompt, so a
 * result for the previous target can never be used as the new target's grant.
 * @param onResolution called once per native prompt result. It may be
 * [LocalNetworkRequestResolution.Stale]; callers must ignore stale results and must
 * still verify that a grant token matches the current catalog target before
 * connecting.
 */
@Composable
public fun rememberLocalNetworkPermissionLauncher(
    currentIntent: LocalNetworkRequestToken?,
    onResolution: (LocalNetworkRequestResolution) -> Unit = {},
): LocalNetworkPermissionLauncher {
    val activity = LocalActivity.current
        ?: error("local-network permission UI requires an Activity host")
    val lifecycleOwner = LocalLifecycleOwner.current

    val gate = remember(activity) {
        LocalNetworkPermissionGate(AndroidLocalNetworkPermissionProbe(activity))
    }
    val latestOnResolution = rememberUpdatedState(onResolution)
    val launcherHolder = remember { mutableStateOf<LocalNetworkPermissionLauncher?>(null) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        launcherHolder.value?.onSystemPermissionResult(granted)
    }

    val launcher = remember(gate, activity) {
        LocalNetworkPermissionLauncher(
            gate = gate,
            launchSystemPrompt = { permission -> permissionLauncher.launch(permission) },
            openSettings = { openAppPermissionSettings(activity) },
        ).also { created ->
            created.onResolution = { resolution -> latestOnResolution.value(resolution) }
        }
    }

    SideEffect { launcherHolder.value = launcher }
    SideEffect { launcher.updateCurrentIntent(currentIntent) }

    DisposableEffect(lifecycleOwner, launcher) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> launcher.onLifecycleStart()
                Lifecycle.Event.ON_RESUME -> launcher.onLifecycleResume()
                Lifecycle.Event.ON_STOP -> launcher.onLifecycleStop()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            launcher.dispose()
        }
    }

    return launcher
}
