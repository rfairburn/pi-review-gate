package io.github.rfairburn.pireviewgate.ui.client

import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntSize

/**
 * Lay one interactive subtree out at its own logical size, then scale it into the frame the
 * caller resolved for this node with an independent horizontal and vertical factor.
 *
 * The subtree is measured against [logicalWidthPx] and [logicalMaxHeightPx] only — never
 * against the frame — so resizing the frame cannot re-wrap, reflow, or otherwise redefine
 * the layout it holds, and a remembered frame size never becomes the measuring reference.
 * Those references come from the extent the pane can actually show, and the subtree's own
 * measured size is reported through [onLogicalSize], so a caller that clamps its frame to
 * that footprint cannot shrink its own measuring reference through the frame it just shrank.
 *
 * [framePx] is the frame to fill and is authoritative: a Box loosens the constraints it
 * hands its children, so a node left to infer the frame from its own constraints would keep
 * scaling at 1 and leave the frame partly empty. Falling back to exact incoming constraints
 * keeps the modifier honest for any caller that does propagate them. With no frame at all —
 * the first frame, before one has been resolved — the node lays itself out at the logical
 * size, which is scale 1: the natural footprint is the smallest frame, so every logical
 * touch target keeps its own physical size.
 *
 * The contents are placed at the frame's own origin and scaled from there, so they reach it
 * edge to edge with no letterbox and no spare space. The scale is a placement layer, so
 * drawing, hit testing, and semantics bounds all move with it. Pointer deltas delivered to
 * detectors inside the subtree come back in the subtree's own logical units, which is why
 * the caller multiplies its move and resize gestures by the same factors before applying
 * them to the frame.
 */
internal fun Modifier.floatingKeysScaledFrame(
    framePx: IntSize?,
    logicalWidthPx: Int,
    logicalMaxHeightPx: Int,
    onLogicalSize: (IntSize) -> Unit,
): Modifier = layout { measurable, constraints ->
    val reference = if (logicalWidthPx > 0 && logicalMaxHeightPx > 0) {
        Constraints(maxWidth = logicalWidthPx, maxHeight = logicalMaxHeightPx)
    } else {
        constraints.copy(minWidth = 0, minHeight = 0)
    }
    val placeable = measurable.measure(reference)
    val logical = IntSize(placeable.width, placeable.height)
    val frameWidth = when {
        framePx != null -> framePx.width
        constraints.hasFixedWidth -> constraints.maxWidth
        else -> logical.width
    }
    val frameHeight = when {
        framePx != null -> framePx.height
        constraints.hasFixedHeight -> constraints.maxHeight
        else -> logical.height
    }
    val horizontal = if (logical.width > 0) frameWidth.toFloat() / logical.width else 1f
    val vertical = if (logical.height > 0) frameHeight.toFloat() / logical.height else 1f
    onLogicalSize(logical)
    layout(frameWidth, frameHeight) {
        placeable.placeWithLayer(0, 0) {
            transformOrigin = TransformOrigin(0f, 0f)
            scaleX = horizontal
            scaleY = vertical
        }
    }
}
