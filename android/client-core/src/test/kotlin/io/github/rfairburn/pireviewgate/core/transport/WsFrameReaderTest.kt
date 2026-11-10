package io.github.rfairburn.pireviewgate.core.transport

import java.io.ByteArrayInputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Adversarial inbound framing.
 *
 * Every case asserts both the refusal and the fixed close code the transport
 * sends back, because a permissive reader is the failure mode that matters.
 */
class WsFrameReaderTest {

    private val maxMessage = 1024

    private fun reader(data: ByteArray, max: Int = maxMessage): WsFrameReader =
        WsFrameReader(ByteArrayInputStream(data), max)

    private fun violationCode(data: ByteArray, max: Int = maxMessage): Int {
        val failure = assertFailsWith<WsProtocolViolation> { reader(data, max).next() }
        return failure.closeCode
    }

    @Test
    fun `a complete binary frame is delivered`() {
        val payload = byteArrayOf(1, 2, 3, 4, 5)
        val message = reader(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload)).next()
        assertEquals(WsFrameCodec.OP_BINARY, message.opcode)
        assertTrue(message.payload.contentEquals(payload))
    }

    @Test
    fun `arbitrary input chunking does not change the parsed message`() {
        val payload = TestSupport.randomBytes(700)
        val bytes = TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload)
        for (chunkSize in listOf(1, 2, 3, 7, 13, 64)) {
            val message = WsFrameReader(TestSupport.ChunkedStream(bytes, chunkSize), maxMessage).next()
            assertTrue(message.payload.contentEquals(payload), "chunk size $chunkSize")
        }
    }

    @Test
    fun `a fragmented binary message is delivered once assembled`() {
        val first = byteArrayOf(1, 1, 1)
        val middle = byteArrayOf(2, 2, 2)
        val last = byteArrayOf(3, 3)
        val stream = ByteArrayInputStream(
            TestSupport.serverFrame(WsFrameCodec.OP_BINARY, first, fin = false) +
                TestSupport.serverFrame(WsFrameCodec.OP_CONTINUATION, middle, fin = false) +
                TestSupport.serverFrame(WsFrameCodec.OP_CONTINUATION, last, fin = true),
        )
        val message = WsFrameReader(stream, maxMessage).next()
        assertEquals(WsFrameCodec.OP_BINARY, message.opcode)
        assertTrue(message.payload.contentEquals(first + middle + last))
    }

    @Test
    fun `a control frame interleaved with fragments is returned between them`() {
        val ping = byteArrayOf(7, 7)
        val stream = ByteArrayInputStream(
            TestSupport.serverFrame(WsFrameCodec.OP_BINARY, byteArrayOf(1), fin = false) +
                TestSupport.serverFrame(WsFrameCodec.OP_PING, ping) +
                TestSupport.serverFrame(WsFrameCodec.OP_CONTINUATION, byteArrayOf(2), fin = true),
        )
        val reader = WsFrameReader(stream, maxMessage)
        val control = reader.next()
        assertEquals(WsFrameCodec.OP_PING, control.opcode)
        assertTrue(control.payload.contentEquals(ping))
        val message = reader.next()
        assertTrue(message.payload.contentEquals(byteArrayOf(1, 2)))
    }

    @Test
    fun `reserved bits are refused`() {
        for (rsv in listOf(1, 2, 3, 4, 6, 7)) {
            assertEquals(
                WsFrameReader.CLOSE_PROTOCOL_ERROR,
                violationCode(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, byteArrayOf(1), rsv = rsv)),
                "rsv $rsv",
            )
        }
    }

    @Test
    fun `a masked server frame is refused`() {
        assertEquals(
            WsFrameReader.CLOSE_PROTOCOL_ERROR,
            violationCode(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, byteArrayOf(1), masked = true)),
        )
    }

    @Test
    fun `unknown and reserved opcodes are refused`() {
        for (opcode in listOf(0x03, 0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F)) {
            assertEquals(
                WsFrameReader.CLOSE_PROTOCOL_ERROR,
                violationCode(TestSupport.serverFrame(opcode, byteArrayOf(1))),
                "opcode $opcode",
            )
        }
    }

    @Test
    fun `a continuation without a message is refused`() {
        assertEquals(
            WsFrameReader.CLOSE_PROTOCOL_ERROR,
            violationCode(TestSupport.serverFrame(WsFrameCodec.OP_CONTINUATION, byteArrayOf(1))),
        )
    }

    @Test
    fun `a new data frame interrupting a fragmented message is refused`() {
        val stream = ByteArrayInputStream(
            TestSupport.serverFrame(WsFrameCodec.OP_BINARY, byteArrayOf(1), fin = false) +
                TestSupport.serverFrame(WsFrameCodec.OP_BINARY, byteArrayOf(2), fin = true),
        )
        assertFailsWith<WsProtocolViolation> { WsFrameReader(stream, maxMessage).next() }
    }

    @Test
    fun `a fragmented control frame is refused`() {
        for (opcode in listOf(WsFrameCodec.OP_CLOSE, WsFrameCodec.OP_PING, WsFrameCodec.OP_PONG)) {
            assertEquals(
                WsFrameReader.CLOSE_PROTOCOL_ERROR,
                violationCode(TestSupport.serverFrame(opcode, byteArrayOf(1), fin = false)),
                "opcode $opcode",
            )
        }
    }

    @Test
    fun `an oversized control frame is refused`() {
        for (opcode in listOf(WsFrameCodec.OP_CLOSE, WsFrameCodec.OP_PING, WsFrameCodec.OP_PONG)) {
            assertEquals(
                WsFrameReader.CLOSE_PROTOCOL_ERROR,
                violationCode(TestSupport.serverFrame(opcode, ByteArray(126))),
                "opcode $opcode",
            )
        }
    }

    @Test
    fun `a one byte close payload is refused`() {
        assertEquals(
            WsFrameReader.CLOSE_PROTOCOL_ERROR,
            violationCode(TestSupport.serverFrame(WsFrameCodec.OP_CLOSE, byteArrayOf(0x03))),
        )
    }

    @Test
    fun `invalid close codes are refused`() {
        for (code in listOf(999, 1004, 1005, 1006, 1016, 2000, 5000)) {
            val payload = byteArrayOf(((code ushr 8) and 0xFF).toByte(), (code and 0xFF).toByte())
            assertEquals(
                WsFrameReader.CLOSE_PROTOCOL_ERROR,
                violationCode(TestSupport.serverFrame(WsFrameCodec.OP_CLOSE, payload)),
                "code $code",
            )
        }
    }

    @Test
    fun `valid close codes are accepted`() {
        for (code in listOf(1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1014, 3000, 4999)) {
            val payload = byteArrayOf(((code ushr 8) and 0xFF).toByte(), (code and 0xFF).toByte())
            val message = reader(TestSupport.serverFrame(WsFrameCodec.OP_CLOSE, payload)).next()
            assertEquals(WsFrameCodec.OP_CLOSE, message.opcode)
        }
    }

    @Test
    fun `an invalid utf8 close reason is refused`() {
        val payload = byteArrayOf(0x03.toByte(), 0xE8.toByte(), 0xFF.toByte())
        assertEquals(
            WsFrameReader.CLOSE_BAD_PAYLOAD,
            violationCode(TestSupport.serverFrame(WsFrameCodec.OP_CLOSE, payload)),
        )
    }

    @Test
    fun `an invalid utf8 text message is refused`() {
        assertEquals(
            WsFrameReader.CLOSE_BAD_PAYLOAD,
            violationCode(TestSupport.serverFrame(WsFrameCodec.OP_TEXT, byteArrayOf(0xC3.toByte(), 0x28.toByte()))),
        )
    }

    @Test
    fun `a 64 bit length form is honoured only for a length that needs it`() {
        val payload = TestSupport.randomBytes(65_536)
        val message = reader(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload, lengthForm = 127), 65_536).next()
        assertTrue(message.payload.contentEquals(payload))
    }

    @Test
    fun `a non-minimal 16 bit length is refused as a protocol violation`() {
        // One byte fits the 7-bit form, so the extended form is malformed.
        val payload = TestSupport.randomBytes(1)
        val failure = assertFailsWith<WsProtocolViolation> {
            reader(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload, lengthForm = 126)).next()
        }
        assertEquals(WsFrameReader.CLOSE_PROTOCOL_ERROR, failure.closeCode)
    }

    @Test
    fun `a non-minimal 64 bit length is refused before payload allocation`() {
        val payload = TestSupport.randomBytes(600)
        val failure = assertFailsWith<WsProtocolViolation> {
            reader(TestSupport.serverFrame(WsFrameCodec.OP_BINARY, payload, lengthForm = 127), 4096).next()
        }
        assertEquals(WsFrameReader.CLOSE_PROTOCOL_ERROR, failure.closeCode)
    }

    @Test
    fun `a control frame must use the 7 bit length form`() {
        val header = byteArrayOf(0x89.toByte(), 126.toByte(), 0x00.toByte(), 0x04.toByte()) + ByteArray(4)
        val failure = assertFailsWith<WsProtocolViolation> { reader(header, 1024).next() }
        assertEquals(WsFrameReader.CLOSE_PROTOCOL_ERROR, failure.closeCode)
    }

    @Test
    fun `a declared length over the bound is refused before allocation`() {
        // The frame header claims 4096 bytes while the bound is 1024: the reader
        // must refuse without reading or allocating the payload.
        val header = byteArrayOf(0x82.toByte(), 126.toByte(), 0x10.toByte(), 0x00.toByte())
        val failure = assertFailsWith<WsProtocolViolation> { reader(header, 1024).next() }
        assertEquals(WsFrameReader.CLOSE_TOO_LARGE, failure.closeCode)
    }

    @Test
    fun `a 64 bit length beyond addressable range is refused`() {
        val header = byteArrayOf(0x82.toByte(), 127.toByte()) + ByteArray(8) { (0xFF - it).toByte() }
        val failure = assertFailsWith<WsProtocolViolation> { reader(header, 1024).next() }
        assertEquals(WsFrameReader.CLOSE_TOO_LARGE, failure.closeCode)
    }

    @Test
    fun `cumulative non final fragments cannot exceed the bound`() {
        // Five 300-byte non-final fragments against a 1024-byte bound: the fourth
        // crosses the cumulative limit, and nothing is ever delivered.
        val fragment = TestSupport.serverFrame(WsFrameCodec.OP_BINARY, ByteArray(300), fin = false)
        val continuation = TestSupport.serverFrame(WsFrameCodec.OP_CONTINUATION, ByteArray(300), fin = false)
        val stream = ByteArrayInputStream(fragment + continuation + continuation + continuation + continuation)
        val reader = WsFrameReader(stream, 1024)
        var seen = 0
        var code: Int? = null
        try {
            while (true) {
                reader.next()
                seen += 1
            }
        } catch (violation: WsProtocolViolation) {
            code = violation.closeCode
        }
        assertEquals(0, seen)
        assertEquals(WsFrameReader.CLOSE_TOO_LARGE, code)
    }

    @Test
    fun `an indefinite non final run is stopped at the bound`() {
        // 40 x 300 bytes with no FIN at all: the reader refuses at the fragment
        // that crosses the bound rather than assembling forever.
        val fragment = TestSupport.serverFrame(WsFrameCodec.OP_BINARY, ByteArray(300), fin = false)
        val continuation = TestSupport.serverFrame(WsFrameCodec.OP_CONTINUATION, ByteArray(300), fin = false)
        val builder = java.io.ByteArrayOutputStream()
        builder.write(fragment)
        repeat(39) { builder.write(continuation) }
        val reader = WsFrameReader(ByteArrayInputStream(builder.toByteArray()), 1024)
        var delivered = 0
        var code: Int? = null
        try {
            while (true) {
                reader.next()
                delivered += 1
            }
        } catch (violation: WsProtocolViolation) {
            code = violation.closeCode
        }
        assertEquals(0, delivered)
        assertEquals(WsFrameReader.CLOSE_TOO_LARGE, code)
    }

    @Test
    fun `a message exactly at the bound is delivered`() {
        val first = TestSupport.serverFrame(WsFrameCodec.OP_BINARY, ByteArray(600), fin = false)
        val last = TestSupport.serverFrame(WsFrameCodec.OP_CONTINUATION, ByteArray(424), fin = true)
        val message = reader(first + last, 1024).next()
        assertEquals(1024, message.payload.size)
    }

    @Test
    fun `end of input mid frame is reported as end of stream`() {
        val bytes = TestSupport.serverFrame(WsFrameCodec.OP_BINARY, TestSupport.randomBytes(50))
        assertFailsWith<WsEndOfStream> { reader(bytes.copyOfRange(0, bytes.size - 10)).next() }
        assertFailsWith<WsEndOfStream> { reader(bytes.copyOfRange(0, 1)).next() }
        assertFailsWith<WsEndOfStream> { reader(ByteArray(0)).next() }
    }

    @Test
    fun `close reason sanitising bounds and strips control characters`() {
        val raw = "ok\u0000\u001b!".toByteArray(Charsets.UTF_8)
        val sanitized = WsFrameReader.sanitizeCloseReason(raw)
        assertEquals("ok??!", sanitized)
        val long = "x".repeat(300).toByteArray(Charsets.UTF_8)
        assertEquals(123, WsFrameReader.sanitizeCloseReason(long).length)
        // Invalid UTF-8 never becomes a reason at all.
        assertEquals("", WsFrameReader.sanitizeCloseReason(byteArrayOf(0xFF.toByte(), 0xFE.toByte())))
    }
}
