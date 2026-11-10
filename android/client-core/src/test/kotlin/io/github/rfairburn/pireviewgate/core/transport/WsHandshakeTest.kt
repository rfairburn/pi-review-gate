package io.github.rfairburn.pireviewgate.core.transport

import java.security.SecureRandom
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The fixed upgrade request and the strict rules its response must satisfy. */
class WsHandshakeTest {

    private val bounds = PeerTransportBounds.DEFAULT
    private val endpoint = PeerEndpoint("127.0.0.1", 53_335)
    private val key = WsHandshake.newKey(SecureRandom())

    private fun head(text: String): HttpHead =
        HttpHeadReader(java.io.ByteArrayInputStream(text.toByteArray(Charsets.ISO_8859_1)), 4096, 20).read()

    private fun successHead(subprotocol: String = APP_SUBPROTOCOL, accept: String = WsHandshake.expectedAccept(key)) =
        "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: $accept\r\n" +
            "Sec-WebSocket-Protocol: $subprotocol\r\n" +
            "\r\n"

    @Test
    fun `the key is sixteen random bytes in standard base64`() {
        assertTrue(key.matches(Regex("^[+/0-9A-Za-z]{22}==${'$'}")))
        val other = WsHandshake.newKey(SecureRandom())
        assertTrue(key != other)
    }

    @Test
    fun `the request names exactly one lane and offers no extension`() {
        val request = String(WsHandshake.buildRequest(endpoint, CONTENT_SUBPROTOCOL, key, bounds), Charsets.US_ASCII)
        assertTrue(request.startsWith("GET /app HTTP/1.1\r\n"))
        assertTrue(request.contains("Host: 127.0.0.1:53335\r\n"))
        assertTrue(request.contains("Upgrade: websocket\r\n"))
        assertTrue(request.contains("Connection: Upgrade\r\n"))
        assertTrue(request.contains("Sec-WebSocket-Version: 13\r\n"))
        assertTrue(request.contains("Sec-WebSocket-Protocol: $CONTENT_SUBPROTOCOL\r\n"))
        assertTrue(!request.contains("Sec-WebSocket-Extensions"))
        assertTrue(!request.contains(APP_SUBPROTOCOL))
        assertTrue(request.endsWith("\r\n\r\n"))
    }

    @Test
    fun `a correct response is accepted for each lane`() {
        for (lane in listOf(PeerAppLane.APP, PeerAppLane.CONTENT)) {
            WsHandshake.validateResponse(head(successHead(lane.subprotocol)), key, lane.subprotocol)
        }
    }

    @Test
    fun `any status other than 101 is refused`() {
        for (status in listOf(200, 301, 400, 401, 403, 404, 405, 503)) {
            val text = "HTTP/1.1 $status Nope\r\nconnection: close\r\n\r\n"
            val failure = assertFailsWith<PeerTransportException> {
                WsHandshake.validateResponse(head(text), key, APP_SUBPROTOCOL)
            }
            assertEquals(PeerTransportErrorCode.APP_REFUSED, failure.code)
            assertEquals(status, failure.statusCode)
        }
    }

    @Test
    fun `a wrong accept value is refused`() {
        assertFailsWith<PeerTransportException> {
            WsHandshake.validateResponse(head(successHead(accept = "AAAAAAAAAAAAAAAAAAAAAAAAAAA=")), key, APP_SUBPROTOCOL)
        }
    }

    @Test
    fun `a missing or duplicated accept value is refused`() {
        assertFailsWith<PeerTransportException> {
            WsHandshake.validateResponse(
                head("HTTP/1.1 101 x\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n"),
                key,
                APP_SUBPROTOCOL,
            )
        }
        assertFailsWith<PeerTransportException> {
            WsHandshake.validateResponse(
                head(
                    "HTTP/1.1 101 x\r\nupgrade: websocket\r\nconnection: upgrade\r\n" +
                        "sec-websocket-accept: ${WsHandshake.expectedAccept(key)}\r\n" +
                        "sec-websocket-accept: ${WsHandshake.expectedAccept(key)}\r\n" +
                        "sec-websocket-protocol: $APP_SUBPROTOCOL\r\n\r\n",
                ),
                key,
                APP_SUBPROTOCOL,
            )
        }
    }

    @Test
    fun `a negotiated protocol that is not the offered lane is refused`() {
        // Asking for content and being answered with app (or nothing) fails closed.
        assertFailsWith<PeerTransportException> {
            WsHandshake.validateResponse(head(successHead(APP_SUBPROTOCOL)), key, CONTENT_SUBPROTOCOL)
        }
        assertFailsWith<PeerTransportException> {
            WsHandshake.validateResponse(
                head(
                    "HTTP/1.1 101 x\r\nupgrade: websocket\r\nconnection: upgrade\r\n" +
                        "sec-websocket-accept: ${WsHandshake.expectedAccept(key)}\r\n\r\n",
                ),
                key,
                APP_SUBPROTOCOL,
            )
        }
        assertFailsWith<PeerTransportException> {
            WsHandshake.validateResponse(
                head(successHead("$APP_SUBPROTOCOL,$CONTENT_SUBPROTOCOL")),
                key,
                APP_SUBPROTOCOL,
            )
        }
    }

    @Test
    fun `a negotiated extension is refused`() {
        assertFailsWith<PeerTransportException> {
            WsHandshake.validateResponse(
                head(successHead().replace("\r\n\r\n", "\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n")),
                key,
                APP_SUBPROTOCOL,
            )
        }
    }

    @Test
    fun `connection headers must carry the upgrade token`() {
        for (connection in listOf("keep-alive", "keep-alive, close", "")) {
            assertFailsWith<PeerTransportException> {
                WsHandshake.validateResponse(
                    head(successHead().replace("Connection: Upgrade", "Connection: $connection")),
                    key,
                    APP_SUBPROTOCOL,
                )
            }
        }
        // A compound header that does contain the token is fine.
        WsHandshake.validateResponse(
            head(successHead().replace("Connection: Upgrade", "Connection: keep-alive, Upgrade")),
            key,
            APP_SUBPROTOCOL,
        )
    }

    @Test
    fun `a wrong upgrade header is refused`() {
        assertFailsWith<PeerTransportException> {
            WsHandshake.validateResponse(
                head(successHead().replace("Upgrade: websocket", "Upgrade: h2c")),
                key,
                APP_SUBPROTOCOL,
            )
        }
    }
}
