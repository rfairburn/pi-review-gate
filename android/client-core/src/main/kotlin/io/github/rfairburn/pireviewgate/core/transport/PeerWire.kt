package io.github.rfairburn.pireviewgate.core.transport

/**
 * Fixed wire names, lanes, and structural validators of the inert paired peer
 * transport, copied from the host contract. This file performs no IO and reads
 * no ambient configuration.
 *
 * The transport has exactly two fixed request shapes on one TLS listener:
 *
 * - `POST /pair` carries bounded pairing metadata in headers and no body.
 * - `GET /app` is a fixed WebSocket upgrade using exactly one subprotocol.
 *
 * A caller names one exact lane; this client never offers a preference list and
 * never negotiates an extension.
 */

const val PAIRING_PATH: String = "/pair"
const val APP_PATH: String = "/app"
const val APP_SUBPROTOCOL: String = "pi-peer-app-v1"
const val CONTENT_SUBPROTOCOL: String = "pi-peer-content-v1"
const val PEER_LABEL_HEADER: String = "x-peer-label"
const val PEER_KEY_HEADER: String = "x-peer-key"

/** Bound on a canonical key id (base64 SPKI DER) carried in a header. */
const val MAX_PEER_KEY_ID_CHARS: Int = 512

internal const val MAX_SPKI_DER_BYTES: Int = 2048
internal const val WEBSOCKET_GUID: String = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
internal const val WEBSOCKET_VERSION: String = "13"

/**
 * Conservative WebSocket control-frame overhead (header plus client mask),
 * identical to the host-side channel accounting.
 */
internal const val CONTROL_FRAME_OVERHEAD: Int = 32

/**
 * Inbound messages the reader is willing to hold for a caller that has not
 * called `receive()` yet. This is a memory bound only: when it is full the
 * reader stops consuming socket bytes, which applies TCP backpressure instead
 * of growing an unbounded listener buffer.
 */
internal const val MAX_QUEUED_INBOUND_MESSAGES: Int = 8

/**
 * Exact lane of one admitted application connection. A lane selects only which
 * caller callback receives the channel on the receiving side; it grants nothing.
 */
enum class PeerAppLane(internal val subprotocol: String) {
    APP(APP_SUBPROTOCOL),
    CONTENT(CONTENT_SUBPROTOCOL),
    ;

    companion object {
        /**
         * Derive the lane from the protocol the peer actually negotiated. Only
         * the two exact known protocols have a lane; anything else returns null
         * and the caller must fail closed.
         */
        fun fromSubprotocol(value: String?): PeerAppLane? {
            if (value == null) return null
            return entries.firstOrNull { it.subprotocol == value }
        }
    }
}

private val PEER_LABEL_PATTERN = Regex("^[0-9A-Za-z ._@:()\\-]+$")
private val PEER_KEY_ID_PATTERN = Regex("^[A-Za-z0-9+/]+={0,2}$")
private val HTTP_TOKEN_PATTERN = Regex("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")

/** Labels are bounded, line-safe display strings and are never identity. */
internal fun isPeerLabel(value: String, maxBytes: Int): Boolean {
    if (value.isEmpty()) return false
    if (value.toByteArray(Charsets.UTF_8).size > maxBytes) return false
    return PEER_LABEL_PATTERN.matches(value)
}

/** Structural bound for a canonical base64 key id carried on the wire. */
internal fun isBoundedPeerKeyId(value: String): Boolean {
    if (value.isEmpty() || value.length > MAX_PEER_KEY_ID_CHARS) return false
    return PEER_KEY_ID_PATTERN.matches(value)
}

internal fun isHttpToken(value: String): Boolean = value.isNotEmpty() && HTTP_TOKEN_PATTERN.matches(value)
