package io.github.rfairburn.pireviewgate.ui.client

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsIgnoringVisibility
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.waterfall
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.QuickSwitcherRow
import io.github.rfairburn.pireviewgate.core.client.ui.SessionActionTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SessionRowKey
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalControlKey
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalKeyRequest
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalModifier
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalModifiers
import io.github.rfairburn.pireviewgate.core.client.ui.TerminalUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlay
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayGeometry
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayOrientation
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPlacement
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPlacementWarning
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPoint
import io.github.rfairburn.pireviewgate.core.client.ui.quickSwitcherRows
import kotlin.math.roundToInt

/** Overlay chrome is translucent enough to hint at covered cells, opaque enough to read. */
private const val OVERLAY_ALPHA = 0.92f

/** Smallest Keys viewport that lets scrolling bring a full 48dp target clear of panel padding. */
private val MinimumKeysViewport = 56.dp

/**
 * The fullscreen terminal.
 *
 * The pane is the whole app drawable window minus only the stable physical system
 * bars, display cutout, and waterfall insets. No app heading, permanent key rows,
 * navigation bar, or status slot is measured into it; those safety areas are kept,
 * not claimed as removed. Nothing below the pane is reserved, so its size, origin,
 * and grid change only when the real window or orientation does.
 *
 * Everything else floats over the pane in this same window: a compact control strip
 * (Back, Switch, keyboard icon, Keys), truthful readiness/status notices, and the
 * dismissible Keys panel with the existing modifiers, paste, special and function
 * keys. None of them is a Dialog, sheet, or focusable popup, so opening one neither
 * takes native window focus nor reports coverage; only the real quick switcher and
 * modal dialogs do that. Every overlay surface consumes its own touches so a tap on
 * a control never reaches the terminal underneath, while the rest of the pane
 * remains the terminal's.
 *
 * The three overlays are independently positioned. A recognized long-press drag on
 * the control strip, the notice's text, or the Keys panel's header moves only that
 * surface; a short tap still delivers the same button/action behavior. A completed
 * drag submits the complete six-slot state through [onOverlayPlacementCommitted];
 * cancels, rotations, IME changes, and ordinary frames never save. The overlay layer
 * is not composed until [overlayPlacementReady] reports the completed placement load,
 * so an early interaction cannot submit defaults over saved slots. The IME may clamp
 * what is visible but never rewrites a remembered position or reflows the pane. In an
 * IME-short layer the Keys panel keeps a scrollable viewport in the free band above or
 * below the controls strip, and a wrapped control strip is height-capped and scrollable
 * so neither surface loses its actions.
 *
 * There is no persistent sidebar and no host or session navigation chrome here.
 * The viewport itself is [terminalContent], supplied by whoever owns a real
 * `TerminalSurface` with its binding and listener. [onKey] and [onPaste] are equally
 * required: the Keys panel submits a semantic key request and a paste request
 * through them, and the surface's own public submit API encodes them under the
 * negotiated modes. Nothing in this screen synthesizes a hardware event or writes a
 * packet. [status] is the app's latest admission/settlement notice, shown here
 * instead of in a layout-reserving slot.
 *
 * [debugInputMessagingEnabled] is the saved whole-app diagnostic presentation
 * preference. Off, the entire status notice surface is absent: no notices surface, no
 * readiness or placement-warning text, no dismiss control, no drag or touch region, and
 * no Keys-panel copy of the raw status — and the height that surface remembered while
 * it was visible reserves nothing, so the Keys panel gets that band back. The saved
 * status position itself is untouched, the control strip and Keys panel keep their own
 * surfaces, and the pane's real input readiness still comes from the genuine
 * viewport/commit facts. On, every one of those messages and surfaces returns exactly
 * as before, including the existing dismissible-per-text behavior.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TerminalScreen(
    terminal: TerminalUiState,
    terminalContent: @Composable (TerminalUiState) -> Unit,
    onKey: (TerminalKeyRequest) -> Unit,
    onPaste: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
    modifier: Modifier = Modifier,
    status: String? = null,
    debugInputMessagingEnabled: Boolean = false,
    overlayPlacement: TerminalOverlayPlacement = TerminalOverlayPlacement.DEFAULT,
    overlayPlacementWarning: TerminalOverlayPlacementWarning? = null,
    overlayPlacementReady: Boolean = true,
    onOverlayPlacementCommitted: (TerminalOverlayPlacement) -> Unit = {},
) {
    TerminalImeWindowPolicy()
    // safeDrawing includes IME. Keep bars/cutouts/waterfall, but never subtract
    // the keyboard from the pane, even on enforced edge-to-edge Android versions.
    // The ignoring-visibility bars keep the pane stable if transient bars change.
    val stable = WindowInsets.systemBarsIgnoringVisibility.union(WindowInsets.displayCutout).union(WindowInsets.waterfall)
    // Which pop-out is open is screen-owned presentation, like an open menu.
    var keysOpen by rememberSaveable { mutableStateOf(false) }
    var dismissedStatus by rememberSaveable { mutableStateOf<String?>(null) }
    // Registered after RootUIScreen's terminal handler, so it wins only while
    // enabled: the switcher and a visible IME keep their existing Back priority.
    BackHandler(enabled = keysOpen && !terminal.quickSwitcherVisible && !terminal.keyboardVisible) {
        keysOpen = false
    }
    Box(modifier.fillMaxSize().windowInsetsPadding(stable)) {
        // The pane: identical constraints whatever the overlays, IME, or readiness.
        Box(Modifier.fillMaxSize()) { terminalContent(terminal) }
        // Overlays only. This layer has no pointer handler of its own and each
        // positioned surface wraps only its own content, so the rest of the pane
        // remains the terminal's. Stable painting is not a claim of physical pixel
        // visibility and grants no input or commit authority. Nothing here composes
        // until the initial placement load completed with saved positions or the
        // warned defaults, so an early interaction cannot write partial state.
        if (overlayPlacementReady) {
            TerminalOverlayLayer(
                terminal = terminal,
                keysOpen = keysOpen,
                onToggleKeys = { keysOpen = !keysOpen },
                status = status,
                debugInputMessagingEnabled = debugInputMessagingEnabled,
                dismissedStatus = dismissedStatus,
                onDismissStatus = { dismissedStatus = it },
                onKey = onKey,
                onPaste = onPaste,
                onIntent = onIntent,
                placement = overlayPlacement,
                placementWarning = overlayPlacementWarning,
                onPlacementCommitted = onOverlayPlacementCommitted,
            )
        }
    }
}

/**
 * The independently positioned overlay layer.
 *
 * Resolution uses the stable pane's free space; the currently visible layer (after
 * IME insets) only clamps the display point. Moving or clamping one surface never
 * changes another slot, and no layout in here changes the pane's constraints.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TerminalOverlayLayer(
    terminal: TerminalUiState,
    keysOpen: Boolean,
    onToggleKeys: () -> Unit,
    status: String?,
    debugInputMessagingEnabled: Boolean,
    dismissedStatus: String?,
    onDismissStatus: (String) -> Unit,
    onKey: (TerminalKeyRequest) -> Unit,
    onPaste: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
    placement: TerminalOverlayPlacement,
    placementWarning: TerminalOverlayPlacementWarning?,
    onPlacementCommitted: (TerminalOverlayPlacement) -> Unit,
) {
    val orientation = when (LocalConfiguration.current.orientation) {
        Configuration.ORIENTATION_LANDSCAPE -> TerminalOverlayOrientation.LANDSCAPE
        else -> TerminalOverlayOrientation.PORTRAIT
    }
    val warningText = when (placementWarning) {
        TerminalOverlayPlacementWarning.LOADED_DEFAULTS -> stringResource(R.string.terminal_overlay_positions_defaulted)
        TerminalOverlayPlacementWarning.SAVE_FAILED -> stringResource(R.string.terminal_overlay_positions_save_failed)
        null -> null
    }
    val visibleStatus = status?.takeIf { it != dismissedStatus }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val stableWidth = constraints.maxWidth
        val stableHeight = constraints.maxHeight
        var controlsSlotHeight by remember { mutableStateOf(0) }
        var noticesSlotHeight by remember { mutableStateOf(0) }
        Box(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.ime),
        ) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val visibleWidth = constraints.maxWidth
                val visibleHeight = constraints.maxHeight
                val minimumKeysViewportPx = with(LocalDensity.current) { MinimumKeysViewport.roundToPx() }
                var controlsCapped by remember(keysOpen) { mutableStateOf(false) }
                var constrainedKeys by remember(keysOpen) { mutableStateOf(false) }
                var keysSlotHeight by remember(keysOpen) { mutableStateOf(0) }

                // A wrapped control strip that cannot fit at all is capped so its own
                // controls stay reachable. While Keys is open, cap it far enough to keep
                // a usable Keys band too. The state resets when Keys closes, so a taller
                // window never inherits a scroll container it no longer needs.
                val controlsOverflow = visibleHeight - controlsSlotHeight < 0
                val keysNeedControlsCap =
                    keysOpen && visibleHeight - controlsSlotHeight < minimumKeysViewportPx
                if (!controlsCapped && (controlsOverflow || keysNeedControlsCap)) {
                    SideEffect { controlsCapped = true }
                }
                val capControlsNow = controlsCapped || controlsOverflow || keysNeedControlsCap
                val controlsMaxHeightPx = if (capControlsNow) {
                    if (keysOpen) {
                        (visibleHeight - minimumKeysViewportPx).coerceAtLeast(0)
                    } else {
                        visibleHeight
                    }
                } else {
                    null
                }

                // While Keys is open, use the height the control strip will occupy
                // after its cap applies. This keeps the chosen Keys band stable instead
                // of collapsing to zero during the frame before the cap is measured.
                val effectiveControlsSlotHeightPx = if (keysOpen) {
                    controlsSlotHeight.coerceAtMost(
                        (visibleHeight - minimumKeysViewportPx).coerceAtLeast(0),
                    )
                } else {
                    controlsSlotHeight
                }
                val unobstructedKeysHeightPx =
                    (visibleHeight - effectiveControlsSlotHeightPx -
                        // A hidden notices surface reserves nothing at all: a height this
                        // layer remembered while debugging was visible must not keep
                        // eating Keys space once that surface is gone.
                        (if (debugInputMessagingEnabled) noticesSlotHeight else 0)).coerceAtLeast(0)
                val controlsPosition = placement.position(TerminalOverlay.CONTROLS, orientation)
                val controlsResolvedTop = if (controlsPosition != null) {
                    TerminalOverlayGeometry.resolve(
                        stableWidth = stableWidth,
                        stableHeight = stableHeight,
                        overlayWidth = 0,
                        overlayHeight = effectiveControlsSlotHeightPx,
                        position = controlsPosition,
                    ).y
                } else {
                    TerminalOverlayGeometry.resolveDefault(
                        overlay = TerminalOverlay.CONTROLS,
                        stableWidth = stableWidth,
                        stableHeight = stableHeight,
                        overlayWidth = 0,
                        overlayHeight = effectiveControlsSlotHeightPx,
                        controlsSlotHeight = 0,
                    ).y
                }
                val controlsDisplayTop = TerminalOverlayGeometry.clampToVisible(
                    point = TerminalOverlayPoint(0, controlsResolvedTop),
                    visibleWidth = visibleWidth,
                    visibleHeight = visibleHeight,
                    overlayWidth = 0,
                    overlayHeight = effectiveControlsSlotHeightPx,
                ).y
                val controlsDisplayBottom =
                    (controlsDisplayTop + effectiveControlsSlotHeightPx).coerceAtMost(visibleHeight)

                // Enter the short-layer layout when the ordinary Keys viewport is too
                // small or intersects a moved control strip. A moved control that does
                // not overlap keeps the ordinary layout and its existing Keys bounds.
                val normalKeysHeightPx = keysSlotHeight.coerceAtMost(unobstructedKeysHeightPx)
                val normalKeysTopPx = if (normalKeysHeightPx > 0) {
                    val resolved = placement.position(TerminalOverlay.KEYS, orientation)?.let { explicit ->
                        TerminalOverlayGeometry.resolve(
                            stableWidth = stableWidth,
                            stableHeight = stableHeight,
                            overlayWidth = 0,
                            overlayHeight = normalKeysHeightPx,
                            position = explicit,
                        )
                    } ?: TerminalOverlayGeometry.resolveDefault(
                        overlay = TerminalOverlay.KEYS,
                        stableWidth = stableWidth,
                        stableHeight = stableHeight,
                        overlayWidth = 0,
                        overlayHeight = normalKeysHeightPx,
                        controlsSlotHeight = 0,
                    )
                    TerminalOverlayGeometry.clampToVisible(
                        point = resolved,
                        visibleWidth = visibleWidth,
                        visibleHeight = visibleHeight,
                        overlayWidth = 0,
                        overlayHeight = normalKeysHeightPx,
                    ).y
                } else {
                    0
                }
                val controlsOverlapNormalKeys = normalKeysHeightPx > 0 &&
                    controlsDisplayTop < normalKeysTopPx + normalKeysHeightPx &&
                    controlsDisplayBottom > normalKeysTopPx
                val needsConstrainedKeys = keysOpen &&
                    (unobstructedKeysHeightPx < minimumKeysViewportPx || controlsOverlapNormalKeys)
                if (needsConstrainedKeys && !constrainedKeys) {
                    SideEffect { constrainedKeys = true }
                }
                val shortKeysLayout = keysOpen && (constrainedKeys || needsConstrainedKeys)

                // effectiveControlsSlotHeight leaves at least MinimumKeysViewport of free
                // height while Keys is open, so every short-layer band below is usable.
                val totalFreeHeightPx = (visibleHeight - effectiveControlsSlotHeightPx).coerceAtLeast(0)
                val aboveControlsPx = controlsDisplayTop.coerceIn(0, visibleHeight)
                val belowControlsPx = (visibleHeight - controlsDisplayBottom).coerceAtLeast(0)
                var keysMaxHeightPx = unobstructedKeysHeightPx
                var keysMinimumTopPx = 0
                var forcedControlsTopPx: Int? = null
                // Short-layer bands are display-only. If neither side of a moved control
                // strip can fit Keys, pin that strip to the nearer edge; its saved slot is
                // untouched.
                if (shortKeysLayout) {
                    when {
                        belowControlsPx >= minimumKeysViewportPx && belowControlsPx >= aboveControlsPx -> {
                            keysMaxHeightPx = belowControlsPx
                            keysMinimumTopPx = controlsDisplayBottom
                        }
                        aboveControlsPx >= minimumKeysViewportPx -> {
                            keysMaxHeightPx = aboveControlsPx
                            keysMinimumTopPx = 0
                        }
                        belowControlsPx >= aboveControlsPx -> {
                            forcedControlsTopPx = 0
                            keysMaxHeightPx = totalFreeHeightPx
                            keysMinimumTopPx = effectiveControlsSlotHeightPx
                        }
                        else -> {
                            forcedControlsTopPx =
                                (visibleHeight - effectiveControlsSlotHeightPx).coerceAtLeast(0)
                            keysMaxHeightPx = totalFreeHeightPx
                            keysMinimumTopPx = 0
                        }
                    }
                }
                // Bind the Keys display and drag clamp to the chosen band's bottom.
                // A bottom-anchored default must not land under a moved control strip.
                val keysVisibleBottomPx = if (shortKeysLayout) {
                    (keysMinimumTopPx + keysMaxHeightPx).coerceAtMost(visibleHeight)
                } else {
                    visibleHeight
                }
                PlaceableOverlay(
                    overlay = TerminalOverlay.CONTROLS,
                    placement = placement,
                    orientation = orientation,
                    stableWidth = stableWidth,
                    stableHeight = stableHeight,
                    visibleWidth = visibleWidth,
                    visibleHeight = visibleHeight,
                    controlsSlotHeight = 0,
                    onMeasured = { size ->
                        if (size.height != controlsSlotHeight) controlsSlotHeight = size.height
                    },
                    maxHeightPx = controlsMaxHeightPx,
                    forcedTopPx = forcedControlsTopPx,
                    layerZIndex = if (shortKeysLayout) 2f else 1f,
                    onCommitted = onPlacementCommitted,
                ) { dragModifier ->
                    TerminalControls(
                        terminal = terminal,
                        keysOpen = keysOpen,
                        onToggleKeys = onToggleKeys,
                        onIntent = onIntent,
                        dragModifier = dragModifier,
                        scrollable = capControlsNow,
                    )
                }
                // The whole diagnostic notice surface is the saved debug presentation.
                // Off, none of it composes: no Surface, no readiness or placement-warning
                // text, no dismiss control, no drag or touch region, and no measured
                // height. The saved STATUS position is never rewritten either way.
                if (debugInputMessagingEnabled) {
                    PlaceableOverlay(
                        overlay = TerminalOverlay.STATUS,
                        placement = placement,
                        orientation = orientation,
                        stableWidth = stableWidth,
                        stableHeight = stableHeight,
                        visibleWidth = visibleWidth,
                        visibleHeight = visibleHeight,
                        controlsSlotHeight = controlsSlotHeight,
                        onMeasured = { size ->
                            if (size.height != noticesSlotHeight) noticesSlotHeight = size.height
                        },
                        layerZIndex = 1f,
                        onCommitted = onPlacementCommitted,
                    ) { dragModifier ->
                        TerminalNotices(
                            terminal = terminal,
                            status = visibleStatus,
                            placementWarning = warningText,
                            onDismissStatus = onDismissStatus,
                            dragModifier = dragModifier,
                        )
                    }
                }
                if (keysOpen) {
                    // Keys uses the ordinary cap while that leaves a usable, unobstructed
                    // viewport. In a short layer it moves into the larger free band above
                    // or below the control strip, which is display-only: the persisted
                    // six-slot placement is never rewritten by this adaptation.
                    PlaceableOverlay(
                        overlay = TerminalOverlay.KEYS,
                        placement = placement,
                        orientation = orientation,
                        stableWidth = stableWidth,
                        stableHeight = stableHeight,
                        visibleWidth = visibleWidth,
                        visibleHeight = keysVisibleBottomPx,
                        controlsSlotHeight = 0,
                        maxHeightPx = keysMaxHeightPx,
                        minimumTopPx = keysMinimumTopPx,
                        layerZIndex = if (shortKeysLayout) 1.5f else 0f,
                        onCommitted = onPlacementCommitted,
                        onMeasured = { size ->
                            if (size.height != keysSlotHeight) keysSlotHeight = size.height
                        },
                    ) { dragModifier ->
                        TerminalKeysPanel(
                            terminal = terminal,
                            // The Keys panel's duplicate of the raw status is part of the
                            // same diagnostic presentation, so it goes with the surface.
                            status = if (debugInputMessagingEnabled) status else null,
                            onKey = onKey,
                            onPaste = onPaste,
                            onIntent = onIntent,
                            dragModifier = dragModifier,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Position one wrapping overlay and own its long-press drag.
 *
 * The wrapper never fills the layer; only the content [content] touches, so no
 * background hit target is introduced. The long-press detector consumes movement
 * only after the pointer has crossed the touch slop, which cancels a child button
 * click exactly when a drag is recognized while leaving short taps untouched.
 */
@Composable
private fun PlaceableOverlay(
    overlay: TerminalOverlay,
    placement: TerminalOverlayPlacement,
    orientation: TerminalOverlayOrientation,
    stableWidth: Int,
    stableHeight: Int,
    visibleWidth: Int,
    visibleHeight: Int,
    controlsSlotHeight: Int,
    maxHeightPx: Int? = null,
    minimumTopPx: Int = 0,
    forcedTopPx: Int? = null,
    layerZIndex: Float = 0f,
    onCommitted: (TerminalOverlayPlacement) -> Unit,
    onMeasured: (IntSize) -> Unit = {},
    content: @Composable (Modifier) -> Unit,
) {
    var size by remember(overlay) { mutableStateOf(IntSize.Zero) }
    var dragPoint by remember(overlay, orientation) { mutableStateOf<TerminalOverlayPoint?>(null) }
    val layoutHeight = if (maxHeightPx != null) {
        size.height.coerceAtMost(maxHeightPx).coerceAtLeast(0)
    } else {
        size.height
    }
    val position = placement.position(overlay, orientation)
    val resolved = position?.let { explicit ->
        TerminalOverlayGeometry.resolve(stableWidth, stableHeight, size.width, layoutHeight, explicit)
    } ?: TerminalOverlayGeometry.resolveDefault(
        overlay = overlay,
        stableWidth = stableWidth,
        stableHeight = stableHeight,
        overlayWidth = size.width,
        overlayHeight = layoutHeight,
        controlsSlotHeight = controlsSlotHeight,
    )
    val basePoint = TerminalOverlayGeometry.clampToVisible(
        point = resolved,
        visibleWidth = visibleWidth,
        visibleHeight = visibleHeight,
        overlayWidth = size.width,
        overlayHeight = layoutHeight,
        minimumY = minimumTopPx,
    ).let { clamped ->
        val forced = forcedTopPx ?: return@let clamped
        val maximumTop = TerminalOverlayGeometry.freeHeight(visibleHeight, layoutHeight)
        val minimumTop = minimumTopPx.coerceIn(0, maximumTop)
        TerminalOverlayPoint(clamped.x, forced.coerceIn(minimumTop, maximumTop))
    }
    val currentBase = rememberUpdatedState(basePoint)
    val currentPlacement = rememberUpdatedState(placement)
    val currentSize = rememberUpdatedState(size)
    val currentCommit = rememberUpdatedState(onCommitted)
    val currentMinimumTop = rememberUpdatedState(minimumTopPx)
    val heightConstraint = if (maxHeightPx != null) {
        val maxHeight = with(LocalDensity.current) { maxHeightPx.toDp() }
        Modifier.heightIn(max = maxHeight)
    } else {
        Modifier
    }
    val dragModifier = Modifier.pointerInput(overlay, orientation, stableWidth, stableHeight, visibleWidth, visibleHeight) {
        var moved = false
        var accumulated = Offset.Zero
        var working: TerminalOverlayPoint? = null
        detectDragGesturesAfterLongPress(
            onDragStart = {
                moved = false
                accumulated = Offset.Zero
                working = currentBase.value
            },
            onDragCancel = {
                moved = false
                working = null
                dragPoint = null
            },
            onDragEnd = {
                val finished = working
                if (moved && finished != null && currentSize.value != IntSize.Zero) {
                    val committed = TerminalOverlayGeometry.toPosition(
                        point = finished,
                        stableWidth = stableWidth,
                        stableHeight = stableHeight,
                        overlayWidth = currentSize.value.width,
                        overlayHeight = currentSize.value.height,
                    )
                    currentCommit.value(currentPlacement.value.withPosition(overlay, orientation, committed))
                }
                moved = false
                working = null
                dragPoint = null
            },
            onDrag = { change, dragAmount ->
                accumulated += dragAmount
                if (!moved && accumulated.getDistance() > viewConfiguration.touchSlop) moved = true
                if (moved) {
                    change.consume()
                    val start = working ?: currentBase.value
                    val next = TerminalOverlayGeometry.clampToVisible(
                        point = TerminalOverlayPoint(
                            x = start.x + dragAmount.x.roundToInt(),
                            y = start.y + dragAmount.y.roundToInt(),
                        ),
                        visibleWidth = visibleWidth,
                        visibleHeight = visibleHeight,
                        overlayWidth = currentSize.value.width,
                        overlayHeight = currentSize.value.height,
                        minimumY = currentMinimumTop.value,
                    )
                    working = next
                    dragPoint = next
                }
            },
        )
    }
    val point = dragPoint ?: basePoint
    Box(
        Modifier
            .offset { IntOffset(point.x, point.y) }
            .zIndex(layerZIndex)
            .then(heightConstraint)
            .onGloballyPositioned { coordinates ->
                val measured = coordinates.size
                if (measured != size) {
                    size = measured
                    onMeasured(measured)
                }
            },
    ) {
        content(dragModifier)
    }
}

/** Only the terminal Activity window opts out of both OS resize and OS pan.
 * Separate dialog/sheet windows retain their own IME behavior; leaving the route
 * restores the Activity's original mode for Add Host and other forms.
 */
@Composable
private fun TerminalImeWindowPolicy() {
    val view = LocalView.current
    DisposableEffect(view) {
        val window = view.context.activity()?.window
        val previous = window?.attributes?.softInputMode
        if (window != null && previous != null) {
            window.setSoftInputMode((previous and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST.inv()) or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
        }
        onDispose { if (window != null && previous != null) window.setSoftInputMode(previous) }
    }
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/**
 * Overlay surfaces own every touch that lands on them through HIT TESTING, not
 * consumption: Compose stops testing overlapping siblings at the first one hit
 * that has pointer input (sharing is opt-in), so the terminal sibling below never
 * receives a touch that lands here. This handler deliberately consumes nothing:
 * consuming here (an ancestor, Main pass) would make descendant buttons and the
 * Keys panel's scroll detector see their own pre-slop moves as consumed and cancel.
 */
private fun Modifier.ownsTouches(): Modifier = pointerInput(Unit) {}

/**
 * The compact control strip: Back, cross-host Switch, the explicit keyboard toggle,
 * and the Keys pop-out. The keyboard toggle is one fixed-footprint vector icon; its
 * accessible description follows observed IME insets ([TerminalUiState.keyboardVisible]),
 * never the tap. [dragModifier] is the long-press drag region for this strip; it adds
 * no grip and no occupied width.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TerminalControls(
    terminal: TerminalUiState,
    keysOpen: Boolean,
    onToggleKeys: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
    dragModifier: Modifier = Modifier,
    scrollable: Boolean = false,
) {
    Surface(
        modifier = Modifier.padding(4.dp).then(dragModifier).ownsTouches(),
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surface.copy(alpha = OVERLAY_ALPHA),
        tonalElevation = 2.dp,
    ) {
        val scrollState = rememberScrollState()
        Column(modifier = if (scrollable) Modifier.verticalScroll(scrollState) else Modifier) {
            // Wraps rather than squeezing trailing controls in narrow windows or with
            // enlarged text; only this overlay grows, never the pane's constraints. A
            // short layer caps this overlay and makes it scrollable instead.
            FlowRow(horizontalArrangement = Arrangement.End) {
                OverlayButton(onClick = { onIntent(ClientIntent.LeaveTerminal) }) {
                    Text(stringResource(R.string.action_back), maxLines = 1)
                }
                OverlayButton(onClick = { onIntent(ClientIntent.ShowQuickSwitcher) }) {
                    Text(stringResource(R.string.action_switch_session), maxLines = 1)
                }
                OverlayButton(onClick = { onIntent(ClientIntent.SetTerminalKeyboardVisible(!terminal.keyboardVisible)) }) {
                    Icon(
                        painter = painterResource(R.drawable.ic_terminal_keyboard),
                        contentDescription = stringResource(
                            if (terminal.keyboardVisible) R.string.key_hide_keyboard else R.string.key_show_keyboard,
                        ),
                        modifier = Modifier.size(24.dp),
                    )
                }
                OverlayButton(onClick = onToggleKeys) {
                    StableLabel(
                        R.string.terminal_keys_close to keysOpen,
                        R.string.terminal_keys_open to !keysOpen,
                    )
                }
            }
        }
    }
}

/** Compact text button; Material keeps the 48dp minimum interactive target. */
@Composable
private fun OverlayButton(onClick: () -> Unit, content: @Composable () -> Unit) {
    TextButton(onClick = onClick, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) {
        content()
    }
}

/** All alternatives share one footprint; only the visible one is in semantics. */
@Composable
private fun StableLabel(vararg labels: Pair<Int, Boolean>) {
    Box {
        labels.forEach { (label, visible) ->
            Text(stringResource(label), maxLines = 1,
                modifier = if (visible) Modifier else Modifier.alpha(0f).clearAndSetSemantics {})
        }
    }
}

/**
 * Readiness, status, and required placement-load/save notices, overlaid without
 * reserving layout. This whole surface is the saved Debug input messaging
 * presentation: the caller composes none of it while that preference is off, so a
 * paused terminal says so only while it is on, and the latest app status can be
 * dismissed here and has its Keys-panel copy under that same condition. The text
 * regions are the existing non-button drag targets for this surface; the dismiss
 * button stays an ordinary button with no new row.
 */
@Composable
private fun TerminalNotices(
    terminal: TerminalUiState,
    status: String?,
    placementWarning: String?,
    onDismissStatus: (String) -> Unit,
    dragModifier: Modifier = Modifier,
) {
    val paused = when {
        terminal.coverage.suspendsTerminalInput -> R.string.terminal_suspended_coverage
        !terminal.inputReady -> R.string.terminal_suspended_viewport
        else -> null
    }
    if (paused == null && status == null && placementWarning == null) return
    Surface(
        modifier = Modifier.padding(horizontal = 4.dp).widthIn(max = 360.dp).ownsTouches(),
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surface.copy(alpha = OVERLAY_ALPHA),
        tonalElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (paused != null) {
                Text(
                    stringResource(paused),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = dragModifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            if (status != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        status,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f, fill = false).then(dragModifier)
                            .semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    TextButton(onClick = { onDismissStatus(status) }) {
                        Text(stringResource(R.string.terminal_status_dismiss))
                    }
                }
            }
            if (placementWarning != null) {
                Text(
                    placementWarning,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = dragModifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }
    }
}

/**
 * The Keys pop-out: the same native key toolbar, now transient.
 *
 * Sticky modifiers are held state, cleared across targets, coverage, and
 * backgrounding by the controller. Every key button submits a semantic
 * [TerminalControlKey] through the slot; nothing here builds an escape sequence or
 * fakes a hardware event. Opening, scrolling, or expanding this panel never
 * measures into the pane. It also carries the session title and host context that
 * the removed app bar used to show.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TerminalKeysPanel(
    terminal: TerminalUiState,
    status: String?,
    onKey: (TerminalKeyRequest) -> Unit,
    onPaste: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
    dragModifier: Modifier = Modifier,
) {
    val suspended = terminal.coverage.suspendsTerminalInput || !terminal.inputReady
    val held = terminal.modifiers

    Surface(
        modifier = Modifier.fillMaxWidth().ownsTouches(),
        color = MaterialTheme.colorScheme.surface.copy(alpha = OVERLAY_ALPHA),
        tonalElevation = 3.dp,
    ) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 6.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // The existing title/host header is the Keys surface's drag region. It
            // keeps both context fields and adds no row, grip, or height.
            Column(
                modifier = dragModifier,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    text = terminal.sessionTitle,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = stringResource(R.string.session_host_context, terminal.hostLabel),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            status?.let { NoticeText(it) }

            // Modifier, action, and special keys stay in their existing order and
            // availability, packed into one row so only the flow gap is saved.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                ModifierToggle(
                    modifier = TerminalModifier.CTRL,
                    label = stringResource(R.string.key_ctrl),
                    held = held,
                    onIntent = onIntent,
                )
                ModifierToggle(
                    modifier = TerminalModifier.ALT,
                    label = stringResource(R.string.key_alt),
                    held = held,
                    onIntent = onIntent,
                )
                ModifierToggle(
                    modifier = TerminalModifier.SHIFT,
                    label = stringResource(R.string.key_shift),
                    held = held,
                    onIntent = onIntent,
                )
                OutlinedButton(
                    onClick = onPaste,
                    enabled = !suspended,
                    contentPadding = OverlayKeyPadding,
                ) {
                    Text(stringResource(R.string.key_paste))
                }
                OutlinedButton(
                    onClick = { onIntent(ClientIntent.SetTerminalExtraKeysVisible(!terminal.extraKeysVisible)) },
                    contentPadding = OverlayKeyPadding,
                ) {
                    Text(
                        stringResource(
                            if (terminal.extraKeysVisible) R.string.key_hide_extra else R.string.key_show_extra,
                        ),
                    )
                }
                KeyButton(TerminalControlKey.ESCAPE, stringResource(R.string.key_escape), held, suspended, onKey)
                KeyButton(TerminalControlKey.TAB, stringResource(R.string.key_tab), held, suspended, onKey)
                KeyButton(TerminalControlKey.BACKTAB, stringResource(R.string.key_shift_tab), held, suspended, onKey)
                KeyButton(TerminalControlKey.HOME, stringResource(R.string.key_home), held, suspended, onKey)
                KeyButton(TerminalControlKey.END, stringResource(R.string.key_end), held, suspended, onKey)
                KeyButton(TerminalControlKey.PAGE_UP, stringResource(R.string.key_page_up), held, suspended, onKey)
                KeyButton(TerminalControlKey.PAGE_DOWN, stringResource(R.string.key_page_down), held, suspended, onKey)
            }

            // Arrows, then the existing optional Insert/Delete/function keys. The
            // expansion behavior, key set, and order are unchanged.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                KeyButton(TerminalControlKey.ARROW_LEFT, stringResource(R.string.key_arrow_left), held, suspended, onKey)
                KeyButton(TerminalControlKey.ARROW_UP, stringResource(R.string.key_arrow_up), held, suspended, onKey)
                KeyButton(TerminalControlKey.ARROW_DOWN, stringResource(R.string.key_arrow_down), held, suspended, onKey)
                KeyButton(TerminalControlKey.ARROW_RIGHT, stringResource(R.string.key_arrow_right), held, suspended, onKey)
                if (terminal.extraKeysVisible) {
                    KeyButton(TerminalControlKey.INSERT, stringResource(R.string.key_insert), held, suspended, onKey)
                    KeyButton(TerminalControlKey.DELETE, stringResource(R.string.key_delete), held, suspended, onKey)
                    val functionKeys = listOf(
                        TerminalControlKey.F1,
                        TerminalControlKey.F2,
                        TerminalControlKey.F3,
                        TerminalControlKey.F4,
                        TerminalControlKey.F5,
                        TerminalControlKey.F6,
                        TerminalControlKey.F7,
                        TerminalControlKey.F8,
                        TerminalControlKey.F9,
                        TerminalControlKey.F10,
                        TerminalControlKey.F11,
                        TerminalControlKey.F12,
                    )
                    functionKeys.forEach { key ->
                        KeyButton(key, key.name, held, suspended, onKey)
                    }
                }
            }
        }
    }
}

private val OverlayKeyPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)

@Composable
private fun ModifierToggle(
    modifier: TerminalModifier,
    label: String,
    held: TerminalModifiers,
    onIntent: (ClientIntent) -> Unit,
) {
    if (held.holds(modifier)) {
        Button(
            onClick = { onIntent(ClientIntent.ToggleTerminalModifier(modifier)) },
            contentPadding = OverlayKeyPadding,
        ) { Text(label) }
    } else {
        OutlinedButton(
            onClick = { onIntent(ClientIntent.ToggleTerminalModifier(modifier)) },
            contentPadding = OverlayKeyPadding,
        ) { Text(label) }
    }
}

@Composable
private fun KeyButton(
    key: TerminalControlKey,
    label: String,
    held: TerminalModifiers,
    suspended: Boolean,
    onKey: (TerminalKeyRequest) -> Unit,
) {
    OutlinedButton(
        onClick = { onKey(TerminalKeyRequest(key, held)) },
        enabled = !suspended,
        contentPadding = OverlayKeyPadding,
    ) { Text(label) }
}

/**
 * The cross-host quick switcher.
 *
 * Every configured host appears, connected or not, and a host whose rows are no
 * longer live is labelled stale rather than being presented as current. Selecting a
 * row asks the controller to switch the terminal to that exact target; the sheet
 * reports its own coverage so terminal input is suspended while it is open.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickSwitcherSheet(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
) {
    val terminal = (state.route as? io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute.Terminal)?.terminal
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = { onIntent(ClientIntent.DismissQuickSwitcher) },
        sheetState = sheetState,
    ) {
        // The sheet is its own window. Commit proof for its entries has to come from
        // frames of *this* window: inheriting the activity's commit source through the
        // composition local would certify a sheet control against an activity frame in
        // which the control was never drawn.
        UiCommitScope {
            Text(
                stringResource(R.string.quick_switcher_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                items(
                    items = quickSwitcherRows(state.hostStates, terminal?.target, state.rowOrder),
                    key = {
                        when (it) {
                            is QuickSwitcherRow.Session ->
                                "qs-${it.session.hostId.value}|${it.session.hostRunId}|${it.session.rowId}"
                            is QuickSwitcherRow.HostWithoutRoster -> "qs-host-${it.host.host.id.value}"
                        }
                    },
                ) { row ->
                    when (row) {
                        is QuickSwitcherRow.Session -> QuickSwitcherSessionRow(
                            row = row,
                            proof = terminal?.chooserProofs?.get(SessionRowKey.of(row.session)),
                            covered = state.dialogs.hasModal,
                            onIntent = onIntent,
                        )
                        is QuickSwitcherRow.HostWithoutRoster -> {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(row.host.host.label.value, style = MaterialTheme.typography.bodyLarge)
                                    Text(
                                        text = row.host.host.endpoint.displayText(),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                ConnectionChip(row.host.connection)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun QuickSwitcherSessionRow(
    row: QuickSwitcherRow.Session,
    proof: UiActionProof?,
    covered: Boolean,
    onIntent: (ClientIntent) -> Unit,
) {
    // The switch is attributed to the chooser entry the operator actually saw, so the
    // proof is the entry's own and not the terminal being left. The semantic key is
    // the frozen entry target, so a listed row that changed under the sheet retires
    // its standing instead of being chosen from a frame that no longer shows it.
    val target = SessionActionTarget.of(row.session)
    val guard = rememberUiActionGuard(proof = proof, semanticKey = target, covered = covered)
    TextButton(
        onClick = {
            proof?.let {
                guard.attempt { onIntent(ClientIntent.SwitchTerminalTarget(target, it)) }
            }
        },
        enabled = proof != null,
        modifier = Modifier
            .fillMaxWidth()
            .then(guard.modifier),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = row.session.displayTitle,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = stringResource(R.string.session_host_context, row.session.hostLabel),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            when {
                row.isCurrent -> Text(stringResource(R.string.quick_switcher_current), style = MaterialTheme.typography.labelLarge)
                row.session.stale -> Text(stringResource(R.string.roster_stale), style = MaterialTheme.typography.labelLarge)
                else -> {}
            }
        }
    }
}
