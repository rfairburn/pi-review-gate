package io.github.rfairburn.pireviewgate.core.transport

/**
 * Outbound RFC 6455 frame encoding.
 *
 * Every client frame is masked with a caller-supplied cryptographic key, and
 * the minimal length form is used. The encoder is pure so the masking and
 * length rules can be verified without a socket.
 */
internal object WsFrameCodec {
    const val OP_CONTINUATION: Int = 0x00
    const val OP_TEXT: Int = 0x01
    const val OP_BINARY: Int = 0x02
    const val OP_CLOSE: Int = 0x08
    const val OP_PING: Int = 0x09
    const val OP_PONG: Int = 0x0A

    /** Header bytes for a frame carrying [payloadSize] (no mask key counted). */
    fun headerSize(payloadSize: Int): Int = when {
        payloadSize < 126 -> 2
        payloadSize <= 0xFFFF -> 4
        else -> 10
    }

    /**
     * Encode one masked frame. [maskKey] must be exactly four bytes of
     * unpredictable randomness and is used for this frame only.
     */
    fun encode(fin: Boolean, opcode: Int, payload: ByteArray, maskKey: ByteArray): ByteArray {
        if (maskKey.size != 4) throw invalidArgument()
        val header = headerSize(payload.size)
        val frame = ByteArray(header + 4 + payload.size)
        frame[0] = (((if (fin) 0x80 else 0x00) or (opcode and 0x0F))).toByte()
        val length = payload.size
        when {
            length < 126 -> frame[1] = (0x80 or length).toByte()
            length <= 0xFFFF -> {
                frame[1] = (0x80 or 126).toByte()
                frame[2] = ((length ushr 8) and 0xFF).toByte()
                frame[3] = (length and 0xFF).toByte()
            }
            else -> {
                frame[1] = (0x80 or 127).toByte()
                val wide = length.toLong()
                for (i in 0 until 8) {
                    frame[2 + i] = ((wide ushr (56 - 8 * i)) and 0xFF).toByte()
                }
            }
        }
        val maskOffset = header
        frame[maskOffset] = maskKey[0]
        frame[maskOffset + 1] = maskKey[1]
        frame[maskOffset + 2] = maskKey[2]
        frame[maskOffset + 3] = maskKey[3]
        for (i in payload.indices) {
            frame[maskOffset + 4 + i] = (payload[i].toInt() xor maskKey[i and 3].toInt()).toByte()
        }
        return frame
    }
}
