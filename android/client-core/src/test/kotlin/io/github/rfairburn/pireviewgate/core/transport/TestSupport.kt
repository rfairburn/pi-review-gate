package io.github.rfairburn.pireviewgate.core.transport

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Shared helpers for the transport's adversarial framing and queue checks. */
internal object TestSupport {

    fun p256Spki(): ByteArray {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        return generator.generateKeyPair().public.encoded
    }

    fun peerKey(): PeerKey = PeerKey.fromSpkiDer(p256Spki())

    /** Build an unmasked server frame, exactly as a peer would send it. */
    fun serverFrame(
        opcode: Int,
        payload: ByteArray,
        fin: Boolean = true,
        rsv: Int = 0,
        masked: Boolean = false,
        lengthForm: Int = 0,
    ): ByteArray {
        val header = ArrayList<Int>(10)
        header.add(((if (fin) 0x80 else 0x00) or (rsv shl 4) or (opcode and 0x0F)))
        val forceWide = lengthForm == 127
        val forceNarrow16 = lengthForm == 126
        when {
            payload.size < 126 && !forceNarrow16 && !forceWide -> header.add((if (masked) 0x80 else 0) or payload.size)
            payload.size <= 0xFFFF && !forceWide -> {
                header.add((if (masked) 0x80 else 0) or 126)
                header.add((payload.size ushr 8) and 0xFF)
                header.add(payload.size and 0xFF)
            }
            else -> {
                header.add((if (masked) 0x80 else 0) or 127)
                val wide = if (forceWide && payload.size < 126) payload.size.toLong() else payload.size.toLong()
                for (index in 0 until 8) header.add(((wide ushr (56 - 8 * index)) and 0xFF).toInt())
            }
        }
        val frame = ByteArray(header.size + payload.size)
        for (index in header.indices) frame[index] = header[index].toByte()
        System.arraycopy(payload, 0, frame, header.size, payload.size)
        return frame
    }

    /** Decode one client frame the transport produced, returning its payload. */
    fun decodeClientFrame(bytes: ByteArray, offset: Int = 0): DecodedFrame {
        val first = bytes[offset].toInt() and 0xFF
        val second = bytes[offset + 1].toInt() and 0xFF
        val fin = (first and 0x80) != 0
        val opcode = first and 0x0F
        val masked = (second and 0x80) != 0
        var length = second and 0x7F
        var cursor = offset + 2
        if (length == 126) {
            length = ((bytes[cursor].toInt() and 0xFF) shl 8) or (bytes[cursor + 1].toInt() and 0xFF)
            cursor += 2
        } else if (length == 127) {
            var wide = 0L
            for (index in 0 until 8) wide = (wide shl 8) or (bytes[cursor + index].toLong() and 0xFF)
            length = wide.toInt()
            cursor += 8
        }
        val mask = if (masked) bytes.copyOfRange(cursor, cursor + 4) else null
        if (masked) cursor += 4
        val payload = ByteArray(length)
        for (index in 0 until length) {
            payload[index] = if (mask == null) {
                bytes[cursor + index]
            } else {
                (bytes[cursor + index].toInt() xor mask[index and 3].toInt()).toByte()
            }
        }
        return DecodedFrame(fin, opcode, masked, mask, payload, cursor + length)
    }

    class DecodedFrame(
        val fin: Boolean,
        val opcode: Int,
        val masked: Boolean,
        val maskKey: ByteArray?,
        val payload: ByteArray,
        val nextOffset: Int,
    )

    fun sha1(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-1").digest(bytes)

    /** A stream that hands out at most [chunkSize] bytes per read call. */
    class ChunkedStream(private val data: ByteArray, private val chunkSize: Int) : InputStream() {
        private var offset = 0

        override fun read(): Int = if (offset >= data.size) -1 else data[offset++].toInt() and 0xFF

        override fun read(target: ByteArray, off: Int, len: Int): Int {
            if (offset >= data.size) return -1
            val take = minOf(chunkSize, len, data.size - offset)
            System.arraycopy(data, offset, target, off, take)
            offset += take
            return take
        }
    }

    /** Records what the transport wrote, with a controllable write gate. */
    class RecordingStream : OutputStream() {
        private val lock = java.util.concurrent.locks.ReentrantLock()
        private val changed = lock.newCondition()
        private val sink = ByteArrayOutputStream()

        @Volatile
        private var latch: CountDownLatch? = null

        @Volatile
        var failWrites: Boolean = false

        private var attempts = 0

        val writeAttempts: Int
            get() = lock.withLock { attempts }

        override fun write(byte: Int) = write(byteArrayOf(byte.toByte()), 0, 1)

        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            val gate: CountDownLatch? = lock.withLock {
                attempts += 1
                changed.signalAll()
                latch
            }
            gate?.await()
            if (failWrites) throw IOException("simulated socket failure")
            lock.withLock {
                sink.write(bytes, offset, length)
                changed.signalAll()
            }
        }

        fun blockWrites() {
            lock.withLock { latch = CountDownLatch(1) }
        }

        fun unblockWrites() {
            val gate: CountDownLatch? = lock.withLock {
                val current = latch
                latch = null
                current
            }
            gate?.countDown()
        }

        fun bytes(): ByteArray = lock.withLock { sink.toByteArray() }

        /** Wait until at least [minimum] bytes were written, bounded by [timeoutMs]. */
        fun awaitBytes(minimum: Int, timeoutMs: Long = 5_000): Boolean =
            awaitCondition(timeoutMs) { sink.size() >= minimum }

        /** Wait until at least [minimum] write calls arrived, even if they are blocked. */
        fun awaitAttempts(minimum: Int, timeoutMs: Long = 5_000): Boolean =
            awaitCondition(timeoutMs) { attempts >= minimum }

        private fun awaitCondition(timeoutMs: Long, predicate: () -> Boolean): Boolean {
            lock.lock()
            try {
                var remaining = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
                while (!predicate()) {
                    if (remaining <= 0L) return false
                    remaining = changed.awaitNanos(remaining)
                }
                return true
            } finally {
                lock.unlock()
            }
        }

        private inline fun <R> java.util.concurrent.locks.ReentrantLock.withLock(block: () -> R): R {
            lock()
            try {
                return block()
            } finally {
                unlock()
            }
        }
    }

    /** A peer pipe the tests feed, with a recording output side. */
    class FakeConnection(
        override val peerKey: PeerKey = TestSupport.peerKey(),
        override val peerLabel: String? = "fake-peer",
    ) : PeerByteConnection {
        private val feedOut = PipedOutputStream()
        private val feedIn = PipedInputStream(feedOut, 256 * 1024)
        val written = RecordingStream()

        @Volatile
        var terminated: Boolean = false
            private set

        override val input: InputStream = feedIn
        override val output: OutputStream get() = written

        fun feed(bytes: ByteArray) {
            try {
                feedOut.write(bytes)
                feedOut.flush()
            } catch (_: IOException) {
                // The channel terminated; the test asserts on that instead.
            }
        }

        fun endInput() {
            try {
                feedOut.close()
            } catch (_: IOException) {
                // Already closed.
            }
        }

        override fun terminate() {
            terminated = true
            unblock()
            try {
                feedIn.close()
            } catch (_: IOException) {
                // Already closed.
            }
            try {
                feedOut.close()
            } catch (_: IOException) {
                // Already closed.
            }
        }

        fun blockWrites() = written.blockWrites()

        fun unblockWrites() = written.unblockWrites()

        private fun unblock() = written.unblockWrites()
    }

    fun randomBytes(size: Int): ByteArray {
        val bytes = ByteArray(size)
        SecureRandom().nextBytes(bytes)
        return bytes
    }

    /** Decode every client frame in [bytes], in order. */
    fun decodeAll(bytes: ByteArray): List<DecodedFrame> {
        val frames = ArrayList<DecodedFrame>()
        var offset = 0
        while (offset < bytes.size) {
            val frame = decodeClientFrame(bytes, offset)
            frames += frame
            if (frame.nextOffset <= offset) break
            offset = frame.nextOffset
        }
        return frames
    }
}
