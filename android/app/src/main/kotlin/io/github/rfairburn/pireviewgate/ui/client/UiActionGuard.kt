package io.github.rfairburn.pireviewgate.ui.client

import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.github.rfairburn.pireviewgate.core.client.ui.CommitDeliveryLedger
import io.github.rfairburn.pireviewgate.core.client.ui.ControlPlacementLedger
import io.github.rfairburn.pireviewgate.core.client.ui.MutableUiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.PresentationGate
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.UiProofInvalidationReason
import io.github.rfairburn.pireviewgate.core.client.ui.UiControlBounds
import io.github.rfairburn.pireviewgate.core.client.ui.UiRect
import io.github.rfairburn.pireviewgate.ui.render.FrameCommitWatcher

/**
 * Commit source shared by the actionable controls of one window.
 *
 * A dialog gets its own window and therefore its own [UiProofGate]. A list row does
 * not: a screen is one Compose view, so the honest fact available for a control is "a
 * frame containing this control was submitted". [UiCommitScope] supplies exactly that,
 * once per window — and it must be established *inside* the window whose controls use
 * it. A bottom sheet or dialog is its own window, so it needs its own scope; inheriting
 * the activity's would certify a sheet control against activity frames.
 *
 * Two floors decide what a commit may certify, and both come from measurement rather
 * than from composition:
 *
 * - **Placement.** A control is eligible only once its layout pass reported bounds that
 *   survived clipping, and a change in those bounds retires that control alone. Size
 *   alone would not do: a same-sized row can scroll, translate, or be clipped out of the
 *   frame it was proven in, and a control that merely composed but was never placed must
 *   not be certified by a frame that did not draw it.
 * - **Registration.** [CommitDeliveryLedger] captures the exact `(proof, epoch)` pairs
 *   before the platform is asked and honours a delivery only when it names that
 *   registration, so a callback that arrives late certifies nothing and cannot silence
 *   the registration that replaced it.
 *
 * Neither floor is fan-in on invalidation: each control retires only on its own
 * placement, focus, coverage, or semantic change, so a status update on an unrelated
 * host cannot retire the standing of an action whose own target did not move — which is
 * what keeps 64 concurrently reporting hosts from starving each other's controls. The
 * one exception is a fact that is genuinely about the whole window: losing focus, or the
 * lifecycle leaving the resumed state, withdraws every standing it serves.
 */
@Composable
fun UiCommitScope(content: @Composable () -> Unit) {
    val hub = rememberUiCommitHub()
    androidx.compose.runtime.CompositionLocalProvider(LocalUiCommitHub provides hub) {
        content()
    }
}

/**
 * Establish the commit source for the window this composable is drawn in.
 *
 * Needed once per window, above anything that uses [rememberUiActionGuard] in it. The
 * source follows the window's lifecycle owner as well as its focus, so pausing the host
 * withdraws every standing it serves even when the window never lost focus.
 */
@Composable
fun rememberUiCommitHub(): UiCommitHub {
    val view = LocalView.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val hub = remember(view, lifecycle) { UiCommitHub(view, lifecycle) }
    DisposableEffect(hub) {
        hub.start()
        onDispose { hub.close() }
    }
    return hub
}

private val LocalUiCommitHub = compositionLocalOf<UiCommitHub?> { null }

/**
 * The commit standing of one control, plus the only way to spend it.
 *
 * [attempt] re-checks at the moment of the tap: current, actually committed, not
 * covered. It emits nothing when any of those fails and asks for a fresh frame instead,
 * so a control that is momentarily unproven is inert rather than silently queued.
 */
class UiActionGuard internal constructor(
    private val gate: PresentationGate?,
    private val hub: UiCommitHub?,
    private val machine: MutableUiActionProof?,
) {
    /**
     * True when this control could act at all: a proof was supplied, the window can
     * report commits, and the proof has not been retired.
     */
    val isAvailable: Boolean
        get() = hub?.isCommitReportingAvailable == true && gate?.proof?.isCurrent == true

    /**
     * Observe this control's own placement.
     *
     * Applied per control, so a control that moved, scrolled, or was clipped out retires
     * its own standing and nobody else's. Attach it to the actionable control itself,
     * not to its container: the bounds that matter are the bounds of what the operator
     * tapped.
     */
    val modifier: Modifier = if (machine == null) {
        Modifier
    } else {
        Modifier.onGloballyPositioned { coordinates -> hub?.positioned(machine, coordinates.controlBounds()) }
    }

    /** Run [onGranted] only while this control's proof actually grants. */
    fun attempt(onGranted: () -> Unit) {
        val current = gate ?: return
        // Spending is fenced by the window too: a paused or unfocused window holds a
        // standing that no longer describes anything the operator can see.
        if (hub?.isWindowReady == true && current.attempt()) {
            onGranted()
        } else {
            hub?.rearm(machine)
        }
    }

    /**
     * Retire this control's standing before an edit is dispatched.
     *
     * The value the operator is about to change is what the committed frame described,
     * so the retirement happens here, in the edit callback, and not during a later
     * recomposition: a guard consulted from another thread immediately after the edit
     * must already see the retired standing, and only the controller's next proof
     * generation can restore it.
     */
    fun retireForEdit() {
        machine?.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
        hub?.disarm(machine)
    }
}

/**
 * Stand in front of one control's proof.
 *
 * [semanticKey] is the frozen semantic presentation this control was drawn for — its
 * target, and for a form its actual values — and not volatile surrounding state. When it
 * changes, the previous standing is invalidated synchronously, during composition, before
 * anything downstream can read it.
 *
 * [covered] means another window is on top of this control's screen, handled the same
 * synchronous way; once covered, the standing is retired rather than paused.
 *
 * A `null` proof yields a guard that can never grant, so a screen whose controller
 * withheld a proof degrades to a disabled control instead of a fabricated one.
 */
@Composable
fun rememberUiActionGuard(
    proof: UiActionProof?,
    semanticKey: Any? = proof?.target,
    covered: Boolean = false,
): UiActionGuard {
    val hub = LocalUiCommitHub.current
    val machine = proof as? MutableUiActionProof

    // Synchronous, in composition: a semantic change or coverage over this screen
    // retires the previous standing before anything downstream can read it, rather than
    // after a side effect or a later recomposition. The tracker is not state because
    // what changes is the controller's proof, not this composition.
    val tracker = remember(proof) { SemanticTracker() }
    if (tracker.seen && tracker.key != semanticKey) {
        machine?.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
    }
    tracker.key = semanticKey
    tracker.seen = true
    if (covered) machine?.invalidate(UiProofInvalidationReason.COVERAGE_CHANGE)

    val gate = remember(hub, proof, semanticKey) { proof?.let { PresentationGate(it, requiredCriticalLines = 0) } }

    DisposableEffect(hub, gate) {
        // Only a standing the controller still holds is registered, and nothing here can
        // revive an invalidated one: standing returns when the controller mints the next
        // generation, which arrives as a new proof. A control that has not been placed
        // yet is registered too, but stays ineligible until its layout pass reports
        // visible bounds, so no frame that never drew it can certify it.
        if (machine?.isCurrent == true) hub?.arm(machine)
        onDispose { hub?.disarm(machine) }
    }

    return UiActionGuard(gate = gate, hub = hub, machine = machine)
}

/** Remembers what one proof object was last drawn for, so a change is seen in composition. */
private class SemanticTracker {
    var seen: Boolean = false
    var key: Any? = null
}

/**
 * One window's commit source.
 *
 * Main-thread only, like every Compose read it serves. It decides nothing about what a
 * proof means; it records what was measured, captures what a commit may certify, and
 * asks for a new frame when a control genuinely changed.
 */
class UiCommitHub internal constructor(
    private val view: View,
    private val lifecycle: Lifecycle,
) {
    private val armed = ArrayList<MutableUiActionProof>()
    private val placements = ControlPlacementLedger()
    private val ledger = CommitDeliveryLedger()
    private var focusListener: ViewTreeObserver.OnWindowFocusChangeListener? = null
    private var lifecycleObserver: LifecycleEventObserver? = null

    /**
     * Whether this window can currently draw, prove, or act.
     *
     * Attachment, focus, and a resumed lifecycle are three separate facts and all three
     * matter: a paused window can keep window focus, and a frame produced while the
     * window is paused, hidden, or detached says nothing about what the operator is
     * being asked to approve. Read on the main thread only.
     */
    internal val isWindowReady: Boolean
        get() = view.isAttachedToWindow &&
            view.hasWindowFocus() &&
            lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

    /** The registration identifier is echoed back by the platform callback and checked. */
    private val watcher = FrameCommitWatcher(view) { id -> publish(id) }

    /** True when this window can report commits at all. */
    val isCommitReportingAvailable: Boolean get() = watcher.isCommitReportingAvailable

    internal fun start() {
        val observer = view.viewTreeObserver
        if (!observer.isAlive) return
        val listener = ViewTreeObserver.OnWindowFocusChangeListener { hasFocus ->
            if (!hasFocus) {
                onFocusLost()
            } else {
                // Focus returning draws nothing by itself. Each attached control
                // restates readability from what its last layout pass measured, and a
                // frame is requested so a real commit can certify it.
                armed.forEach { placements.publishReadability(it) }
                awaitCurrent()
            }
        }
        observer.addOnWindowFocusChangeListener(listener)
        focusListener = listener

        // Pause and focus loss are distinct: an activity can be paused while its window
        // keeps focus. Standing is withdrawn on either, and resume asks for a fresh
        // frame rather than restoring anything.
        val lifecycleListener = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP, Lifecycle.Event.ON_DESTROY ->
                    withdraw(UiProofInvalidationReason.LIFECYCLE_CHANGE)
                Lifecycle.Event.ON_RESUME -> {
                    armed.forEach { placements.publishReadability(it) }
                    awaitCurrent()
                }
                else -> Unit
            }
        }
        lifecycleObserver = lifecycleListener
        lifecycle.addObserver(lifecycleListener)
    }

    internal fun close() {
        lifecycleObserver?.let { lifecycle.removeObserver(it) }
        lifecycleObserver = null
        val observer = view.viewTreeObserver
        focusListener?.let { if (observer.isAlive) observer.removeOnWindowFocusChangeListener(it) }
        focusListener = null
        armed.forEach { it.invalidate(UiProofInvalidationReason.DISMISSED) }
        armed.clear()
        placements.clear()
        watcher.cancel()
        ledger.cancel()
    }

    /**
     * Attach one control and begin the draw pass its commit will be captured against.
     *
     * Readability states whether this control's own last layout pass reported visible,
     * unclipped bounds — every control this source serves is identity-free by
     * construction ([rememberUiActionGuard] builds a [PresentationGate] requiring no
     * critical line), so placement is the only thing it can be required to show. A
     * control that must have identity fully visible belongs to a dialog and uses
     * [UiProofGate], where the layout pass reports each line.
     */
    internal fun arm(machine: MutableUiActionProof?) {
        onMain {
            val target = machine ?: return@onMain
            target.beginDraw()
            placements.publishReadability(target)
            if (!armed.contains(target)) armed.add(target)
            awaitCurrent()
        }
    }

    /**
     * Detach one control, retiring its standing.
     *
     * Removing it from the attached set is not enough: an intent already emitted with
     * that proof must stop being spendable the moment the control it was drawn on goes
     * away, and only retiring it achieves that against a callback already in flight.
     */
    internal fun disarm(machine: MutableUiActionProof?) {
        machine?.invalidate(UiProofInvalidationReason.DISMISSED)
        onMain {
            armed.remove(machine)
            placements.forget(machine)
            awaitCurrent()
        }
    }

    /**
     * Record what one control's layout pass measured.
     *
     * An unchanged report changes nothing, so a static list stays proven. Any movement,
     * scroll, or clip retires that control alone — immediately, in the layout callback —
     * and asks for a frame of where it now is.
     */
    internal fun positioned(machine: MutableUiActionProof?, placement: UiControlBounds) {
        val target = machine ?: return
        if (!placements.report(target, placement)) return
        rearm(target)
    }

    /** Re-arm one attached, still-current proof for the next real commit. */
    internal fun rearm(machine: MutableUiActionProof?) {
        onMain {
            val target = machine ?: return@onMain
            if (!target.isCurrent || !armed.contains(target)) return@onMain
            target.beginDraw()
            placements.publishReadability(target)
            awaitCurrent()
        }
    }

    /**
     * Withdraw whatever was registered, capture the pairs the next commit may certify,
     * and register that. Only controls whose measured bounds are actually visible are
     * candidates, and a commit is awaited only while at least one of them is.
     */
    private fun awaitCurrent() {
        watcher.cancel()
        val token = ledger.install(
            candidates = placements.eligibleFrom(armed),
            windowHasFocus = isWindowReady,
        )
        if (token != null) {
            watcher.awaitCommit(token)
            // Nothing else is scheduled to draw, and no frame means no proof: ask the
            // window to produce the frame the registration is waiting for.
            view.invalidate()
        }
    }

    private fun publish(id: Long) {
        onMain {
            if (!ledger.isAwaitingDelivery || !isWindowReady) return@onMain
            // Pending status is re-derived, never assumed: a callback reposted to this
            // thread can arrive after a newer registration replaced the one it belongs
            // to, and must not silence that newer registration.
            ledger.deliver(id) { proof -> armed.contains(proof) }
        }
    }

    private fun onFocusLost() {
        withdraw(UiProofInvalidationReason.FOCUS_CHANGE)
    }

    /** Retire every attached control's standing and withdraw the pending registration. */
    private fun withdraw(reason: UiProofInvalidationReason) {
        armed.forEach { it.invalidate(reason) }
        watcher.cancel()
        ledger.cancel()
    }

    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else view.post { block() }
    }
}

/** Map a Compose node's own extent and its clipped platform bounds into the portable form. */
private fun LayoutCoordinates.controlBounds(): UiControlBounds {
    val width = size.width.toFloat()
    val height = size.height.toFloat()
    val corners = listOf(
        localToWindow(Offset.Zero),
        localToWindow(Offset(width, 0f)),
        localToWindow(Offset(0f, height)),
        localToWindow(Offset(width, height)),
    )
    val clipped = boundsInWindow()
    return UiControlBounds(
        full = UiRect(corners.minOf { it.x }, corners.minOf { it.y }, corners.maxOf { it.x }, corners.maxOf { it.y }),
        clipped = UiRect(clipped.left, clipped.top, clipped.right, clipped.bottom),
    )
}
