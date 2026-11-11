package io.github.rfairburn.pireviewgate.ui.client

import androidx.activity.compose.LocalActivity
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.toArgb
import androidx.core.graphics.drawable.toDrawable
import androidx.core.view.WindowCompat
import io.github.rfairburn.pireviewgate.core.hosts.AppAppearance

/**
 * The one place the saved appearance becomes a Material appearance.
 *
 * Every app-owned surface — the routes, their dialogs, the quick switcher, and the
 * controls inside them — is painted from the [MaterialTheme] this provides, so the
 * saved choice reaches the whole app through a single boundary and nothing else
 * picks its own palette. Light uses Material3's own light scheme, which is exactly
 * what the app painted before the choice existed; dark uses Material3's own dark
 * scheme. There is no custom palette and no mixed variant: one saved value selects
 * one scheme.
 *
 * This boundary owns app surfaces only. The terminal's received colors and its own
 * foreground and background defaults belong to the host and to
 * [io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceView], and neither
 * one reads an appearance, a color scheme, or a theme.
 */
@Composable
fun ClientTheme(appearance: AppAppearance, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = rememberClientColorScheme(appearance), content = content)
}

/**
 * The scheme one saved appearance paints with.
 *
 * The two schemes are the unmodified Material3 defaults: light is what the app
 * shipped with, dark is Material3's dark scheme.
 */
internal fun clientColorScheme(appearance: AppAppearance): ColorScheme = when (appearance) {
    AppAppearance.LIGHT -> lightColorScheme()
    AppAppearance.DARK -> darkColorScheme()
}

/** One scheme per saved appearance, so a switch recomposes without reallocating each frame. */
@Composable
internal fun rememberClientColorScheme(appearance: AppAppearance): ColorScheme =
    remember(appearance) { clientColorScheme(appearance) }

/**
 * The window decorations that belong to the selected appearance.
 *
 * Two things follow the app's own palette, and only these:
 *
 * - **Status-bar icon contrast.** The app paints the strip below the status bar
 *   itself, so the icons ask for the contrast that matches that strip instead of
 *   the contrast the edge-to-edge helper derives from the system night flag. A
 *   light app asks for dark icons, a dark app for light ones — which is the same
 *   reason the fixed light app always asked for dark ones.
 * - **The surface behind the app's own content.** On the non-terminal routes the
 *   window reserves the status-bar band above the composed content, so that band
 *   shows the window's own background. It is set to the selected scheme's surface,
 *   and a light appearance gets back exactly the background its theme supplied.
 *
 * Contrast and one background fill only: edge-to-edge geometry, the consumed
 * insets, the navigation bar, and every system bar color are untouched, and no
 * route measures or lays out differently for one appearance than another.
 */
@Composable
fun ClientWindowAppearance(appearance: AppAppearance) {
    val window = LocalActivity.current?.window
    val surfaceColor = rememberClientColorScheme(appearance).surface
    // Captured before this composable ever writes, so switching back to light
    // restores the theme's own window background rather than a color chosen here.
    val themeBackground = remember(window) { window?.decorView?.background }
    SideEffect {
        val target = window ?: return@SideEffect
        val dark = appearance == AppAppearance.DARK
        target.decorView.background =
            if (dark) surfaceColor.toArgb().toDrawable() else themeBackground
        WindowCompat.getInsetsController(target, target.decorView).isAppearanceLightStatusBars = !dark
    }
}
