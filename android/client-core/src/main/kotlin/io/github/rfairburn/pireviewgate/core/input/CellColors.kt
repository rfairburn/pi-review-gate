package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalColorMode
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalColorSpec

/**
 * The phone's own 256-color palette.
 *
 * The owner records color as a palette index or an RGB triple; it ships no
 * theme. These values are this client's rendering choice — the conventional
 * xterm 16, the standard 6x6x6 cube, and the 24-step grayscale ramp — so the
 * same frame looks the same on every phone instead of depending on a device
 * resource. Nothing here is a wire claim, and a later task may make it
 * configurable without changing anything on the wire.
 */
object TerminalPalette {
	/** Opaque ARGB from 8-bit components. */
	fun rgb(red: Int, green: Int, blue: Int): Int =
		(-0x1000000) or ((red and 0xff) shl 16) or ((green and 0xff) shl 8) or (blue and 0xff)

	/** Resolve a 0-255 palette index to an opaque ARGB color. */
	fun color(index: Int): Int {
		val clamped = index.coerceIn(0, 255)
		return if (clamped < 16) BASIC[clamped] else extended(clamped)
	}

	private fun extended(index: Int): Int {
		if (index < 232) {
			val value = index - 16
			val red = value / 36
			val green = (value / 6) % 6
			val blue = value % 6
			return rgb(level(red), level(green), level(blue))
		}
		val gray = 8 + (index - 232) * 10
		return rgb(gray, gray, gray)
	}

	private fun level(component: Int): Int = if (component == 0) 0 else 55 + component * 40

	private val BASIC = intArrayOf(
		rgb(0, 0, 0), rgb(205, 0, 0), rgb(0, 205, 0), rgb(205, 205, 0),
		rgb(0, 0, 238), rgb(205, 0, 205), rgb(0, 205, 205), rgb(229, 229, 229),
		rgb(127, 127, 127), rgb(255, 0, 0), rgb(0, 255, 0), rgb(255, 255, 0),
		rgb(92, 92, 255), rgb(255, 0, 255), rgb(0, 255, 255), rgb(255, 255, 255),
	)
}

/** One cell's resolved colors. A null [background] means the surface background shows. */
data class CellColors(val foreground: Int, val background: Int?)

/**
 * Resolving a recorded style into colors, with no platform dependency so the
 * rules are testable off-device.
 *
 * Foreground and background resolve independently: a recorded palette or RGB
 * background is painted, and only a genuinely default background leaves the
 * surface through. Inverse swaps the two roles, exactly as the owner's
 * attributes mean them.
 */
object CellColorResolution {
	/** The colors one cell is drawn with. */
	fun resolve(style: SgrStyle, defaultForeground: Int, defaultBackground: Int): CellColors {
		val recordedForeground = colorOf(style.fg, defaultForeground)
		val recordedBackground = colorOf(style.bg, defaultBackground)
		val foreground = if (style.inverse) recordedBackground else recordedForeground
		val background = if (style.inverse) recordedForeground else recordedBackground
		return CellColors(
			foreground = if (style.dim) dim(foreground) else foreground,
			background = if (background == defaultBackground) null else background,
		)
	}

	/** Opaque ARGB from 8-bit components. */
	fun rgb(red: Int, green: Int, blue: Int): Int = TerminalPalette.rgb(red, green, blue)

	/** The same color at [DIM_ALPHA] of 255 alpha. */
	fun dim(color: Int): Int {
		val alpha = ((color ushr 24) and 0xff) * DIM_ALPHA / 255
		return (alpha shl 24) or (color and 0x00ffffff)
	}

	private fun colorOf(spec: TerminalColorSpec?, fallback: Int): Int {
		if (spec == null) return fallback
		return when (spec.mode) {
			TerminalColorMode.DEFAULT -> fallback
			TerminalColorMode.PALETTE -> TerminalPalette.color(spec.value)
			TerminalColorMode.RGB -> rgb(
				(spec.value shr 16) and 0xff,
				(spec.value shr 8) and 0xff,
				spec.value and 0xff,
			)
		}
	}

	private const val DIM_ALPHA = 150
}
