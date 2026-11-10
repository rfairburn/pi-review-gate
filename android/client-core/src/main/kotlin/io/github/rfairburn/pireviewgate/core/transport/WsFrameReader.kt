package io.github.rfairburn.pireviewgate.core.transport

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * One complete inbound item. Data opcodes are already assembled: a fragmented
 * binary message is delivered once, atomically, with [opcode] `OP_BINARY`.
 */
internal class WsInboundMessage(val opcode: Int, val payload: ByteArray)

/**
 * A peer frame that must be refused. [closeCode] is the code this side sends
 * back before closing, following the same fixed choices as the host transport.
 */
internal class WsProtocolViolation(val closeCode: Int) : Exception("websocket protocol violation")

/** The peer closed the stream; no further frame boundary follows. */
internal class WsEndOfStream : IOException("peer closed the connection")

/**
 * Inbound RFC 6455 framing with the length bound enforced before allocation.
 *
 * The reader inspects each frame header and adds the declared length to the
 * running message total *before* allocating anything, so an endless sequence of
 * non-final continuation fragments cannot grow the buffer past
 * [maxMessageBytes]: the reader refuses at the fragment that would cross the
 * bound, and a completed message is delivered only once, atomically.
 *
 * Refusals are structural, never permissive: set reserved bits, a masked server
 * frame, an unknown opcode, a continuation without a message or a new data
 * frame interrupting one, a fragmented or oversized control frame, a one-byte
 * close payload, an invalid close code, invalid close UTF-8, and an invalid
 * text payload all end the connection with the fixed close code.
 */
internal class WsFrameReader(
    private val input: InputStream,
    private val maxMessageBytes: Int,
) {
    private var assemblyOpcode = -1
    private var assemblyTotal = 0
    private var fragments: ByteArrayOutputStream? = null

    /** True while a fragmented message is mid-assembly. */
    internal val assembling: Boolean
        get() = assemblyOpcode != -1

    /**
     * Read the next complete message or control frame.
     *
     * @throws WsProtocolViolation for a frame that must be refused
     * @throws WsEndOfStream when the peer closed the stream
     */
    fun next(): WsInboundMessage {
        while (true) {
            val frame = readFrame()
            val opcode = frame.opcode
            if (opcode >= 0x08) {
                if (opcode == WsFrameCodec.OP_CLOSE) validateClosePayload(frame.payload)
                return WsInboundMessage(opcode, frame.payload)
            }
            if (opcode == WsFrameCodec.OP_CONTINUATION) {
                val buffer = fragments ?: throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
                buffer.write(frame.payload)
                assemblyTotal += frame.payload.size
                if (!frame.fin) continue
                val assembled = buffer.toByteArray()
                val completed = assemblyOpcode
                resetMessage()
                validatePayload(completed, assembled)
                return WsInboundMessage(completed, assembled)
            }
            // A new data frame.
            if (assemblyOpcode != -1) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
            if (!frame.fin) {
                val buffer = ByteArrayOutputStream(frame.payload.size)
                buffer.write(frame.payload)
                assemblyOpcode = opcode
                assemblyTotal = frame.payload.size
                fragments = buffer
                continue
            }
            validatePayload(opcode, frame.payload)
            return WsInboundMessage(opcode, frame.payload)
        }
    }

    private fun resetMessage() {
        assemblyOpcode = -1
        assemblyTotal = 0
        fragments = null
    }

    private inner class RawFrame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

    private fun readFrame(): RawFrame {
        val first = readByte()
        val second = readByte()
        val fin = (first and 0x80) != 0
        if ((first and 0x70) != 0) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
        val opcode = first and 0x0F

        if (opcode == WsFrameCodec.OP_CONTINUATION) {
            if (assemblyOpcode == -1) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
        } else if (opcode == WsFrameCodec.OP_TEXT || opcode == WsFrameCodec.OP_BINARY) {
            if (assemblyOpcode != -1) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
        } else if (opcode < 0x08 || opcode > 0x0A) {
            throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
        }

        val isControl = opcode >= 0x08
        if (isControl && !fin) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
        // A server frame must never be masked.
        if ((second and 0x80) != 0) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)

        var length = second and 0x7F
        if (length == 126) {
            val high = readByte()
            val low = readByte()
            length = ((high and 0xFF) shl 8) or (low and 0xFF)
            // RFC 6455 requires minimal encoding: the two-byte form is only
            // legal for lengths that the one-byte form cannot express.
            if (length < 126) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
        } else if (length == 127) {
            var wide = 0L
            for (index in 0 until 8) {
                wide = (wide shl 8) or (readByte().toLong() and 0xFF)
                if (wide > MAX_ADDRESSABLE_LENGTH) throw WsProtocolViolation(CLOSE_TOO_LARGE)
            }
            // Likewise the eight-byte form is only legal above the two-byte range.
            if (wide < 65_536L) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
            if (wide > maxMessageBytes.toLong()) throw WsProtocolViolation(CLOSE_TOO_LARGE)
            length = wide.toInt()
        }

        if (isControl) {
            if (length > 125) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
            if (opcode == WsFrameCodec.OP_CLOSE && length == 1) {
                throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
            }
        }

        // Cumulative message bound, applied before any allocation for this
        // fragment: the running total, not the individual frame, is the limit.
        if (!isControl) {
            val projected = assemblyTotal.toLong() + length.toLong()
            if (projected > maxMessageBytes.toLong()) throw WsProtocolViolation(CLOSE_TOO_LARGE)
        }

        val payload = ByteArray(length)
        readFully(payload)
        return RawFrame(fin, opcode, payload)
    }

    private fun validatePayload(opcode: Int, payload: ByteArray) {
        if (opcode != WsFrameCodec.OP_TEXT) return
        if (!isValidUtf8(payload)) throw WsProtocolViolation(CLOSE_BAD_PAYLOAD)
    }

    private fun validateClosePayload(payload: ByteArray) {
        if (payload.size < 2) return
        val code = ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF)
        if (!isValidCloseCode(code)) throw WsProtocolViolation(CLOSE_PROTOCOL_ERROR)
        if (payload.size > 2) {
            val reason = ByteArray(payload.size - 2)
            System.arraycopy(payload, 2, reason, 0, reason.size)
            if (!isValidUtf8(reason)) throw WsProtocolViolation(CLOSE_BAD_PAYLOAD)
        }
    }

    private fun readByte(): Int {
        val value = input.read()
        if (value < 0) throw WsEndOfStream()
        return value
    }

    private fun readFully(target: ByteArray) {
        var offset = 0
        while (offset < target.size) {
            val read = input.read(target, offset, target.size - offset)
            if (read < 0) throw WsEndOfStream()
            offset += read
        }
    }

    companion object {
        internal const val CLOSE_NORMAL = 1000
        internal const val CLOSE_UNSUPPORTED_MESSAGE = 1003
        internal const val CLOSE_PROTOCOL_ERROR = 1002
        internal const val CLOSE_BAD_PAYLOAD = 1007
        internal const val CLOSE_TOO_LARGE = 1009
        internal const val CLOSE_INTERNAL = 1011
        internal const val CLOSE_ABNORMAL = 1006

        private const val MAX_ADDRESSABLE_LENGTH = 0x7FFF_FFFFL

        internal fun isValidCloseCode(code: Int): Boolean =
            (code in 1000..1014 && code != 1004 && code != 1005 && code != 1006) || code in 3000..4999

        /** Strict UTF-8 validation with no replacement characters. */
        internal fun isValidUtf8(bytes: ByteArray): Boolean = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
            true
        } catch (_: CharacterCodingException) {
            false
        }

        /**
         * Bound and strip control characters from a remote close reason, exactly
         * as the host-side channel does.
         */
        internal fun sanitizeCloseReason(reason: ByteArray): String {
            val text = if (isValidUtf8(reason)) String(reason, Charsets.UTF_8) else ""
            val builder = StringBuilder()
            for (character in text.take(123)) {
                val code = character.code
                builder.append(if (code < 0x20 || code == 0x7F) '?' else character)
            }
            return builder.toString()
        }
    }
}
