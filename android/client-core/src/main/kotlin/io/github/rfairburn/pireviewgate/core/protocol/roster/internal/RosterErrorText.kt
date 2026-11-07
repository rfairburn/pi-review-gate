package io.github.rfairburn.pireviewgate.core.protocol.roster.internal

import io.github.rfairburn.pireviewgate.core.protocol.roster.MAX_REMOTE_ERROR_BYTES
import io.github.rfairburn.pireviewgate.core.protocol.roster.MAX_REMOTE_ERROR_CHARS
import io.github.rfairburn.pireviewgate.core.protocol.roster.MAX_REMOTE_ERROR_INPUT_BYTES
import io.github.rfairburn.pireviewgate.core.protocol.roster.REMOTE_ERROR_FALLBACK_TEXT

/**
 * The bounded, display-safe error text boundary for one roster row.
 *
 * Redaction runs after terminal-control stripping, so splitting a credential with
 * an injected control cannot unmask it, and before truncation, so a secret
 * straddling the output bound is already replaced. Uninspectable or unsafe detail
 * fails closed to one fixed useful message. The recognizers are bounded helpers
 * for credentials a generic pass leaves partly visible; they are never claimed as
 * exhaustive.
 */
object RosterErrorText {

    private const val REDACTED = "[REDACTED]"

    private val PRIVATE_KEY_FRAGMENT_RE =
        Regex("-----BEGIN[\\s\\S]{0,96}?PRIVATE KEY-----|PRIVATE KEY-----", RegexOption.IGNORE_CASE)

    private const val SENSITIVE_KEY =
        "(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|token|" +
            "auth(?:orization)?|bearer|password|passwd|secret|cookie)"

    /**
     * An ambiguous key/value shape whose delimiters can leave a credential tail
     * visible. Ambiguous diagnostics fail closed instead.
     */
    private val AMBIGUOUS_SECRET_ASSIGNMENT_RE = Regex(
        "$SENSITIVE_KEY[\"']?\\s*[:=]\\s*\\S*[,\"'\\]}]",
        RegexOption.IGNORE_CASE,
    )

    // A generated marker is matched explicitly as the first value alternative so
    // repeated redaction consumes its closing bracket idempotently. Groups:
    // 1 leading quote, 2 sensitive key, 3 separator, 4 value quote, 5 value,
    // 6 closing quote (backreference to 4).
    private val ASSIGNMENT_RE = Regex(
        "([\"']?)($SENSITIVE_KEY)([\"']?\\s*[:=]\\s*)([\"']?)" +
            "(\\[REDACTED\\][^\\s,\"'\\]}]*|[^\\s,\"'\\]}]+|[^\"']*)(\\4)",
        RegexOption.IGNORE_CASE,
    )

    private val COOKIE_HEADER_RE = Regex("\\b(Cookie|Set-Cookie)\\s*:\\s*[^\\n]*=[^\\n]*", RegexOption.IGNORE_CASE)

    // Authorization values may carry comma-separated credential parameters or
    // schemes this boundary does not enumerate, so the whole bounded single-line
    // header value is consumed rather than only its first component.
    private val AUTHORIZATION_HEADER_RE = Regex("\\b(Authorization\\s*:\\s*)[^\\r\\n]*", RegexOption.IGNORE_CASE)
    private val AUTH_CREDENTIAL_RE = Regex("\\b(?:Basic|Bearer)\\s+[A-Za-z0-9._~+/=-]+", RegexOption.IGNORE_CASE)
    private val URL_USERINFO_RE = Regex("\\b([a-z][a-z0-9+.-]*://)[^\\s/?#@]*@", RegexOption.IGNORE_CASE)

    private const val MAX_PEM_PRIVATE_KEY_BODY_LENGTH = 64 * 1024
    private const val PEM_PRIVATE_KEY_LABEL = "(?:[A-Z0-9][A-Z0-9-]{0,31} ){0,3}PRIVATE KEY"

    // Accepts real newlines and escaped newline sequences, as a private key
    // embedded in captured output may use either.
    private val PEM_PRIVATE_KEY_RE = Regex(
        "-----BEGIN ($PEM_PRIVATE_KEY_LABEL)-----[ \\t]*(?:\\r?\\n|\\\\n)[\\s\\S]" +
            "{1,$MAX_PEM_PRIVATE_KEY_BODY_LENGTH}?-----END \\1-----",
    )

    private val JWT_CANDIDATE_RE = Regex(
        "(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{15,2048}\\.[A-Za-z0-9_-]{3,16384}\\.[A-Za-z0-9_-]{16,4096}(?![A-Za-z0-9_-])",
    )

    private val TOKEN_PATTERNS = listOf(
        Regex("\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}", RegexOption.IGNORE_CASE),
        Regex("\\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\\b"),
        Regex("\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b"),
        Regex("\\bgithub_pat_[A-Za-z0-9_]{20,}\\b"),
        Regex("\\bxox[baprs]-[A-Za-z0-9-]{12,}\\b"),
        Regex("\\bAKIA[0-9A-Z]{16}\\b"),
    )

    /**
     * Produces bounded, display-safe error text from one raw owner diagnostic, or
     * the fixed generic message when the detail cannot be shown safely.
     */
    fun displaySafe(raw: String): String {
        if (jsTrim(raw).isEmpty()) return REMOTE_ERROR_FALLBACK_TEXT
        if (RosterText.LINE_BREAK_RE.containsMatchIn(raw)) return REMOTE_ERROR_FALLBACK_TEXT
        // A tab inside a credential key or value would otherwise survive as an
        // unrecognized fragment under any whitespace normalization.
        if (raw.contains('\t')) return REMOTE_ERROR_FALLBACK_TEXT
        if (PRIVATE_KEY_FRAGMENT_RE.containsMatchIn(raw)) return REMOTE_ERROR_FALLBACK_TEXT
        if (RosterJson.utf8Length(raw) > MAX_REMOTE_ERROR_INPUT_BYTES) return REMOTE_ERROR_FALLBACK_TEXT
        val stripped = stripTerminalControls(raw)
        if (stripped.unterminated) return REMOTE_ERROR_FALLBACK_TEXT
        // Control stripping can reconstruct a private-key header that was split by
        // an injected control; detect it again before the generic pass runs.
        if (PRIVATE_KEY_FRAGMENT_RE.containsMatchIn(stripped.text)) return REMOTE_ERROR_FALLBACK_TEXT
        if (AMBIGUOUS_SECRET_ASSIGNMENT_RE.containsMatchIn(stripped.text)) return REMOTE_ERROR_FALLBACK_TEXT
        val redacted = try {
            redactRecognizable(stripped.text)
        } catch (ignored: Exception) {
            return REMOTE_ERROR_FALLBACK_TEXT
        }
        if (jsTrim(redacted.replace(REDACTED, "")).isEmpty()) return REMOTE_ERROR_FALLBACK_TEXT
        val bounded = jsTrim(boundErrorText(redacted))
        return if (bounded.isEmpty()) REMOTE_ERROR_FALLBACK_TEXT else bounded
    }

    /** The local credential recognizers, then the generic sensitive-text pass. */
    private fun redactRecognizable(input: String): String {
        var text = input
        text = COOKIE_HEADER_RE.replace(text) { match -> "${match.groupValues[1]}: $REDACTED" }
        text = AUTHORIZATION_HEADER_RE.replace(text) { match -> "${match.groupValues[1]}$REDACTED" }
        text = AUTH_CREDENTIAL_RE.replace(text, REDACTED)
        text = URL_USERINFO_RE.replace(text) { match -> "${match.groupValues[1]}$REDACTED@" }
        return redactSensitiveText(text)
    }

    /** The generic sensitive-text pass, in the source's fixed order. */
    internal fun redactSensitiveText(value: String): String {
        var text = PEM_PRIVATE_KEY_RE.replace(value, REDACTED)
        text = JWT_CANDIDATE_RE.replace(text) { match ->
            val candidate = match.value
            if (isStructurallyPlausibleJwt(candidate)) REDACTED else candidate
        }
        for (pattern in TOKEN_PATTERNS) {
            text = pattern.replace(text, REDACTED)
        }
        text = ASSIGNMENT_RE.replace(text) { match ->
            val leadQuote = match.groupValues[1]
            val key = match.groupValues[2]
            val separator = match.groupValues[3]
            val valueQuote = match.groupValues[4]
            // The one documented exception in the shared redactor preserves a bare
            // `id-token: write` line inside a GitHub Actions `permissions:` block,
            // which needs an enclosing line above the match. A roster diagnostic can
            // never contain a line break: this boundary fails closed on one before
            // redaction runs, so the exception is unreachable here.
            "$leadQuote$key$separator$valueQuote$REDACTED$valueQuote"
        }
        return text
    }

    private fun isStructurallyPlausibleJwt(candidate: String): Boolean {
        val parts = candidate.split('.')
        if (parts.size != 3) return false
        val header = decodeJsonSegment(parts[0]) ?: return false
        val payload = decodeJsonSegment(parts[1]) ?: return false
        val alg = header["alg"] as? kotlinx.serialization.json.JsonPrimitive ?: return false
        return alg.isString && alg.content.isNotEmpty()
    }

    private fun decodeJsonSegment(segment: String): kotlinx.serialization.json.JsonObject? {
        val bytes = decodeBase64UrlLenient(segment) ?: return null
        return RosterJson.parse(String(bytes, Charsets.UTF_8)) as? kotlinx.serialization.json.JsonObject
    }

    /**
     * Base64url decode with the tolerance the source's decoder shows: characters
     * outside the alphabet are ignored and missing padding is accepted.
     */
    private fun decodeBase64UrlLenient(value: String): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        var buffer = 0
        var bits = 0
        for (unit in value) {
            val six = when (unit) {
                in 'A'..'Z' -> unit.code - 'A'.code
                in 'a'..'z' -> unit.code - 'a'.code + 26
                in '0'..'9' -> unit.code - '0'.code + 52
                '-' -> 62
                '_' -> 63
                else -> continue
            }
            buffer = (buffer shl 6) or six
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buffer shr bits) and 0xFF)
            }
        }
        return out.toByteArray()
    }

    /** Truncates to the error bound without emitting a partial generated marker. */
    internal fun boundErrorText(value: String): String {
        val sb = StringBuilder()
        var chars = 0
        var bytes = 0
        var truncated = false
        var index = 0
        while (index < value.length) {
            val codePoint = value.codePointAt(index)
            val size = utf8Size(codePoint)
            if (chars >= MAX_REMOTE_ERROR_CHARS || bytes + size > MAX_REMOTE_ERROR_BYTES) {
                truncated = true
                break
            }
            sb.appendCodePoint(codePoint)
            chars += 1
            bytes += size
            index += Character.charCount(codePoint)
        }
        if (!truncated) return sb.toString()
        val text = sb.toString()
        val markerStart = text.lastIndexOf('[')
        if (markerStart != -1 &&
            text.length - markerStart < REDACTED.length &&
            REDACTED.startsWith(text.substring(markerStart))
        ) {
            return jsTrimEnd(text.substring(0, markerStart))
        }
        return text
    }

    private fun utf8Size(codePoint: Int): Int = when {
        codePoint < 0x80 -> 1
        codePoint < 0x800 -> 2
        codePoint < 0x10000 -> 3
        else -> 4
    }

    /** Removes terminal control sequences and non-display controls. */
    internal fun stripTerminalControls(raw: String): StripResult {
        val sb = StringBuilder()
        var index = 0
        var unterminated = false
        while (index < raw.length) {
            val code = raw[index].code
            val next = if (index + 1 < raw.length) raw[index + 1] else ' '
            if (code == 0x1b) {
                val end = when (next) {
                    '[' -> consumeCsi(raw, index + 2)
                    ']', 'P', '_', '^', 'X' -> consumeControlString(raw, index + 2)
                    else -> consumeEscapeFunction(raw, index + 1)
                }
                if (end < 0) {
                    unterminated = true
                    break
                }
                index = end
                continue
            }
            if (code == 0x9b) {
                val end = consumeCsi(raw, index + 1)
                if (end < 0) {
                    unterminated = true
                    break
                }
                index = end
                continue
            }
            if (code == 0x90 || code == 0x98 || code == 0x9d || code == 0x9e || code == 0x9f) {
                val end = consumeControlString(raw, index + 1)
                if (end < 0) {
                    unterminated = true
                    break
                }
                index = end
                continue
            }
            if (code < 0x20 || code == 0x7f || (code in 0x80..0x9f)) {
                index += 1
                continue
            }
            val codePoint = raw.codePointAt(index)
            sb.appendCodePoint(codePoint)
            index += Character.charCount(codePoint)
        }
        return StripResult(sb.toString(), unterminated)
    }

    /** One ESC or C1 control sequence consumer, or `-1` when it never terminates. */
    private fun consumeCsi(raw: String, start: Int): Int {
        var end = start
        while (end < raw.length) {
            val code = raw[end].code
            end += 1
            if (code in 0x40..0x7e) return end
        }
        return -1
    }

    private fun consumeControlString(raw: String, start: Int): Int {
        var end = start
        while (end < raw.length) {
            val code = raw[end].code
            if (code == 0x07 || code == 0x9c) return end + 1
            if (code == 0x1b && end + 1 < raw.length && raw[end + 1].code == 0x5c) return end + 2
            end += 1
        }
        return -1
    }

    private fun consumeEscapeFunction(raw: String, start: Int): Int {
        var end = start
        while (end < raw.length) {
            val code = raw[end].code
            if (code in 0x20..0x2f) {
                end += 1
                continue
            }
            if (code in 0x30..0x7e) return end + 1
            return -1
        }
        return -1
    }

    /** Trim with the ECMAScript whitespace set, which the source's trim uses. */
    fun jsTrim(value: String): String = jsTrimEnd(jsTrimStart(value))

    private fun jsTrimStart(value: String): String {
        var start = 0
        while (start < value.length && RosterText.isJsTrimWhiteSpace(value[start].code)) start += 1
        return value.substring(start)
    }

    private fun jsTrimEnd(value: String): String {
        var end = value.length
        while (end > 0 && RosterText.isJsTrimWhiteSpace(value[end - 1].code)) end -= 1
        return value.substring(0, end)
    }

    /** A stripped diagnostic plus whether it ended inside an unterminated sequence. */
    data class StripResult(val text: String, val unterminated: Boolean)
}
