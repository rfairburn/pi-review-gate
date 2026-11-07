package io.github.rfairburn.pireviewgate.core.transport

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.security.SecureRandom
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

/**
 * The byte pipe a peer channel drives.
 *
 * Production uses [PeerTlsConnection]; the seam exists so the framing, queue,
 * and lifecycle rules can be exercised off-device without a TLS handshake.
 */
internal interface PeerByteConnection {
    val input: InputStream
    val output: OutputStream

    /** Exact peer identity proved on this connection. */
    val peerKey: PeerKey

    /** Bounded display label from the peer certificate, never identity. */
    val peerLabel: String?

    /** Abrupt, idempotent teardown. Never replays buffered bytes. */
    fun terminate()

    /** Bound the next blocking read; zero means no timeout. */
    fun applyReadTimeout(timeoutMs: Int) {
        // Connections without a socket-level timeout ignore this.
    }
}

/**
 * One fresh TLS connection with a fresh key proof.
 *
 * A brand-new [SSLContext] is built for every connection, so there is no
 * shared session cache, no connection pool, and nothing to resume: each
 * connection completes its own full handshake and produces its own SPKI proof.
 * The session is invalidated immediately after the handshake as defence in
 * depth. Only TLS 1.2 and TLS 1.3 are enabled, and no endpoint identification
 * algorithm is used, because identity here is the exact pinned key rather than
 * a DNS name validated by a CA.
 */
internal class PeerTlsConnection internal constructor(
    private val socket: SSLSocket,
    override val peerKey: PeerKey,
    internal val peerSpkiDer: ByteArray,
    override val peerLabel: String?,
) : PeerByteConnection {

    override val input: InputStream = socket.inputStream
    override val output: OutputStream = socket.outputStream

    /** Number of completed handshakes on this connection; always exactly one. */
    val handshakeCount: Int = 1

    override fun terminate() {
        try {
            socket.close()
        } catch (_: IOException) {
            // Already gone.
        } catch (_: Throwable) {
            // A provider teardown failure still leaves the socket unusable.
        }
    }

    override fun applyReadTimeout(timeoutMs: Int) {
        try {
            socket.soTimeout = if (timeoutMs < 0) 0 else timeoutMs
        } catch (_: Throwable) {
            // A closed socket has no timeout to set.
        }
    }

    internal companion object {
        /**
         * Connect, prove, and pin.
         *
         * @param pinnedSpkiDer the exact expected SPKI, or null for an explicit
         * first-use pairing that will confirm the observed key before any byte.
         */
        internal fun connect(
            endpoint: PeerEndpoint,
            identity: PeerClientIdentity,
            pinnedSpkiDer: ByteArray?,
            handshakeTimeoutMs: Int,
            onSocket: (SSLSocket) -> Unit = {},
        ): PeerTlsConnection {
            val observation = HandshakeObservation()
            val trustManager = SpkiPinTrustManager(pinnedSpkiDer, observation)
            var socket: SSLSocket? = null
            try {
                val context = SSLContext.getInstance("TLS")
                context.init(identity.keyManagers, arrayOf<X509TrustManager>(trustManager), SecureRandom())
                val created = context.socketFactory.createSocket() as SSLSocket
                socket = created
                // Published before any blocking call so an absolute deadline can
                // close the socket out from under a stalled handshake.
                onSocket(created)
                created.connect(InetSocketAddress(endpoint.host, endpoint.port), handshakeTimeoutMs)
                created.tcpNoDelay = true

                val parameters = created.sslParameters
                val enabled = created.supportedProtocols.filter { it == "TLSv1.2" || it == "TLSv1.3" }
                if (enabled.isEmpty()) throw PeerTransportException(PeerTransportErrorCode.TLS_HANDSHAKE_FAILED)
                parameters.setProtocols(enabled.toTypedArray())
                // Identity is the exact pinned key, never a DNS name through a CA.
                parameters.setEndpointIdentificationAlgorithm("")
                offerAlpn(parameters)
                created.sslParameters = parameters

                created.soTimeout = handshakeTimeoutMs
                created.startHandshake()
                created.soTimeout = 0
                created.session?.invalidate()

                val proved = observation.spkiDer
                    ?: throw PeerTransportException(PeerTransportErrorCode.PEER_CERTIFICATE_MISSING)
                if (observation.completedHandshakes != 1) {
                    throw PeerTransportException(PeerTransportErrorCode.PAIRING_HANDSHAKE_COUNT_MISMATCH)
                }
                // The claimed identity is only real if this handshake actually sent
                // it: a nonempty KeyManager array proves availability, not choice.
                val claimedClientSpki = PeerKey.fromKeyId(identity.keyId).pinnedDer()
                verifySelectedClientKey(created.session.localCertificates, claimedClientSpki)
                val key = PeerKey.fromSpkiDer(proved)
                return PeerTlsConnection(created, key, proved, observation.label)
            } catch (failure: PeerTransportException) {
                socket?.closeQuietly()
                throw failure
            } catch (failure: SocketTimeoutException) {
                socket?.closeQuietly()
                throw PeerTransportException(PeerTransportErrorCode.TLS_HANDSHAKE_TIMEOUT)
            } catch (failure: SSLException) {
                socket?.closeQuietly()
                throw PeerTransportException(mapHandshakeFailure(observation))
            } catch (failure: IOException) {
                socket?.closeQuietly()
                throw PeerTransportException(PeerTransportErrorCode.TLS_CONNECTION_CLOSED)
            } catch (failure: Throwable) {
                socket?.closeQuietly()
                throw PeerTransportException(PeerTransportErrorCode.TLS_HANDSHAKE_FAILED)
            }
        }

        /**
         * Prove that the certificate this side actually presented on the finished
         * handshake is the claimed key. A missing selection, an empty chain, or a
         * different key all refuse the connection before any request byte.
         */
        internal fun verifySelectedClientKey(
            localCertificates: Array<out java.security.cert.Certificate>?,
            expectedSpkiDer: ByteArray,
        ) {
            val leaf = localCertificates?.firstOrNull()
                ?: throw PeerTransportException(PeerTransportErrorCode.CLIENT_KEY_NOT_PROVED)
            val proved = try {
                leaf.publicKey?.encoded
            } catch (_: Throwable) {
                null
            } ?: throw PeerTransportException(PeerTransportErrorCode.CLIENT_KEY_NOT_PROVED)
            if (!java.security.MessageDigest.isEqual(proved, expectedSpkiDer)) {
                throw PeerTransportException(PeerTransportErrorCode.CLIENT_KEY_MISMATCH)
            }
        }

        private fun mapHandshakeFailure(observation: HandshakeObservation): PeerTransportErrorCode = when {
            observation.pinMismatch -> PeerTransportErrorCode.PEER_KEY_MISMATCH
            observation.spkiDer == null -> PeerTransportErrorCode.PEER_CERTIFICATE_MISSING
            else -> PeerTransportErrorCode.TLS_HANDSHAKE_FAILED
        }

        /**
         * Offer `http/1.1` when the platform exposes ALPN. Older platforms
         * without the public setter simply do not offer it; the peer's HTTP/1.1
         * path is unchanged either way, and no private API is reached for.
         */
        private fun offerAlpn(parameters: javax.net.ssl.SSLParameters) {
            try {
                parameters.setApplicationProtocols(arrayOf("http/1.1"))
            } catch (_: NoSuchMethodError) {
                // Platform without ALPN support.
            } catch (_: UnsupportedOperationException) {
                // Provider refuses ALPN.
            }
        }

        private fun SSLSocket.closeQuietly() {
            try {
                close()
            } catch (_: Throwable) {
                // Already gone.
            }
        }
    }
}
