package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * Coverage over the terminal, as observed by the UI that drew it.
 *
 * Any non-[NONE] coverage means the terminal must not accept user input until the
 * covering control is gone, and any proof minted underneath it is retired. The UI
 * reports coverage with [ClientIntent.UiCoverageChanged] because it is the only
 * component that knows what is actually on screen; the controller passes the value
 * to the terminal view, and the view's own input eligibility remains its own.
 */
public enum class UiCoverage {
    NONE,
    MODAL_DIALOG,
    OPEN_MENU,
    BOTTOM_SHEET,
    ;

    /** True when this coverage must suspend terminal input and retire terminal proofs. */
    public val suspendsTerminalInput: Boolean get() = this != NONE
}

/** Sticky toolbar modifiers. Each is a held state, not a delivered key. */
public enum class TerminalModifier {
    CTRL,
    ALT,
    SHIFT,
    META,
}

/**
 * One terminal key the toolbar can send.
 *
 * These are semantic key identities, not hardware scan codes and not encoded
 * packets: the toolbar never synthesizes a `KeyEvent` and never rewrites a wire
 * packet. The request reaches the renderer's own public submit API through the
 * injected terminal content slot, which owns encoding.
 */
public enum class TerminalControlKey {
    ESCAPE,
    TAB,
    BACKTAB,
    ARROW_UP,
    ARROW_DOWN,
    ARROW_LEFT,
    ARROW_RIGHT,
    HOME,
    END,
    PAGE_UP,
    PAGE_DOWN,
    INSERT,
    DELETE,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
}

/**
 * Which toolbar modifiers are currently held.
 *
 * Held state is transient by contract: it is cleared when the terminal target
 * changes, when a modal, menu, or sheet takes coverage, and when the app leaves the
 * foreground. A stale sticky Ctrl must never ride into the next session.
 */
public data class TerminalModifiers(
    public val ctrl: Boolean = false,
    public val alt: Boolean = false,
    public val shift: Boolean = false,
    public val meta: Boolean = false,
) {
    /** True when nothing is held. */
    public val isNone: Boolean get() = !ctrl && !alt && !shift && !meta

    /** Toggle one sticky modifier. */
    public fun toggled(modifier: TerminalModifier): TerminalModifiers = when (modifier) {
        TerminalModifier.CTRL -> copy(ctrl = !ctrl)
        TerminalModifier.ALT -> copy(alt = !alt)
        TerminalModifier.SHIFT -> copy(shift = !shift)
        TerminalModifier.META -> copy(meta = !meta)
    }

    /** True when [modifier] is currently held. */
    public fun holds(modifier: TerminalModifier): Boolean = when (modifier) {
        TerminalModifier.CTRL -> ctrl
        TerminalModifier.ALT -> alt
        TerminalModifier.SHIFT -> shift
        TerminalModifier.META -> meta
    }

    public companion object {
        /** Nothing held. */
        public val NONE: TerminalModifiers = TerminalModifiers()
    }
}

/**
 * One key request handed to the injected terminal content slot.
 *
 * The slot's owner routes it to the renderer's public submit API. This type carries
 * no bytes, no escape sequence, and no hardware event: encoding stays with the
 * renderer, which is the only component that knows the negotiated modes.
 */
public data class TerminalKeyRequest(
    public val key: TerminalControlKey,
    public val modifiers: TerminalModifiers = TerminalModifiers.NONE,
)

/**
 * The exact terminal this screen is showing.
 *
 * [selectionGeneration] is issued by the future controller: it is what the old
 * stream's retirement and the new stream's admission are keyed on. The UI never
 * invents one — it re-baselines a target only by asking the controller for a new
 * [TerminalUiState].
 */
public data class TerminalTarget(
    public val hostId: HostId,
    public val hostRunId: String,
    public val rowId: String,
    public val selectionGeneration: Long,
) {
    init {
        require(selectionGeneration > 0L) { "selection generation must be positive" }
    }

    public companion object {
        /** The target one row addresses, under the controller's current generation. */
        public fun of(row: SessionUiState, selectionGeneration: Long): TerminalTarget =
            TerminalTarget(row.hostId, row.hostRunId, row.rowId, selectionGeneration)
    }
}

/**
 * Everything the fullscreen terminal screen draws that is not the terminal content
 * itself.
 *
 * The content is an injected slot: this client never fabricates a terminal, sample
 * buffer, or placeholder. [inputReady] is a controller-owned fact, not a UI guess —
 * it is true only once the current viewport has been laid out and a fresh commit
 * receipt was observed for it, which is what makes the optional extra-keys row a
 * real resize instead of an overlay that bypasses one.
 *
 * [keyboardVisible], [extraKeysVisible], and [modifiers] are transient UI state.
 * They are reset across targets, coverage, and backgrounding by [rebasedTo] and
 * [withCoverage] so nothing sticky survives into another session.
 */
public data class TerminalUiState(
    public val target: TerminalTarget,
    public val sessionTitle: String,
    public val hostLabel: String,
    public val hostConnection: HostConnectionState,
    public val rosterFreshness: RosterFreshness? = null,
    public val coverage: UiCoverage = UiCoverage.NONE,
    public val inputReady: Boolean = false,
    public val keyboardVisible: Boolean = false,
    public val extraKeysVisible: Boolean = false,
    public val modifiers: TerminalModifiers = TerminalModifiers.NONE,
    public val quickSwitcherVisible: Boolean = false,
    /**
     * Commit proofs for the quick switcher's entries, keyed by row.
     *
     * A switch is attributed to the chooser entry the operator actually saw, so the
     * proof belongs to that entry rather than to the terminal being left. An entry
     * with no proof here is listed but cannot be chosen. Entries are keyed by row, so
     * an unrelated host updating its roster cannot retire the standing of an entry
     * whose own row did not change.
     */
    public val chooserProofs: Map<SessionRowKey, UiActionProof> = emptyMap(),
) {
    /** Drop every transient input affordance: held modifiers, keyboard, extra keys. */
    public fun withoutTransientInput(): TerminalUiState =
        copy(modifiers = TerminalModifiers.NONE, keyboardVisible = false, extraKeysVisible = false)

    /** Re-baseline onto [next], clearing all transient state when the target changed. */
    public fun rebasedTo(next: TerminalTarget): TerminalUiState =
        if (next == target) this else copy(target = next).withoutTransientInput()

    /** Apply coverage, clearing held modifiers whenever input is being suspended. */
    public fun withCoverage(next: UiCoverage): TerminalUiState =
        if (next == coverage) {
            this
        } else if (next.suspendsTerminalInput) {
            copy(coverage = next, modifiers = TerminalModifiers.NONE)
        } else {
            copy(coverage = next)
    }
}

/** What a system Back press must do on the terminal screen, in priority order. */
public enum class TerminalBackAction {
    /** Retire the quick switcher sheet first. */
    DISMISS_QUICK_SWITCHER,

    /** Let the soft keyboard go away before anything else. */
    DISMISS_KEYBOARD,

    /** Leave the terminal and show the session list again. */
    LEAVE_TERMINAL,
}

/**
 * The honest back plan for one terminal screen.
 *
 * The quick switcher, then the IME, then the terminal itself. Leaving the terminal
 * is a detach only: it never closes the owner's session and never sends a stop.
 */
public fun TerminalUiState.backAction(): TerminalBackAction = when {
    quickSwitcherVisible -> TerminalBackAction.DISMISS_QUICK_SWITCHER
    keyboardVisible -> TerminalBackAction.DISMISS_KEYBOARD
    else -> TerminalBackAction.LEAVE_TERMINAL
}

/**
 * One row of the terminal's cross-host quick switcher.
 *
 * Every configured host appears, connected or not, so switching is a single gesture
 * rather than a trip through the host screen. A host whose rows are no longer live
 * is labelled stale by [SessionUiState.stale] and is still selectable: the
 * controller decides whether it can honour the switch, and a stale row is never
 * silently presented as live.
 */
public sealed interface QuickSwitcherRow {
    /** A host with no rows to switch to; shows its real connection state. */
    public data class HostWithoutRoster(public val host: HostUiState) : QuickSwitcherRow

    /** One selectable session row. */
    public data class Session(public val session: SessionUiState, public val isCurrent: Boolean) :
        QuickSwitcherRow
}

/**
 * Build the quick switcher with sessions in [orderedSessionRows] order, including
 * cross-host interleaving from [rowOrder]. Empty-host placeholders retain their
 * saved-host/owner-row slots; only the session slots are refilled in canonical order.
 * An empty [rowOrder] preserves the saved-host, then owner-row fallback unchanged.
 */
public fun quickSwitcherRows(
    hostStates: List<HostUiState>,
    current: TerminalTarget?,
    rowOrder: List<SessionRowKey> = emptyList(),
): List<QuickSwitcherRow> {
    val sessions = orderedSessionRows(hostStates, rowOrder).iterator()
    return buildList {
        hostStates.forEach { host ->
            if (host.rows.isEmpty()) {
                add(QuickSwitcherRow.HostWithoutRoster(host))
            } else {
                host.rows.forEach { _ ->
                    if (sessions.hasNext()) {
                        val session = sessions.next()
                        add(
                            QuickSwitcherRow.Session(
                                session = session,
                                isCurrent = current != null &&
                                    current.hostId == session.hostId &&
                                    current.hostRunId == session.hostRunId &&
                                    current.rowId == session.rowId,
                            ),
                        )
                    }
                }
            }
        }
    }
}
