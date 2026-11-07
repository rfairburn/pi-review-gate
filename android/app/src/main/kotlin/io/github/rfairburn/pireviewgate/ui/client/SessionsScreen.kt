package io.github.rfairburn.pireviewgate.ui.client

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.LocalPinnableContainer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import io.github.rfairburn.pireviewgate.R
import io.github.rfairburn.pireviewgate.core.client.ui.AgentActivity
import io.github.rfairburn.pireviewgate.core.client.ui.CapabilityStatus
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientUiState
import io.github.rfairburn.pireviewgate.core.client.ui.EmptyHostRow
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.InputObservation
import io.github.rfairburn.pireviewgate.core.client.ui.RenameTarget
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.SessionActionTarget
import io.github.rfairburn.pireviewgate.core.client.ui.SessionCardBackground
import io.github.rfairburn.pireviewgate.core.client.ui.SessionCardDrag
import io.github.rfairburn.pireviewgate.core.client.ui.SessionDragHover
import io.github.rfairburn.pireviewgate.core.client.ui.SessionDragItemSpan
import io.github.rfairburn.pireviewgate.core.client.ui.SessionIdentityIndex
import io.github.rfairburn.pireviewgate.core.client.ui.SessionRowKey
import io.github.rfairburn.pireviewgate.core.client.ui.SessionStatusStyle
import io.github.rfairburn.pireviewgate.core.client.ui.SessionStatusTheme
import io.github.rfairburn.pireviewgate.core.client.ui.SessionUiState
import io.github.rfairburn.pireviewgate.core.client.ui.UiCoverage
import io.github.rfairburn.pireviewgate.core.client.ui.sessionCardAccessibleMoves
import io.github.rfairburn.pireviewgate.core.client.ui.sessionCardBackground
import io.github.rfairburn.pireviewgate.core.client.ui.sessionCardStatusRoles
import io.github.rfairburn.pireviewgate.core.client.ui.sessionDragEdgeScroll
import io.github.rfairburn.pireviewgate.core.client.ui.sessionDragHover
import io.github.rfairburn.pireviewgate.core.client.ui.style
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteNativePersistence
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire

/**
 * The unified session list.
 *
 * One list across every configured host, in saved host order and then in each
 * owner's own row order, so a row stays where its owner put it. Every card names the
 * host it came from because two owners may report the same row id and only the
 * qualifying triple tells them apart.
 *
 * Hosts that contribute no rows stay visible with the honest reason: never reported,
 * positively empty, or retained but stale. Nothing here is sample data, and an
 * unknown count is never rendered as zero.
 *
 * Session cards reorder by long-press drag, like the desktop sidebar. The drag is a
 * local preview only; a valid release sends exactly one existing
 * [ClientIntent.MoveSessionRow], which updates this viewer's local presentation
 * order. A drag never selects, opens, or acts on a row, and anything that changes
 * which rows are on screen, covers the list, or retires the window cancels it with
 * no intent.
 */
@Composable
fun SessionsScreen(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
    listState: LazyListState,
    modifier: Modifier = Modifier,
) {
    val sessions = state.sessions
    val emptyHosts = state.emptyHosts
    val holder = remember { SessionDragHolder() }

    val covered = state.dialogs.hasModal
    val windowFocused = LocalWindowInfo.current.isWindowFocused
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    // Coverage, a modal, or a window that is no longer the focused, resumed window
    // all retire a drag: none of them is an ordinary roster update.
    val dragBlocked = covered ||
        state.coverage != UiCoverage.NONE ||
        !windowFocused ||
        !lifecycleState.isAtLeast(Lifecycle.State.RESUMED)
    val hostLive: (SessionRowKey) -> Boolean = { key -> isLiveHost(state.hostState(key.hostId)) }

    val current = holder.drag
    val dragValid = current != null &&
        !dragBlocked &&
        hostLive(current.source) &&
        current.stillValidFor(sessions)
    // The preview is local and derived from the real order every composition, so a
    // status or count update simply redraws it; a cancelled drag shows the real order.
    val displayRows = if (dragValid) current!!.previewRows(sessions) else sessions
    val itemKeys: Map<Any, SessionRowKey> =
        displayRows.associate<SessionUiState, Any, SessionRowKey> { sessionItemKey(it) to SessionRowKey.of(it) }
    val cancelInvalid = current != null && !dragValid
    val identityIndex = remember(sessions) { SessionIdentityIndex(sessions) }

    SideEffect {
        // Gesture callbacks read only these latest committed facts, never values
        // captured when the gesture began.
        holder.rows = sessions
        holder.displayRows = displayRows
        holder.itemKeys = itemKeys
        holder.blocked = dragBlocked
        holder.hostLive = hostLive
        holder.onIntent = onIntent
        holder.listState = listState
        if (cancelInvalid && holder.drag === current) holder.cancel(null)
    }

    // Edge auto-scroll reaches rows that are not on screen in a long list. Each step
    // re-resolves the drop position against the frame drawn after the scroll.
    val dragging = dragValid
    val density = LocalDensity.current
    val edgePx = with(density) { DRAG_EDGE.toPx() }
    val maxStepPx = with(density) { DRAG_MAX_STEP.toPx() }
    LaunchedEffect(dragging, listState) {
        if (!dragging) return@LaunchedEffect
        while (true) {
            withFrameNanos { }
            val pointer = holder.pointer ?: continue
            val size = holder.listSize() ?: continue
            // Beside the list (left or right) is outside: no scroll from there.
            val step = sessionDragEdgeScroll(pointer.x, pointer.y, size.width, size.height, edgePx, maxStepPx)
            if (step == 0f) continue
            if (listState.scrollBy(step) != 0f) {
                withFrameNanos { }
                holder.retargetAt(holder.pointer)
            }
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        // One header call site in every state, so New session and Saved conversations
        // are always in the same place — even with no rows or no hosts — and an open
        // chooser survives the list appearing or emptying. It sits outside the list,
        // so drag coordinates, edge scrolling, and hover spans stay measured against
        // the list container alone.
        SessionsHeader(state = state, onIntent = onIntent, dragActive = dragValid)
        if (sessions.isEmpty() && emptyHosts.isEmpty()) {
            EmptyMessage(
                text = stringResource(R.string.sessions_empty_no_hosts),
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(16.dp),
            )
        } else LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .onGloballyPositioned { holder.listCoordinates = it },
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(displayRows, key = { sessionItemKey(it) }) { row ->
                val key = SessionRowKey.of(row)
                SessionCard(
                    row = row,
                    host = state.hostState(row.hostId),
                    orderedRows = sessions,
                    identityIndex = identityIndex,
                    covered = covered,
                    dragActive = dragValid,
                    isDragSource = dragValid && current?.source == key,
                    holder = holder,
                    onIntent = onIntent,
                )
            }
            items(emptyHosts, key = { "empty-${it.host.host.id.value}" }) { empty ->
                EmptyHostCard(empty = empty, onIntent = onIntent)
            }
        }
    }
}

/**
 * The session list's one entry point for starting and finding conversations.
 *
 * New session opens the existing create form, whose owner selector starts empty: no
 * host is guessed here. Saved conversations opens a host chooser listing every
 * configured host with its endpoint and current eligibility; only a host that is
 * connected *and* positively acknowledged Saved support can be chosen, and choosing
 * it only navigates to the dedicated Saved screen for that exact host id. Nothing
 * here lists, searches, resumes, or creates — those stay behind the Saved screen's
 * and create form's own explicit controls.
 *
 * The chooser reports menu coverage while it is open, like every other menu, so a
 * session-card drag is cancelled and terminal proofs retire; both controls are
 * disabled while a drag is in progress.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionsHeader(
    state: ClientUiState,
    onIntent: (ClientIntent) -> Unit,
    dragActive: Boolean,
) {
    var savedMenuOpen by remember { mutableStateOf(false) }
    // The click callback re-reads the latest committed hosts: an item drawn for a host
    // that has since gone, or stopped being eligible, refuses instead of navigating.
    val latestHosts by rememberUpdatedState(state.hostStates)
    val latestOnIntent by rememberUpdatedState(onIntent)

    fun closeSavedMenu() {
        if (!savedMenuOpen) return
        savedMenuOpen = false
        latestOnIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
    }

    // A drag that starts, or anything else that disables the header while the chooser
    // is open, closes it and clears its coverage rather than leaving either behind.
    if (dragActive && savedMenuOpen) SideEffect { closeSavedMenu() }
    // Leaving the screen with the chooser open retracts its menu coverage too.
    DisposableEffect(Unit) {
        onDispose { if (savedMenuOpen) latestOnIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE)) }
    }

    FlowRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Button(
            onClick = { onIntent(ClientIntent.RequestSessionCreate) },
            enabled = !dragActive,
        ) { Text(stringResource(R.string.action_create_session)) }
        Box {
            OutlinedButton(
                onClick = {
                    savedMenuOpen = true
                    onIntent(ClientIntent.UiCoverageChanged(UiCoverage.OPEN_MENU))
                },
                enabled = !dragActive,
            ) { Text(stringResource(R.string.action_saved)) }
            DropdownMenu(
                expanded = savedMenuOpen,
                onDismissRequest = { closeSavedMenu() },
            ) {
                // Plain text, not items: neither the prompt nor the no-host notice is
                // something to choose.
                Text(
                    text = stringResource(R.string.sessions_header_saved_chooser_title),
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
                if (state.hostStates.isEmpty()) {
                    Text(
                        text = stringResource(R.string.sessions_header_saved_no_hosts),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
                state.hostStates.forEach { host ->
                    // The id is frozen into this item; never a position or a title.
                    val hostId = host.host.id
                    key(hostId.value) {
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text(
                                        stringResource(
                                            R.string.sessions_header_saved_host,
                                            host.host.label.value,
                                            host.host.endpoint.displayText(),
                                        ),
                                    )
                                    Text(
                                        text = savedChoiceStatusText(host),
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                            },
                            enabled = host.canBrowseSaved,
                            onClick = {
                                val current = latestHosts.firstOrNull { it.host.id == hostId }
                                if (current?.canBrowseSaved != true) return@DropdownMenuItem
                                closeSavedMenu()
                                latestOnIntent(ClientIntent.ShowSaved(hostId))
                            },
                        )
                    }
                }
            }
        }
    }
}

/** Why one host can or cannot be chosen for Saved conversations, as currently known. */
@Composable
private fun savedChoiceStatusText(host: HostUiState): String = when {
    host.canBrowseSaved -> stringResource(R.string.sessions_header_saved_available)
    host.connection != HostConnectionState.CONNECTED ->
        stringResource(R.string.sessions_header_saved_not_connected, connectionText(host.connection))
    host.capabilities.statusOf(RosterWire.SAVED_CAPABILITY) == CapabilityStatus.UNSUPPORTED ->
        stringResource(R.string.sessions_header_saved_unsupported)
    else -> stringResource(R.string.sessions_header_saved_unconfirmed)
}

@Composable
private fun connectionText(state: HostConnectionState): String = when (state) {
    HostConnectionState.DISCONNECTED -> stringResource(R.string.connection_disconnected)
    HostConnectionState.CONNECTING -> stringResource(R.string.connection_connecting)
    HostConnectionState.PAIRING -> stringResource(R.string.connection_pairing)
    HostConnectionState.RETRYING -> stringResource(R.string.connection_retrying)
    HostConnectionState.CONNECTED -> stringResource(R.string.connection_connected)
    HostConnectionState.ERROR -> stringResource(R.string.connection_error)
}

/** Distance from either list edge in which a drag auto-scrolls. */
private val DRAG_EDGE = 56.dp

/** Largest auto-scroll step per frame. */
private val DRAG_MAX_STEP = 18.dp

/** The stable lazy-list key of one session card: host, owner run, and row. */
private fun sessionItemKey(row: SessionUiState): String = "${row.hostId.value}|${row.hostRunId}|${row.rowId}"

/** The existing move eligibility: a connected host whose roster is current. */
private fun isLiveHost(host: HostUiState?): Boolean =
    host?.connection == HostConnectionState.CONNECTED && host.roster?.freshness == RosterFreshness.CURRENT

/**
 * The one in-flight session-card drag of this screen and the latest facts its gesture
 * callbacks may read.
 *
 * Only [drag] and [pointer] are snapshot state. Everything else is refreshed after
 * each committed composition, so a long-lived pointer handler never acts on rows,
 * eligibility, or an intent sink it captured earlier.
 */
private class SessionDragHolder {
    var drag by mutableStateOf<SessionCardDrag?>(null)

    /**
     * The pointer's full position in list-container coordinates while dragging. Both
     * axes are kept: leaving the list through its left or right side is outside.
     */
    var pointer by mutableStateOf<Offset?>(null)

    var rows: List<SessionUiState> = emptyList()
    var displayRows: List<SessionUiState> = emptyList()
    var itemKeys: Map<Any, SessionRowKey> = emptyMap()
    var blocked: Boolean = true
    var hostLive: (SessionRowKey) -> Boolean = { false }
    var onIntent: (ClientIntent) -> Unit = {}
    var listState: LazyListState? = null
    var listCoordinates: LayoutCoordinates? = null

    /** Identifies the gesture that owns [drag]; a stale gesture can neither move nor drop it. */
    private var gesture: Long = 0L

    fun listSize(): Size? = listCoordinates?.takeIf { it.isAttached }?.size?.let {
        Size(it.width.toFloat(), it.height.toFloat())
    }

    /** Begin a drag of [key] from a long press, or `null` when it may not move. */
    fun start(key: SessionRowKey, region: LayoutCoordinates?, local: Offset): Long? {
        if (drag != null || blocked) return null
        val next = SessionCardDrag.begin(rows, key, eligible = hostLive(key)) ?: return null
        gesture += 1
        drag = next
        pointer = toListPosition(region, local)
        return gesture
    }

    /** Pointer motion of gesture [token]: preview only, never an intent. */
    fun move(token: Long, region: LayoutCoordinates?, local: Offset) {
        if (token != gesture || drag == null) return
        val position = toListPosition(region, local)
        pointer = position
        retargetAt(position)
    }

    /** Re-resolve the drop position at [position] against the frame currently drawn. */
    fun retargetAt(position: Offset?) {
        val active = drag ?: return
        if (blocked || !active.stillValidFor(rows)) return
        drag = active.retarget(rows, if (position == null) SessionDragHover.Outside else hoverAt(position))
    }

    /** Release of gesture [token]: at most one [ClientIntent.MoveSessionRow]. */
    fun finish(token: Long) {
        if (token != gesture || drag == null) return
        // The release position decides: a release beside, above, or below the list
        // clears the target here, so it drops nothing.
        retargetAt(pointer)
        val finished = drag
        drag = null
        pointer = null
        if (finished == null || blocked || !hostLive(finished.source)) return
        val intent = finished.dropIntent(rows) ?: return
        onIntent(intent)
    }

    /** Cancel gesture [token] (or whatever drag is live when `null`) with no intent. */
    fun cancel(token: Long?) {
        if (token != null && token != gesture) return
        drag = null
        pointer = null
    }

    private fun toListPosition(region: LayoutCoordinates?, local: Offset): Offset? {
        val list = listCoordinates?.takeIf { it.isAttached } ?: return null
        val source = region?.takeIf { it.isAttached } ?: return null
        return list.localPositionOf(source, local)
    }

    private fun hoverAt(position: Offset): SessionDragHover {
        val state = listState ?: return SessionDragHover.Outside
        val size = listSize() ?: return SessionDragHover.Outside
        val info = state.layoutInfo
        // Item offsets start after the leading content padding; the container's own
        // top is at viewportStartOffset in that space.
        val spans = info.visibleItemsInfo.map { item ->
            val top = (item.offset - info.viewportStartOffset).toFloat()
            SessionDragItemSpan(itemKeys[item.key], top, top + item.size)
        }
        return sessionDragHover(
            position.x,
            position.y,
            size.width,
            size.height,
            spans,
            displayRows.lastOrNull()?.let { SessionRowKey.of(it) },
        )
    }
}

/** Holder for one drag region's latest layout coordinates; not composition state. */
private class RegionCoordinates {
    var value: LayoutCoordinates? = null
}

/**
 * A long-press drag region of one card.
 *
 * Only the card's non-interactive content carries this, never its buttons, so a press
 * meant for Open terminal or Actions can never start or end as a drag, and a drag can
 * never activate a control.
 */
@Composable
private fun sessionDragRegion(key: SessionRowKey, holder: SessionDragHolder): Modifier {
    val region = remember { RegionCoordinates() }
    val haptics by rememberUpdatedState(LocalHapticFeedback.current)
    return Modifier
        .onGloballyPositioned { region.value = it }
        .pointerInput(key, holder) {
            var token: Long? = null
            detectDragGesturesAfterLongPress(
                onDragStart = { offset: Offset ->
                    token = holder.start(key, region.value, offset)
                    if (token != null) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                },
                onDragEnd = { ->
                    token?.let { holder.finish(it) }
                    token = null
                },
                onDragCancel = { ->
                    token?.let { holder.cancel(it) }
                    token = null
                },
                onDrag = { change: PointerInputChange, _: Offset ->
                    val owned = token
                    if (owned != null) {
                        change.consume()
                        holder.move(owned, region.value, change.position)
                    }
                },
            )
        }
}

/**
 * One session card.
 *
 * The action menu is capability-gated and stale-gated: an unacknowledged capability
 * is never offered as support, and a row from a view the client is no longer being
 * fed is labelled stale rather than being treated as live. Opening the menu reports
 * menu coverage so terminal input is suspended and in-flight proofs retire.
 *
 * Reordering is by drag. The former Move up/Move down menu items remain available to
 * accessibility services as custom actions sending the same intent.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionCard(
    row: SessionUiState,
    host: HostUiState?,
    orderedRows: List<SessionUiState>,
    identityIndex: SessionIdentityIndex,
    covered: Boolean,
    dragActive: Boolean,
    isDragSource: Boolean,
    holder: SessionDragHolder,
    onIntent: (ClientIntent) -> Unit,
) {
    var expanded by remember(row.hostId, row.rowId) { mutableStateOf(false) }
    var menuOpen by remember(row.hostId, row.rowId) { mutableStateOf(false) }
    val capabilities: HostCapabilities = host?.capabilities ?: HostCapabilities.UNKNOWN
    val live = isLiveHost(host)
    val renameTarget = RenameTarget.of(row)
    val rowKey = SessionRowKey.of(row)
    // Opening the terminal selects a row for the controller to write, so it is
    // attributed to that row's own commit proof. The semantic key is the frozen target
    // as drawn: a row whose title or revision changed retires its previous standing
    // synchronously, while an unrelated host reporting changes nothing here.
    val selectTarget = SessionActionTarget.of(row)
    val selectGuard = rememberUiActionGuard(
        proof = row.selectProof,
        semanticKey = selectTarget,
        covered = covered,
    )

    // Accessible moves are addressed by presentation identities relative to the real
    // rendered neighbours, exactly as the removed menu items were; an ambiguous or
    // unnamed row or neighbour offers no action.
    val moves = sessionCardAccessibleMoves(orderedRows, row, identityIndex)
    val canMove = live && !covered && !dragActive
    val latestMoves by rememberUpdatedState(moves)
    val latestCanMove by rememberUpdatedState(canMove)
    val latestOnIntent by rememberUpdatedState(onIntent)
    val moveUpLabel = stringResource(R.string.action_move_up)
    val moveDownLabel = stringResource(R.string.action_move_down)
    val draggingLabel = stringResource(R.string.session_card_dragging)

    // Keep the dragged card composed while it is offscreen, so the gesture that owns
    // the drag is never torn down by the list recycling it.
    val pinnable = LocalPinnableContainer.current
    DisposableEffect(isDragSource, pinnable) {
        val handle = if (isDragSource) pinnable?.pin() else null
        onDispose { handle?.release() }
    }

    /** Closes the menu, reports the coverage change, then acts on the frozen row. */
    fun act(block: () -> Unit) {
        menuOpen = false
        onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
        block()
    }

    val dragRegionTitle = sessionDragRegion(rowKey, holder)
    val dragRegionBody = sessionDragRegion(rowKey, holder)
    val theme = SessionStatusTheme.forSurfaceLuminance(MaterialTheme.colorScheme.surface.luminance())
    val roles = sessionCardStatusRoles(row)

    // The action lives on the card itself, not in the overflow menu. A dropdown is a
    // popup that takes window focus, which retires the card's own commit standing; an
    // item inside it would then be spending a proof its window had already invalidated.
    ClientCard(
        modifier = Modifier
            .then(
                if (isDragSource) {
                    Modifier
                        .zIndex(1f)
                        .graphicsLayer {
                            shadowElevation = 8.dp.toPx()
                            scaleX = 1.02f
                            scaleY = 1.02f
                        }
                } else {
                    Modifier
                },
            )
            .semantics {
                if (isDragSource) stateDescription = draggingLabel
                val actions = ArrayList<CustomAccessibilityAction>(2)
                if (canMove && moves.moveUp != null) {
                    actions += CustomAccessibilityAction(moveUpLabel) {
                        val intent = latestMoves.moveUp
                        if (latestCanMove && intent != null) {
                            latestOnIntent(intent)
                            true
                        } else {
                            false
                        }
                    }
                }
                if (canMove && moves.moveDown != null) {
                    actions += CustomAccessibilityAction(moveDownLabel) {
                        val intent = latestMoves.moveDown
                        if (latestCanMove && intent != null) {
                            latestOnIntent(intent)
                            true
                        } else {
                            false
                        }
                    }
                }
                customActions = actions
            },
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f).then(dragRegionTitle)) {
                Text(text = row.displayTitle, style = MaterialTheme.typography.titleMedium)
                Text(
                    text = stringResource(R.string.session_host_context, row.hostLabel),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(
                onClick = {
                    row.selectProof?.let { proof ->
                        selectGuard.attempt {
                            onIntent(ClientIntent.EnterTerminal(selectTarget, proof))
                        }
                    }
                },
                enabled = live && row.selectProof != null && !dragActive,
                modifier = selectGuard.modifier,
            ) { Text(stringResource(R.string.action_open_terminal)) }
            Box {
                TextButton(
                    onClick = {
                        menuOpen = true
                        onIntent(ClientIntent.UiCoverageChanged(UiCoverage.OPEN_MENU))
                    },
                    enabled = !dragActive,
                ) { Text(stringResource(R.string.action_menu)) }
                DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = {
                        menuOpen = false
                        onIntent(ClientIntent.UiCoverageChanged(UiCoverage.NONE))
                    },
                ) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_rename)) },
                        enabled = live &&
                            capabilities.supports(RosterWire.RENAME_CAPABILITY) &&
                            renameTarget != null,
                        onClick = {
                            act { renameTarget?.let { onIntent(ClientIntent.RequestSessionRename(it)) } }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_close)) },
                        enabled = live && capabilities.supports(RosterWire.CLOSE_CAPABILITY),
                        onClick = {
                            act { onIntent(ClientIntent.RequestSessionClose(SessionActionTarget.of(row))) }
                        },
                    )
                    DropdownMenuItem(
                        text = {
                            Text(
                                stringResource(
                                    if (expanded) R.string.action_hide_details else R.string.action_show_details,
                                ),
                            )
                        },
                        onClick = { act { expanded = !expanded } },
                    )
                }
            }
        }

        Column(
            modifier = Modifier.fillMaxWidth().then(dragRegionBody),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StatusValueChip(
                    lifecycleChipText(row.metadata.lifecycle, row.metadata.exitCode, roles.lifecycle?.style(theme)),
                )
                StatusValueChip(agentChipText(row.agentActivity, roles.agent?.style(theme)))
                // Like the desktop card, input status is shown only for a starting or
                // alive row; the observation itself stays in the expanded details.
                if (row.metadata.lifecycle == RosterLifecycle.STARTING || row.metadata.lifecycle == RosterLifecycle.ALIVE) {
                    StatusValueChip(inputChipText(row.inputObservation, roles.input?.style(theme)))
                }
                if (row.stale) TextChip(stringResource(R.string.roster_stale))
            }

            Text(
                text = backgroundText(sessionCardBackground(row.metadata)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            row.metadata.error?.let { NoticeText(stringResource(R.string.session_error, it)) }

            if (expanded) SessionDetails(row)
        }
    }
}

/**
 * The text of one status chip: an optional neutral [label] followed by the observed
 * [value], with only the value carrying the desktop status color and weight.
 *
 * The label (for example "Agent" or "Input state") keeps the chip's ordinary content
 * color and weight; a `null` [style] leaves the value neutral too. The whole phrase
 * stays readable text, so color is never the only signal and accessibility services
 * read the same words a sighted reader sees.
 */
internal fun sessionStatusChipText(label: String?, value: String, style: SessionStatusStyle?): AnnotatedString =
    buildAnnotatedString {
        if (label != null) {
            append(label)
            append(' ')
        }
        if (style == null) {
            append(value)
        } else {
            withStyle(sessionStatusSpanStyle(style)) { append(value) }
        }
    }

/** The span one painted status value carries. */
internal fun sessionStatusSpanStyle(style: SessionStatusStyle): SpanStyle = SpanStyle(
    color = Color(OPAQUE or style.rgb),
    fontWeight = if (style.bold) FontWeight.Bold else FontWeight.Normal,
)

/** One non-interactive status chip with a neutral container. */
@Composable
private fun StatusValueChip(text: AnnotatedString) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceVariant,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

/** Opaque alpha for a `0xRRGGBB` palette value. */
private const val OPAQUE: Int = -0x1000000

/** Lifecycle: the owner's lifecycle word (with exit code) is itself the value. */
@Composable
private fun lifecycleChipText(lifecycle: RosterLifecycle, exitCode: Double?, style: SessionStatusStyle?): AnnotatedString {
    val base = when (lifecycle) {
        RosterLifecycle.STARTING -> stringResource(R.string.lifecycle_starting)
        RosterLifecycle.ALIVE -> stringResource(R.string.lifecycle_alive)
        RosterLifecycle.EXITED -> stringResource(R.string.lifecycle_exited)
        RosterLifecycle.ERROR -> stringResource(R.string.lifecycle_error)
    }
    return sessionStatusChipText(null, if (exitCode != null) "$base ${exitCode.toInt()}" else base, style)
}

/** Agent: neutral "Agent"/"Agent state" label, painted observed value. */
@Composable
private fun agentChipText(activity: AgentActivity?, style: SessionStatusStyle?): AnnotatedString {
    val agent = stringResource(R.string.session_card_agent_label)
    return when (activity) {
        AgentActivity.RUNNING -> sessionStatusChipText(agent, stringResource(R.string.session_card_value_running), style)
        AgentActivity.WAITING -> sessionStatusChipText(agent, stringResource(R.string.session_card_value_waiting), style)
        AgentActivity.IDLE -> sessionStatusChipText(agent, stringResource(R.string.session_card_value_idle), style)
        AgentActivity.UNKNOWN -> sessionStatusChipText(
            stringResource(R.string.session_card_agent_state_label),
            stringResource(R.string.session_card_value_unknown),
            style,
        )
        null -> sessionStatusChipText(null, stringResource(R.string.activity_not_applicable), null)
    }
}

/** Input: neutral "Input"/"Input state" label, painted observed value. */
@Composable
private fun inputChipText(observation: InputObservation, style: SessionStatusStyle?): AnnotatedString = when (observation) {
    InputObservation.PENDING -> sessionStatusChipText(
        stringResource(R.string.session_card_input_label),
        stringResource(R.string.session_card_value_pending),
        style,
    )
    InputObservation.NONE -> sessionStatusChipText(
        stringResource(R.string.session_card_input_label),
        stringResource(R.string.session_card_value_none),
        style,
    )
    InputObservation.UNKNOWN -> sessionStatusChipText(
        stringResource(R.string.session_card_input_state_label),
        stringResource(R.string.session_card_value_unknown),
        style,
    )
}

/** The desktop card's background line: activity-intent counts, unknown never zero. */
@Composable
private fun backgroundText(background: SessionCardBackground): String = when (background) {
    SessionCardBackground.Unknown -> stringResource(R.string.session_card_background_unknown)
    is SessionCardBackground.Counts -> {
        val unknown = stringResource(R.string.session_card_count_unknown)
        stringResource(
            R.string.session_card_background_counts,
            background.activeTasks?.toString() ?: unknown,
            background.activeShells?.toString() ?: unknown,
        )
    }
}

/**
 * Every current owner fact for one row except the durable roster slot.
 *
 * Nothing else is summarised away: workspace, live process, busy and pending-input
 * observations, the input surface, both ownership counts and both activity-intent
 * counts, exit code, error text, and the native identity with its epoch, name, and
 * persistence. Absences are spelled out instead of blanked. The roster slot is an
 * internal presentation identity and is not rendered on the card.
 */
@Composable
private fun SessionDetails(row: SessionUiState) {
    val metadata = row.metadata
    FactRow(stringResource(R.string.fact_row_label), metadata.label)
    FactRow(stringResource(R.string.fact_workspace), metadata.workspace)
    FactRow(
        stringResource(R.string.fact_live_process),
        if (metadata.hasLiveProcess) stringResource(R.string.value_yes) else stringResource(R.string.value_no),
    )
    FactRow(stringResource(R.string.fact_busy), triState(metadata.busy))
    FactRow(stringResource(R.string.fact_pending_input), triState(metadata.pendingInput))
    FactRow(
        stringResource(R.string.fact_input_surface),
        if (metadata.inputSurface) stringResource(R.string.value_yes) else stringResource(R.string.value_no),
    )
    FactRow(stringResource(R.string.fact_background_tasks), countOrUnknown(metadata.backgroundTasks))
    FactRow(stringResource(R.string.fact_background_shells), countOrUnknown(metadata.backgroundShells))
    FactRow(stringResource(R.string.fact_active_tasks), countOrUnknown(metadata.activeTasks))
    FactRow(stringResource(R.string.fact_active_shells), countOrUnknown(metadata.activeShells))
    FactRow(
        stringResource(R.string.fact_exit_code),
        metadata.exitCode?.let { it.toInt().toString() } ?: stringResource(R.string.value_unknown),
    )
    FactRow(stringResource(R.string.fact_error), metadata.error ?: stringResource(R.string.value_none))

    val native = metadata.nativeSession
    if (native == null) {
        NoticeText(stringResource(R.string.session_no_native))
    } else {
        FactRow(stringResource(R.string.fact_native_id), native.sessionId)
        FactRow(stringResource(R.string.fact_native_epoch), native.epoch.toString())
        FactRow(stringResource(R.string.fact_native_name), native.name)
        FactRow(stringResource(R.string.fact_native_persistence), persistenceLabel(native.persistence))
    }

    if (metadata.activity.isEmpty()) {
        NoticeText(stringResource(R.string.session_no_activity))
    } else {
        Text(stringResource(R.string.session_activity_lines), style = MaterialTheme.typography.labelLarge)
        metadata.activity.forEach { line -> NoticeText(line) }
    }
}

/** One host that currently contributes no rows, with the honest reason. */
@Composable
private fun EmptyHostCard(empty: EmptyHostRow, onIntent: (ClientIntent) -> Unit) {
    val host = empty.host
    ClientCard {
        Text(text = host.host.label.value, style = MaterialTheme.typography.titleMedium)
        Text(
            text = host.host.endpoint.displayText(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = when (empty) {
                is EmptyHostRow.NeverReported -> stringResource(R.string.empty_host_never_reported)
                is EmptyHostRow.ReportedEmpty -> stringResource(R.string.empty_host_reported_empty)
                is EmptyHostRow.Stale -> stringResource(R.string.empty_host_stale)
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        Button(onClick = { onIntent(ClientIntent.ConnectHost(host.host.id, host.pendingConnectToken)) }) {
            Text(stringResource(R.string.action_connect))
        }
    }
}

@Composable
private fun triState(value: Boolean?): String = when (value) {
    true -> stringResource(R.string.value_yes)
    false -> stringResource(R.string.value_no)
    null -> stringResource(R.string.value_unknown)
}

@Composable
private fun countOrUnknown(value: Long?): String =
    value?.toString() ?: stringResource(R.string.value_unknown)

@Composable
private fun persistenceLabel(persistence: RemoteNativePersistence?): String = when (persistence) {
    RemoteNativePersistence.SAVED -> stringResource(R.string.persistence_saved)
    RemoteNativePersistence.UNSAVED -> stringResource(R.string.persistence_unsaved)
    RemoteNativePersistence.UNKNOWN, null -> stringResource(R.string.value_unknown)
}
