package io.github.rfairburn.pireviewgate.ui.client

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.gestures.detectDragGestures
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
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
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
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalKeysLayout
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlay
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayGeometry
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayOrientation
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPlacement
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPlacementWarning
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPoint
import io.github.rfairburn.pireviewgate.core.client.ui.quickSwitcherRows
import java.util.UUID
import kotlin.math.roundToInt

/** Overlay chrome is translucent enough to hint at covered cells, opaque enough to read. */
private const val OVERLAY_ALPHA = 0.92f

/**
 * The smallest Keys viewport that lets scrolling bring a full 48dp target clear of panel
 * padding. Everything that reads it is a constraint on the control strip, never a rule
 * about the terminal pane: while a docked band is composed the strip leaves this much of
 * the current available extent to the band.
 */
private val MinimumKeysViewport = 56.dp

/** One accessible corner control: the Keys docking toggle, and the floating resize grip. */
private val KeysCornerControl = 48.dp

/**
 * Identifies the floating panel's real 48dp resize-grip container — the pointer-input box,
 * not the 24dp glyph inside it — so its scaled bounds can be measured directly.
 */
private const val KeysResizeGripTag = "terminal-keys-resize-grip"

/**
 * The width the one logical floating Keys layout is laid out at.
 *
 * A floating panel holds exactly one interactive Keys subtree, and that subtree is
 * measured at this width and at the visible height the pane leaves it — never at the
 * frame the user resized to. That fixed reference is what makes the contents stretch
 * instead of re-wrapping: the frame changes, the logical layout does not, and a
 * remembered size never redefines it. It is narrower than a phone's full width so the
 * panel that was never resized is a detached window the operator can move, not a second
 * full-width band sitting where the docked one was.
 *
 * The logical footprint is also the floating panel's resize floor: scale never drops
 * below 1, so every logical touch target — the key buttons, the corner toggle, and the
 * grip, all of which are at least [KeysCornerControl] in the layout — stays at least
 * [KeysCornerControl] of real physical size however far a grip drag overshoots. Shrinking
 * stops there. This is a rule about the floating panel's own contents only: the docked
 * band, its height, and the control strip's [MinimumKeysViewport] constraint are
 * untouched.
 */
private val FloatingKeysLogicalWidth = 320.dp

/**
 * The control strip and the notice surface paint and hit-test above a floating Keys
 * panel, as they did before docking existed. A floating panel that overlaps the strip
 * therefore never swallows a Back, Switch, keyboard, or Keys tap.
 */
private const val ChromeLayerZIndex = 1f

/** A floating Keys panel paints below that chrome. */
private const val FloatingKeysLayerZIndex = 0f

/**
 * The terminal, with one dock-aware layout.
 *
 * The pane is the app drawable window minus the stable physical system bars, display
 * cutout, and waterfall insets, and minus the bottom area a docked surface actually
 * occupies. Those two safety areas are consumed exactly once: the root consumes the
 * stable safety insets, and the pane column below it is reserved only by what the
 * platform reports as real occlusion on top of that band. A docked on-screen keyboard
 * reserves its reported occluding magnitude, and a visible bottom-docked Keys panel
 * reserves its own measured height; the remaining area is the pane, so its size,
 * origin, and grid change only when one of those real reservations does. A floating
 * keyboard or a floating Keys panel reserves nothing and simply overlays.
 *
 * A docked band never takes the area the control strip itself measures. The strip is
 * measured against the current available extent — never against the pane the band has
 * already shrunk — and the band is capped by what that measurement leaves, so the strip
 * cannot be squeezed by a reservation read back through its own shrunken pane. While a
 * band is composed the strip carries the constraint this module has always applied to it:
 * it leaves the band one usable [MinimumKeysViewport] out of the current extent, and is
 * capped and scrollable itself. Both numbers therefore describe the strip and the Keys
 * viewport, never the terminal pane: there is no fixed pane minimum, no split of the
 * layer, and no remembered window size.
 *
 * Observed keyboard visibility is never a reservation. Only the platform's reported
 * occluding inset magnitude is, so a floating IME that reports no occlusion leaves the
 * pane exactly as wide and as tall as it was, and no test or code path treats a tap on
 * the keyboard control as proof that the pane shrank.
 *
 * Everything else floats over this layout in the same window: a compact control strip
 * (Back, cross-host Switch, keyboard icon, Keys), truthful readiness/status notices,
 * and the Keys panel when it is floating. None of them is a Dialog, sheet, or focusable
 * popup, so opening one neither takes native window focus nor reports coverage; only
 * the real quick switcher and modal dialogs do that. Every overlay surface consumes its
 * own touches so a tap on a control never reaches the terminal underneath, while the
 * rest of the pane remains the terminal's.
 *
 * The control strip and the notice surface paint and hit-test above a floating Keys
 * panel, so an overlapping panel cannot swallow a Back, Switch, keyboard, or Keys tap.
 *
 * The controls strip, the notice surface, and a floating Keys panel are positioned
 * independently. A recognized long-press drag on the control strip, the notice's text,
 * or the floating panel's header moves only that surface; a short tap still delivers the
 * same button/action behavior. A floating panel also resizes from its own corner grip.
 * A completed drag, resize, or docking toggle submits the complete placement state
 * through [onOverlayPlacementCommitted]; cancels, rotations, IME changes, and ordinary
 * frames never save. Remembered positions and the remembered floating size survive
 * docking and undocking untouched. The overlay layer is not composed until
 * [overlayPlacementReady] reports the completed placement load, so an early interaction
 * cannot submit defaults over saved slots. Remembered coordinates resolve against the
 * stable layer and are only clamped for display into the pane's actual measured area,
 * so a real reservation can move an overlay on screen without rewriting it.
 *
 * There is no persistent sidebar and no host or session navigation chrome here. The
 * viewport itself is [terminalContent], supplied by whoever owns a real
 * `TerminalSurface` with its binding and listener. [onKey] and [onPaste] are equally
 * required: the Keys panel submits a semantic key request and a paste request through
 * them, and the surface's own public submit API encodes them under the negotiated
 * modes. Nothing in this screen synthesizes a hardware event or writes a packet.
 * [status] is the app's latest admission/settlement notice, shown here instead of in a
 * layout-reserving slot.
 *
 * [debugInputMessagingEnabled] is the saved whole-app diagnostic presentation
 * preference. Off, the entire status notice surface is absent: no notices surface, no
 * readiness or placement-warning text, no dismiss control, no drag or touch region, and
 * no Keys-panel copy of the raw status. The saved status position itself is untouched,
 * the control strip and Keys panel keep their own surfaces, and the pane's real input
 * readiness still comes from the genuine viewport/commit facts. On, every one of those
 * messages and surfaces returns exactly as before, including the existing
 * dismissible-per-text behavior.
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
    // One safety consumption for the whole screen: the bars a transient reveal may hide,
    // the cutout, and the waterfall edge. Nothing below subtracts them again.
    val safety = WindowInsets.systemBarsIgnoringVisibility
        .union(WindowInsets.displayCutout)
        .union(WindowInsets.waterfall)
    // Which pop-out is open, and which raw status text was dismissed, is screen-owned
    // presentation like an open menu. It lives exactly as long as this terminal route
    // instance: a configuration change keeps it, backgrounding keeps it, changing the
    // terminal target keeps it, and leaving the terminal or restarting the process does
    // not. [TerminalKeysEphemeralState] holds the values outside any saved bundle, and
    // [keysRouteToken] is the screen-local identity of this route instance — a random
    // token and nothing else, so neither the open flag nor a dismissed notice is ever
    // written to saved instance state or to the placement document.
    val keysState = rememberTerminalKeysEphemeralState()
    val keysRouteToken = rememberSaveable { UUID.randomUUID().toString() }
    // Claimed during composition, before any child reads the open flag, so the first
    // frame of a fresh route instance is already closed rather than flashing the panel
    // the previous instance left behind.
    keysState.claimRoute(keysRouteToken)
    val keysOpen = keysState.keysOpen
    val dismissedStatus = keysState.dismissedStatus
    // Registered after RootUIScreen's terminal handler, so it wins only while
    // enabled: the switcher and a visible IME keep their existing Back priority.
    BackHandler(enabled = keysOpen && !terminal.quickSwitcherVisible && !terminal.keyboardVisible) {
        keysState.keysOpen = false
    }
    val density = LocalDensity.current
    val orientation = currentTerminalOrientation()
    val keysLayout = overlayPlacement.keysLayout(orientation)
    // The pane's single IME reservation is the platform's own reported occluding inset
    // less the safety band this root already consumed, so the shared band is never
    // subtracted twice. A floating IME reports no occluding magnitude and reserves
    // nothing; keyboard visibility alone is never a reservation.
    val imeReservePx = TerminalDockGeometry.imeReservePx(
        imeBottomPx = WindowInsets.ime.getBottom(density),
        safetyBottomPx = safety.getBottom(density),
    )
    // The pane's real measured area is what every floating surface clamps into. It
    // already excludes the docked IME and a docked Keys band, so neither is subtracted
    // a second time anywhere in this screen.
    var paneSize by remember { mutableStateOf(IntSize.Zero) }
    // The control strip's own measured footprint. The strip is measured against the
    // current available extent (less the Keys viewport it must leave a docked band),
    // never against the pane that band already shrank: reading the reservation basis back
    // through the shrunk pane makes a zero-height pane — or any earlier, smaller one — a
    // fixed point that survives forever. This is the one interactive strip in the one
    // layout pass; there is no second measuring copy of it and nothing here remembers a
    // previous window size.
    var controlsFootprintPx by remember { mutableStateOf(0) }
    BoxWithConstraints(modifier.fillMaxSize().windowInsetsPadding(safety)) {
        val stableWidth = constraints.maxWidth
        val stableHeight = constraints.maxHeight
        val keysDocked = keysOpen && keysLayout.docked
        val layerHeightPx = (stableHeight - imeReservePx).coerceAtLeast(0)
        // The extent the control strip is measured against. While a docked band is
        // composed the strip keeps this module's existing Keys-specific constraint: it
        // gives the band one usable Keys viewport out of the current available extent and
        // is capped and scrollable itself. That is a bound on the strip, not a pane
        // minimum and not a split of the layer, and it never reads the pane back.
        val minimumKeysViewportPx = with(density) { MinimumKeysViewport.roundToPx() }
        val controlsMaxHeightPx = if (keysDocked) {
            (layerHeightPx - minimumKeysViewportPx).coerceAtLeast(0)
        } else {
            layerHeightPx
        }
        // A docked band reserves its own measured height, bounded by what the strip's
        // independent measurement leaves: band <= available extent - strip footprint. With
        // room for both natural sizes nothing is capped and the band keeps the height it
        // always measured; in a short layer the strip is capped instead, so the band keeps
        // a usable Keys viewport and the pane keeps at least the strip's own measured
        // footprint. That bound is only as strong as the footprint itself: once the
        // available extent is no larger than one usable Keys viewport the strip's own cap
        // reaches zero, and a zero measured footprint then leaves the band the whole
        // available extent, so the pane can be squeezed out entirely. Nothing here promises
        // a reachable pane at an arbitrarily tiny extent. No fixed pane minimum, no half
        // split, no remembered window size.
        val dockedBandMaxHeight = with(density) {
            (layerHeightPx - controlsFootprintPx).coerceAtLeast(0).toDp()
        }
        Column(Modifier.fillMaxSize().padding(bottom = with(density) { imeReservePx.toDp() })) {
            // The actual pane: everything the real docked reservations leave it. A size
            // change here is a real native size change and reaches the surface through
            // its own onSizeChanged, grid measurement, and commit fences.
            Box(Modifier.weight(1f).onSizeChanged { if (it != paneSize) paneSize = it }) {
                terminalContent(terminal)
            }
            // Docked Keys is a real bottom band, not an overlay: it reserves its own
            // measured height, and the pane above it shrinks by exactly that much. Like
            // every other placement-driven surface it waits for the initial placement
            // load, so its pop-out cannot commit against a snapshot still loading.
            if (keysDocked && overlayPlacementReady) {
                DockedKeys(
                    terminal = terminal,
                    status = if (debugInputMessagingEnabled) status else null,
                    onKey = onKey,
                    onPaste = onPaste,
                    onIntent = onIntent,
                    maxHeight = dockedBandMaxHeight,
                    onPopOut = {
                        onOverlayPlacementCommitted(
                            overlayPlacement.withKeysLayout(orientation, keysLayout.copy(docked = false)),
                        )
                    },
                )
            }
        }
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
                keysLayout = keysLayout,
                onToggleKeys = { keysState.keysOpen = !keysOpen },
                status = status,
                debugInputMessagingEnabled = debugInputMessagingEnabled,
                dismissedStatus = dismissedStatus,
                onDismissStatus = { keysState.dismissedStatus = it },
                onKey = onKey,
                onPaste = onPaste,
                onIntent = onIntent,
                placement = overlayPlacement,
                placementWarning = overlayPlacementWarning,
                orientation = orientation,
                stableWidth = stableWidth,
                stableHeight = stableHeight,
                // The strip is measured against the current available extent (minus the
                // Keys viewport it must leave a docked band), never against the pane that
                // band shrinks, so the band's reservation basis cannot be set by the pane
                // it produced.
                controlsMaxHeightPx = controlsMaxHeightPx,
                controlsSlotHeight = controlsFootprintPx,
                onControlsMeasured = { height ->
                    if (height != controlsFootprintPx) controlsFootprintPx = height
                },
                // The pane's measured area is the only clamp an overlay gets. A pane that
                // has not been measured yet falls back to the stable layer; a pane that
                // measured a real area is never replaced by a fabricated one, because
                // that would let chrome paint over the band it must leave reachable.
                visibleWidth = if (paneSize == IntSize.Zero) stableWidth else paneSize.width,
                visibleHeight = if (paneSize == IntSize.Zero) stableHeight else paneSize.height,
                onPlacementCommitted = onOverlayPlacementCommitted,
            )
        }
    }
}

/** The orientation whose independent placement and Keys layout slots are in use. */
@Composable
private fun currentTerminalOrientation(): TerminalOverlayOrientation =
    when (LocalConfiguration.current.orientation) {
        Configuration.ORIENTATION_LANDSCAPE -> TerminalOverlayOrientation.LANDSCAPE
        else -> TerminalOverlayOrientation.PORTRAIT
    }

/**
 * The independently positioned overlay layer: the controls strip, the diagnostic notice
 * surface, and the Keys panel while it is floating.
 *
 * Remembered coordinates resolve against the stable layer; the pane's actual measured
 * area only clamps the display point. Moving, clamping, or resizing one surface never
 * changes another slot, and nothing in here changes the pane's constraints: a floating
 * panel reserves no pane area, and a docked one is not composed here at all.
 *
 * The control strip is measured against [controlsMaxHeightPx] — the current available
 * extent, less the Keys viewport it must leave a docked band — and reports that footprint
 * through [onControlsMeasured], which is what bounds the band. It is never measured
 * against the already-shrunk pane, and the strip becomes scrollable exactly when its
 * measured footprint no longer fits the pane it has to stay inside of, which is how its
 * own controls stay reachable in a short layer. The strip and the notice surface carry
 * [ChromeLayerZIndex] so they paint and hit-test above a floating Keys panel.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TerminalOverlayLayer(
    terminal: TerminalUiState,
    keysOpen: Boolean,
    keysLayout: TerminalKeysLayout,
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
    orientation: TerminalOverlayOrientation,
    stableWidth: Int,
    stableHeight: Int,
    controlsMaxHeightPx: Int,
    controlsSlotHeight: Int,
    onControlsMeasured: (Int) -> Unit,
    visibleWidth: Int,
    visibleHeight: Int,
    onPlacementCommitted: (TerminalOverlayPlacement) -> Unit,
) {
    val density = LocalDensity.current
    val warningText = when (placementWarning) {
        TerminalOverlayPlacementWarning.LOADED_DEFAULTS -> stringResource(R.string.terminal_overlay_positions_defaulted)
        TerminalOverlayPlacementWarning.SAVE_FAILED -> stringResource(R.string.terminal_overlay_positions_save_failed)
        null -> null
    }
    val visibleStatus = status?.takeIf { it != dismissedStatus }
    // The floating panel's one logical measuring reference. Both values come from the
    // extent the pane can actually show — never from the panel's own frame — so the
    // logical layout cannot be redefined by a resize and cannot feed back through a
    // frame it already shrank.
    val logicalKeysWidthPx = minOf(
        with(density) { FloatingKeysLogicalWidth.roundToPx() },
        if (visibleWidth > 0) visibleWidth else with(density) { FloatingKeysLogicalWidth.roundToPx() },
    )
    val logicalKeysMaxHeightPx = if (visibleHeight > 0) visibleHeight else stableHeight
    Box(Modifier.fillMaxSize()) {
        // A wrapped control strip is capped to the current available extent — less the
        // usable Keys viewport it must leave a docked band — and becomes scrollable
        // exactly when that cap binds, so its own controls stay reachable in a narrow or
        // short layout. The cap is the current measurement alone: no latch remembers a
        // taller or shorter window, and nothing here moves another overlay.
        PlaceableOverlay(
            overlay = TerminalOverlay.CONTROLS,
            placement = placement,
            orientation = orientation,
            stableWidth = stableWidth,
            stableHeight = stableHeight,
            visibleWidth = visibleWidth,
            visibleHeight = visibleHeight,
            controlsSlotHeight = 0,
            maxHeightPx = controlsMaxHeightPx,
            layerZIndex = ChromeLayerZIndex,
            onMeasured = { size ->
                if (size.height != controlsSlotHeight) onControlsMeasured(size.height)
            },
            onCommitted = onPlacementCommitted,
        ) { dragModifier ->
            TerminalControls(
                terminal = terminal,
                keysOpen = keysOpen,
                onToggleKeys = onToggleKeys,
                onIntent = onIntent,
                dragModifier = dragModifier,
                scrollable = visibleHeight > 0 && controlsSlotHeight >= visibleHeight,
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
                layerZIndex = ChromeLayerZIndex,
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
        // Floating Keys reserves nothing: it overlays the pane at its remembered size,
        // moves by the same recognized header long-press, and resizes from its corner
        // grip. Docking state is the only thing its corner toggle changes.
        if (keysOpen && !keysLayout.docked) {
            FloatingKeys(
                terminal = terminal,
                keysLayout = keysLayout,
                status = if (debugInputMessagingEnabled) status else null,
                onKey = onKey,
                onPaste = onPaste,
                onIntent = onIntent,
                placement = placement,
                orientation = orientation,
                stableWidth = stableWidth,
                stableHeight = stableHeight,
                visibleWidth = visibleWidth,
                visibleHeight = visibleHeight,
                logicalWidthPx = logicalKeysWidthPx,
                logicalMaxHeightPx = logicalKeysMaxHeightPx,
                layerZIndex = FloatingKeysLayerZIndex,
                onPlacementCommitted = onPlacementCommitted,
            )
        }
    }
}

/**
 * The Keys panel as a bottom-docked band: a real sibling of the pane that reserves its
 * own measured height and never moves, so its header is not a drag region here.
 *
 * [maxHeight] is the caller's current available extent minus the control strip's
 * independently measured footprint, so a band can never take the area the strip needs;
 * within that bound the band measures its own natural height, and the panel's content
 * stays scrollable. No fixed floor or split of the layer participates.
 */
@Composable
private fun DockedKeys(
    terminal: TerminalUiState,
    status: String?,
    onKey: (TerminalKeyRequest) -> Unit,
    onPaste: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
    maxHeight: Dp,
    onPopOut: () -> Unit,
) {
    // The docking toggle belongs to the panel header, so it shares the header's scroll:
    // when the header scrolls away the toggle scrolls and clips with it instead of
    // standing still over key targets that moved up underneath it.
    val keysScroll = rememberScrollState()
    Box(Modifier.fillMaxWidth().heightIn(max = maxHeight)) {
        TerminalKeysPanel(
            modifier = Modifier.fillMaxWidth(),
            terminal = terminal,
            status = status,
            onKey = onKey,
            onPaste = onPaste,
            onIntent = onIntent,
            headerEndInset = KeysCornerControl,
            scrollState = keysScroll,
        )
        KeysDockingControl(
            docked = true,
            scrollOffset = keysScroll.value,
            onClick = onPopOut,
            modifier = Modifier.align(Alignment.TopEnd),
        )
    }
}

/**
 * The Keys panel while floating: an overlay that reserves no pane area.
 *
 * It holds one interactive Keys subtree, laid out at the panel's own logical reference
 * ([logicalWidthPx] by at most [logicalMaxHeightPx]) and scaled into its frame by an
 * independent horizontal and vertical factor, so the contents fill the frame edge to edge
 * at any frame shape with no re-wrap, no reflow, and no blank letterbox. Text, buttons,
 * padding, spacing, and the interior corner controls all scale with that one layout.
 *
 * The logical footprint is the panel's own resize floor, so the scale never drops below 1
 * and every logical target — already at least [KeysCornerControl] in the layout — keeps at
 * least [KeysCornerControl] of real physical size: an overshooting grip drag stops instead
 * of shrinking a key. The floor is that measured footprint, not a named constant, and it
 * and the frame are display values only.
 *
 * Its size comes from the remembered `TerminalKeysFloatingSize` — permille of the stable
 * layer's own extent — or from the logical footprint when nothing was ever resized. Either
 * way it never measures past the pane's current visible extent, and that display-only
 * adaptation never writes a size, so a null remembered size stays null and a remembered
 * size is never normalized. A resize is transient until the corner grip's drag completes:
 * a cancel, a rotation, or an inset change leaves the remembered size exactly as it was.
 * Only a completed drag, resize, or docking toggle publishes placement. The grip's own
 * 48dp is reserved as a band inside the panel, so it never covers scrollable key content
 * at any scroll position, and the panel keeps its own scroll: content past the logical
 * viewport stays scroll-reachable inside the frame.
 *
 * Because the layout is a scaled placement layer, the pointer deltas its own detectors
 * report are in the layout's logical units. The move and resize gestures multiply them by
 * the same factors, so a physical drag moves the panel and its frame by the distance the
 * finger actually travelled rather than by a transformed magnification of it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FloatingKeys(
    terminal: TerminalUiState,
    keysLayout: TerminalKeysLayout,
    status: String?,
    onKey: (TerminalKeyRequest) -> Unit,
    onPaste: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
    placement: TerminalOverlayPlacement,
    orientation: TerminalOverlayOrientation,
    stableWidth: Int,
    stableHeight: Int,
    visibleWidth: Int,
    visibleHeight: Int,
    logicalWidthPx: Int,
    logicalMaxHeightPx: Int,
    layerZIndex: Float,
    onPlacementCommitted: (TerminalOverlayPlacement) -> Unit,
) {
    var resizingPx by remember(orientation) { mutableStateOf<IntSize?>(null) }
    var measuredPx by remember { mutableStateOf(IntSize.Zero) }
    // The measured size of the one logical Keys layout. Display-only: it is never saved,
    // and it is measured against the reference above rather than against the frame, so
    // neither a remembered size nor a shrunk frame can redefine it.
    var logicalPx by remember(orientation) { mutableStateOf(IntSize.Zero) }
    // The docking toggle belongs to the panel header, so it shares the header's scroll and
    // clips with it rather than standing still over key targets scrolled up underneath it.
    val keysScroll = rememberScrollState()
    val logical = logicalPx
    val minimum = logical
    val maximum = IntSize(visibleWidth, visibleHeight)
    val rememberedPx = TerminalDockGeometry.floatingSizePx(keysLayout.floatingSize, stableWidth, stableHeight)
    // The frame this panel actually shows. Before the logical layout has been measured
    // there is no frame to claim; from the first measured frame on, the panel is at least
    // its own logical footprint and never larger than the visible extent.
    val sizePx = if (logical == IntSize.Zero) {
        null
    } else {
        TerminalDockGeometry.clampFloatingSize(
            resizingPx ?: rememberedPx ?: logical,
            maximum = maximum,
            minimum = minimum,
        )
    }
    // The same factors the scaled layout applies, in the same axes, for the gestures that
    // live inside that layout.
    val contentScale = if (sizePx != null && logical.width > 0 && logical.height > 0) {
        Offset(sizePx.width.toFloat() / logical.width, sizePx.height.toFloat() / logical.height)
    } else {
        Offset(1f, 1f)
    }
    val currentStart = rememberUpdatedState(if (measuredPx != IntSize.Zero) measuredPx else sizePx ?: IntSize.Zero)
    val currentMaximum = rememberUpdatedState(maximum)
    val currentMinimum = rememberUpdatedState(minimum)
    val currentScale = rememberUpdatedState(contentScale)
    val currentStable = rememberUpdatedState(IntSize(stableWidth, stableHeight))
    val currentPlacement = rememberUpdatedState(placement)
    val currentLayout = rememberUpdatedState(keysLayout)
    val currentCommit = rememberUpdatedState(onPlacementCommitted)
    val resizeModifier = Modifier.pointerInput(orientation) {
        // The size the gesture started from is read once, and every per-event delta is
        // accumulated onto it, so the finished size is the pointer's total movement
        // rather than the last event's delta and cannot compound on a growth this same
        // drag already applied. The grip sits inside the scaled layout, so its deltas
        // arrive in logical units and are converted to the frame's own units here.
        var startPx = IntSize.Zero
        var accumulated = Offset.Zero
        var started = false
        detectDragGestures(
            onDragStart = {
                startPx = currentStart.value
                accumulated = Offset.Zero
                started = true
            },
            onDragCancel = {
                started = false
                accumulated = Offset.Zero
                resizingPx = null
            },
            onDragEnd = {
                val finished = resizingPx
                started = false
                accumulated = Offset.Zero
                resizingPx = null
                if (finished != null) {
                    val stable = currentStable.value
                    val committed = currentLayout.value.copy(
                        floatingSize = TerminalDockGeometry.toFloatingSize(finished, stable.width, stable.height),
                    )
                    currentCommit.value(
                        currentPlacement.value.withKeysLayout(orientation, committed),
                    )
                }
            },
            onDrag = { change, dragAmount ->
                if (started) {
                    change.consume()
                    val scale = currentScale.value
                    accumulated += Offset(dragAmount.x * scale.x, dragAmount.y * scale.y)
                    resizingPx = TerminalDockGeometry.resizeFloatingSize(
                        from = startPx,
                        drag = accumulated,
                        maximum = currentMaximum.value,
                        minimum = currentMinimum.value,
                    )
                }
            },
        )
    }
    PlaceableOverlay(
        overlay = TerminalOverlay.KEYS,
        placement = placement,
        orientation = orientation,
        stableWidth = stableWidth,
        stableHeight = stableHeight,
        visibleWidth = visibleWidth,
        visibleHeight = visibleHeight,
        controlsSlotHeight = 0,
        sizePx = sizePx,
        contentScale = contentScale,
        // Below the control strip and the notice surface, exactly as before docking:
        // an overlapping panel never swallows a chrome tap.
        layerZIndex = layerZIndex,
        onMeasured = { size -> if (size != measuredPx) measuredPx = size },
        onCommitted = onPlacementCommitted,
    ) { dragModifier ->
        // One interactive subtree, and the corner controls that belong to it: they are
        // part of the scaled layout, so they scale with the keys they sit beside and keep
        // the same header and bottom-edge relation at any frame shape.
        Box(
            Modifier.floatingKeysScaledFrame(
                framePx = sizePx,
                logicalWidthPx = logicalWidthPx,
                logicalMaxHeightPx = logicalMaxHeightPx,
                onLogicalSize = { size -> if (size != logicalPx) logicalPx = size },
            ),
        ) {
            TerminalKeysPanel(
                modifier = Modifier.fillMaxWidth(),
                terminal = terminal,
                // The Keys panel's duplicate of the raw status is part of the same
                // diagnostic presentation, so it goes with the surface.
                status = status,
                onKey = onKey,
                onPaste = onPaste,
                onIntent = onIntent,
                dragModifier = dragModifier,
                headerEndInset = KeysCornerControl,
                reservedBottomBand = KeysCornerControl,
                scrollState = keysScroll,
            )
            KeysDockingControl(
                docked = false,
                scrollOffset = keysScroll.value,
                onClick = {
                    onPlacementCommitted(
                        placement.withKeysLayout(orientation, keysLayout.copy(docked = true)),
                    )
                },
                modifier = Modifier.align(Alignment.TopEnd),
            )
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .size(KeysCornerControl)
                    .testTag(KeysResizeGripTag)
                    .then(resizeModifier),
                contentAlignment = Alignment.BottomEnd,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_terminal_keys_resize),
                    contentDescription = stringResource(R.string.terminal_keys_resize),
                    modifier = Modifier.size(24.dp),
                )
            }
        }
    }
}

/**
 * The Keys corner toggle. It is icon-only and sits inside the panel's existing
 * footprint: it adds no word, no row, and no height, and it changes only docking. It
 * never opens or closes the panel and never touches the on-screen keyboard. It belongs to
 * the panel header, so it is offset and clipped by the header's own scroll offset and can
 * never sit over a key row the header has scrolled past.
 */
@Composable
private fun KeysDockingControl(
    docked: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    scrollOffset: Int = 0,
) {
    Box(modifier.size(KeysCornerControl).clipToBounds()) {
        IconButton(
            onClick = onClick,
            modifier = Modifier.offset { IntOffset(0, -scrollOffset) }.size(KeysCornerControl),
        ) {
            Icon(
                painter = painterResource(
                    if (docked) R.drawable.ic_terminal_keys_pop_out else R.drawable.ic_terminal_keys_pop_in,
                ),
                contentDescription = stringResource(
                    if (docked) R.string.terminal_keys_pop_out else R.string.terminal_keys_pop_in,
                ),
                modifier = Modifier.size(24.dp),
            )
        }
    }
}

/**
 * Position one wrapping overlay and own its long-press drag.
 *
 * The wrapper never fills the layer unless [sizePx] gives it an explicit size; only the
 * content [content] touches, so no background hit target is introduced. The long-press
 * detector consumes movement only after the pointer has crossed the touch slop, which
 * cancels a child button click exactly when a drag is recognized while leaving short
 * taps untouched.
 *
 * [contentScale] is the independent horizontal and vertical factor a scaled subtree such
 * as the floating Keys panel applies to its own contents. A detector that lives inside
 * that subtree reports its deltas in the subtree's logical units, so they are converted
 * back through the same factors here: the overlay then follows the pointer's real physical
 * travel instead of a magnified or shrunken transformation of it, in either axis
 * independently. An unscaled overlay passes an unscaled [Offset] and behaves exactly as
 * before.
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
    sizePx: IntSize? = null,
    layerZIndex: Float = 0f,
    contentScale: Offset = Offset(1f, 1f),
    onCommitted: (TerminalOverlayPlacement) -> Unit,
    onMeasured: (IntSize) -> Unit = {},
    content: @Composable (Modifier) -> Unit,
) {
    var size by remember(overlay) { mutableStateOf(IntSize.Zero) }
    var dragPoint by remember(overlay, orientation) { mutableStateOf<TerminalOverlayPoint?>(null) }
    val layoutWidth = sizePx?.width ?: size.width
    val layoutHeight = sizePx?.height
        ?: (if (maxHeightPx != null) size.height.coerceAtMost(maxHeightPx).coerceAtLeast(0) else size.height)
    val position = placement.position(overlay, orientation)
    val resolved = position?.let { explicit ->
        TerminalOverlayGeometry.resolve(stableWidth, stableHeight, layoutWidth, layoutHeight, explicit)
    } ?: TerminalOverlayGeometry.resolveDefault(
        overlay = overlay,
        stableWidth = stableWidth,
        stableHeight = stableHeight,
        overlayWidth = layoutWidth,
        overlayHeight = layoutHeight,
        controlsSlotHeight = controlsSlotHeight,
    )
    val basePoint = TerminalOverlayGeometry.clampToVisible(
        point = resolved,
        visibleWidth = visibleWidth,
        visibleHeight = visibleHeight,
        overlayWidth = layoutWidth,
        overlayHeight = layoutHeight,
    )
    val currentBase = rememberUpdatedState(basePoint)
    val currentPlacement = rememberUpdatedState(placement)
    val currentLayoutSize = rememberUpdatedState(IntSize(layoutWidth, layoutHeight))
    val currentCommit = rememberUpdatedState(onCommitted)
    val currentScale = rememberUpdatedState(contentScale)
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
                if (moved && finished != null) {
                    val measured = currentLayoutSize.value
                    val committed = TerminalOverlayGeometry.toPosition(
                        point = finished,
                        stableWidth = stableWidth,
                        stableHeight = stableHeight,
                        overlayWidth = measured.width,
                        overlayHeight = measured.height,
                    )
                    currentCommit.value(currentPlacement.value.withPosition(overlay, orientation, committed))
                }
                moved = false
                working = null
                dragPoint = null
            },
            onDrag = { change, dragAmount ->
                val scale = currentScale.value
                val physical = Offset(dragAmount.x * scale.x, dragAmount.y * scale.y)
                accumulated += physical
                if (!moved && accumulated.getDistance() > viewConfiguration.touchSlop) moved = true
                if (moved) {
                    change.consume()
                    val measured = currentLayoutSize.value
                    val start = working ?: currentBase.value
                    val next = TerminalOverlayGeometry.clampToVisible(
                        point = TerminalOverlayPoint(
                            x = start.x + physical.x.roundToInt(),
                            y = start.y + physical.y.roundToInt(),
                        ),
                        visibleWidth = visibleWidth,
                        visibleHeight = visibleHeight,
                        overlayWidth = measured.width,
                        overlayHeight = measured.height,
                    )
                    working = next
                    dragPoint = next
                }
            },
        )
    }
    val point = dragPoint ?: basePoint
    val sizeConstraint = when {
        sizePx != null -> {
            val width = with(LocalDensity.current) { sizePx.width.toDp() }
            val height = with(LocalDensity.current) { sizePx.height.toDp() }
            Modifier.size(width, height)
        }
        maxHeightPx != null -> {
            val maxHeight = with(LocalDensity.current) { maxHeightPx.toDp() }
            Modifier.heightIn(max = maxHeight)
        }
        else -> Modifier
    }
    Box(
        Modifier
            .offset { IntOffset(point.x, point.y) }
            .zIndex(layerZIndex)
            .then(sizeConstraint)
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

/**
 * Only the terminal Activity window opts out of both OS resize and OS pan, because
 * this screen owns the one IME reservation: the pane column pads by the platform's
 * reported occluding ime inset. Letting the OS resize or pan as well would subtract or
 * shift the same keyboard area twice. Separate dialog/sheet windows retain their own
 * IME behavior; leaving the route restores the Activity's original mode for Add Host
 * and other forms.
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
 * The Keys panel: the same native key toolbar, docked as a real bottom band or floating
 * as an overlay, exactly as the caller places it.
 *
 * Sticky modifiers are held state, cleared across targets, coverage, and
 * backgrounding by the controller. Every key button submits a semantic
 * [TerminalControlKey] through the slot; nothing here builds an escape sequence or
 * fakes a hardware event. It also carries the session title and host context that
 * the removed app bar used to show.
 *
 * Docked, this band reserves its own measured height and the pane above it shrinks by
 * that much; floating, it reserves nothing. Either way its content is scrollable, so a
 * panel taller than its slot never loses an action, and [headerEndInset] keeps the
 * header text clear of the corner docking control the caller draws over it.
 * [dragModifier] is the recognized move gesture, supplied only while floating.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TerminalKeysPanel(
    modifier: Modifier = Modifier,
    terminal: TerminalUiState,
    status: String?,
    onKey: (TerminalKeyRequest) -> Unit,
    onPaste: () -> Unit,
    onIntent: (ClientIntent) -> Unit,
    dragModifier: Modifier = Modifier,
    headerEndInset: Dp = 0.dp,
    reservedBottomBand: Dp = 0.dp,
    scrollState: ScrollState = rememberScrollState(),
) {
    val suspended = terminal.coverage.suspendsTerminalInput || !terminal.inputReady
    val held = terminal.modifiers

    Surface(
        modifier = modifier.ownsTouches(),
        color = MaterialTheme.colorScheme.surface.copy(alpha = OVERLAY_ALPHA),
        tonalElevation = 3.dp,
    ) {
        Column(
            modifier = Modifier
                // The floating panel reserves the resize grip's 48dp as a band outside
                // its scrollable viewport, so the corner grip never covers key content at
                // any scroll position and every key keeps a complete 48dp target. Docked
                // and uncapped callers pass zero and are laid out exactly as before.
                .padding(bottom = reservedBottomBand)
                .verticalScroll(scrollState)
                .padding(horizontal = 6.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // The existing title/host header is the floating panel's drag region. It
            // keeps both context fields and adds no row, grip, or height; only the
            // trailing inset for the existing corner control narrows the text.
            Column(
                modifier = dragModifier.padding(end = headerEndInset),
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
