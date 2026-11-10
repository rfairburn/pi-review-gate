package io.github.rfairburn.pireviewgate.core.transport

import java.io.ByteArrayInputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Bounded, strict HTTP/1.1 response head parsing. */
class HttpHeadReaderTest {

    private fun head(text: String, maxBytes: Int = 4096, maxLines: Int = 20): HttpHead =
        HttpHeadReader(ByteArrayInputStream(text.toByteArray(Charsets.ISO_8859_1)), maxBytes, maxLines).read()

    @Test
    fun `a normal pairing response parses`() {
        val parsed = head("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 12\r\n\r\n")
        assertEquals(200, parsed.statusCode)
        assertEquals("application/json", parsed.singleValue("content-type"))
        assertEquals("12", parsed.singleValue("Content-Length"))
        assertEquals(null, parsed.singleValue("x-absent"))
    }

    @Test
    fun `an oversized head is refused`() {
        val builder = StringBuilder("HTTP/1.1 200 OK\r\n")
        repeat(200) { builder.append("x-pad-").append(it).append(": ").append("v".repeat(40)).append("\r\n") }
        builder.append("\r\n")
        assertFailsWith<HttpHeadTooLargeException> { head(builder.toString(), maxBytes = 2048) }
    }

    @Test
    fun `too many header lines are refused`() {
        val builder = StringBuilder("HTTP/1.1 200 OK\r\n")
        repeat(21) { builder.append("x-pad-").append(it).append(": v\r\n") }
        builder.append("\r\n")
        assertFailsWith<HttpHeadTooLargeException> { head(builder.toString(), maxLines = 20) }
    }

    @Test
    fun `a duplicated header is visible and refused as a single value`() {
        val parsed = head("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nupgrade: websocket\r\n\r\n")
        assertEquals(2, parsed.valuesOf("upgrade").size)
        assertFailsWith<HttpHeadInvalidException> { parsed.singleValue("upgrade") }
    }

    @Test
    fun `obsolete line folding is refused`() {
        assertFailsWith<HttpHeadInvalidException> {
            head("HTTP/1.1 200 OK\r\nx-a: 1\r\n  folded\r\n\r\n")
        }
    }

    @Test
    fun `a header line without a colon is refused`() {
        assertFailsWith<HttpHeadInvalidException> { head("HTTP/1.1 200 OK\r\nbroken\r\n\r\n") }
    }

    @Test
    fun `a non numeric status is refused`() {
        assertFailsWith<HttpHeadInvalidException> { head("HTTP/1.1 abc OK\r\n\r\n") }
        assertFailsWith<HttpHeadInvalidException> { head("SIP/2.0 200 OK\r\n\r\n") }
    }

    @Test
    fun `a bare lf head never terminates and fails at end of input`() {
        assertFailsWith<HttpHeadInvalidException> { head("HTTP/1.1 200 OK\ncontent-length: 0\n\n") }
    }

    @Test
    fun `control characters in a header value are refused`() {
        assertFailsWith<HttpHeadInvalidException> { head("HTTP/1.1 200 OK\r\nx-a: 1\u00012\r\n\r\n") }
    }

    @Test
    fun `bounded body reading refuses an oversized declared length`() {
        val parsed = head("HTTP/1.1 200 OK\r\ncontent-length: 5000\r\n\r\n")
        val body = ByteArray(5000)
        assertFailsWith<HttpExchange.BodyTooLargeException> {
            HttpExchange.readBoundedBody(ByteArrayInputStream(body), parsed, 2048)
        }
    }

    @Test
    fun `bounded body reading refuses a stream that crosses the bound`() {
        val parsed = head("HTTP/1.1 200 OK\r\n\r\n")
        val body = ByteArray(3000)
        assertFailsWith<HttpExchange.BodyTooLargeException> {
            HttpExchange.readBoundedBody(ByteArrayInputStream(body), parsed, 2048)
        }
    }

    @Test
    fun `a chunked pairing body is refused rather than decoded`() {
        val parsed = head("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n")
        assertFailsWith<HttpHeadInvalidException> {
            HttpExchange.readBoundedBody(ByteArrayInputStream(ByteArray(10)), parsed, 2048)
        }
    }

    @Test
    fun `a declared length is read exactly`() {
        val parsed = head("HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\n")
        val body = HttpExchange.readBoundedBody(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4, 5)), parsed, 2048)
        assertTrue(body.contentEquals(byteArrayOf(1, 2, 3, 4)))
    }

    @Test
    fun `request rendering refuses header injection and oversized blocks`() {
        val bounds = PeerTransportBounds.DEFAULT
        assertFailsWith<PeerTransportException> {
            HttpExchange.renderRequest("POST /pair HTTP/1.1", listOf("x-a" to "1\r\nX-Injected: 2"), bounds)
        }
        assertFailsWith<PeerTransportException> {
            HttpExchange.renderRequest("GET /app HTTP/1.1", listOf("bad name" to "v"), bounds)
        }
        assertFailsWith<PeerTransportException> {
            HttpExchange.renderRequest("POST /pair HTTP/2", emptyList(), bounds)
        }
        val big = List(30) { "x-pad-$it" to "v" }
        assertFailsWith<PeerTransportException> {
            HttpExchange.renderRequest("POST /pair HTTP/1.1", big, bounds)
        }
        val rendered = String(
            HttpExchange.renderRequest("POST /pair HTTP/1.1", listOf("Host" to "127.0.0.1:1"), bounds),
            Charsets.US_ASCII,
        )
        assertEquals("POST /pair HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n", rendered)
    }
}
