package io.github.rfairburn.pireviewgate.core.protocol.content

import java.nio.charset.StandardCharsets

/**
 * The shared native PNG subset, ported from the native graphics validator so a
 * wire boundary and the native surface accept exactly the same images.
 *
 * Canonical base64, the PNG signature, per-chunk CRCs, IHDR depth/color/interlace
 * rules, decoded and base64 byte bounds, dimension and pixel bounds, and refusal
 * of animated PNGs are all enforced here. It retains nothing; anything outside the
 * subset yields null.
 */
internal object KittyPngValidator {
	private const val MAX_IMAGE_BASE64_BYTES = 4 * 1024 * 1024
	private const val MAX_IMAGE_DECODED_BYTES = 3 * 1024 * 1024
	private const val MAX_IMAGE_DIMENSION = 8_192
	private const val MAX_IMAGE_PIXELS = 8 * 1024 * 1024
	private const val MIN_PNG_BYTES = 45

	private val PNG_SIGNATURE = byteArrayOf(
		0x89.toByte(),
		0x50.toByte(),
		0x4e.toByte(),
		0x47.toByte(),
		0x0d.toByte(),
		0x0a.toByte(),
		0x1a.toByte(),
		0x0a.toByte(),
	)

	private val BASE64_CANONICAL =
		Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")

	private val CRC_TABLE: IntArray = makeCrcTable()

	/** The validated dimensions and decoded length, or null when [base64] is outside the subset. */
	fun validate(base64: String): TerminalGraphicsPng? {
		if (base64.isEmpty() ||
			base64.length > MAX_IMAGE_BASE64_BYTES ||
			base64.length % 4 != 0 ||
			!BASE64_CANONICAL.matches(base64)
		) {
			return null
		}
		val bytes = Base64Wire.decodeCanonical(base64) ?: return null
		if (bytes.size > MAX_IMAGE_DECODED_BYTES || bytes.size < MIN_PNG_BYTES || !hasSignature(bytes)) {
			return null
		}
		var offset = 8
		var widthPx = 0
		var heightPx = 0
		var sawHeader = false
		var sawData = false
		var sawEnd = false
		while (offset < bytes.size) {
			if (offset + 12 > bytes.size) return null
			val length = readUInt32BE(bytes, offset)
			if (length > (bytes.size - offset - 12).toLong()) return null
			val type = String(bytes, offset + 4, 4, StandardCharsets.ISO_8859_1)
			val dataStart = offset + 8
			val crcOffset = dataStart + length.toInt()
			if (crc32(bytes, offset + 4, crcOffset) != readUInt32BE(bytes, crcOffset)) return null
			if (!sawHeader) {
				if (type != "IHDR" || length != 13L) return null
				widthPx = readUInt32BE(bytes, dataStart).toInt()
				heightPx = readUInt32BE(bytes, dataStart + 4).toInt()
				val bitDepth = bytes[dataStart + 8].toInt() and 0xff
				val colorType = bytes[dataStart + 9].toInt() and 0xff
				val compression = bytes[dataStart + 10].toInt() and 0xff
				val filterMethod = bytes[dataStart + 11].toInt() and 0xff
				val interlace = bytes[dataStart + 12].toInt() and 0xff
				if (widthPx < 1 ||
					heightPx < 1 ||
					widthPx > MAX_IMAGE_DIMENSION ||
					heightPx > MAX_IMAGE_DIMENSION ||
					widthPx.toLong() * heightPx.toLong() > MAX_IMAGE_PIXELS.toLong() ||
					!validPngDepth(bitDepth, colorType) ||
					compression != 0 ||
					filterMethod != 0 ||
					(interlace != 0 && interlace != 1)
				) {
					return null
				}
				sawHeader = true
			} else if (type == "IHDR") {
				return null
			}
			if (type == "acTL") return null
			if (type == "IDAT") sawData = true
			if (type == "IEND") {
				if (length != 0L || crcOffset + 4 != bytes.size || !sawData) return null
				sawEnd = true
				break
			}
			offset = crcOffset + 4
		}
		if (!sawHeader || !sawData || !sawEnd) return null
		return TerminalGraphicsPng(widthPx = widthPx, heightPx = heightPx, byteLength = bytes.size)
	}

	private fun hasSignature(bytes: ByteArray): Boolean {
		if (bytes.size < PNG_SIGNATURE.size) return false
		for (index in PNG_SIGNATURE.indices) {
			if (bytes[index] != PNG_SIGNATURE[index]) return false
		}
		return true
	}

	/** The color types and bit depths the native subset accepts. */
	private fun validPngDepth(bitDepth: Int, colorType: Int): Boolean = when (colorType) {
		0 -> bitDepth == 1 || bitDepth == 2 || bitDepth == 4 || bitDepth == 8 || bitDepth == 16
		2, 4, 6 -> bitDepth == 8 || bitDepth == 16
		3 -> bitDepth == 1 || bitDepth == 2 || bitDepth == 4 || bitDepth == 8
		else -> false
	}

	private fun readUInt32BE(bytes: ByteArray, offset: Int): Long =
		((bytes[offset].toLong() and 0xff) shl 24) or
			((bytes[offset + 1].toLong() and 0xff) shl 16) or
			((bytes[offset + 2].toLong() and 0xff) shl 8) or
			(bytes[offset + 3].toLong() and 0xff)

	private fun crc32(bytes: ByteArray, start: Int, end: Int): Long {
		var crc = -1
		var index = start
		while (index < end) {
			crc = CRC_TABLE[(crc xor (bytes[index].toInt() and 0xff)) and 0xff] xor (crc ushr 8)
			index += 1
		}
		return (crc xor -1).toLong() and 0xffffffffL
	}

	private fun makeCrcTable(): IntArray {
		val table = IntArray(256)
		for (index in table.indices) {
			var value = index
			for (bit in 0 until 8) {
				value = if (value and 1 != 0) 0xEDB88320.toInt() xor (value ushr 1) else value ushr 1
			}
			table[index] = value
		}
		return table
	}
}
