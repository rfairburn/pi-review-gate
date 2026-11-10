package io.github.rfairburn.pireviewgate.ui.client

import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.IntSize
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.github.rfairburn.pireviewgate.core.client.ui.CriticalLineObservation
import io.github.rfairburn.pireviewgate.core.client.ui.MutableUiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.PresentationGate
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.UiProofInvalidationReason
import io.github.rfairburn.pireviewgate.core.client.ui.UiRect
import io.github.rfairburn.pireviewgate.ui.render.FrameCommitWatcher

/**
 * Wraps one dialog's or form's content in the actual commit gate.
 *
 * The correct view is the one this composable is inside: a Material dialog hosts its
 * content in its own window, so [LocalView] here is that window's view, not the
 * activity's. The policy — what invalidates, what re-arms, what the critical content
 * requirement is, and whether a tap may be spent — is the portable
 * [PresentationGate]; this adapter supplies only platform facts and drives it.
 *
 * Three distinctions are load-bearing:
 *
 * - [covered] means *another window is on top of this one*. A dialog is itself the
 *   modal over a terminal, and that must never retire the dialog's own standing;
 *   only a further window above it does, and then permanently.
 * - [semanticKey] is the frozen semantic presentation of the dialog — its target and
 *   generation, deliberately not its volatile display text. A change to it composes a
 *   new gate and retires the old proof, because the committed frame described
 *   different content.
 * - [requiredCriticalLines] states what this dialog must have fully visible to act.
 *   Zero is an honest answer for an intentionally identity-free confirmation; a
 *   positive number is satisfied only when that many lines have reported, and every
 *   one of them is inside the visible viewport.
 *
 * Invalidation is synchronous and first: layout, focus, scroll, and coverage changes
 * flip the proof before anything else is computed, obsolete commit registrations are
 * cancelled, and only a freshly begun generation is awaited afterwards. Composition
 * alone never grants.
 */
@Composable
fun UiProofGate(
    proof: UiActionProof,
    semanticKey: Any,
    covered: Boolean,
    modifier: Modifier = Modifier,
    requiredCriticalLines: Int = 0,
    content: @Composable (ProofGate) -> Unit,
) {
    val view: View = LocalView.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scrollState = rememberScrollState()

    // Only the portable proof state machine can be armed from a view report. A proof
    // supplied by anything else is still consulted honestly, but nothing here can
    // make it report a committed frame, so it fails closed.
    val armable = remember(proof) { proof as? MutableUiActionProof }

    // Synchronous, in composition, before any descendant is composed: a new proof
    // generation or a different semantic presentation retires the standing that was
    // drawn before. Waiting for a side effect would leave a window in which a guard on
    // another thread still sees the previous frame's proof as spendable.
    val presentation = remember { DialogPresentation(proof, semanticKey) }
    if (presentation.proof !== proof || presentation.key != semanticKey) {
        (presentation.proof as? MutableUiActionProof)
            ?.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
        presentation.proof = proof
        presentation.key = semanticKey
    }

    val gate = remember(proof, semanticKey, requiredCriticalLines) {
        PresentationGate(proof = proof, requiredCriticalLines = requiredCriticalLines)
    }

    /**
     * Whether this dialog's window can currently draw, prove, or act.
     *
     * A detached, unfocused, or non-resumed window produces no meaningful frame, so
     * nothing observed while it is in that state may satisfy a proof, and no control in
     * it may act. Read on the main thread only, which is the only thread that knows.
     */
    fun windowReady(): Boolean = view.isAttachedToWindow &&
        view.hasWindowFocus() &&
        lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

    val watcher = remember(proof, view, lifecycleOwner) {
        FrameCommitWatcher(view) { drawEpoch -> publishCommit(view, armable, drawEpoch) { windowReady() } }
    }

    /**
     * Cancel whatever registration is pending, then begin a fresh generation and ask for
     * the frame that will certify it.
     *
     * A window that cannot draw right now is left alone rather than registered against a
     * frame that will never come; recovery happens when focus or the lifecycle returns.
     */
    fun rearm() {
        watcher.cancel()
        if (!windowReady()) return
        val epoch = gate.rearm() ?: return
        watcher.awaitCommit(epoch)
        view.invalidate()
    }

    // Leaving composition, or a new semantic presentation replacing this one, retires
    // the proof this gate was standing for.
    DisposableEffect(gate) {
        onDispose { armable?.invalidate(UiProofInvalidationReason.DISMISSED) }
    }

    DisposableEffect(gate, view) {
        val observer = view.viewTreeObserver
        val listener = ViewTreeObserver.OnWindowFocusChangeListener { hasFocus ->
            if (!hasFocus) {
                gate.onFocusLost()
                watcher.cancel()
            } else {
                // Focus returning draws nothing by itself. A popup the operator opened
                // and dismissed without choosing anything — Create's owner menu, for
                // example — would otherwise leave the dialog's control permanently inert
                // until an unrelated tap asked for a frame. Recovery requests one here.
                rearm()
            }
        }
        if (observer.isAlive) observer.addOnWindowFocusChangeListener(listener)
        onDispose { if (observer.isAlive) observer.removeOnWindowFocusChangeListener(listener) }
    }

    DisposableEffect(lifecycleOwner, gate) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP || event == Lifecycle.Event.ON_PAUSE) {
                gate.onFocusLost()
                watcher.cancel()
            } else if (event == Lifecycle.Event.ON_RESUME) {
                rearm()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // Another window on top retires this one's standing before anything else, in
    // composition rather than in a coroutine that runs after descendants are composed.
    gate.onCoveredChanged(covered)
    if (covered) watcher.cancel()

    // Scrolling invalidates synchronously as soon as the value moves, then a fresh
    // frame is awaited so the identity that scrolled into view is committed too.
    LaunchedEffect(gate, scrollState) {
        snapshotFlow { scrollState.value }.collect {
            if (gate.onScroll() != null) rearm()
        }
    }

    var boxSize by remember(gate) { mutableStateOf(IntSize.Zero) }
    var viewportCoordinates by remember(gate) { mutableStateOf<LayoutCoordinates?>(null) }

    LaunchedEffect(gate) { rearm() }

    Box(
        modifier = modifier
            .onSizeChanged {
                if (it != boxSize) {
                    boxSize = it
                    // Flip first, then re-arm: a guard that reads between the two
                    // sees the retired standing, never the pre-layout one.
                    if (gate.onLayoutChange() != null) {
                        watcher.cancel()
                        val epoch = gate.rearm()
                        if (epoch != null) watcher.awaitCommit(epoch)
                    }
                }
            }
            .onGloballyPositioned { viewportCoordinates = it },
    ) {
        content(
            ProofGate(
                gate = gate,
                watcher = watcher,
                viewport = { viewportCoordinates },
                scrollState = scrollState,
                onRefusedRearm = { rearm() },
                canAct = { windowReady() },
            ),
        )
    }
}

/**
 * The control surface a gated dialog hands its buttons and identity lines.
 *
 * [attempt] is the only way to spend the proof: it re-checks every gate at the moment
 * of the tap and emits nothing when any gate fails.
 */
class ProofGate internal constructor(
    private val gate: PresentationGate,
    private val watcher: FrameCommitWatcher,
    private val viewport: () -> LayoutCoordinates?,
    private val scrollState: androidx.compose.foundation.ScrollState,
    private val onRefusedRearm: () -> Unit,
    private val canAct: () -> Boolean,
) {
    /** The proof this gate stands for. */
    val proof: UiActionProof get() = gate.proof

    /**
     * True when the platform can report commits for this window at all. Where it
     * cannot, no control in this dialog will ever be spendable, and the dialog says so
     * instead of leaving the operator tapping a dead button.
     */
    val commitReportingAvailable: Boolean get() = watcher.isCommitReportingAvailable

    /**
     * The dialog's scrollable body.
     *
     * It is the viewport the critical-identity check measures against, which is why
     * the gate owns it: content scrolled out of this container is out of the frame
     * that will be committed, and must not be counted as readable.
     */
    @Composable
    fun Body(content: @Composable ColumnScope.() -> Unit) {
        Column(
            modifier = Modifier.verticalScroll(scrollState),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            content = content,
        )
    }

    /**
     * Retire this dialog's standing because the operator is editing it.
     *
     * Called from the edit callback, before the edit intent is dispatched: the frame
     * that was committed described the value being changed, so it stops proving
     * anything the moment that value is touched, and only the controller's next proof
     * generation restores a spendable control.
     */
    fun retireForEdit() {
        (gate.proof as? MutableUiActionProof)?.invalidate(UiProofInvalidationReason.TARGET_CHANGE)
        watcher.cancel()
    }

    /**
     * Run [onGranted] only while every gate holds: the proof is current, its frame was
     * committed, the required critical content is fully visible, and no other
     * window is on top.
     *
     * A refused tap does not emit and claims nothing happened; it asks for a fresh
     * committed frame.
     */
    fun attempt(onGranted: () -> Unit) {
        if (canAct() && gate.attempt()) onGranted() else onRefusedRearm()
    }

    /**
     * One critical identity line, checked against the frame that will actually be
     * committed.
     *
     * Three independent failures are caught.
     *
     * The line is configured so it cannot be shortened by policy — it wraps, has no
     * line limit, and clips rather than ellipsizing — and its measured height is
     * compared with the height its own text needs at the measured width, so an
     * internally truncated line fails.
     *
     * Its *unclipped* extent is then compared with the bounds the platform actually
     * reports for it. Those reported bounds already have the ancestors' clipping
     * applied, so a line half scrolled out of the container reports a small, entirely
     * on-screen rectangle; comparing that fragment with the viewport would call it
     * readable. Requiring the full extent to survive the clipping applied to it is what
     * rejects it.
     *
     * Finally the full extent must lie inside the viewport, so a line clipped by the
     * scroll container, by a clipping ancestor, or by the window edge fails: a
     * fingerprint that is laid out but not fully in the frame the operator compared
     * must not carry an approval. Any change in placement retires the generation that
     * was committed before the move and awaits a new one.
     *
     * [key] distinguishes several lines inside one gate; the gate grants only once
     * [UiProofGate]'s required number have reported and all of them are visible.
     */
    @Composable
    fun CriticalIdentityText(
        key: String,
        value: String,
        modifier: Modifier = Modifier,
        style: TextStyle = MaterialTheme.typography.bodyLarge,
    ) {
        // Written during the layout pass and read by the visibility report in the
        // same pass, on the main thread. Deliberately not state: a layout-time state
        // write would recompose the very content being measured.
        var internallyClipped = false
        val placement = remember(gate, key) { CriticalPlacement() }
        Text(
            text = value,
            style = style,
            softWrap = true,
            // Clip, never Ellipsis: dots would hide the identity this line exists to
            // show, and the checks below report the clip instead of pretending.
            overflow = TextOverflow.Clip,
            maxLines = Int.MAX_VALUE,
            modifier = modifier
                .reportInternalClip { clipped -> internallyClipped = clipped }
                .onGloballyPositioned { coords ->
                    val observation = CriticalLineObservation(
                        full = coords.fullWindowRect(),
                        clipped = coords.windowRect(),
                        internallyClipped = internallyClipped,
                    )
                    val epoch = if (placement.observation != observation) {
                        // Flip first, then re-arm: a guard reading between the two
                        // sees the retired standing, never the pre-move one.
                        val next = gate.onLayoutChange()
                        watcher.cancel()
                        placement.observation = observation
                        next
                    } else {
                        null
                    }
                    val box = viewport()
                    gate.reportCriticalLine(key, box != null && observation.isReadable(box.windowRect()))
                    if (epoch != null) watcher.awaitCommit(epoch)
                },
        )
    }
}

/**
 * Reports whether the wrapped content was given the height its own text needs.
 *
 * [minIntrinsicHeight] at the measured width is the height required to show every
 * line; less than that means the box truncated or clipped it vertically. The report
 * runs on the layout pass, which is the main thread.
 */
private fun Modifier.reportInternalClip(onReport: (Boolean) -> Unit): Modifier = layout { measurable, constraints ->
    val placeable = measurable.measure(constraints)
    val requiredHeight = measurable.minIntrinsicHeight(placeable.width)
    onReport(placeable.height < requiredHeight)
    layout(placeable.width, placeable.height) { placeable.placeRelative(0, 0) }
}

private fun LayoutCoordinates.windowRect(): UiRect {
    val rect = boundsInWindow()
    return UiRect(rect.left, rect.top, rect.right, rect.bottom)
}

/**
 * This node's own bounds in window coordinates, unclipped.
 *
 * [LayoutCoordinates.boundsInWindow] has the ancestors' clipping applied, which is the
 * fact needed for what is actually on screen — and the wrong fact for asking whether a
 * line survived that clipping. Mapping the node's four corners through the same
 * transform gives its extent before clipping, in the same coordinate space.
 */
private fun LayoutCoordinates.fullWindowRect(): UiRect {
    val width = size.width.toFloat()
    val height = size.height.toFloat()
    val corners = listOf(
        localToWindow(Offset.Zero),
        localToWindow(Offset(width, 0f)),
        localToWindow(Offset(0f, height)),
        localToWindow(Offset(width, height)),
    )
    return UiRect(
        corners.minOf { it.x },
        corners.minOf { it.y },
        corners.maxOf { it.x },
        corners.maxOf { it.y },
    )
}

/** What one critical line's last layout pass measured, so a move is noticed. */
private class CriticalPlacement {
    var observation: CriticalLineObservation? = null
}

/** What this gate was last drawn for, so a new generation or presentation is seen in composition. */
private class DialogPresentation(var proof: UiActionProof, var key: Any)

/**
 * Publish one platform commit, main-thread only.
 *
 * The frame-commit callback is dispatched on the view's own thread, so this is normally
 * already the case; the repost keeps that an assertion rather than an assumption, and a
 * report for a superseded epoch is dropped inside the proof. A commit observed while the
 * window is detached, unfocused, or paused is dropped too: whatever was drawn then is
 * not what the operator is being asked to approve now.
 */
private fun publishCommit(
    view: View,
    armable: MutableUiActionProof?,
    drawEpoch: Long,
    canCommit: () -> Boolean,
) {
    if (armable == null) return
    if (Looper.myLooper() != Looper.getMainLooper()) {
        view.post { publishCommit(view, armable, drawEpoch, canCommit) }
        return
    }
    if (canCommit()) armable.markCommitted(drawEpoch)
}
