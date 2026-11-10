package io.github.rfairburn.pireviewgate.core.transport

/**
 * Fixed, sanitized transport failure surface for the phone-side peer client.
 *
 * The codes and their fixed messages mirror the shared wire contract of the
 * inert paired peer transport (`src/session-host/network/protocol.ts` on the
 * Pi host). Only codes that a client can actually observe are carried here;
 * the listener-side codes (bind failures, host consent limits) belong to the
 * receiving half.
 *
 * An exception never carries peer text: no label, no key material, no endpoint,
 * no payload, no raw TLS or provider message. `statusCode` is the only extra
 * fact, and only when a peer refused an application upgrade with a fixed HTTP
 * status.
 */
enum class PeerTransportErrorCode(val fixedMessage: String) {
    ABORTED("peer transport operation was aborted"),
    APP_REFUSED("peer application channel was refused"),
    APP_TIMEOUT("peer application channel did not open in time"),
    CHANNEL_CLOSED("peer channel is closed"),
    CHANNEL_NOT_OPEN("peer channel is not open"),
    CLIENT_KEY_MISMATCH("client certificate sent on the handshake is not the claimed key"),
    CLIENT_KEY_NOT_PROVED("handshake sent no client certificate for the claimed key"),
    CLIENT_LIMIT_REACHED("client peer operation bound was reached"),
    CONSENT_LIMIT_REACHED("client peer consent bound was reached"),
    HOST_CLOSED("peer host is closed"),
    IDENTITY_ENCODING_INVALID("peer identity material is not a bounded supported encoding"),
    INVALID_ARGUMENT("invalid peer transport argument"),
    MESSAGE_TOO_LARGE("peer message exceeds the configured bound"),
    OUTBOUND_QUEUE_FULL("peer outbound queue bound was reached"),
    PAIRING_DENIED("peer pairing was denied"),
    PAIRING_FAILED("peer pairing failed"),
    PAIRING_HANDSHAKE_COUNT_MISMATCH("pairing decision did not arrive on one verified handshake"),
    PAIRING_KEY_ECHO_MISMATCH("peer accepted a key other than the one proved over TLS"),
    PAIRING_RESPONSE_INVALID("peer pairing response was invalid"),
    PAIRING_RESPONSE_TOO_LARGE("peer pairing response exceeded the configured bound"),
    PAIRING_TIMEOUT("peer pairing timed out"),
    PEER_CERTIFICATE_INVALID("peer presented an unusable certificate"),
    PEER_CERTIFICATE_MISSING("peer presented no certificate"),
    PEER_KEY_APPROVER_FAILED("local peer-key approval handler failed"),
    PEER_KEY_CANCELLED("local peer-key approval was cancelled"),
    PEER_KEY_CHANGED("remembered peer identity changed during the connection"),
    PEER_KEY_DECISION_INVALID("local peer-key approval returned an unsupported decision"),
    PEER_KEY_MISMATCH("peer key does not match the exact remembered identity"),
    PEER_KEY_PROMPT_TIMEOUT("local peer-key approval timed out"),
    PEER_KEY_REJECTED("local peer key was rejected"),
    SEND_FAILED("peer channel send failed"),
    TLS_CONNECTION_CLOSED("peer TLS connection closed before acceptance"),
    TLS_HANDSHAKE_FAILED("peer TLS handshake failed"),
    TLS_HANDSHAKE_TIMEOUT("peer TLS handshake did not complete in time"),
    TLS_SESSION_RESUMED("resumed TLS session has no fresh key proof"),
    TRUST_STORE_FAILED("injected peer trust store failed"),
    UNSUPPORTED_KEY_TYPE("peer identity key type is not supported by this transport"),
    ;
}

/**
 * Sanitized transport failure.
 *
 * `deliveryIsUnknown` is the truthful-outcome marker. It is set for
 * [PeerTransportErrorCode.SEND_FAILED], which means the bytes were handed to the
 * platform socket writer and the result of that write is not knowable from this
 * side, and for any refusal raised after the accepted-dispatch boundary recorded
 * by [PeerSendReceipt.wasInvoked]. It never establishes a peer receipt: it only
 * says this side cannot honestly claim the bytes provably never left the process.
 */
class PeerTransportException internal constructor(
    val code: PeerTransportErrorCode,
    val statusCode: Int? = null,
    private val invocationBoundaryCrossed: Boolean = false,
) : Exception(code.fixedMessage) {
    /** True when the outcome must be treated conservatively as unknown. */
    val deliveryIsUnknown: Boolean
        get() = invocationBoundaryCrossed || code == PeerTransportErrorCode.SEND_FAILED
}

internal fun invalidArgument(): PeerTransportException =
    PeerTransportException(PeerTransportErrorCode.INVALID_ARGUMENT)

/**
 * Fixed wire error codes a receiving peer puts in a bounded JSON body. Values
 * are copied from the shared contract; an unrecognised string is never carried
 * forward as if it were meaningful.
 */
enum class PeerWireErrorCode(val wireValue: String) {
    ABORTED("aborted"),
    APP_UNAVAILABLE("app_unavailable"),
    BAD_REQUEST("bad_request"),
    CLAIM_MISMATCH("claim_mismatch"),
    DENIED("denied"),
    HEADER_TOO_LARGE("header_too_large"),
    INVALID_LABEL("invalid_label"),
    METHOD_NOT_ALLOWED("method_not_allowed"),
    NO_CLIENT_CERTIFICATE("no_client_certificate"),
    NO_HTTP_ENDPOINT("no_http_endpoint"),
    NOT_AUTHORIZED("not_authorized"),
    PAIRING_FAILED("pairing_failed"),
    TIMEOUT("timeout"),
    TOO_MANY_CONNECTIONS("too_many_connections"),
    TOO_MANY_PENDING("too_many_pending"),
    UNEXPECTED_BODY("unexpected_body"),
    UNKNOWN_PATH("unknown_path"),
    UNSUPPORTED_SUBPROTOCOL("unsupported_subprotocol"),
    UPGRADE_NOT_ALLOWED("upgrade_not_allowed"),
    ;

    companion object {
        internal fun fromWire(value: String?): PeerWireErrorCode? {
            if (value == null) return null
            return entries.firstOrNull { it.wireValue == value }
        }
    }
}
