package io.github.rfairburn.pireviewgate.core.transport

import java.io.IOException
import java.io.InputStream

/** Signals a header block larger than the configured bound. */
internal class HttpHeadTooLargeException : IOException("http header block exceeded the bound")

/** Signals a header block that is not a well-formed HTTP/1.1 response head. */
internal class HttpHeadInvalidException : IOException("http response head is invalid")

/**
 * One parsed HTTP/1.1 response head.
 *
 * Header names are lower-cased for lookup; the original count of every name is
 * preserved so a caller can refuse a duplicate of a header that must appear at
 * most once.
 */
internal class HttpHead(
    val statusCode: Int,
    val headers: Map<String, List<String>>,
) {
    fun has(name: String): Boolean = headers.containsKey(name.lowercase())

    /** All values of [name] in wire order. */
    fun valuesOf(name: String): List<String> = headers[name.lowercase()] ?: emptyList()

    /**
     * The single value of [name], or null when absent. A duplicated header is a
     * protocol violation rather than something to guess about.
     */
    fun singleValue(name: String): String? {
        val values = valuesOf(name)
        if (values.isEmpty()) return null
        if (values.size > 1) throw HttpHeadInvalidException()
        return values[0]
    }
}

/**
 * Strict, bounded HTTP/1.1 response head reader.
 *
 * The reader never buffers more than `maxHeaderBytes` or more than
 * [HttpHead] lines, requires CRLF line endings, rejects obsolete line folding,
 * and rejects a status line that is not a three-digit HTTP/1.x status.
 */
internal class HttpHeadReader(
    private val input: InputStream,
    private val maxHeaderBytes: Int,
    private val maxHeaderLines: Int,
) {
    fun read(): HttpHead {
        val accumulated = ArrayList<Byte>(256)
        while (true) {
            val next = input.read()
            if (next < 0) throw HttpHeadInvalidException()
            accumulated.add(next.toByte())
            if (accumulated.size > maxHeaderBytes) throw HttpHeadTooLargeException()
            val size = accumulated.size
            if (size >= 4 &&
                accumulated[size - 4] == CR &&
                accumulated[size - 3] == LF &&
                accumulated[size - 2] == CR &&
                accumulated[size - 1] == LF
            ) {
                break
            }
        }
        val bytes = ByteArray(accumulated.size)
        for (i in accumulated.indices) bytes[i] = accumulated[i]
        // ISO-8859-1 is byte-preserving, so validation below sees the raw bytes.
        val text = String(bytes, Charsets.ISO_8859_1)
        // The block ends with CRLF CRLF: strip the terminator, then the last
        // line's own CRLF, before splitting. An interior empty line can only be
        // the terminator, so anything left empty below is a violation.
        val headerLines = text.substring(0, text.length - 2).removeSuffix(CRLF).split(CRLF)
        if (headerLines.isEmpty()) throw HttpHeadInvalidException()
        if (headerLines.size - 1 > maxHeaderLines) throw HttpHeadTooLargeException()

        val statusCode = parseStatusLine(headerLines[0])
        val collected = LinkedHashMap<String, MutableList<String>>()
        for (index in 1 until headerLines.size) {
            val line = headerLines[index]
            if (line.isEmpty()) throw HttpHeadInvalidException()
            val first = line[0]
            if (first == ' ' || first == '\t') throw HttpHeadInvalidException()
            val colon = line.indexOf(':')
            if (colon <= 0) throw HttpHeadInvalidException()
            val name = line.substring(0, colon)
            if (!isHttpToken(name)) throw HttpHeadInvalidException()
            val value = line.substring(colon + 1).trim()
            if (value.any { it == '\r' || it == '\n' || it.code < 0x20 || it.code == 0x7F }) {
                throw HttpHeadInvalidException()
            }
            val key = name.lowercase()
            collected.getOrPut(key) { ArrayList() }.add(value)
        }
        return HttpHead(statusCode, collected)
    }

    private fun parseStatusLine(line: String): Int {
        if (!line.startsWith("HTTP/1.0 ") && !line.startsWith("HTTP/1.1 ")) throw HttpHeadInvalidException()
        val rest = line.substring(9)
        val statusToken = rest.split(' ')[0]
        if (statusToken.length != 3) throw HttpHeadInvalidException()
        val code = statusToken.toIntOrNull() ?: throw HttpHeadInvalidException()
        if (code < 100 || code > 599) throw HttpHeadInvalidException()
        return code
    }

    companion object {
        private const val CR: Byte = 0x0D
        private const val LF: Byte = 0x0A
        private const val CRLF = "\r\n"
    }
}
