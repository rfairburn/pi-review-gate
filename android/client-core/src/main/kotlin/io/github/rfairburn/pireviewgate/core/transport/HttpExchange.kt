package io.github.rfairburn.pireviewgate.core.transport

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * Bounded HTTP/1.1 request rendering and response reading for the two fixed
 * requests of this transport.
 *
 * Requests are bodyless: `POST /pair` carries `content-length: 0` and the
 * upgrade carries no body. Responses are read under an explicit byte bound; a
 * response that exceeds it is abandoned rather than buffered.
 */
internal object HttpExchange {

    /**
     * Render one bodyless HTTP/1.1 request, rejecting anything that could
     * inject a header line or exceed the configured header bounds.
     */
    fun renderRequest(requestLine: String, headers: List<Pair<String, String>>, bounds: PeerTransportBounds): ByteArray {
        if (!requestLine.startsWith("GET ") && !requestLine.startsWith("POST ")) throw invalidArgument()
        if (!requestLine.endsWith(" HTTP/1.1")) throw invalidArgument()
        if (requestLine.any { it == '\r' || it == '\n' }) throw invalidArgument()
        if (headers.size > bounds.maxHttpHeaders) throw invalidArgument()
        var total = requestLine.toByteArray(Charsets.UTF_8).size + 4
        for (header in headers) {
            val name = header.first
            val value = header.second
            if (!isHttpToken(name)) throw invalidArgument()
            if (value.isEmpty()) throw invalidArgument()
            if (value.any { it == '\r' || it == '\n' || it.code < 0x20 || it.code == 0x7F }) throw invalidArgument()
            total += name.toByteArray(Charsets.UTF_8).size + value.toByteArray(Charsets.UTF_8).size + 4
            if (total > bounds.maxHttpHeaderBytes) throw invalidArgument()
        }
        val builder = StringBuilder()
        builder.append(requestLine).append(CRLF)
        for (header in headers) builder.append(header.first).append(": ").append(header.second).append(CRLF)
        builder.append(CRLF)
        return builder.toString().toByteArray(Charsets.US_ASCII)
    }

    fun writeAll(output: OutputStream, bytes: ByteArray) {
        output.write(bytes)
        output.flush()
    }

    /**
     * Read a response body under [maxBytes]. A `content-length` larger than the
     * bound is refused before any of it is read; a body that streams past the
     * bound is refused as it crosses it.
     */
    fun readBoundedBody(input: InputStream, head: HttpHead, maxBytes: Int): ByteArray {
        if (head.has("transfer-encoding")) throw HttpHeadInvalidException()
        val declared = try {
            head.singleValue("content-length")
        } catch (_: HttpHeadInvalidException) {
            throw HttpHeadInvalidException()
        }
        if (declared != null) {
            val length = declared.toLongOrNull() ?: throw HttpHeadInvalidException()
            if (length < 0 || length > maxBytes.toLong()) {
                if (length > maxBytes.toLong()) throw BodyTooLargeException()
                throw HttpHeadInvalidException()
            }
            val body = ByteArray(length.toInt())
            var offset = 0
            while (offset < body.size) {
                val read = input.read(body, offset, body.size - offset)
                if (read < 0) throw EOFException()
                offset += read
            }
            return body
        }
        val collected = ArrayList<Byte>(256)
        while (true) {
            val next = input.read()
            if (next < 0) break
            collected.add(next.toByte())
            if (collected.size > maxBytes) throw BodyTooLargeException()
        }
        val body = ByteArray(collected.size)
        for (index in collected.indices) body[index] = collected[index]
        return body
    }

    /** Signals a response body past the configured bound. */
    class BodyTooLargeException : IOException("response body exceeded the bound")

    private const val CRLF = "\r\n"
}
