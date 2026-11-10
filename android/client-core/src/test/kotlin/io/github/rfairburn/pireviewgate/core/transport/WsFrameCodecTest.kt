package io.github.rfairburn.pireviewgate.core.transport

import java.security.SecureRandom
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** Outbound framing: every frame masked with fresh randomness, minimal lengths. */
class WsFrameCodecTest {

    private val random = SecureRandom()

    private fun maskKey(): ByteArray {
        val key = ByteArray(4)
        random.nextBytes(key)
        return key
    }

    @Test
    fun `small frames use the seven bit length and round trip`() {
        val payload = TestSupport.randomBytes(100)
        val encoded = WsFrameCodec.encode(true, WsFrameCodec.OP_BINARY, payload, maskKey())
        assertEquals(2 + 4 + payload.size, encoded.size)
        val decoded = TestSupport.decodeClientFrame(encoded)
        assertTrue(decoded.fin)
        assertEquals(WsFrameCodec.OP_BINARY, decoded.opcode)
        assertTrue(decoded.masked)
        assertTrue(decoded.payload.contentEquals(payload))
        assertEquals(encoded.size, decoded.nextOffset)
    }

    @Test
    fun `medium frames use the sixteen bit length`() {
        val payload = TestSupport.randomBytes(300)
        val encoded = WsFrameCodec.encode(true, WsFrameCodec.OP_BINARY, payload, maskKey())
        assertEquals(4 + 4 + payload.size, encoded.size)
        assertEquals(126, encoded[1].toInt() and 0x7F)
        assertTrue(TestSupport.decodeClientFrame(encoded).payload.contentEquals(payload))
    }

    @Test
    fun `large frames use the sixty four bit length`() {
        val payload = TestSupport.randomBytes(70_000)
        val encoded = WsFrameCodec.encode(true, WsFrameCodec.OP_BINARY, payload, maskKey())
        assertEquals(10 + 4 + payload.size, encoded.size)
        assertEquals(127, encoded[1].toInt() and 0x7F)
        assertTrue(TestSupport.decodeClientFrame(encoded).payload.contentEquals(payload))
    }

    @Test
    fun `payload bytes are never visible on the wire`() {
        val payload = ByteArray(64) { 0x41 }
        val encoded = WsFrameCodec.encode(true, WsFrameCodec.OP_BINARY, payload, maskKey())
        val wire = encoded.copyOfRange(6, encoded.size)
        assertTrue(!wire.contentEquals(payload))
        assertTrue(wire.none { it == 0x41.toByte() })
    }

    @Test
    fun `mask keys differ between frames`() {
        val payload = TestSupport.randomBytes(16)
        val keys = HashSet<String>()
        repeat(32) {
            val encoded = WsFrameCodec.encode(true, WsFrameCodec.OP_BINARY, payload, maskKey())
            keys += TestSupport.decodeClientFrame(encoded).maskKey!!.joinToString(",")
        }
        assertTrue(keys.size > 1)
    }

    @Test
    fun `a non four byte mask key is refused`() {
        assertFailsWith<PeerTransportException> {
            WsFrameCodec.encode(true, WsFrameCodec.OP_PING, ByteArray(1), ByteArray(3))
        }
    }

    @Test
    fun `the fin bit and opcode are encoded independently of the payload`() {
        val first = WsFrameCodec.encode(false, WsFrameCodec.OP_BINARY, ByteArray(1), maskKey())
        val last = WsFrameCodec.encode(true, WsFrameCodec.OP_CONTINUATION, ByteArray(1), maskKey())
        assertTrue((first[0].toInt() and 0x80) == 0)
        assertEquals(WsFrameCodec.OP_BINARY, first[0].toInt() and 0x0F)
        assertTrue((last[0].toInt() and 0x80) != 0)
        assertEquals(WsFrameCodec.OP_CONTINUATION, last[0].toInt() and 0x0F)
        // Reserved bits stay clear on every frame this transport writes.
        assertEquals(0, first[0].toInt() and 0x70)
        assertEquals(0, last[0].toInt() and 0x70)
    }

    @Test
    fun `header size accounting matches the encoded frame`() {
        for (size in listOf(0, 1, 125, 126, 65_535, 65_536)) {
            val payload = ByteArray(size)
            val encoded = WsFrameCodec.encode(true, WsFrameCodec.OP_BINARY, payload, maskKey())
            assertEquals(WsFrameCodec.headerSize(size) + 4 + size, encoded.size)
        }
    }

    @Test
    fun `an outbound frame survives the reader that the peer would use`() {
        val payload = TestSupport.randomBytes(500)
        val encoded = WsFrameCodec.encode(true, WsFrameCodec.OP_BINARY, payload, maskKey())
        // A server-side reader must reject a masked client frame: the mask is real.
        val failure = assertFailsWith<WsProtocolViolation> {
            WsFrameReader(java.io.ByteArrayInputStream(encoded), 1024).next()
        }
        assertEquals(WsFrameReader.CLOSE_PROTOCOL_ERROR, failure.closeCode)
        assertNotEquals(0, encoded[1].toInt() and 0x80)
    }
}
