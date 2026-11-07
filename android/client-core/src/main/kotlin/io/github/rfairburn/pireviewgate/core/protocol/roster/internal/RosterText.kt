package io.github.rfairburn.pireviewgate.core.protocol.roster.internal

/**
 * The text rules this lane shares with its source contract.
 *
 * Each rule is the source rule restated, not a stricter convenience check: an
 * identifier is the lane's opaque token, a workspace keeps the New form's own
 * single-line bound, a native session id keeps the native rule, and a rename name
 * keeps the stored-name rule. Nothing here trims, normalizes, resolves, rewrites,
 * or truncates a value: a value outside its bound is refused.
 */
object RosterText {

    /** C0, DEL, C1, and the Unicode line and paragraph separators. */
    private const val UNSAFE_TEXT = "[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]"
    private val UNSAFE_TEXT_RE = Regex(UNSAFE_TEXT)

    /** The native rule additionally refuses the two path separators. */
    private val NATIVE_ID_UNSAFE_RE = Regex("[\\\\/\\u0000-\\u001F\\u007F\\u0080-\\u009F\\u2028\\u2029]")

    /** A bounded, non-empty, unremarkable token. Matched in full, so no anchors. */
    val IDENTIFIER_RE = Regex("[A-Za-z0-9][A-Za-z0-9._:-]*")

    /** Line breaks that can never appear inside one display-safe diagnostic. */
    val LINE_BREAK_RE = Regex("[\\n\\r\\u000B\\u000C\\u0085\\u2028\\u2029]")

    /** True when the text contains a C0, DEL, C1, or line/paragraph separator. */
    fun isUnsafeText(value: String): Boolean = UNSAFE_TEXT_RE.containsMatchIn(value)

    /** True when every surrogate is paired, so the text is representable UTF-8. */
    fun isWellFormedUnicode(value: String): Boolean {
        var index = 0
        while (index < value.length) {
            val unit = value[index].code
            if (unit in 0xD800..0xDBFF) {
                val next = if (index + 1 < value.length) value[index + 1].code else -1
                if (next !in 0xDC00..0xDFFF) return false
                index += 2
            } else if (unit in 0xDC00..0xDFFF) {
                return false
            } else {
                index += 1
            }
        }
        return true
    }

    /** Unicode code point count, not UTF-16 units. */
    fun codePointCount(value: String): Int {
        var count = 0
        var index = 0
        while (index < value.length) {
            val unit = value[index].code
            index += if (unit in 0xD800..0xDBFF && index + 1 < value.length &&
                value[index + 1].code in 0xDC00..0xDFFF
            ) 2 else 1
            count += 1
        }
        return count
    }

    /**
     * The byte ceiling stays a [Long]: a source-valid bound above [Int.MAX_VALUE]
     * must not narrow into a negative limit and start refusing ordinary tokens.
     */
    fun isIdentifier(value: String, maxBytes: Long): Boolean =
        value.isNotEmpty() &&
            RosterJson.utf8Length(value) <= maxBytes &&
            IDENTIFIER_RE.matches(value)

    /** Canonical native conversation id: bounded, path-free, and control-free. */
    fun isNativeSessionId(value: String): Boolean =
        value.isNotEmpty() &&
            RosterJson.utf8Length(value) <= MAX_NATIVE_SESSION_ID_BYTES &&
            !NATIVE_ID_UNSAFE_RE.containsMatchIn(value)

    /**
     * Persisted rename input, bounded without clipping or normalization. This is the
     * local rename seam's rule, not the native-id rule: a display name may contain a
     * path separator, so only blankness, size, and control text are refused.
     */
    fun isRenameName(value: String): Boolean =
        !isJsBlank(value) &&
            RosterJson.utf8Length(value) <= MAX_RENAME_NAME_BYTES &&
            !isUnsafeText(value)

    /**
     * Canonical workspace text: the New form's own bound (2048 code points, hence
     * at most 8192 UTF-8 bytes) with the same single-line safety rule. This is not
     * the identifier rule: a path is not an identifier, so no character class is
     * imposed beyond that, and spaces, slashes, and backslashes survive.
     */
    fun isCreateWorkspace(value: String): Boolean =
        value.isNotEmpty() &&
            !isUnsafeText(value) &&
            isWellFormedUnicode(value) &&
            codePointCount(value) <= OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS &&
            RosterJson.utf8Length(value) <= OWNER_CREATE_WORKSPACE_MAX_BYTES

    /** True when the text has no character outside the ECMAScript trim set. */
    fun isJsBlank(value: String): Boolean {
        for (unit in value) {
            if (!isJsTrimWhiteSpace(unit.code)) return false
        }
        return true
    }

    /** True when the text begins or ends with an ECMAScript trim character. */
    fun hasJsTrimmedEdge(value: String): Boolean {
        if (value.isEmpty()) return false
        return isJsTrimWhiteSpace(value[0].code) || isJsTrimWhiteSpace(value[value.length - 1].code)
    }

    /** The ECMAScript `WhiteSpace` plus `LineTerminator` code units. */
    fun isJsTrimWhiteSpace(code: Int): Boolean = when (code) {
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0xFEFF, 0x2028, 0x2029 -> true
        0x1680, 0x202F, 0x205F, 0x3000 -> true
        in 0x2000..0x200A -> true
        else -> false
    }

    /** Native display metadata bound, shared with the local protocol contract. */
    const val MAX_NATIVE_SESSION_NAME_LENGTH: Int = 256

    /** Persisted rename input bound in UTF-8 bytes. */
    const val MAX_RENAME_NAME_BYTES: Int = 1024

    /** Native session ids are opaque, bounded, path-free, and control-free. */
    const val MAX_NATIVE_SESSION_ID_BYTES: Int = 256

    /** The New form's workspace bound in Unicode code points. */
    const val OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS: Int = 2048

    /** Derived, not tunable: 2048 legal code points occupy at most 4 bytes each. */
    const val OWNER_CREATE_WORKSPACE_MAX_BYTES: Int = OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS * 4
}
