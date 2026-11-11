package io.github.rfairburn.pireviewgate.core.hosts

/**
 * The saved appearance of the app's own surfaces: screens, dialogs, and controls.
 *
 * It is a presentation preference and nothing else. It selects which Material
 * appearance the app paints with, and it is never consulted by a connection, a
 * pairing decision, an input path, a rendered terminal frame, a host protocol
 * message, or a storage or trust rule. Host-provided terminal colors stay exactly
 * as the host sent them: the terminal's own defaults and its received palette are
 * not derived from this value.
 *
 * The choice is closed to these two variants. There is deliberately no "follow the
 * system", no automatic or time-based mode, and no custom palette: an appearance
 * that changed without the operator choosing it would make the painted surface
 * unpredictable, and a palette the client owns would be a second color system
 * beside the host's.
 */
public enum class AppAppearance {
    /** The shipped default: the app's light Material appearance. */
    LIGHT,

    /** The app's dark Material appearance. */
    DARK,
    ;

    /** The exact persisted name of this variant, lower-case. */
    public val wireName: String
        get() = when (this) {
            LIGHT -> "light"
            DARK -> "dark"
        }

    public companion object {
        /** The shipped default, used whenever nothing was ever saved. */
        public val DEFAULT: AppAppearance = LIGHT

        /**
         * The variant one persisted name names, or `null` when it names none.
         *
         * Only the exact lower-case names are admitted: an unknown spelling, a
         * capitalized one, or empty text is a refusal the caller reports, never a
         * silent fall back to the default.
         */
        public fun fromWireName(text: String): AppAppearance? = when (text) {
            "light" -> LIGHT
            "dark" -> DARK
            else -> null
        }
    }
}
