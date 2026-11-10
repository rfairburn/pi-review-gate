package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalColorMode
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalColorSpec

/**
 * A style bundle decoded from serializer-generated SGR, in the same terms the
 * native frame's structured style runs use: the same colors, the same nine
 * attributes, and no other capability.
 */
data class SgrStyle(
	val fg: TerminalColorSpec? = null,
	val bg: TerminalColorSpec? = null,
	val bold: Boolean = false,
	val dim: Boolean = false,
	val italic: Boolean = false,
	val underline: Boolean = false,
	val blink: Boolean = false,
	val inverse: Boolean = false,
	val invisible: Boolean = false,
	val strikethrough: Boolean = false,
	val overline: Boolean = false,
)

/** One contiguous span of a frame row sharing one [SgrStyle]. */
data class SgrSpan(val text: String, val style: SgrStyle)

/**
 * Decoder for the SGR the native serializer generates.
 *
 * A frame row is sanitized visible text plus only `\u001b[<params>m` sequences
 * this decoder accepts: `0` alone, or the serializer's own attribute codes in
 * its own order, followed by at most one foreground and one background color
 * group in the palette, bright-palette, 256-color, or truecolor forms it emits.
 * The grammar is deliberately the same one the wire reader enforces, so this
 * decoder is a second fence rather than a looser copy: any other escape, any
 * sub-parameter, any control byte, any unlisted attribute, and any reordered or
 * incomplete color group yields null for the whole row instead of a partial
 * interpretation. Nothing here can execute a control sequence, and nothing here
 * can invent an attribute the owner never recorded.
 *
 * Every accepted sequence establishes a complete style rather than merging into
 * the previous one, because the serializer emits a run's whole attribute bundle
 * each time it changes and an explicit reset when a run returns to defaults.
 */
object GeneratedSgrStyles {
	/** Default foreground, default background, no attributes. */
	val DEFAULT: SgrStyle = SgrStyle()

	private const val ESC = 0x1b
	private const val OPEN_BRACKET = 0x5b

	private val PARAM = Regex("0|[1-9][0-9]{0,2}")

	/** The serializer's own attribute emission order. */
	private val ATTRIBUTE_ORDER = listOf("1", "2", "3", "4", "5", "7", "8", "9", "53")
	private val ATTRIBUTE_INDEX: Map<String, Int> = ATTRIBUTE_ORDER.withIndex().associate { (index, code) -> code to index }

	private val FOREGROUND_SIMPLE = listOf(30..37, 90..97)
	private val BACKGROUND_SIMPLE = listOf(40..47, 100..107)

	/**
	 * Split [line] into styled spans, or null when the row is not native
	 * serializer output.
	 */
	fun parse(line: String): List<SgrSpan>? {
		val spans = ArrayList<SgrSpan>()
		var style = DEFAULT
		var textStart = 0
		var index = 0
		while (index < line.length) {
			val code = line[index].code
			if (code != ESC) {
				if (code < 0x20 || code == 0x7f || (code in 0x80..0x9f)) return null
				index += 1
				continue
			}
			if (index + 1 >= line.length || line[index + 1].code != OPEN_BRACKET) return null
			val terminator = line.indexOf('m', index + 2)
			if (terminator < 0) return null
			val decoded = decodeParams(line.substring(index + 2, terminator)) ?: return null
			if (index > textStart) spans.add(SgrSpan(line.substring(textStart, index), style))
			style = decoded
			index = terminator + 1
			textStart = index
		}
		if (line.length > textStart) spans.add(SgrSpan(line.substring(textStart), style))
		return spans
	}

	/** The row's visible text with every generated sequence removed, or null. */
	fun textOnly(line: String): String? {
		val spans = parse(line) ?: return null
		if (spans.isEmpty()) return ""
		val builder = StringBuilder()
		for (span in spans) builder.append(span.text)
		return builder.toString()
	}

	/** The style one generated sequence establishes, or null when it is not native. */
	private fun decodeParams(params: String): SgrStyle? {
		if (params == "0") return DEFAULT
		if (params.isEmpty()) return null
		val parts = params.split(";")
		for (part in parts) {
			if (!PARAM.matches(part)) return null
		}
		var style = DEFAULT
		var index = 0
		var attributeCursor = 0
		while (index < parts.size) {
			val position = ATTRIBUTE_INDEX[parts[index]] ?: break
			if (position < attributeCursor) return null
			attributeCursor = position + 1
			style = applyAttribute(style, parts[index])
			index += 1
		}
		val foreground = readColorGroup(parts, index, "38", FOREGROUND_SIMPLE, true) ?: return null
		style = style.copy(fg = foreground.spec)
		index = foreground.nextIndex
		val background = readColorGroup(parts, index, "48", BACKGROUND_SIMPLE, false) ?: return null
		style = style.copy(bg = background.spec)
		index = background.nextIndex
		return if (index == parts.size) style else null
	}

	private fun applyAttribute(style: SgrStyle, code: String): SgrStyle = when (code) {
		"1" -> style.copy(bold = true)
		"2" -> style.copy(dim = true)
		"3" -> style.copy(italic = true)
		"4" -> style.copy(underline = true)
		"5" -> style.copy(blink = true)
		"7" -> style.copy(inverse = true)
		"8" -> style.copy(invisible = true)
		"9" -> style.copy(strikethrough = true)
		"53" -> style.copy(overline = true)
		else -> style
	}

	/** One decoded color group and the index after it. */
	private class ColorGroup(val spec: TerminalColorSpec?, val nextIndex: Int)

	private fun readColorGroup(
		parts: List<String>,
		start: Int,
		extended: String,
		simpleRanges: List<IntRange>,
		foreground: Boolean,
	): ColorGroup? {
		if (start >= parts.size) return ColorGroup(null, start)
		if (parts[start] == extended) {
			return when (parts.getOrNull(start + 1)) {
				"5" -> {
					val value = colorComponent(parts.getOrNull(start + 2)) ?: return null
					ColorGroup(TerminalColorSpec(TerminalColorMode.PALETTE, value), start + 3)
				}
				"2" -> {
					val red = colorComponent(parts.getOrNull(start + 2)) ?: return null
					val green = colorComponent(parts.getOrNull(start + 3)) ?: return null
					val blue = colorComponent(parts.getOrNull(start + 4)) ?: return null
					ColorGroup(
						TerminalColorSpec(
							TerminalColorMode.RGB,
							(red shl 16) or (green shl 8) or blue,
						),
						start + 5,
					)
				}
				else -> null
			}
		}
		val simple = colorComponent(parts[start]) ?: return null
		if (!simpleRanges.any { simple in it }) return ColorGroup(null, start)
		return ColorGroup(TerminalColorSpec(TerminalColorMode.PALETTE, paletteIndex(simple, simpleRanges)), start + 1)
	}

	/** Map a simple 16-color code onto its palette index. */
	private fun paletteIndex(code: Int, simpleRanges: List<IntRange>): Int {
		if (code in 30..37) return code - 30
		if (code in 40..47) return code - 40
		if (code in 90..97) return 8 + (code - 90)
		return 8 + (code - 100)
	}

	private fun colorComponent(value: String?): Int? {
		if (value == null || !PARAM.matches(value)) return null
		val numeric = value.toIntOrNull() ?: return null
		return if (numeric <= 255) numeric else null
	}
}
