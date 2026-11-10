package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle

/*
 * The sRGB values below are color data derived from the Pi Coding Agent v1.5.0
 * dark and light themes (packages/coding-agent/src/modes/interactive/theme/
 * dark.json and light.json), Copyright (c) 2025 Mario Zechner, MIT License; see
 * LICENSES/MIT-pi-theme-colors.txt and NOTICE. Only the resolved foreground values
 * are embedded: no Pi runtime, theme loader, or color conversion code is included.
 */

/**
 * The painted role of one observed session-card status value.
 *
 * This is the desktop card's status palette: it paints only the observed VALUE,
 * never a label or a separator, and the text itself always states the value, so
 * color is never the only signal. The roles add no classification of their own:
 * they read [RosterLifecycle], [AgentActivity], and [InputObservation] unchanged.
 *
 * The count seam [sessionCountStatusRole] reuses these same roles for the desktop
 * card's count bands, where [ERROR] is only the highest observed activity
 * intensity and never an error, a lifecycle, or a routing state.
 */
public enum class SessionStatusRole {
    /** Lifecycle starting. */
    STARTING,

    /** Agent running. */
    RUNNING,

    /** Agent waiting. */
    WAITING,

    /** Input pending (pending input or an open input surface). */
    INPUT_PENDING,

    /** Agent positively idle, or input positively none. */
    IDLE,

    /** Agent or input unknown. Never painted as idle. */
    UNKNOWN,

    /** Lifecycle exited. */
    EXITED,

    /** Lifecycle error. */
    ERROR,
}

/**
 * Which of the two existing desktop theme variants applies.
 *
 * Chosen from the brightness of the current native Material surface only — not a
 * remote host setting, an OS preference read, or a stored preference.
 */
public enum class SessionStatusTheme {
    DARK,
    LIGHT,
    ;

    public companion object {
        /** A surface whose relative luminance is below one half is dark. */
        public fun forSurfaceLuminance(luminance: Float): SessionStatusTheme =
            if (luminance < 0.5f) DARK else LIGHT
    }
}

/** One painted value: an opaque `0xRRGGBB` sRGB color and whether it is bold. */
public data class SessionStatusStyle(
    public val rgb: Int,
    public val bold: Boolean,
)

/** The six Pi theme tokens the card palette uses, resolved to sRGB per variant. */
private enum class PiThemeToken(val dark: Int, val light: Int) {
    MUTED(0x9DA5A9, 0x677176),
    DIM(0x7E888E, 0x879095),
    SUCCESS(0x68B78D, 0x337E58),
    ERROR(0xEA7F81, 0xC8253D),
    WARNING(0xCD9A22, 0x8F6802),
    MD_LINK(0x69ADD0, 0x2F7899),
    ;

    fun rgb(theme: SessionStatusTheme): Int = when (theme) {
        SessionStatusTheme.DARK -> dark
        SessionStatusTheme.LIGHT -> light
    }
}

/** The desktop color and weight of this role in [theme]. */
public fun SessionStatusRole.style(theme: SessionStatusTheme): SessionStatusStyle {
    val token = when (this) {
        SessionStatusRole.STARTING -> PiThemeToken.MD_LINK
        SessionStatusRole.RUNNING -> PiThemeToken.SUCCESS
        SessionStatusRole.WAITING, SessionStatusRole.INPUT_PENDING -> PiThemeToken.WARNING
        SessionStatusRole.IDLE -> PiThemeToken.MUTED
        SessionStatusRole.UNKNOWN, SessionStatusRole.EXITED -> PiThemeToken.DIM
        SessionStatusRole.ERROR -> PiThemeToken.ERROR
    }
    val bold = when (this) {
        SessionStatusRole.STARTING -> theme == SessionStatusTheme.DARK
        SessionStatusRole.RUNNING,
        SessionStatusRole.WAITING,
        SessionStatusRole.ERROR,
        SessionStatusRole.INPUT_PENDING,
        -> true
        SessionStatusRole.IDLE, SessionStatusRole.UNKNOWN, SessionStatusRole.EXITED -> false
    }
    return SessionStatusStyle(token.rgb(theme), bold)
}

/**
 * The painted role of one observed background count, or `null` to stay neutral.
 *
 * These are the desktop card's count bands read off the number alone: zero is
 * [SessionStatusRole.IDLE] (muted, normal weight), 1 to 2 are
 * [SessionStatusRole.RUNNING] (success, bold), 3 to 6 are
 * [SessionStatusRole.WAITING] (warning, bold), and 7 or more are
 * [SessionStatusRole.ERROR] (error, bold). The bands are palette only — the red of
 * [SessionStatusRole.ERROR] is the highest observed intensity and never an error, a
 * lifecycle, or a routing decision — and this reads no classification and changes
 * none: what the card says about the row is decided elsewhere, unchanged.
 *
 * Only an observed number is painted. A `null` count has no observed value and
 * returns `null`, so the chip keeps its ordinary neutral content color rather than
 * the dimmed [SessionStatusRole.UNKNOWN]; a negative is not an observed number
 * either, and the card's existing count sanitation already reports it as unknown.
 * Zero is an observation, never unknown.
 */
public fun sessionCountStatusRole(count: Long?): SessionStatusRole? {
    val observed = count ?: return null
    if (observed < 0L) return null
    return when {
        observed == 0L -> SessionStatusRole.IDLE
        observed <= 2L -> SessionStatusRole.RUNNING
        observed <= 6L -> SessionStatusRole.WAITING
        else -> SessionStatusRole.ERROR
    }
}

/**
 * The painted roles of one card's three status values; `null` stays neutral.
 *
 * - [lifecycle] paints starting, exited, and error. An ALIVE lifecycle is not a
 *   painted value on the desktop card (its agent value is), so it stays neutral.
 * - [agent] paints the existing [AgentActivity] of an ALIVE row; any other
 *   lifecycle has no agent value to paint.
 * - [input] is painted only for a starting or alive row, independently of the
 *   agent value: pending input never overrides running, and unknown never becomes
 *   idle.
 */
public data class SessionCardStatusRoles(
    public val lifecycle: SessionStatusRole?,
    public val agent: SessionStatusRole?,
    public val input: SessionStatusRole?,
)

/** The painted roles for [row], from its existing classification only. */
public fun sessionCardStatusRoles(row: SessionUiState): SessionCardStatusRoles {
    val lifecycle = row.metadata.lifecycle
    val lifecycleRole = when (lifecycle) {
        RosterLifecycle.STARTING -> SessionStatusRole.STARTING
        RosterLifecycle.ALIVE -> null
        RosterLifecycle.EXITED -> SessionStatusRole.EXITED
        RosterLifecycle.ERROR -> SessionStatusRole.ERROR
    }
    val agentRole = when (row.agentActivity) {
        AgentActivity.RUNNING -> SessionStatusRole.RUNNING
        AgentActivity.WAITING -> SessionStatusRole.WAITING
        AgentActivity.IDLE -> SessionStatusRole.IDLE
        AgentActivity.UNKNOWN -> SessionStatusRole.UNKNOWN
        null -> null
    }
    val inputRole = if (lifecycle == RosterLifecycle.STARTING || lifecycle == RosterLifecycle.ALIVE) {
        when (row.inputObservation) {
            InputObservation.PENDING -> SessionStatusRole.INPUT_PENDING
            InputObservation.NONE -> SessionStatusRole.IDLE
            InputObservation.UNKNOWN -> SessionStatusRole.UNKNOWN
        }
    } else {
        null
    }
    return SessionCardStatusRoles(lifecycleRole, agentRole, inputRole)
}
