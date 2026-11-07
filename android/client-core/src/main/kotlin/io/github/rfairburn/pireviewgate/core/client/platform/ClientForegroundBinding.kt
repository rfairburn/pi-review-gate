package io.github.rfairburn.pireviewgate.core.client.platform

import java.util.concurrent.atomic.AtomicBoolean

/** Required synchronous hooks. Implementations must not block or defer authority retirement. */
public interface ClientLifecycleCallbacks {
    /** Retire terminal receipts, input sources and pending input, not a dialog's own proof. */
    public fun invalidateTerminalInput()

    /** Retire all old-window committed proofs; none may be revived on return/recreation. */
    public fun invalidateWindowProofs()

    /** Cancel explicit Connect, permission and UI-consent context, with no replay on return. */
    public fun cancelPendingUserIntent()
}

/** System facts, read afresh by Android before any foreground restoration. */
public data class ClientDeviceVisibility(public val interactive: Boolean, public val unlocked: Boolean) {
    public val permitsForeground: Boolean get() = interactive && unlocked
}

/**
 * Single platform-thread lifecycle policy, with an any-thread atomic input veto.
 *
 * Owns no host policy: every network transition is delegated to the real registry.
 * In particular, restoration is not conditional on Auto, and suppression/pins are
 * solely the registry's responsibility. Eligibility is only a veto; true never
 * grants an input receipt or proves a frame has committed.
 */
public class ClientForegroundBinding(private val setRegistryForeground: (Boolean) -> Unit) {
    private val inputEligible = AtomicBoolean(false)
    private var nextId = 0L
    private var current: Long? = null
    private var callbacks: ClientLifecycleCallbacks? = null
    private var started = false
    private var resumed = false
    private var focused = false
    private var handoff = false
    private var networkForeground = false
    private var facts = ClientDeviceVisibility(interactive = false, unlocked = false)
    private var closed = false

    public val terminalInputEligible: Boolean get() = inputEligible.get()

    /** Replaces the old window, retiring its proofs without retaining its callbacks. */
    public fun bind(next: ClientLifecycleCallbacks): Long {
        check(!closed) { "platform binding is closed" }
        val previous = callbacks
        val preserveNetwork = networkForeground && facts.permitsForeground
        inputEligible.set(false)
        current = null
        callbacks = null
        started = false
        resumed = false
        focused = false
        handoff = preserveNetwork
        // State is fenced before calling external code; stale bindings are already inert.
        try {
            retire(previous)
        } catch (error: Throwable) {
            handoff = false
            updateNetwork(false)
            throw error
        }
        current = ++nextId
        callbacks = next
        return nextId
    }

    public fun isCurrent(id: Long): Boolean = !closed && current == id

    /** Real background/lock also overrides an in-progress configuration handoff. */
    public fun deviceVisibility(next: ClientDeviceVisibility) {
        if (closed) return
        facts = next
        if (!next.permitsForeground) {
            handoff = false
            resumed = false
            focused = false
            inputEligible.set(false)
            try {
                updateNetwork(false)
            } finally {
                retire(callbacks)
            }
        } else {
            reconcile()
        }
    }

    public fun onStart(id: Long) {
        if (!isCurrent(id)) return
        started = true
        handoff = false
        reconcile()
    }

    public fun onResume(id: Long) {
        if (!isCurrent(id)) return
        resumed = started && facts.permitsForeground
        reconcile()
    }

    /** Permission dialogs may pause a still-visible app: network is deliberately unchanged. */
    public fun onPause(id: Long) {
        if (!isCurrent(id)) return
        resumed = false
        focused = false
        inputEligible.set(false)
        callbacks?.invalidateTerminalInput()
    }

    /** A dialog's own window proof need not depend on the Activity root's focus. */
    public fun onWindowFocusChanged(id: Long, hasFocus: Boolean) {
        if (!isCurrent(id)) return
        focused = hasFocus && started && facts.permitsForeground
        if (!hasFocus) {
            inputEligible.set(false)
            callbacks?.invalidateTerminalInput()
        } else {
            reconcile()
        }
    }

    public fun onStop(id: Long, changingConfigurations: Boolean) {
        if (!isCurrent(id)) return
        inputEligible.set(false)
        handoff = changingConfigurations && networkForeground && facts.permitsForeground
        started = false
        resumed = false
        focused = false
        try {
            if (!handoff) updateNetwork(false)
        } finally {
            retireOrEndHandoff(callbacks)
        }
    }

    /** Explicit unregistration. Config handoff retains connections, never the window or proofs. */
    public fun unbind(id: Long, changingConfigurations: Boolean) {
        if (!isCurrent(id)) return
        val previous = callbacks
        inputEligible.set(false)
        handoff = changingConfigurations && networkForeground && facts.permitsForeground
        current = null
        callbacks = null
        started = false
        resumed = false
        focused = false
        try {
            if (!handoff) updateNetwork(false)
        } finally {
            retireOrEndHandoff(previous)
        }
    }

    public fun close() {
        if (closed) return
        closed = true
        inputEligible.set(false)
        val previous = callbacks
        current = null
        callbacks = null
        started = false
        resumed = false
        focused = false
        handoff = false
        try {
            updateNetwork(false)
        } finally {
            retire(previous)
        }
    }

    private fun reconcile() {
        val foreground = facts.permitsForeground && (started || handoff)
        if (!foreground) inputEligible.set(false)
        updateNetwork(foreground)
        inputEligible.set(foreground && started && resumed && focused)
    }

    private fun updateNetwork(next: Boolean) {
        if (networkForeground == next) return
        networkForeground = next
        setRegistryForeground(next)
    }

    private fun retireOrEndHandoff(target: ClientLifecycleCallbacks?) {
        try {
            retire(target)
        } catch (error: Throwable) {
            // A failed window-proof retirement cannot retain the registry's consent epoch.
            handoff = false
            try {
                updateNetwork(false)
            } catch (teardownError: Throwable) {
                if (teardownError !== error) error.addSuppressed(teardownError)
            }
            throw error
        }
    }

    private fun retire(target: ClientLifecycleCallbacks?) {
        if (target == null) return
        // All hooks run even if another fails; callers fence authority before invoking them.
        var failure: Throwable? = null
        for (action in listOf<() -> Unit>(
            target::invalidateTerminalInput,
            target::invalidateWindowProofs,
            target::cancelPendingUserIntent,
        )) {
            try {
                action()
            } catch (error: Throwable) {
                val first = failure
                if (first == null) failure = error else if (first !== error) first.addSuppressed(error)
            }
        }
        failure?.let { throw it }
    }
}
