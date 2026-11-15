package io.github.rfairburn.pireviewgate.core.protocol.native

/**
 * The canonical backend identity and owner-advertised native launch-target model.
 *
 * This is the ONE shared native identity this client uses. The roster lane decodes
 * the owner's typed row backend and advertised target catalog with it, native
 * create and native host-caption requests address targets with it, and a future
 * native IO variant consumes the same [NativeCliBackend] and [NativeCliTarget]
 * instead of declaring a second backend vocabulary.
 *
 * Nothing here discovers a provider, resolves a target, launches a process, reads
 * an environment, or carries a command, argument, credential, path, or private
 * configuration. A target descriptor is exactly the closed `id`/`backend`/`label`
 * triple the owner advertised, and every rule below is the host contract restated:
 * it never trims, normalizes, infers, or falls back.
 */

/** Every backend one hosted row may belong to; an absent row backend means [PI]. */
enum class SessionBackend(val wireName: String) {
    PI("pi"),
    CLAUDE("claude"),
    CODEX("codex"),
    ;

    /** Stable provider display label; never a conversation name or an observation. */
    val displayLabel: String
        get() = when (this) {
            PI -> "Pi"
            CLAUDE -> "Claude"
            CODEX -> "Codex"
        }

    /** The native CLI identity of this backend, or `null` for Pi. */
    fun nativeCliOrNull(): NativeCliBackend? = when (this) {
        PI -> null
        CLAUDE -> NativeCliBackend.CLAUDE
        CODEX -> NativeCliBackend.CODEX
    }

    companion object {
        fun fromWireName(value: String): SessionBackend? = entries.firstOrNull { it.wireName == value }
    }
}

/**
 * The closed native CLI backend identity: Claude or Codex and nothing else.
 *
 * This type is the future native IO consumer contract as well as today's roster,
 * create, and host-caption identity. It is never inferred from a label, a row
 * status, a native conversation, an executable name, or the absence of Pi telemetry.
 */
enum class NativeCliBackend(val wireName: String) {
    CLAUDE("claude"),
    CODEX("codex"),
    ;

    /** Stable provider display label; the same words the desktop card uses. */
    val displayLabel: String
        get() = when (this) {
            CLAUDE -> "Claude"
            CODEX -> "Codex"
        }

    /** The broader row backend this native identity names. */
    val sessionBackend: SessionBackend
        get() = when (this) {
            CLAUDE -> SessionBackend.CLAUDE
            CODEX -> SessionBackend.CODEX
        }

    companion object {
        fun fromWireName(value: String): NativeCliBackend? = entries.firstOrNull { it.wireName == value }
    }
}

/** One owner-advertised native interactive launch target. Closed: no extra field. */
data class NativeCliTarget(
    /** Exact owner-advertised target id, matched with [backend] and never alone. */
    val id: String,
    val backend: NativeCliBackend,
    /** The owner's own operator-facing label for this target. */
    val label: String,
)

/** Upper bound for one target id, shared by every surface that accepts one. */
const val MAX_NATIVE_CLI_TARGET_CHARS: Int = 128

/** Upper bound for one advertised target label, in Unicode code points. */
const val MAX_NATIVE_TARGET_LABEL_CHARS: Int = 128

/** Derived, not tunable: one legal code point occupies at most four UTF-8 bytes. */
const val MAX_NATIVE_TARGET_LABEL_BYTES: Int = MAX_NATIVE_TARGET_LABEL_CHARS * 4

/** The owner's shared native row display-name/caption bound, in UTF-16 units. */
const val MAX_NATIVE_DISPLAY_NAME_CHARS: Int = 80

private val TARGET_ID_UNSAFE_RE = Regex("[\\u0000-\\u001F\\u007F-\\u009F]")
private val UNSAFE_DISPLAY_RE = Regex("[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]")

/** The host's one target-id rule: non-empty, bounded, control-free single-line text. */
fun isNativeCliTargetId(value: String): Boolean =
    value.length in 1..MAX_NATIVE_CLI_TARGET_CHARS && !TARGET_ID_UNSAFE_RE.containsMatchIn(value)

/**
 * The owner's advertised target-label rule: bounded, non-empty display text with no
 * control, line-separator, or unrepresentable surrogate.
 */
fun isNativeTargetLabel(value: String): Boolean {
    if (value.isEmpty()) return false
    if (UNSAFE_DISPLAY_RE.containsMatchIn(value)) return false
    if (!isWellFormedUnicode(value)) return false
    if (codePointCount(value) > MAX_NATIVE_TARGET_LABEL_CHARS) return false
    return value.toByteArray(Charsets.UTF_8).size <= MAX_NATIVE_TARGET_LABEL_BYTES
}

/**
 * The host's one native row display-name/caption rule. It is deliberately NOT a
 * conversation name: the value is never sent to a provider, typed into a child, or
 * stored as a Pi native session identity.
 */
fun isNativeDisplayName(value: String): Boolean =
    value.isNotEmpty() &&
        !isJsBlank(value) &&
        !hasTrimmedEdge(value) &&
        value.length <= MAX_NATIVE_DISPLAY_NAME_CHARS &&
        !UNSAFE_DISPLAY_RE.containsMatchIn(value)

/**
 * The canonical native card caption: the owner label under the host's JS-trim
 * whitespace rule, falling back to the stable provider label when the trimmed
 * caption is empty. It mirrors the desktop card exactly and never invents text.
 */
fun nativeDisplayCaption(label: String, providerFallback: String): String =
    jsTrim(label).ifEmpty { providerFallback }

private fun jsTrim(value: String): String {
    var start = 0
    var end = value.length
    while (start < end && isJsTrimWhiteSpace(value[start].code)) start += 1
    while (end > start && isJsTrimWhiteSpace(value[end - 1].code)) end -= 1
    return value.substring(start, end)
}

private fun isWellFormedUnicode(value: String): Boolean {
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

private fun codePointCount(value: String): Int {
    var count = 0
    var index = 0
    while (index < value.length) {
        val unit = value[index].code
        index += if (unit in 0xD800..0xDBFF && index + 1 < value.length &&
            value[index + 1].code in 0xDC00..0xDFFF
        ) {
            2
        } else {
            1
        }
        count += 1
    }
    return count
}

private fun isJsBlank(value: String): Boolean {
    for (unit in value) if (!isJsTrimWhiteSpace(unit.code)) return false
    return true
}

private fun hasTrimmedEdge(value: String): Boolean =
    isJsTrimWhiteSpace(value[0].code) || isJsTrimWhiteSpace(value[value.length - 1].code)

private fun isJsTrimWhiteSpace(code: Int): Boolean = when (code) {
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0xFEFF, 0x2028, 0x2029 -> true
    0x1680, 0x202F, 0x205F, 0x3000 -> true
    in 0x2000..0x200A -> true
    else -> false
}
