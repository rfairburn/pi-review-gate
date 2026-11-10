package io.github.rfairburn.pireviewgate.client.platform

import android.app.Activity
import android.view.ViewTreeObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import io.github.rfairburn.pireviewgate.core.client.platform.ClientLifecycleCallbacks

/**
 * Explicit Activity/window registration. All methods are main-thread only.
 * Close on destruction (also automatic via ON_DESTROY), NOT on pause/stop.
 * No Activity, View or rationale probe is retained by the app-scoped facade.
 */
public class AndroidClientActivityBinding internal constructor(
    private val platform: AndroidClientPlatform,
    private val activity: Activity,
    private val lifecycleOwner: LifecycleOwner,
    callbacks: ClientLifecycleCallbacks,
) {
    private val decor = activity.window.decorView
    private val focusObserver = decor.viewTreeObserver
    private val policy = platform.foreground
    private val id = policy.bind(callbacks)
    private var disposed = false
    private val focusListener = ViewTreeObserver.OnWindowFocusChangeListener { focused ->
        if (isCurrent()) {
            if (focused) {
                refreshFacts()
                policy.onWindowFocusChanged(id, true)
            } else {
                // Atomic terminal veto before even consulting any framework facts.
                try {
                    policy.onWindowFocusChanged(id, false)
                } finally {
                    refreshFacts()
                }
            }
        }
    }
    private val observer = LifecycleEventObserver { _, event ->
        if (!disposed) {
            when (event) {
                Lifecycle.Event.ON_START -> if (isCurrent()) {
                    refreshFacts()
                    policy.onStart(id)
                }
                Lifecycle.Event.ON_RESUME -> if (isCurrent()) {
                    refreshFacts()
                    policy.onResume(id)
                    // The new window must restate focus; the old binding's focus is never copied.
                    policy.onWindowFocusChanged(id, decor.hasWindowFocus())
                }
                Lifecycle.Event.ON_PAUSE -> if (isCurrent()) {
                    try {
                        policy.onPause(id)
                    } finally {
                        refreshFacts()
                    }
                }
                Lifecycle.Event.ON_STOP -> if (isCurrent()) {
                    try {
                        policy.onStop(id, activity.isChangingConfigurations)
                    } finally {
                        // A real screen-off/lock wins over configuration handoff.
                        refreshFacts()
                    }
                }
                Lifecycle.Event.ON_DESTROY -> close()
                else -> Unit
            }
        }
    }

    init {
        requirePlatformThread()
        try {
            focusObserver.addOnWindowFocusChangeListener(focusListener)
            lifecycleOwner.lifecycle.addObserver(observer)
        } catch (error: Throwable) {
            close()
            throw error
        }
    }

    /**
     * Invoke after the existing explicit permission launcher's result, including stale
     * results. Only refreshes actual facts: never trusts the Boolean, launches a prompt,
     * connects, restores an old intent, or bypasses the launcher's token/epoch fencing.
     */
    public fun refreshAfterPermissionResult() {
        requirePlatformThread()
        if (isCurrent()) refreshFacts()
    }

    private fun refreshFacts() {
        platform.refreshActivityFacts(activity)
    }

    private fun isCurrent(): Boolean = !disposed && policy.isCurrent(id)

    /** Explicitly releases both registrations even if required UI retirement throws. */
    public fun close() {
        requirePlatformThread()
        if (disposed) return
        disposed = true
        lifecycleOwner.lifecycle.removeObserver(observer)
        if (focusObserver.isAlive) focusObserver.removeOnWindowFocusChangeListener(focusListener)
        else if (decor.viewTreeObserver.isAlive) {
            decor.viewTreeObserver.removeOnWindowFocusChangeListener(focusListener)
        }
        policy.unbind(id, activity.isChangingConfigurations)
    }
}
