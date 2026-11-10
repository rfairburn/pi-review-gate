package io.github.rfairburn.pireviewgate.core.presentation

/**
 * JSON string escaping for admitted identity text and the persisted order document.
 *
 * This matches `JSON.stringify` for the values this client admits:
 *
 * - quotes, backslashes, and control characters use the ordinary JSON escapes;
 * - a valid UTF-16 surrogate pair is retained as the pair, so supplementary
 *   Unicode keeps its exact value;
 * - an isolated high or low surrogate is escaped as `\uXXXX`, exactly as
 *   well-formed `JSON.stringify` does, instead of emitting a code unit that would
 *   be replaced when the document is encoded as UTF-8.
 *
 * The result contains no isolated surrogate code units, so [String.toByteArray]
 * with UTF-8 preserves every admitted identity value.
 */
internal fun jsonString(value: String): String = buildString(value.length + 2) {
    append('"')
    var index = 0
    while (index < value.length) {
        val character = value[index]
        when {
            character == '"' -> append("\\\"")
            character == '\\' -> append("\\\\")
            character == '\b' -> append("\\b")
            character == '\u000C' -> append("\\f")
            character == '\n' -> append("\\n")
            character == '\r' -> append("\\r")
            character == '\t' -> append("\\t")
            character < ' ' -> appendUnicodeEscape(character)
            character.isHighSurrogate() -> {
                val next = value.getOrNull(index + 1)
                if (next != null && next.isLowSurrogate()) {
                    append(character)
                    append(next)
                    index += 2
                    continue
                }
                appendUnicodeEscape(character)
            }
            character.isLowSurrogate() -> appendUnicodeEscape(character)
            else -> append(character)
        }
        index += 1
    }
    append('"')
}

private fun StringBuilder.appendUnicodeEscape(character: Char) {
    append("\\u")
    append(character.code.toString(16).padStart(4, '0'))
}
