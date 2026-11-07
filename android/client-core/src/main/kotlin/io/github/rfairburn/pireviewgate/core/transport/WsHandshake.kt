package io.github.rfairburn.pireviewgate.core.transport

import java.security.SecureRandom
import java.util.Base64

/**
 * The fixed `GET /app` WebSocket upgrade and its strict response validation.
 *
 * Exactly one subprotocol is offered, for exactly one lane. No extension header
 * is ever offered, because accepting an extension would let the peer change the
 * bytes this transport is responsible for bounding.
 */
internal object WsHandshake {

    /** A fresh RFC 6455 key: sixteen random bytes, standard base64. */
    fun newKey(random: SecureRandom): String {
        val material = ByteArray(16)
        random.nextBytes(material)
        return Base64.getEncoder().encodeToString(material)
    }

    fun expectedAccept(key: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-1")
            .digest((key + WEBSOCKET_GUID).toByteArray(Charsets.US_ASCII))
        return Base64.getEncoder().encodeToString(digest)
    }

    fun buildRequest(
        endpoint: PeerEndpoint,
        subprotocol: String,
        key: String,
        bounds: PeerTransportBounds,
    ): ByteArray {
        val headers = listOf(
            "Host" to endpoint.hostHeaderValue(),
            "Upgrade" to "websocket",
            "Connection" to "Upgrade",
            "Sec-WebSocket-Key" to key,
            "Sec-WebSocket-Version" to WEBSOCKET_VERSION,
            "Sec-WebSocket-Protocol" to subprotocol,
        )
        return HttpExchange.renderRequest("GET " + APP_PATH + " HTTP/1.1", headers, bounds)
    }

    /**
     * Validate the upgrade response. Anything other than a single, exact 101
     * with the expected accept value, the exact negotiated protocol, and no
     * negotiated extension is refused.
     */
    fun validateResponse(head: HttpHead, offeredKey: String, offeredSubprotocol: String) {
        if (head.statusCode != 101) throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED, head.statusCode)
        val upgrade = try {
            head.singleValue("upgrade")
        } catch (_: HttpHeadInvalidException) {
            throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
        }
        if (upgrade == null || !upgrade.equals("websocket", ignoreCase = true)) {
            throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
        }
        if (!hasUpgradeToken(head)) throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
        val accept = singleOrNull(head, "sec-websocket-accept")
        if (accept == null || !constantTimeEquals(accept, expectedAccept(offeredKey))) {
            throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
        }
        val protocol = singleOrNull(head, "sec-websocket-protocol")
        if (protocol != offeredSubprotocol) throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
        // No extension was offered, so none may be negotiated.
        if (head.has("sec-websocket-extensions")) throw PeerTransportException(PeerTransportErrorCode.APP_REFUSED)
    }

    /**
     * The `Connection` header must carry the `upgrade` token. Repeat headers are
     * joined for the token test, matching how the receiving peer parses them.
     */
    private fun hasUpgradeToken(head: HttpHead): Boolean {
        val values = head.valuesOf("connection")
        if (values.isEmpty()) return false
        return values.any { value ->
            value.split(',').any { token -> token.trim().equals("upgrade", ignoreCase = true) }
        }
    }

    private fun singleOrNull(head: HttpHead, name: String): String? {
        val values = head.valuesOf(name)
        if (values.size != 1) return null
        return values[0]
    }

    private fun constantTimeEquals(left: String, right: String): Boolean {
        val a = left.toByteArray(Charsets.US_ASCII)
        val b = right.toByteArray(Charsets.US_ASCII)
        if (a.size != b.size) return false
        var diff = 0
        for (index in a.indices) diff = diff or (a[index].toInt() xor b[index].toInt())
        return diff == 0
    }
}
