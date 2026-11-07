package io.github.rfairburn.pireviewgate.client.platform

import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Looper
import android.os.PowerManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import io.github.rfairburn.pireviewgate.core.client.connection.CommittedPromptValidator
import io.github.rfairburn.pireviewgate.core.client.connection.HostConnectionRegistry
import io.github.rfairburn.pireviewgate.core.client.connection.NetworkAccessAdmission
import io.github.rfairburn.pireviewgate.core.client.platform.CachedLocalNetworkAdmission
import io.github.rfairburn.pireviewgate.core.client.platform.ClientDeviceVisibility
import io.github.rfairburn.pireviewgate.core.client.platform.ClientForegroundBinding
import io.github.rfairburn.pireviewgate.core.client.platform.ClientLifecycleCallbacks
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettingsStore
import io.github.rfairburn.pireviewgate.core.identity.HostPinStore
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStore
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermission
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionStatus
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationOrderStore
import io.github.rfairburn.pireviewgate.permissions.AndroidLocalNetworkPermissionProbe
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage

/**
 * App-scoped production client platform. Create once in application composition,
 * not once per screen/Activity; Activity destruction must close only its binding.
 * No channel readers, owner operations, automatic identity creation, or prompts.
 * Registry commands that touch storage must still be called off the main thread.
 */
public class AndroidClientPlatform private constructor(
    private val appContext: Context,
    public val settingsStore: NetworkSettingsStore,
    public val pinStore: HostPinStore,
    public val identityStore: PeerIdentityStore,
    public val presentationOrderStore: RemotePresentationOrderStore,
    private val admission: CachedLocalNetworkAdmission,
    /**
     * Exposed to the sole protocol coordinator. Consumers MUST fence channel events
     * by host/channel generation: a stale old-generation loss must never retire a
     * newer channel. This facade neither reads channels nor rewrites registry events.
     */
    public val registry: HostConnectionRegistry,
) {
    internal val foreground = ClientForegroundBinding { registry.setForeground(it) }
    private var disposed = false
    private var receiverRegistered = false
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (disposed) return
            when (intent?.action) {
                Intent.ACTION_SCREEN_OFF -> foreground.deviceVisibility(
                    ClientDeviceVisibility(interactive = false, unlocked = false),
                )
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> refreshPlatformFacts()
            }
        }
    }

    /** Any-thread cheap veto only; a fresh committed frame is independently required. */
    public val terminalInputEligible: Boolean get() = foreground.terminalInputEligible

    /** Read-only cache-backed capability supplied to the registry. */
    public val networkAccess: NetworkAccessAdmission get() = admission

    public val localNetworkPermissionStatus: LocalNetworkPermissionStatus
        get() = admission.permissionStatus

    /** Non-exhaustive explicit hints only; false never proves an Internet route. */
    public fun requiresLocalNetworkGrant(endpoint: Endpoint): Boolean =
        admission.requiresLocalNetworkGrant(endpoint)

    /** Re-read actual app-context grant, without rationale, prompts, DNS or Activity retention. */
    public fun refreshLocalNetworkPermission(): LocalNetworkPermissionStatus {
        requirePlatformThread()
        check(!disposed) { "client platform is disposed" }
        return readApplicationGrant()
    }

    /**
     * Register the real Activity lifecycle and root-window focus. The supplied hooks
     * must synchronously retire runtime/UI authority; they are not optional cleanup.
     * Dialog consent must use its OWN committed-window proof, not terminal eligibility.
     */
    public fun bindActivity(
        activity: Activity,
        lifecycleOwner: LifecycleOwner,
        callbacks: ClientLifecycleCallbacks,
    ): AndroidClientActivityBinding {
        requirePlatformThread()
        check(!disposed) { "client platform is disposed" }
        check(lifecycleOwner.lifecycle.currentState != Lifecycle.State.DESTROYED) { "Activity is destroyed" }
        return AndroidClientActivityBinding(this, activity, lifecycleOwner, callbacks)
    }

    internal fun refreshPlatformFacts() {
        requirePlatformThread()
        readApplicationGrant()
        refreshDeviceVisibility()
    }

    internal fun refreshActivityFacts(activity: Activity) {
        requirePlatformThread()
        // Temporary rationale source: only status is cached, never this Activity.
        admission.refresh { AndroidLocalNetworkPermissionProbe(activity).observe().status }
        refreshDeviceVisibility()
    }

    internal fun refreshDeviceVisibility() {
        requirePlatformThread()
        val observed = runCatching {
            val power = appContext.getSystemService(PowerManager::class.java)
            val keyguard = appContext.getSystemService(KeyguardManager::class.java)
            ClientDeviceVisibility(
                interactive = power != null && power.isInteractive,
                unlocked = keyguard != null && !keyguard.isKeyguardLocked && !keyguard.isDeviceLocked,
            )
        }.getOrElse { ClientDeviceVisibility(interactive = false, unlocked = false) }
        foreground.deviceVisibility(observed)
    }

    private fun readApplicationGrant(): LocalNetworkPermissionStatus = admission.refresh {
        val granted = Build.VERSION.SDK_INT >= LocalNetworkPermission.REQUIRED_SDK_INT &&
            ContextCompat.checkSelfPermission(appContext, LocalNetworkPermission.PERMISSION_NAME) ==
            PackageManager.PERMISSION_GRANTED
        LocalNetworkPermission.statusFor(Build.VERSION.SDK_INT, granted)
    }

    /** App-owner disposal only, never ordinary Activity stop/recreation. Main thread. */
    public fun close() {
        requirePlatformThread()
        if (disposed) return
        disposed = true
        try {
            foreground.close()
        } finally {
            try {
                registry.close()
            } finally {
                if (receiverRegistered) {
                    receiverRegistered = false
                    appContext.unregisterReceiver(screenReceiver)
                }
            }
        }
    }

    public companion object {
        /**
         * Call on an IO thread: constructs/reads/starts real private stores and registry, initially
         * backgrounded. The validator is required and must consult actual GUI proofs;
         * tuples, snapshots and consent data alone are never committed-prompt evidence.
         * Startup does not generate identity or show permission/key prompts.
         */
        public fun create(
            context: Context,
            promptValidator: CommittedPromptValidator,
        ): AndroidClientPlatform {
            check(Looper.myLooper() != Looper.getMainLooper()) { "client creation requires an IO thread" }
            val app = context.applicationContext
            val settings = AndroidClientStorage.settingsStore(app)
            val pins = AndroidClientStorage.pinStore(app)
            val identity = AndroidClientStorage.identityStore(app)
            val presentation = AndroidClientStorage.presentationOrderStore(app)
            val admission = CachedLocalNetworkAdmission(Build.VERSION.SDK_INT)
            val registry = HostConnectionRegistry(
                settingsStore = settings,
                pinStore = pins,
                identityStore = identity,
                promptValidator = promptValidator,
                networkAccess = admission,
            )
            val platform = AndroidClientPlatform(app, settings, pins, identity, presentation, admission, registry)
            try {
                // Core defaults to foreground: fence it before startup can schedule work.
                registry.setForeground(false)
                platform.readApplicationGrant()
                registry.start()
                app.registerReceiver(
                    platform.screenReceiver,
                    IntentFilter().apply {
                        addAction(Intent.ACTION_SCREEN_OFF)
                        addAction(Intent.ACTION_SCREEN_ON)
                        addAction(Intent.ACTION_USER_PRESENT)
                    },
                    Context.RECEIVER_NOT_EXPORTED,
                )
                platform.receiverRegistered = true
                return platform
            } catch (error: Throwable) {
                registry.close()
                throw error
            }
        }
    }
}

internal fun requirePlatformThread() {
    check(Looper.myLooper() == Looper.getMainLooper()) { "client lifecycle requires the main thread" }
}
